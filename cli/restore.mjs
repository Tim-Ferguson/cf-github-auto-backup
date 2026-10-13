// Restores one backed-up repository to a new home on GitHub, using whatever
// account the `gh` CLI is signed in to: git history, kept snapshots, LFS
// objects, wiki, issues, pull request discussions and releases.
//
// What GitHub cannot take back is said plainly at the end: pull requests
// return as closed issues, and everything is authored by the restoring account.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const WRITE_PAUSE_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exec(cmd, args, { cwd, env, input } = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", () => resolve({ code: 127, out, err }));
		child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
		if (input !== undefined) child.stdin.end(input);
	});
}

/** Credentials reach git through the environment, never the command line. */
const gitAuth = (user, secret) => ({
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "http.extraHeader",
	GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`,
});

/** Splits a clone command from the API into a clean URL and its token. */
function parseClone(command) {
	const url = new URL(command.split(" ").pop());
	const secret = decodeURIComponent(url.password);
	url.username = "";
	url.password = "";
	return { url: url.toString(), env: gitAuth("x", secret) };
}

/** Keeps restored text from notifying the people it mentions. */
const quiet = (text) => (text ?? "").replace(/(^|[^\w`/])@(?=[a-z0-9])/gi, "$1@<!-- -->");
const day = (iso) => (iso ? iso.slice(0, 10) : "an unknown date");

