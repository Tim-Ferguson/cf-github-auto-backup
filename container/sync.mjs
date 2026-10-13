// Mirrors a source git repo into a backup remote without ever losing history.
// Refs that were force-pushed or deleted upstream are preserved under
// refs/backup/ before the live refs are updated.
//
// There are two ways to do it:
//
//   incremental  asks the source for only the objects the backup lacks and
//                hands exactly those over. Nothing is downloaded twice.
//   full         downloads the existing backup, fetches the source on top
//                and pushes the result. Used for a first sync, for repos
//                too large for the target, and whenever the incremental
//                path cannot finish.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { advertisedRefs, fetchPack, pushCommands, ZERO } from "./relay.mjs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const SNAPSHOT_PREFIX = "refs/backup/";
const LIVE_PREFIXES = ["refs/heads/", "refs/tags/", "refs/pull/"];
const LFS_POINTER_MAX = 1024;
// Pointer files committed from Windows can carry CRLF line endings.
const LFS_POINTER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n(?:[a-z0-9.-]+ [^\n]*\n)*?oid sha256:([0-9a-f]{64})\r?\nsize (\d+)\r?\n/;

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

function git(cwd, args, { authHeader, input, inputFile, allowFail = false, onLine } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...authEnv(authHeader) },
			stdio: [input === undefined && !inputFile ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (inputFile) {
			// If git stops reading (a corrupt pack, say) the pipe breaks; that
			// must reject this call, not crash the process.
			child.stdin.on("error", () => {});
			createReadStream(inputFile).on("error", reject).pipe(child.stdin);
		}
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
 * @param opts {{ workdir: string, onPhase?: (phase: string) => void, now?: Date, seedBundle?: string }}
 *   `seedBundle` is a git bundle holding the existing backup, for repos too
 *   large for the target to hold. It stands in for the target as the source
 *   of existing history, so rewritten and deleted refs are still kept.
 */
export async function syncRepo(job, opts) {
	const overHttp = /^https?:\/\//.test(job.source.url) && /^https?:\/\//.test(job.target.url);
	let fallback;
	if (overHttp && !opts.seedBundle && job.incremental !== false) {
		try {
			const result = await syncIncremental(job, opts);
			if (result) return result;
		} catch (err) {
			// A missing or unreachable source is a real answer, not a reason to retry differently.
			if (err instanceof SyncError && err.code !== "GIT_FAILED") throw err;
			fallback = String(err.message ?? err);
			opts.onPhase?.("falling back to a full sync");
		}
	}
	return { ...(await syncFull(job, opts)), mode: "full", ...(fallback ? { fallback } : {}) };
}

/** Snapshot bookkeeping shared by both paths: one snapshot per (ref, commit), ever. */
function snapshotPlanner(before, ts) {
	const taken = new Set();
	for (const [ref, sha] of before) {
		const kept = /^refs\/backup\/[^/]+\/[^/]+\/(.+)$/.exec(ref);
		if (kept) taken.add(`${kept[1]} ${sha}`);
	}
	return (kind, ref, sha) => {
		const rest = ref.slice("refs/".length);
		if (taken.has(`${rest} ${sha}`)) return null;
		taken.add(`${rest} ${sha}`);
		return `${SNAPSHOT_PREFIX}${kind}/${ts}/${rest}`;
	};
}

const refCounts = (refs) => {
	const count = (prefix) => [...refs.keys()].filter((r) => r.startsWith(prefix)).length;
	return { heads: count("refs/heads/"), tags: count("refs/tags/"), pulls: count("refs/pull/"), snapshots: count(SNAPSHOT_PREFIX) };
};

/**
 * Whether `old` is an ancestor of `tip`, judged from the commits in a pack
 * that holds everything new. "yes" is certain. "unknown" means the walk left
 * the pack without meeting `old`, which a pack alone cannot settle.
 */
async function descendsFrom(scratchDir, commits, tip, old) {
	if (tip === old) return "yes";
	const parents = new Map();
	if (commits.length) {
		const bodies = await catBlobs(scratchDir, commits);
		commits.forEach((sha, i) => parents.set(sha, [...(bodies[i] ?? "").split("\n\n")[0].matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1])));
	}
	const seen = new Set();
	const queue = [tip];
	while (queue.length) {
		const sha = queue.pop();
		if (sha === old) return "yes";
		if (seen.has(sha)) continue;
		seen.add(sha);
		for (const parent of parents.get(sha) ?? []) queue.push(parent);
	}
	return "unknown";
}

