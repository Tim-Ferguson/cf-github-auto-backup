// Mirrors a source git repo into a backup remote without ever losing history.
//
// The backup remote is fetched first, so anything it already holds stays
// reachable. Refs that were force-pushed or deleted upstream are preserved
// under refs/backup/ before the live refs are updated.

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const SNAPSHOT_PREFIX = "refs/backup/";
const LIVE_PREFIXES = ["refs/heads/", "refs/tags/", "refs/pull/"];
const LFS_POINTER_MAX = 1024;
const LFS_POINTER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:[a-z0-9.-]+ [^\n]*\n)*?oid sha256:([0-9a-f]{64})\nsize (\d+)\n/;

export class SyncError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** Credentials go through the environment so they never show up in argv. */
function authEnv(authHeader) {
	if (!authHeader) return {};
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: ${authHeader}`,
	};
}

function git(cwd, args, { authHeader, input, allowFail = false, onLine } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...authEnv(authHeader) },
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		if (onLine) {
			createInterface({ input: child.stdout }).on("line", onLine);
		} else {
			child.stdout.on("data", (d) => (stdout += d));
		}
		child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0 || allowFail) resolve({ code, stdout, stderr });
			else reject(new SyncError("GIT_FAILED", `git ${args[0]} exited ${code}: ${stderr.trim()}`));
		});
		if (input !== undefined) child.stdin.end(input);
	});
}

async function listRefs(repoDir) {
	const { stdout } = await git(repoDir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
	const refs = new Map();
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const i = line.indexOf(" ");
		refs.set(line.slice(i + 1), line.slice(0, i));
	}
	return refs;
}

async function lsRemote(repoDir, url, authHeader, patterns) {
	const { code, stdout, stderr } = await git(repoDir, ["ls-remote", url, ...patterns], { authHeader, allowFail: true });
	if (code !== 0) {
		const notFound = /not found|does not exist|returned error: 40[134]|does not appear to be a git repository/i.test(stderr);
		throw new SyncError(notFound ? "SOURCE_NOT_FOUND" : "SOURCE_UNREACHABLE", stderr.trim() || `ls-remote exited ${code}`);
	}
	const refs = new Map();
	for (const line of stdout.split("\n")) {
		const [sha, ref] = line.split("\t");
		if (sha && ref && !ref.endsWith("^{}")) refs.set(ref, sha);
	}
	return refs;
}

const isLive = (ref) => LIVE_PREFIXES.some((p) => ref.startsWith(p));
const stamp = (date) => date.toISOString().replace(/[-:]|\.\d+/g, "");

/**
 * @param job {{
 *   source: { url: string, authHeader?: string, pulls?: boolean },
 *   target: { url: string, authHeader?: string },
 *   limits?: { maxBlobBytes?: number, maxRepoBytes?: number },
 *   lfs?: boolean,
 * }}
 * @param opts {{ workdir: string, onPhase?: (phase: string) => void, now?: Date }}
 */
export async function syncRepo(job, { workdir, onPhase = () => {}, now = new Date() }) {
	const repoDir = join(workdir, "repo.git");
	await rm(workdir, { recursive: true, force: true });
	await mkdir(repoDir, { recursive: true });
	await git(repoDir, ["init", "--bare", "--quiet"]);
	// Keep unreachable objects around; this clone is thrown away anyway.
	await git(repoDir, ["config", "gc.auto", "0"]);

	const { source, target } = job;
	const ts = stamp(now);

	onPhase("fetching existing backup");
	await git(repoDir, ["fetch", "--quiet", "--no-tags", target.url, "+refs/*:refs/*"], { authHeader: target.authHeader });
	const before = await listRefs(repoDir);

	onPhase("listing source refs");
	const patterns = ["refs/heads/*", "refs/tags/*"];
	if (source.pulls) patterns.push("refs/pull/*/head");
	const upstream = await lsRemote(repoDir, source.url, source.authHeader, patterns);

	const snapshotted = new Set();
	for (const [ref, sha] of before) if (ref.startsWith(SNAPSHOT_PREFIX)) snapshotted.add(sha);
	const snapshots = [];
	const snapshot = async (kind, ref, sha) => {
		if (snapshotted.has(sha)) return;
		const name = `${SNAPSHOT_PREFIX}${kind}/${ts}/${ref.slice("refs/".length)}`;
		await git(repoDir, ["update-ref", name, sha]);
		snapshotted.add(sha);
		snapshots.push({ kind, ref, sha, name });
	};

	// Refs that vanished upstream move out of the live namespace, so a later
	// branch like `foo/bar` cannot collide with a retained `foo`.
	const deleted = [];
	for (const [ref, sha] of before) {
		if (!isLive(ref) || upstream.has(ref)) continue;
		await snapshot("deleted", ref, sha);
		await git(repoDir, ["update-ref", "-d", ref]);
		deleted.push(ref);
	}

	onPhase("fetching from source");
	if (upstream.size > 0) {
		const refspecs = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
		if (source.pulls) refspecs.push("+refs/pull/*/head:refs/pull/*/head");
		await git(repoDir, ["fetch", "--quiet", "--no-tags", "--force", source.url, ...refspecs], { authHeader: source.authHeader });
	}
	const after = await listRefs(repoDir);

	let updated = 0;
	for (const [ref, oldSha] of before) {
		const newSha = after.get(ref);
		if (!isLive(ref) || !newSha || newSha === oldSha) continue;
		updated++;
		// A moved tag is always a rewrite; a branch only if history was dropped.
		const fastForward =
			!ref.startsWith("refs/tags/") &&
			(await git(repoDir, ["merge-base", "--is-ancestor", oldSha, newSha], { allowFail: true })).code === 0;
		if (!fastForward) await snapshot("rewritten", ref, oldSha);
	}
	for (const ref of after.keys()) if (isLive(ref) && !before.has(ref)) updated++;

	onPhase("scanning objects");
	const scan = await scanObjects(repoDir, job.limits?.maxBlobBytes ?? Infinity, job.lfs !== false);
	const { stdout: countOut } = await git(repoDir, ["count-objects", "-v"]);
	const packKb = Number(/size-pack: (\d+)/.exec(countOut)?.[1] ?? 0);
	const looseKb = Number(/^size: (\d+)/m.exec(countOut)?.[1] ?? 0);
	const sizeBytes = (packKb + looseKb) * 1024;

	let oversize = null;
	if (scan.largestBlob > (job.limits?.maxBlobBytes ?? Infinity)) {
		oversize = `contains a ${scan.largestBlob}-byte blob (limit ${job.limits.maxBlobBytes})`;
	} else if (sizeBytes > (job.limits?.maxRepoBytes ?? Infinity)) {
		oversize = `repository is ${sizeBytes} bytes (limit ${job.limits.maxRepoBytes})`;
	}

	const lfsPath = join(workdir, "lfs.json");
	await writeFile(lfsPath, JSON.stringify(scan.lfs));
	const lfsFileSize = (await stat(lfsPath)).size;

	let bundle = null;
	let deleteFailures = 0;
	if (after.size === 0) {
		// Empty repository: nothing to push.
	} else if (oversize) {
		onPhase("bundling (too large for Artifacts)");
		const bundlePath = join(workdir, "repo.bundle");
		await git(repoDir, ["bundle", "create", "--quiet", bundlePath, "--all"]);
		bundle = { path: bundlePath, size: (await stat(bundlePath)).size };
	} else {
		onPhase("pushing to backup");
		// Snapshots land first so retained history is safe before anything is
		// removed. Deletions then clear the way for names reused upstream
		// (`foo` -> `foo/bar`); if the remote refuses them the stale live ref
		// just lingers next to its snapshot.
		if (snapshots.length > 0) {
			await git(repoDir, ["push", "--quiet", target.url, `+${SNAPSHOT_PREFIX}*:${SNAPSHOT_PREFIX}*`], { authHeader: target.authHeader });
		}
		for (let i = 0; i < deleted.length; i += 200) {
			const specs = deleted.slice(i, i + 200).map((ref) => `:${ref}`);
			const res = await git(repoDir, ["push", "--quiet", target.url, ...specs], { authHeader: target.authHeader, allowFail: true });
			if (res.code !== 0) deleteFailures += specs.length;
		}
		await git(repoDir, ["push", "--quiet", target.url, "+refs/*:refs/*"], { authHeader: target.authHeader });
	}

	const count = (prefix) => [...after.keys()].filter((r) => r.startsWith(prefix)).length;
	return {
		refs: {
			heads: count("refs/heads/"),
			tags: count("refs/tags/"),
			pulls: count("refs/pull/"),
			snapshots: count(SNAPSHOT_PREFIX),
		},
		updated,
		deleted: deleted.length,
		deleteFailures,
		newSnapshots: snapshots.map((s) => s.name),
		sizeBytes,
		oversize,
		bundle,
		lfs: { path: lfsPath, size: lfsFileSize, count: scan.lfs.length, bytes: scan.lfs.reduce((n, o) => n + o.size, 0) },
	};
}

/** One pass over every object: finds the largest blob and all LFS pointers. */
async function scanObjects(repoDir, maxBlobBytes, wantLfs) {
	let largestBlob = 0;
	const candidates = [];
	await git(repoDir, ["cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objecttype) %(objectsize) %(objectname)"], {
		onLine: (line) => {
			if (!line.startsWith("blob ")) return;
			const [, size, sha] = line.split(" ");
			const n = Number(size);
			if (n > largestBlob) largestBlob = n;
			if (wantLfs && n >= 100 && n <= LFS_POINTER_MAX) candidates.push(sha);
		},
	});

	const lfs = new Map();
	if (candidates.length > 0) {
		const out = await catBlobs(repoDir, candidates);
		for (const text of out) {
			const m = LFS_POINTER_RE.exec(text);
			if (m) lfs.set(m[1], { oid: m[1], size: Number(m[2]) });
		}
	}
	return { largestBlob, lfs: [...lfs.values()] };
}

function catBlobs(repoDir, shas) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["cat-file", "--batch"], { cwd: repoDir, stdio: ["pipe", "pipe", "inherit"] });
		const chunks = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("error", reject);
		child.on("close", () => {
			const buf = Buffer.concat(chunks);
			const blobs = [];
			let pos = 0;
			while (pos < buf.length) {
				const nl = buf.indexOf(10, pos);
				if (nl === -1) break;
				const header = buf.toString("latin1", pos, nl).split(" ");
				const size = Number(header[2]);
				if (!Number.isFinite(size)) {
					pos = nl + 1; // "<sha> missing"
					continue;
				}
				blobs.push(buf.toString("utf8", nl + 1, nl + 1 + size));
				pos = nl + 1 + size + 1;
			}
			resolve(blobs);
		});
		child.stdin.on("error", reject);
		child.stdin.end(shas.join("\n") + "\n");
	});
}