export async function restore(ctx, args) {
	const { state, api, say, step, ok, warn, ask, confirm, findRepo, Abort, dim, bold } = ctx;
	const flags = new Set(args.filter((a) => a.startsWith("--")));
	const positional = args.filter((a) => !a.startsWith("--"));
	const toIndex = args.indexOf("--to");
	const explicitTarget = toIndex >= 0 ? args[toIndex + 1] : null;
	const term = positional.find((p) => p !== explicitTarget);

	for (const tool of ["git", "gh"]) {
		if ((await exec(tool, ["--version"])).code !== 0) throw new Abort(`${tool} is needed for a restore${tool === "gh" ? " (https://cli.github.com/)" : ""}.`);
	}
	const login = (await exec("gh", ["api", "user", "-q", ".login"])).out.trim();
	if (!login) throw new Abort("Sign in to the destination GitHub account first: gh auth login");
	const ghToken = (await exec("gh", ["auth", "token"])).out.trim();

	const repo = await findRepo(state, term);
	if (repo.storage !== "artifacts") {
		throw new Abort(repo.storage === "r2-bundle" ? `${repo.full_name} is stored as a git bundle (bundles/${repo.id}/ in R2). Restore it by hand: git clone --mirror <bundle>, then push.` : `${repo.full_name} has no backup to restore yet.`);
	}
	const target = explicitTarget ?? (flags.has("--yes") ? `${login}/${repo.full_name.split("/")[1]}` : await ask("Restore to (owner/name):", { fallback: `${login}/${repo.full_name.split("/")[1]}` }));
	if (!/^[\w.-]+\/[\w.-]+$/.test(target)) throw new Abort("The destination must look like owner/name.");
	const isPublic = flags.has("--public") || (!flags.has("--private") && !repo.private && !flags.has("--yes") && !flags.has("--dry-run") && (await confirm("The original was public. Make the restored copy public too?", false)));
	const withIssues = !flags.has("--skip-issues");
	const withReleases = !flags.has("--skip-releases");
	const dryRun = flags.has("--dry-run");

	if (dryRun) say(`\nDry run: nothing will be created on GitHub. The destination would be ${bold(target)}, as ${bold(login)}.`);
	else {
		say(`\nThis will create ${bold(target)} (${isPublic ? "public" : "private"}) as ${bold(login)} and push the backup of ${bold(repo.full_name)} into it.`);
		if (!flags.has("--yes") && !(await confirm("Go ahead?"))) return;
	}

	const gh = async (method, path, body) => {
		for (let attempt = 0; ; attempt++) {
			const res = await exec("gh", ["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], { input: body === undefined ? undefined : JSON.stringify(body) });
			if (res.code === 0) return res.out ? JSON.parse(res.out) : null;
			// GitHub throttles bursts of content creation; wait it out.
			if (/rate limit|abuse|secondary/i.test(res.err + res.out) && attempt < 6) {
				warn(`GitHub asked to slow down; waiting ${60 * (attempt + 1)} seconds…`);
				await sleep(60_000 * (attempt + 1));
				continue;
			}
			throw Object.assign(new Error((res.err || res.out).trim().split("\n").pop()), { output: res.err + res.out });
		}
	};
	const download = async (path, file) => {
		const res = await fetch(`${state.url}/api${path}`, { headers: { Authorization: `Bearer ${state.password}` } });
		if (!res.ok || !res.body) throw new Error(`download of ${path} failed (${res.status})`);
		mkdirSync(dirname(file), { recursive: true });
		await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
	};
	const fetchJson = async (key) => {
		const res = await fetch(`${state.url}/api/repos/${repo.id}/file?key=${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${state.password}` } });
		return res.ok ? res.json() : null;
	};
	const listFiles = async (prefix) => {
		const files = [];
		for (let cursor = null; ; ) {
			const page = await api(state, `/repos/${repo.id}/files?prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			files.push(...page.files);
			if (!(cursor = page.cursor)) return files;
		}
	};

	const work = mkdtempSync(join(tmpdir(), "gh-backup-restore-"));
	const done = [];
	const notes = [];
	try {
		step("1. Fetching the backup from Cloudflare");
		const { clones } = await api(state, `/repos/${repo.id}/clone-token`, {});
		const code = clones.find((c) => c.label === "Repository");
		if (!code) throw new Abort("The backup could not be opened.");
		const source = parseClone(code.command);
		const mirror = join(work, "repo.git");
		let res = await exec("git", ["clone", "--mirror", "--quiet", source.url, mirror], { env: source.env });
		if (res.code !== 0) throw new Abort(`Cloning the backup failed: ${res.err.trim()}`);
		const refs = (await exec("git", ["for-each-ref", "--format=%(refname)"], { cwd: mirror })).out.split("\n").filter(Boolean);
		const count = (prefix) => refs.filter((r) => r.startsWith(prefix)).length;
		ok(`${count("refs/heads/")} branches, ${count("refs/tags/")} tags, ${count("refs/backup/")} kept snapshots`);

		if (dryRun) {
			const issues = await listFiles("issues/");
			const releases = await listFiles("releases/");
			const lfs = await api(state, `/repos/${repo.id}/lfs`);
			const exists = (await exec("gh", ["api", `repos/${target}`])).code === 0;
			step("A real run would");
			say(`  create ${target}${exists ? "  (it already exists, so the run would stop here)" : ""}`);
			say(`  push ${count("refs/heads/")} branches, ${count("refs/tags/")} tags and ${count("refs/backup/")} kept snapshots`);
			if (lfs.length) say(`  upload ${lfs.length} LFS objects`);
			if (clones.some((c) => c.label === "Wiki")) say("  push the wiki");
			if (withIssues && issues.length) say(`  recreate ${issues.length} issues and pull request discussions, about ${Math.ceil((issues.length * 3 * WRITE_PAUSE_MS) / 60000)} minute(s) or more`);
			if (withReleases && releases.length) say(`  recreate ${releases.length} releases`);
			if (count("refs/pull/")) say(dim(`  leave ${count("refs/pull/")} pull request heads in the backup only`));
			return;
		}

		step("2. Creating the repository on GitHub");
		const [owner, name] = target.split("/");
		try {
			await gh("POST", owner === login ? "user/repos" : `orgs/${owner}/repos`, { name, private: !isPublic, has_issues: true, has_wiki: true, description: `Restored from a backup of ${repo.full_name}` });
		} catch (err) {
			throw new Abort(/already exists/i.test(err.output ?? "") ? `${target} already exists. Pick another name with --to owner/name, or delete it first.` : `Could not create ${target}: ${err.message}`);
		}
		ok(`https://github.com/${target}`);

		step("3. Pushing history");
		const dest = `https://github.com/${target}.git`;
		const destEnv = gitAuth("x-access-token", ghToken);
		// GitHub refuses refs/pull/*, and only shows branches and tags, so the
		// kept snapshots go up as branches named backup/….
		res = await exec("git", ["push", "--quiet", dest, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*", "+refs/backup/*:refs/heads/backup/*"], { cwd: mirror, env: destEnv });
		if (res.code !== 0) throw new Abort(`Pushing to ${target} failed: ${res.err.trim()}`);
		if (repo.default_branch && refs.includes(`refs/heads/${repo.default_branch}`)) await gh("PATCH", `repos/${target}`, { default_branch: repo.default_branch }).catch(() => {});
		ok("Branches and tags pushed");
		done.push(`${count("refs/heads/")} branches and ${count("refs/tags/")} tags`);
		if (count("refs/backup/")) done.push(`${count("refs/backup/")} kept snapshots, as branches named backup/…`);
		if (count("refs/pull/")) notes.push(`${count("refs/pull/")} pull request heads stay in the backup only: GitHub does not accept refs/pull/* from outside.`);

		const manifest = await api(state, `/repos/${repo.id}/lfs`);
		if (manifest.length) {
			step(`LFS: ${manifest.length} objects`);
			if ((await exec("git", ["lfs", "version"])).code !== 0) {
				notes.push(`${manifest.length} LFS objects were not restored because git-lfs is not installed. They remain in the backup.`);
				warn("git-lfs is not installed; skipping LFS objects.");
			} else {
				for (const { oid } of manifest) await download(`/lfs/${oid}`, join(mirror, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid));
				res = await exec("git", ["lfs", "push", "--all", dest], { cwd: mirror, env: destEnv });
				if (res.code === 0) done.push(`${manifest.length} LFS objects`);
				else notes.push(`Uploading LFS objects failed: ${res.err.trim().split("\n").pop()}`);
			}
		}

		const wiki = clones.find((c) => c.label === "Wiki");
		if (wiki) {
			step("Wiki");
			const wikiSource = parseClone(wiki.command);
			const wikiMirror = join(work, "wiki.git");
			res = await exec("git", ["clone", "--mirror", "--quiet", wikiSource.url, wikiMirror], { env: wikiSource.env });
			const pushWiki = () => exec("git", ["push", "--quiet", `https://github.com/${target}.wiki.git`, "+refs/heads/*:refs/heads/*"], { cwd: wikiMirror, env: destEnv });
			if (res.code === 0) res = await pushWiki();
			if (res.code !== 0 && !flags.has("--yes")) {
				say(`GitHub only creates a wiki's storage once it has a first page.\nCreate any page at ${bold(`https://github.com/${target}/wiki`)} (it will be replaced), then come back.`);
				if (await confirm("Done? Retry the wiki now?")) res = await pushWiki();
			}
			if (res.code === 0) done.push("the wiki");
			else notes.push(`The wiki was not restored. Create a first page at https://github.com/${target}/wiki and run the restore of the wiki again, or clone it from the dashboard.`);
		}

		if (withIssues) {
			const issueFiles = (await listFiles("issues/")).map((f) => Number(/issues\/(\d+)\.json$/.exec(f.key)?.[1])).filter(Boolean).sort((a, b) => a - b);
			if (issueFiles.length) {
				step(`4. Issues and pull request discussions (${issueFiles.length})`);
				say(dim("Numbers are kept so #references still point at the right thing. This is slow on purpose: GitHub throttles bulk creation."));
				for (const file of await listFiles("labels/")) {
					const label = await fetchJson(file.key);
					if (label) await gh("POST", `repos/${target}/labels`, { name: label.name, color: label.color, description: label.description ?? "" }).catch(() => {});
				}
				let restored = 0;
				const wanted = new Set(issueFiles);
				for (let n = 1; n <= issueFiles[issueFiles.length - 1]; n++) {
					const issue = wanted.has(n) ? await fetchJson(`issues/${n}.json`) : null;
					if (!issue) {
						// A deleted issue left a gap; fill it so later numbers line up.
						const filler = await gh("POST", `repos/${target}/issues`, { title: `(number ${n} was not in the backup)`, body: "Placeholder that keeps issue numbers aligned with the original repository." });
						await gh("PATCH", `repos/${target}/issues/${filler.number}`, { state: "closed" });
						await sleep(WRITE_PAUSE_MS);
						continue;
					}
					const pull = issue.pull_request ? await fetchJson(`pulls/${n}.json`) : null;
					const header = pull
						? `> **Restored pull request.** Originally opened by **${issue.user?.login ?? "unknown"}** on ${day(issue.created_at)}, \`${pull.head?.label ?? pull.head?.ref ?? "?"}\` into \`${pull.base?.ref ?? "?"}\`. It was ${pull.merged_at ? `merged on ${day(pull.merged_at)}` : issue.state === "open" ? "still open" : "closed without merging"}.`
						: `> Originally opened by **${issue.user?.login ?? "unknown"}** on ${day(issue.created_at)}.`;
					const created = await gh("POST", `repos/${target}/issues`, {
						title: `${pull ? "[PR] " : ""}${issue.title}`,
						body: `${header}\n\n${quiet(issue.body)}`,
						labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
					});
					if (created.number !== n) notes.push(`Issue #${n} was restored as #${created.number}; numbering drifted from there on.`);
					await sleep(WRITE_PAUSE_MS);

					const comments = [];
					for (const f of await listFiles(`issue-comments/${n}/`)) {
						const c = await fetchJson(f.key);
						if (c) comments.push({ at: c.created_at, body: `> **${c.user?.login ?? "unknown"}** commented on ${day(c.created_at)}:\n\n${quiet(c.body)}` });
					}
					if (pull) {
						for (const f of await listFiles(`pull-comments/${n}/`)) {
							const c = await fetchJson(f.key);
							if (c) comments.push({ at: c.created_at, body: `> **${c.user?.login ?? "unknown"}** commented on \`${c.path}\` on ${day(c.created_at)}:\n\n${c.diff_hunk ? `\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n\n` : ""}${quiet(c.body)}` });
						}
						for (const r of (await fetchJson(`pull-reviews/${n}.json`)) ?? []) {
							if (r.body) comments.push({ at: r.submitted_at ?? "", body: `> **${r.user?.login ?? "unknown"}** reviewed (${String(r.state).toLowerCase().replace(/_/g, " ")}) on ${day(r.submitted_at)}:\n\n${quiet(r.body)}` });
						}
					}
					for (const comment of comments.sort((a, b) => a.at.localeCompare(b.at))) {
						await gh("POST", `repos/${target}/issues/${created.number}/comments`, { body: comment.body });
						await sleep(WRITE_PAUSE_MS);
					}
					if (issue.state !== "open") await gh("PATCH", `repos/${target}/issues/${created.number}`, { state: "closed" });
					restored++;
					process.stdout.write(`\r  ${restored}/${issueFiles.length}`);
				}
				say("");
				done.push(`${restored} issues and pull request discussions`);
				notes.push("Pull requests came back as closed issues titled [PR] …, holding the original description, reviews and comments. Their code is in the history.");
			}
		}

		if (withReleases) {
			const releases = [];
			for (const f of await listFiles("releases/")) {
				const r = await fetchJson(f.key);
				if (r) releases.push(r);
			}
			if (releases.length) {
				step(`5. Releases (${releases.length})`);
				let assets = 0;
				for (const r of releases.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
					const created = await gh("POST", `repos/${target}/releases`, { tag_name: r.tag_name, name: r.name ?? r.tag_name, body: quiet(r.body), draft: r.draft, prerelease: r.prerelease });
					for (const asset of r.assets ?? []) {
						const file = join(work, "assets", String(asset.id), asset.name);
						await download(`/repos/${repo.id}/file?key=${encodeURIComponent(`release-assets/${asset.id}/${asset.name}`)}`, file);
						const up = await exec("gh", ["release", "upload", created.tag_name, file, "--repo", target]);
						if (up.code === 0) assets++;
						else notes.push(`Asset ${asset.name} of release ${r.tag_name} was not uploaded.`);
					}
					await sleep(WRITE_PAUSE_MS);
				}
				done.push(`${releases.length} releases with ${assets} assets`);
			}
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	step("Restored");
	say(`https://github.com/${target}`);
	for (const line of done) ok(line);
	say(dim("\nNot restored, because GitHub has no way to import them:"));
	for (const line of [
		...notes,
		"Everything is authored by you; original authors and dates are written into each item instead.",
		"Stars, watchers, forks, reactions, milestones, assignees, projects, settings, secrets, webhooks and Actions history.",
	]) {
		say(dim(`  - ${line}`));
	}
}