/**
 * Syncs by moving only new objects. Returns null when this path does not
 * apply (an empty backup, or content the target cannot hold), in which case
 * the caller does a full sync.
 */
async function syncIncremental(job, { workdir, onPhase = () => {}, now = new Date() }) {
	const { source, target } = job;
	const ts = stamp(now);

	onPhase("reading the backup's refs");
	const { refs: before, capabilities } = await advertisedRefs(target.url, target.authHeader);
	if (before.size === 0) return null;

	await rm(workdir, { recursive: true, force: true });
	const scratch = join(workdir, "new.git");
	await mkdir(scratch, { recursive: true });
	await git(scratch, ["init", "--bare", "--quiet"]);

	onPhase("listing source refs");
	const patterns = ["refs/heads/*", "refs/tags/*"];
	if (source.pulls) patterns.push("refs/pull/*/head");
	const upstream = await lsRemote(scratch, source.url, source.authHeader, patterns);

	const changed = [...upstream].filter(([ref, sha]) => before.get(ref) !== sha);
	const deleted = [...before].filter(([ref]) => isLive(ref) && !upstream.has(ref));

	// Fetch what the backup does not have. Everything it holds is offered as
	// a "have", so the source sends only what is genuinely new.
	const held = new Set(before.values());
	const wants = [...new Set(changed.map(([, sha]) => sha).filter((sha) => !held.has(sha)))];
	const packPath = join(workdir, "new.pack");
	let packBytes = 0;
	let scan = { largestBlob: 0, lfs: [], commits: [] };
	if (wants.length) {
		onPhase("fetching new objects from source");
		packBytes = await fetchPack(source.url, source.authHeader, wants, [...held], packPath);
		// index-pack verifies every object's checksum before anything is passed on.
		await git(scratch, ["index-pack", "--stdin"], { inputFile: packPath });
		onPhase("scanning new objects");
		scan = await scanObjects(scratch, job.limits?.maxBlobBytes ?? Infinity, job.lfs !== false);
	}
	const sizeBytes = (job.knownSizeBytes ?? 0) + packBytes;
	if (scan.largestBlob > (job.limits?.maxBlobBytes ?? Infinity) || sizeBytes > (job.limits?.maxRepoBytes ?? Infinity)) return null;

	// Work out which changes dropped history, before anything is overwritten.
	const snapshotName = snapshotPlanner(before, ts);
	const snapshots = [];
	const keep = (kind, ref, sha) => {
		const name = snapshotName(kind, ref, sha);
		if (name) snapshots.push({ ref: name, old: ZERO, new: sha });
	};
	for (const [ref, sha] of deleted) keep("deleted", ref, sha);
	for (const [ref, newSha] of changed) {
		const oldSha = before.get(ref);
		if (!oldSha) continue;
		// A moved tag is always a rewrite; a branch only if history was dropped.
		let fastForward = false;
		if (!ref.startsWith("refs/tags/")) {
			fastForward = (await descendsFrom(scratch, scan.commits, newSha, oldSha)) === "yes";
			if (!fastForward && source.api) fastForward = await aheadOnSource(source, oldSha, newSha);
		}
		// When it cannot be settled, keep the old commit: an extra snapshot costs nothing.
		if (!fastForward) keep("rewritten", ref, oldSha);
	}

	// Three separate requests, in this order, and each must succeed before
	// the next is sent. A push applies its ref updates one by one, so a
	// snapshot sharing a request with the deletion it protects could be
	// refused while the deletion went through.
	//   1. snapshots: kept history is safe before anything is removed
	//   2. deletions: clears the way for a reused name (`foo` -> `foo/bar`)
	//   3. updates, with the new objects
	onPhase("pushing to backup");
	if (snapshots.length) {
		const outcome = await pushCommands(target.url, target.authHeader, snapshots);
		const refused = snapshots.find((s) => outcome.get(s.ref));
		if (refused) throw new SyncError("GIT_FAILED", `could not keep ${refused.ref}: ${outcome.get(refused.ref)}`);
	}
	let deleteFailures = 0;
	if (!capabilities.has("delete-refs")) deleteFailures = deleted.length;
	else if (deleted.length) {
		const removals = deleted.map(([ref, sha]) => ({ ref, old: sha, new: ZERO }));
		const outcome = await pushCommands(target.url, target.authHeader, removals);
		for (const r of removals) if (outcome.get(r.ref)) deleteFailures++;
	}
	if (changed.length) {
		const updates = changed.map(([ref, sha]) => ({ ref, old: before.get(ref) ?? ZERO, new: sha }));
		const outcome = await pushCommands(target.url, target.authHeader, updates, wants.length ? packPath : null);
		const refused = updates.filter((u) => outcome.get(u.ref));
		if (refused.length) throw new SyncError("GIT_FAILED", `the backup refused ${refused.length} ref(s), first ${refused[0].ref}: ${outcome.get(refused[0].ref)}`);
	}

	const after = new Map(before);
	for (const s of snapshots) after.set(s.ref, s.new);
	for (const [ref] of deleted) after.delete(ref);
	for (const [ref, sha] of changed) after.set(ref, sha);

	const lfsPath = join(workdir, "lfs.json");
	await writeFile(lfsPath, JSON.stringify(scan.lfs));
	await rm(scratch, { recursive: true, force: true });
	await rm(packPath, { force: true });
	return {
		mode: "incremental",
		transferredBytes: packBytes,
		refs: refCounts(after),
		updated: changed.length,
		deleted: deleted.length,
		deleteFailures,
		newSnapshots: snapshots.map((s) => s.ref),
		sizeBytes,
		oversize: null,
		bundle: null,
		// Only pointers in the new objects; the caller adds them to what it knows.
		lfs: { path: lfsPath, size: (await stat(lfsPath)).size, count: scan.lfs.length, bytes: scan.lfs.reduce((n, o) => n + o.size, 0), incremental: true },
	};
}

