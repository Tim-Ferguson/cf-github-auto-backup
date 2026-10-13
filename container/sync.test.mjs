// Exercises syncRepo against local bare repos standing in for GitHub and Artifacts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function setup() {
	const root = mkdtempSync(join(tmpdir(), "gh-backup-test-"));
	const source = join(root, "source.git");
	const target = join(root, "target.git");
	const work = join(root, "work");
	git(root, "init", "--bare", "-q", "-b", "main", source);
	git(root, "init", "--bare", "-q", "-b", "main", target);
	git(root, "clone", "-q", source, work);
	git(work, "checkout", "-q", "-b", "main");
	const commit = (file, content, msg = file) => {
		writeFileSync(join(work, file), content);
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", msg);
		return git(work, "rev-parse", "HEAD");
	};
	const run = (extra = {}, now = new Date()) =>
		syncRepo({ source: { url: source }, target: { url: target }, ...extra }, { workdir: join(root, "sync"), now });
	const refs = () =>
		Object.fromEntries(
			git(target, "for-each-ref", "--format=%(refname) %(objectname)")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.split(" ")),
		);
	return { root, source, target, work, commit, run, refs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("mirrors branches and tags, then syncs incrementally", async () => {
	const t = setup();
	try {
		const first = t.commit("a.txt", "one");
		git(t.work, "tag", "v1");
		git(t.work, "push", "-q", "origin", "main", "v1");

		let result = await t.run();
		assert.deepEqual(result.refs, { heads: 1, tags: 1, pulls: 0, snapshots: 0 });
		assert.equal(t.refs()["refs/heads/main"], first);
		assert.equal(t.refs()["refs/tags/v1"], first);

		const second = t.commit("b.txt", "two");
		git(t.work, "push", "-q", "origin", "main");
		result = await t.run();
		assert.equal(result.updated, 1);
		assert.deepEqual(result.newSnapshots, []);
		assert.equal(t.refs()["refs/heads/main"], second);
	} finally {
		t.cleanup();
	}
});

test("force-push keeps the overwritten history under refs/backup", async () => {
	const t = setup();
	try {
		t.commit("a.txt", "one");
		const lost = t.commit("secret.txt", "about to be force-pushed away");
		git(t.work, "push", "-q", "origin", "main");
		await t.run();

		git(t.work, "reset", "-q", "--hard", "HEAD~1");
		const rewritten = t.commit("c.txt", "rewrite");
		git(t.work, "push", "-q", "--force", "origin", "main");

		const result = await t.run({}, new Date("2026-10-13T12:00:00Z"));
		assert.deepEqual(result.newSnapshots, ["refs/backup/rewritten/20261013T120000Z/heads/main"]);
		const refs = t.refs();
		assert.equal(refs["refs/heads/main"], rewritten);
		assert.equal(refs["refs/backup/rewritten/20261013T120000Z/heads/main"], lost);
		assert.equal(git(t.target, "cat-file", "-t", lost), "commit");

		// Syncing again must not snapshot the same commit twice.
		const again = await t.run();
		assert.deepEqual(again.newSnapshots, []);
		assert.equal(again.refs.snapshots, 1);
	} finally {
		t.cleanup();
	}
});

test("deleted branches and tags are retained, and the name can be reused", async () => {
	const t = setup();
	try {
		t.commit("a.txt", "one");
		git(t.work, "checkout", "-q", "-b", "feature");
		const featureTip = t.commit("f.txt", "feature work");
		git(t.work, "tag", "old-tag");
		git(t.work, "push", "-q", "origin", "main", "feature", "old-tag");
		await t.run();

		git(t.work, "push", "-q", "origin", "--delete", "feature", "old-tag");
		git(t.work, "checkout", "-q", "main");
		git(t.work, "branch", "-q", "-D", "feature");
		git(t.work, "checkout", "-q", "-b", "feature/nested");
		t.commit("n.txt", "nested");
		git(t.work, "push", "-q", "origin", "feature/nested");

		const result = await t.run({}, new Date("2026-10-13T12:00:00Z"));
		assert.equal(result.deleted, 2);
		assert.equal(result.deleteFailures, 0);
		const refs = t.refs();
		assert.equal(refs["refs/backup/deleted/20261013T120000Z/heads/feature"], featureTip);
		assert.equal(refs["refs/heads/feature"], undefined);
		assert.ok(refs["refs/heads/feature/nested"]);
		// The tag pointed at the same commit, so one snapshot already covers it.
		assert.equal(result.refs.snapshots, 1);
	} finally {
		t.cleanup();
	}
});

test("a vanished source fails without touching the backup", async () => {
	const t = setup();
	try {
		const tip = t.commit("a.txt", "one");
		git(t.work, "push", "-q", "origin", "main");
		await t.run();

		rmSync(t.source, { recursive: true, force: true });
		await assert.rejects(t.run(), (err) => err.code === "SOURCE_NOT_FOUND" || err.code === "SOURCE_UNREACHABLE");
		assert.equal(t.refs()["refs/heads/main"], tip);
	} finally {
		t.cleanup();
	}
});

test("a source that lost every ref keeps the backup as snapshots", async () => {
	const t = setup();
	try {
		const tip = t.commit("a.txt", "one");
		git(t.work, "push", "-q", "origin", "main");
		await t.run();

		git(t.source, "update-ref", "-d", "refs/heads/main");
		const result = await t.run({}, new Date("2026-10-13T12:00:00Z"));
		assert.equal(result.deleted, 1);
		assert.equal(t.refs()["refs/backup/deleted/20261013T120000Z/heads/main"], tip);
	} finally {
		t.cleanup();
	}
});

test("finds LFS pointers and falls back to a bundle for oversized blobs", async () => {
	const t = setup();
	try {
		const oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
		t.commit("big.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`);
		t.commit("blob.txt", "x".repeat(5000));
		git(t.work, "push", "-q", "origin", "main");

		const result = await t.run({ limits: { maxBlobBytes: 1000 } });
		assert.match(result.oversize, /5000-byte blob/);
		assert.ok(result.bundle.size > 0);
		assert.deepEqual(t.refs(), {}, "oversized repos are not pushed");
		assert.deepEqual(JSON.parse(readFileSync(result.lfs.path, "utf8")), [{ oid, size: 12345 }]);
		assert.match(git(t.root, "bundle", "list-heads", result.bundle.path), /refs\/heads\/main/);
	} finally {
		t.cleanup();
	}
});
