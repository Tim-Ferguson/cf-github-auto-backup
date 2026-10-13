// Exercises the incremental path over real smart-HTTP git servers
// (`git http-backend`), standing in for GitHub and Artifacts.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { syncRepo } from "./sync.mjs";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Serves every bare repo under `root` over smart HTTP, plus a stand-in compare API. */
function serve(root, compare, knobs) {
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname.startsWith("/api/")) {
			const [, old, tip] = /compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url.pathname) ?? [];
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ status: compare(old, tip) }));
		}
		const child = spawn("git", ["http-backend"], {
			env: {
				...ENV,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				REQUEST_METHOD: req.method,
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers["content-type"] ?? "",
				CONTENT_LENGTH: req.headers["content-length"] ?? "",
				GIT_PROTOCOL: knobs.oldProtocolOnly ? "" : (req.headers["git-protocol"] ?? ""),
				REMOTE_USER: "test",
			},
		});
		req.pipe(child.stdin);
		const chunks = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("close", () => {
			const out = Buffer.concat(chunks);
			const split = out.indexOf("\r\n\r\n");
			const head = out.subarray(0, split).toString();
			const status = Number(/^Status: (\d+)/m.exec(head)?.[1] ?? 200);
			const headers = Object.fromEntries(head.split("\r\n").filter((l) => l && !l.startsWith("Status:")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
			const body = out.subarray(split + 4);
			// Flip bytes in the middle of a protocol-v2 pack, as a bad transfer would.
			if (knobs.corruptPack && req.headers["git-protocol"] && url.pathname.endsWith("/git-upload-pack") && body.length > 2000) {
				for (let i = Math.floor(body.length / 2); i < Math.floor(body.length / 2) + 64; i++) body[i] ^= 0xff;
				knobs.corruptPack = false; // one bad transfer; the retry is clean
			}
			res.writeHead(status, headers);
			res.end(body);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "gh-backup-inc-"));
	for (const name of ["source.git", "target.git"]) {
		git(root, "init", "--bare", "-q", "-b", "main", name);
		git(join(root, name), "config", "http.receivepack", "true");
		git(join(root, name), "config", "uploadpack.allowAnySHA1InWant", "true");
	}
	const work = join(root, "work");
	git(root, "clone", "-q", join(root, "source.git"), work);
	git(work, "checkout", "-q", "-b", "main");
	const t = { root, work, source: join(root, "source.git"), target: join(root, "target.git"), ahead: new Set() };
	const server = await serve(root, (old, tip) => (t.ahead.has(`${old} ${tip}`) ? "ahead" : "diverged"), t);
	const base = `http://127.0.0.1:${server.address().port}`;
	t.commit = (file, content) => {
		writeFileSync(join(work, file), content);
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", file);
		return git(work, "rev-parse", "HEAD");
	};
	t.push = (...args) => git(work, "push", "-q", "origin", ...args);
	t.run = (extra = {}, now = new Date()) =>
		syncRepo({ source: { url: `${base}/source.git`, pulls: true, ...extra.source }, target: { url: `${base}/target.git` }, ...extra.job }, { workdir: join(root, "sync"), now });
	t.refs = () =>
		Object.fromEntries(
			git(t.target, "for-each-ref", "--format=%(refname) %(objectname)")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.split(" ")),
		);
	t.api = `${base}/api/repo`;
	t.cleanup = () => {
		server.close();
		server.closeAllConnections();
		rmSync(root, { recursive: true, force: true });
	};
	return t;
}

test("the first sync is full, later ones move only what is new", async () => {
	const t = await setup();
	try {
		// A large file gives the history real weight to (not) re-download.
		t.commit("big.txt", Array.from({ length: 20000 }, (_, i) => `line ${i} ${Math.random()}`).join("\n"));
		t.commit("a.txt", "one");
		t.push("main");

		const first = await t.run();
		assert.equal(first.mode, "full", "an empty backup has nothing to build on");

		const tip = t.commit("b.txt", "two");
		t.push("main");
		const second = await t.run();
		assert.equal(second.mode, "incremental");
		assert.equal(second.fallback, undefined);
		assert.ok(second.transferredBytes > 0 && second.transferredBytes < 2000, `moved ${second.transferredBytes} bytes for one small commit`);
		assert.deepEqual(second.newSnapshots, []);
		assert.equal(t.refs()["refs/heads/main"], tip);
		assert.equal(git(t.target, "fsck", "--full", "--strict"), "", "the backup is complete and intact");

		const third = await t.run();
		assert.equal(third.mode, "incremental");
		assert.equal(third.transferredBytes, 0, "nothing changed, nothing moved");
		assert.equal(third.updated, 0);
	} finally {
		t.cleanup();
	}
});