/** Asks the source's API whether `tip` only adds to `old`. Any doubt counts as "no". */
async function aheadOnSource(source, old, tip) {
	try {
		const res = await fetch(`${source.api}/compare/${old}...${tip}`, {
			headers: { "User-Agent": "gh-backup", Accept: "application/vnd.github+json", ...(source.authHeader ? { Authorization: source.authHeader } : {}) },
		});
		if (!res.ok) return false;
		const status = (await res.json()).status;
		return status === "ahead" || status === "identical";
	} catch {
		return false;
	}
}

async function syncFull(job, { workdir, onPhase = () => {}, now = new Date(), seedBundle }) {
	const repoDir = join(workdir, "repo.git");
	await rm(workdir, { recursive: true, force: true });
	await mkdir(repoDir, { recursive: true });
	await git(repoDir, ["init", "--bare", "--quiet"]);
	// Keep unreachable objects around; this clone is thrown away anyway.
	await git(repoDir, ["config", "gc.auto", "0"]);

	const { source, target } = job;
	const ts = stamp(now);

	onPhase("fetching existing backup");
	if (seedBundle) await git(repoDir, ["fetch", "--quiet", "--no-tags", seedBundle, "+refs/*:refs/*"]);
	else await git(repoDir, ["fetch", "--quiet", "--no-tags", target.url, "+refs/*:refs/*"], { authHeader: target.authHeader });
	const before = await listRefs(repoDir);

	onPhase("listing source refs");
	const patterns = ["refs/heads/*", "refs/tags/*"];
	if (source.pulls) patterns.push("refs/pull/*/head");
	const upstream = await lsRemote(repoDir, source.url, source.authHeader, patterns);

	const snapshotName = snapshotPlanner(before, ts);
	const snapshots = [];
	const snapshot = async (kind, ref, sha) => {
		const name = snapshotName(kind, ref, sha);
		if (!name) return;
		await git(repoDir, ["update-ref", name, sha]);
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

	return {
		refs: refCounts(after),
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
	const commits = [];
	await git(repoDir, ["cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objecttype) %(objectsize) %(objectname)"], {
		onLine: (line) => {
			if (line.startsWith("commit ")) commits.push(line.split(" ")[2]);
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
	return { largestBlob, lfs: [...lfs.values()], commits };
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