test("a merge of an old branch moves only the new commits", async () => {
	const t = await setup();
	try {
		t.commit("big.txt", Array.from({ length: 20000 }, (_, i) => `line ${i} ${Math.random()}`).join("\n"));
		const fork = t.commit("a.txt", "one");
		for (let i = 0; i < 5; i++) t.commit(`main-${i}.txt`, String(i));
		t.push("main");
		await t.run();

		// A feature branch from far back, merged and then deleted: the case
		// where a shallow clone would pull the whole history again.
		git(t.work, "checkout", "-q", "-b", "feature", fork);
		t.commit("feature.txt", "feature work");
		git(t.work, "checkout", "-q", "main");
		git(t.work, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
		const tip = git(t.work, "rev-parse", "HEAD");
		t.push("main");

		const result = await t.run();
		assert.equal(result.mode, "incremental");
		assert.ok(result.transferredBytes < 3000, `moved ${result.transferredBytes} bytes, not the history`);
		assert.deepEqual(result.newSnapshots, [], "a merge is a fast-forward");
		assert.equal(t.refs()["refs/heads/main"], tip);
		assert.equal(git(t.target, "fsck", "--full", "--strict"), "");
	} finally {
		t.cleanup();
	}
});

test("force-pushes and deletions are kept, without downloading the backup", async () => {
	const t = await setup();
	try {
		t.commit("a.txt", "one");
		const lost = t.commit("secret.txt", "about to be force-pushed away");
		git(t.work, "branch", "feature");
		git(t.work, "tag", "v1");
		t.push("main", "feature", "v1");
		await t.run();

		git(t.work, "reset", "-q", "--hard", "HEAD~1");
		const rewritten = t.commit("c.txt", "rewrite");
		t.push("--force", "main");
		t.push("--delete", "feature", "v1");
		git(t.work, "branch", "-q", "-D", "feature");
		git(t.work, "checkout", "-q", "-b", "feature/nested");
		const nested = t.commit("n.txt", "nested");
		t.push("feature/nested");

		const result = await t.run({}, new Date("2026-10-13T12:00:00Z"));
		assert.equal(result.mode, "incremental");
		assert.equal(result.fallback, undefined);
		const refs = t.refs();
		assert.equal(refs["refs/heads/main"], rewritten);
		assert.equal(refs["refs/backup/rewritten/20261013T120000Z/heads/main"], lost);
		assert.equal(refs["refs/backup/deleted/20261013T120000Z/heads/feature"], lost);
		assert.equal(refs["refs/backup/deleted/20261013T120000Z/tags/v1"], lost);
		assert.equal(refs["refs/heads/feature"], undefined);
		assert.equal(refs["refs/heads/feature/nested"], nested, "the deleted name was reused as a folder");
		assert.equal(git(t.target, "cat-file", "-t", lost), "commit");
		assert.equal(git(t.target, "fsck", "--full", "--strict"), "");

		const again = await t.run();
		assert.deepEqual(again.newSnapshots, [], "nothing is snapshotted twice");
	} finally {
		t.cleanup();
	}
});

test("a branch moved onto a commit the backup already has asks the source whether history was dropped", async () => {
	const t = await setup();
	try {
		const base = t.commit("a.txt", "one");
		git(t.work, "checkout", "-q", "-b", "feature");
		const tip = t.commit("f.txt", "feature");
		t.push("main", "feature");
		await t.run();

		// main fast-forwards to a commit already backed up: no objects move,
		// so the pack cannot show that nothing was lost.
		git(t.work, "checkout", "-q", "main");
		git(t.work, "merge", "-q", "--ff-only", "feature");
		t.push("main");
		t.ahead.add(`${base} ${tip}`);

		const result = await t.run({ source: { api: t.api } });
		assert.equal(result.mode, "incremental");
		assert.equal(result.transferredBytes, 0);
		assert.deepEqual(result.newSnapshots, [], "the source confirmed a fast-forward");
		assert.equal(t.refs()["refs/heads/main"], tip);
	} finally {
		t.cleanup();
	}
});

test("when it cannot be settled, the old commit is kept", async () => {
	const t = await setup();
	try {
		const base = t.commit("a.txt", "one");
		git(t.work, "checkout", "-q", "-b", "feature");
		t.commit("f.txt", "feature");
		t.push("main", "feature");
		await t.run();
		git(t.work, "checkout", "-q", "main");
		git(t.work, "merge", "-q", "--ff-only", "feature");
		t.push("main");

		// No API to ask (as for a wiki): better one snapshot too many than one too few.
		const result = await t.run({}, new Date("2026-10-13T12:00:00Z"));
		assert.deepEqual(result.newSnapshots, ["refs/backup/rewritten/20261013T120000Z/heads/main"]);
		assert.equal(t.refs()["refs/backup/rewritten/20261013T120000Z/heads/main"], base);
	} finally {
		t.cleanup();
	}
});

test("new LFS pointers are reported, and oversized content falls back to a full sync", async () => {
	const t = await setup();
	try {
		t.commit("a.txt", "one");
		t.push("main");
		await t.run();

		const oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
		t.commit("asset.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 999\n`);
		t.push("main");
		const withLfs = await t.run({ job: { knownSizeBytes: 1000 } });
		assert.equal(withLfs.mode, "incremental");
		assert.equal(withLfs.lfs.incremental, true);
		assert.deepEqual(JSON.parse(readFileSync(withLfs.lfs.path, "utf8")), [{ oid, size: 999 }]);
		assert.ok(withLfs.sizeBytes > 1000, "size grows by what was moved");

		t.commit("huge.txt", "x".repeat(5000));
		t.push("main");
		const big = await t.run({ job: { limits: { maxBlobBytes: 1000 } } });
		assert.equal(big.mode, "full");
		assert.match(big.oversize, /5000-byte blob/);
		assert.ok(big.bundle.size > 0);
	} finally {
		t.cleanup();
	}
});

test("a failure on the incremental path falls back to a full sync", async () => {
	const t = await setup();
	try {
		t.commit("a.txt", "one");
		t.push("main");
		await t.run();
		const tip = t.commit("b.txt", "two");
		t.push("main");

		// The source stops speaking the protocol version the direct fetch
		// needs; ordinary git still works against it.
		t.oldProtocolOnly = true;
		const result = await t.run();
		assert.equal(result.mode, "full");
		assert.match(result.fallback, /source/);
		assert.equal(t.refs()["refs/heads/main"], tip, "the commit is backed up either way");
	} finally {
		t.cleanup();
	}
});

test("a branch is never deleted from the backup unless its snapshot was stored", async () => {
	const t = await setup();
	try {
		t.commit("a.txt", "one");
		git(t.work, "checkout", "-q", "-b", "feature");
		const tip = t.commit("f.txt", "feature work");
		t.push("main", "feature");
		await t.run();

		// The backup refuses snapshot refs but would accept the deletion.
		const hook = join(t.target, "hooks", "update");
		writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/backup/*) echo "snapshots refused" >&2; exit 1;; esac\n', { mode: 0o755 });
		t.push("--delete", "feature");

		await assert.rejects(t.run(), "the sync fails rather than drop the branch");
		assert.equal(t.refs()["refs/heads/feature"], tip, "the branch is still in the backup");
		assert.equal(git(t.target, "cat-file", "-t", tip), "commit");

		// Once snapshots are accepted again, the deletion goes through safely.
		rmSync(hook);
		const result = await t.run({}, new Date("2026-10-13T12:00:00Z"));
		assert.equal(t.refs()["refs/backup/deleted/20261013T120000Z/heads/feature"], tip);
		assert.equal(t.refs()["refs/heads/feature"], undefined);
		assert.equal(result.deleted, 1);
	} finally {
		t.cleanup();
	}
});

test("a corrupt pack from the source is rejected, not relayed", async () => {
	const t = await setup();
	try {
		t.commit("a.txt", "one");
		t.push("main");
		await t.run();
		// Random content, so the pack is large enough to damage in the middle.
		const tip = t.commit("b.txt", Array.from({ length: 6000 }, () => Math.random().toString(36)).join("\n"));
		t.push("main");

		t.corruptPack = true;
		const result = await t.run();
		assert.equal(result.mode, "full", "the damaged transfer was abandoned");
		assert.ok(result.fallback);
		assert.equal(t.refs()["refs/heads/main"], tip);
		assert.equal(git(t.target, "fsck", "--full", "--strict"), "");
	} finally {
		t.cleanup();
	}
});
