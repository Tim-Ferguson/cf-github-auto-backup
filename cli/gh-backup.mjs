#!/usr/bin/env node
// Interactive setup and control for a gh-backup deployment.
//
//   npm run cli              interactive menu (runs setup first if needed)
//   npm run cli -- setup     deploy and connect Cloudflare and GitHub
//   npm run cli -- status | discover | sync | accounts | clone [repo] | open
//
// The deployment is protected by a password that setup uploads as the
// ADMIN_PASSWORD secret in the same deploy, so it is never left unclaimed.
//
// Cloudflare auth comes from `cf auth login` or CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID (environment or .env). GitHub is connected with a
// GitHub App (browser), the `gh` CLI's token, or a pasted token.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(ROOT, ".gh-backup.json");
const ENV_FILE = join(ROOT, ".env");
const CF_BIN = join(ROOT, "node_modules", ".bin", "cf");

const tty = process.stdout.isTTY;
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);

const say = (text = "") => console.log(text);
const step = (text) => say(`\n${bold(text)}`);
const ok = (text) => say(`${green("✓")} ${text}`);
const warn = (text) => say(`${yellow("!")} ${text}`);

class Abort extends Error {}

// --- prompts ---

// One shared reader, so answers piped in on stdin are not lost between prompts.
let reader = null;
let muted = false;
const pendingLines = [];
const waiters = [];

function openReader() {
	if (reader) return;
	const rl = (reader = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY }));
	const write = rl._writeToOutput.bind(rl);
	rl._writeToOutput = (text) => {
		if (!muted) write(text);
	};
	rl.on("line", (line) => (waiters.length ? waiters.shift().resolve(line) : pendingLines.push(line)));
	rl.on("close", () => {
		if (reader === rl) reader = null;
		for (const w of waiters.splice(0)) w.reject(new Abort("input closed"));
	});
	rl.on("SIGINT", () => {
		process.stdout.write("\n");
		process.exit(130);
	});
}

/** Releases stdin, for example before handing the terminal to another program. */
function closeReader() {
	const rl = reader;
	reader = null;
	rl?.close();
}

function nextLine() {
	if (pendingLines.length) return Promise.resolve(pendingLines.shift());
	openReader();
	return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

async function ask(question, { fallback = "" } = {}) {
	openReader();
	process.stdout.write(`${question}${fallback ? dim(` [${fallback}]`) : ""} `);
	return (await nextLine()).trim() || fallback;
}

/** Reads a line without echoing it, so tokens stay out of scrollback. */
async function askSecret(question) {
	openReader();
	process.stdout.write(`${question} `);
	muted = true;
	try {
		return (await nextLine()).trim();
	} finally {
		muted = false;
		if (process.stdin.isTTY) process.stdout.write("\n");
	}
}

async function choose(question, options) {
	say(`\n${question}`);
	options.forEach((o, i) => say(`  ${bold(i + 1)}. ${o.label}${o.hint ? dim(`  ${o.hint}`) : ""}`));
	for (;;) {
		const n = Number(await ask(">", { fallback: "1" }));
		if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
		say(dim(`Enter a number from 1 to ${options.length}.`));
	}
}

const confirm = async (question, yes = true) => /^y/i.test(await ask(`${question} ${dim(yes ? "(Y/n)" : "(y/N)")}`, { fallback: yes ? "y" : "n" }));

// --- processes ---

/** Runs a command. `show` streams its output to the terminal while capturing it. */
function run(cmd, args, { show = false, interactive = false, env } = {}) {
	if (interactive) closeReader();
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
		});
		let out = "";
		const collect = (stream, sink) =>
			stream?.on("data", (d) => {
				out += d;
				if (show) sink.write(d);
			});
		collect(child.stdout, process.stdout);
		collect(child.stderr, process.stderr);
		child.on("error", () => resolve({ code: 127, out }));
		child.on("close", (code) => resolve({ code: code ?? 1, out }));
	});
}

const cf = (args, opts) => run(CF_BIN, args, { ...opts, env: { NODE_NO_WARNINGS: "1", ...opts?.env } });

function openBrowser(url) {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	return run(cmd, [url]);
}

// --- local state ---

function loadState() {
	const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
	return {
		url: process.env.GH_BACKUP_URL ?? state.url ?? null,
		password: process.env.GH_BACKUP_PASSWORD ?? state.password ?? state.adminToken ?? null,
	};
}

function saveState(state) {
	writeFileSync(STATE_FILE, JSON.stringify({ url: state.url, password: state.password }, null, "\t") + "\n", { mode: 0o600 });
	chmodSync(STATE_FILE, 0o600);
}

function readDotEnv() {
	if (!existsSync(ENV_FILE)) return {};
	return Object.fromEntries(
		readFileSync(ENV_FILE, "utf8")
			.split("\n")
			.map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line))
			.filter(Boolean)
			.map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
	);
}

function writeDotEnv(values) {
	const merged = { ...readDotEnv(), ...values };
	writeFileSync(ENV_FILE, Object.entries(merged).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
	chmodSync(ENV_FILE, 0o600);
}

// --- deployment API ---

async function api(state, path, body) {
	const res = await fetch(`${state.url}/api${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { Authorization: `Bearer ${state.password}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({ error: `unexpected response (${res.status})` }));
	if (!res.ok) throw Object.assign(new Error(data.error ?? `request failed (${res.status})`), { status: res.status });
	return data;
}

// --- setup steps ---

async function checkPrerequisites() {
	step("1. Checking this machine");
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 18)) throw new Abort(`Node.js 22.18 or newer is needed (this is ${process.versions.node}).`);
	ok(`Node.js ${process.versions.node}`);

	if (!existsSync(CF_BIN)) {
		say("Installing dependencies…");
		if ((await run("npm", ["install"], { show: true })).code !== 0) throw new Abort("npm install failed.");
	}
	ok("Cloudflare CLI (cf)");

	if ((await run("docker", ["info"])).code !== 0) {
		warn("Docker is not running. It is needed to build the small git container when deploying.");
		say(dim("  Install Docker Desktop (https://docs.docker.com/get-started/get-docker/) or start it, then continue."));
		if (!(await confirm("Is Docker running now?"))) throw new Abort("Start Docker and run setup again.");
		if ((await run("docker", ["info"])).code !== 0) throw new Abort("Docker still is not reachable.");
	}
	ok("Docker");
}

async function cloudflareIdentity() {
	const who = await cf(["auth", "whoami"]);
	try {
		const data = JSON.parse(who.out.slice(who.out.indexOf("{")));
		return data.authenticated === false ? null : data;
	} catch {
		return who.code === 0 ? {} : null;
	}
}

async function connectCloudflare() {
	step("2. Cloudflare");
	const dotenv = readDotEnv();
	if (process.env.CLOUDFLARE_API_TOKEN || dotenv.CLOUDFLARE_API_TOKEN) {
		ok(`Using the API token from ${process.env.CLOUDFLARE_API_TOKEN ? "the environment" : ".env"}`);
		return;
	}
	if (await cloudflareIdentity()) {
		ok("Already signed in with cf");
		return;
	}

	const method = await choose("How do you want to sign in to Cloudflare?", [
		{ value: "browser", label: "Sign in with the browser", hint: "runs `cf auth login`" },
		{ value: "token", label: "Paste an API token", hint: "for servers and CI" },
	]);
	if (method === "browser") {
		if ((await cf(["auth", "login"], { interactive: true })).code !== 0 || !(await cloudflareIdentity())) throw new Abort("Cloudflare sign-in did not complete.");
		ok("Signed in to Cloudflare");
		return;
	}

	say(dim("Create one at https://dash.cloudflare.com/profile/api-tokens with Edit access to:"));
	say(dim("Workers Scripts, D1, R2, Workflows, Containers and Artifacts."));
	const token = await askSecret("API token:");
	const accountId = await ask("Account ID:");
	if (!token || !accountId) throw new Abort("Both the token and the account ID are needed.");
	writeDotEnv({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId });
	ok("Saved to .env (git-ignored, readable only by you)");
}

const MIN_PASSWORD_LENGTH = 12;

async function choosePassword(state) {
	step("3. Password");
	say("The dashboard and this CLI are protected by a password that is set as part of the deploy,");
	say("so the deployment is never open to whoever finds its address first.");
	if (state.password) {
		ok("Using the password saved in .gh-backup.json");
		return;
	}
	const method = await choose("Which password?", [
		{ value: "generate", label: "Generate a strong one", hint: "saved to .gh-backup.json; you can copy it from there" },
		{ value: "own", label: "Choose my own", hint: `at least ${MIN_PASSWORD_LENGTH} characters` },
	]);
	if (method === "generate") {
		state.password = randomBytes(24).toString("base64url");
	} else {
		for (;;) {
			const first = await askSecret("Password:");
			if (first.length < MIN_PASSWORD_LENGTH) {
				warn(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
				continue;
			}
			if ((await askSecret("Again:")) === first) {
				state.password = first;
				break;
			}
			warn("Those did not match.");
		}
	}
	saveState(state);
	ok("Saved to .gh-backup.json (git-ignored, readable only by you)");
}

async function deploy(state) {
	step("4. Deploying to Cloudflare");
	if (state.url && !(await confirm(`Deploy again to ${state.url}?`, true))) return;

	// The password travels in a private temp file, never on a command line.
	const dir = mkdtempSync(join(tmpdir(), "gh-backup-"));
	const secretsFile = join(dir, "secrets.json");
	let result;
	try {
		writeFileSync(secretsFile, JSON.stringify({ ADMIN_PASSWORD: state.password }), { mode: 0o600 });
		result = await cf(["deploy", "--secrets-file", secretsFile], { show: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	if (result.code !== 0) throw new Abort("The deploy failed; see the output above.");
	const found = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i.exec(result.out)?.[0];
	state.url = (await ask("Worker URL:", { fallback: found ?? state.url ?? "" })).replace(/\/+$/, "");
	if (!/^https:\/\//.test(state.url)) throw new Abort("A https:// URL is needed.");
	saveState(state);
}

/** A brand-new Worker can take a few seconds to serve the new version. */
async function waitUntilReady(state) {
	process.stdout.write("Waiting for the deployment to answer");
	let last = "no response";
	for (let i = 0; i < 40; i++) {
		const res = await fetch(`${state.url}/api/status`, { headers: { Authorization: `Bearer ${state.password}` } }).catch(() => null);
		if (res?.ok) {
			say("");
			ok(`Live and password-protected at ${state.url}`);
			return;
		}
		last = res ? `HTTP ${res.status}` : last;
		if (res?.status === 401 && i > 6) break;
		process.stdout.write(".");
		await new Promise((r) => setTimeout(r, 3000));
	}
	say("");
	throw new Abort(
		last === "HTTP 401"
			? `${state.url} does not accept the saved password. If it was deployed elsewhere, set GH_BACKUP_PASSWORD or fix .gh-backup.json.`
			: `${state.url} is not answering (${last}). Check the URL and run setup again.`,
	);
}

async function githubTokenFromGh() {
	if ((await run("gh", ["--version"])).code !== 0) throw new Abort("The GitHub CLI (gh) is not installed. See https://cli.github.com/ or pick another option.");
	if ((await run("gh", ["auth", "status"])).code !== 0) {
		say("You are not signed in to gh yet.");
		if ((await run("gh", ["auth", "login"], { interactive: true })).code !== 0) throw new Abort("gh sign-in did not complete.");
	}
	const token = (await run("gh", ["auth", "token"])).out.trim();
	if (!token) throw new Abort("gh did not return a token.");
	return token;
}

async function connectGitHub(state) {
	step("5. GitHub");
	const status = await api(state, "/status");
	if (status.configured) {
		ok(`Connected as ${status.owner} using ${status.mode === "app" ? `the GitHub App ${status.app_slug}` : "a stored token"}`);
		if (status.mode === "app" || !(await confirm("Replace the stored token?", false))) return;
	}

	const method = await choose("How should the backup read your repositories?", [
		{ value: "app", label: "GitHub App (recommended)", hint: "read-only, syncs on every push, finishes in the browser" },
		{ value: "gh", label: "Token from the gh CLI", hint: "no browser; uses your gh sign-in's access" },
		{ value: "paste", label: "Paste a personal access token", hint: "fine-grained and read-only is best" },
	]);

	if (method === "app") {
		say(`\nOpening ${bold(state.url)}`);
		say(`Sign in there with your password, then click ${bold("Create the GitHub App")}.`);
		say(dim("  The password is in .gh-backup.json if you need to copy it."));
		await openBrowser(state.url);
		await ask("Press Enter here once the app is installed");
		const after = await api(state, "/status");
		if (!after.configured) throw new Abort("The GitHub App is not set up yet. Finish it in the browser and run setup again.");
		ok(`Connected as ${after.owner}`);
		await api(state, "/discover", {}).catch(() => {});
		return;
	}

	if (method === "gh") {
		warn("The gh token can do whatever your gh sign-in can, including write. It is stored in your D1 database.");
		say(dim("  It also stops working if you run `gh auth logout`. There are no push notifications in this mode; syncs run every 6 hours."));
		if (!(await confirm("Continue?"))) return connectGitHub(state);
	} else {
		say(dim("Create one at https://github.com/settings/personal-access-tokens with read-only access to"));
		say(dim("Contents, Metadata, Issues and Pull requests for the repositories you want backed up."));
	}
	const token = method === "gh" ? await githubTokenFromGh() : await askSecret("GitHub token:");
	const result = await api(state, "/github-token", { token });
	ok(`Connected as ${result.owner}: ${result.repos} repositories found, ${result.queued} sync(s) started`);
}

async function setup(state) {
	say(bold("gh-backup setup"));
	say(dim("Backs up your GitHub repositories into your own Cloudflare account."));
	await checkPrerequisites();
	await connectCloudflare();
	await choosePassword(state);
	await deploy(state);
	await waitUntilReady(state);
	await connectGitHub(state);

	step("6. What to back up");
	say("Your own non-fork repositories are on. Organizations, forks and starred repos are off until you switch them on.");
	if (await confirm("Review that now?")) await accounts(state);

	step("Done");
	say(`Dashboard: ${bold(state.url)}`);
	say(`Run ${bold("npm run cli")} any time to check status, change what is backed up, or restore.`);
}

// --- everyday commands ---

const ago = (iso) => {
	if (!iso) return "never";
	const s = (Date.now() - Date.parse(iso)) / 1000;
	return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const accountLabel = (a) => (a.kind === "starred" ? "★ starred repositories" : `${a.login} ${dim(a.kind === "Organization" ? "(org)" : "(user)")}`);

function repoState(r) {
	if (r.gone_at) return yellow("gone from GitHub, kept");
	if (!r.backed_up) return dim("off");
	if (r.last_status === "error") return red("failed");
	if (r.last_status === "running") return "syncing";
	if (r.last_status === "ok") return green("ok");
	return dim("queued");
}

async function status(state) {
	const s = await api(state, "/status");
	if (!s.configured) return warn("GitHub is not connected yet. Run: npm run cli -- setup");
	say(`\n${bold(s.owner)} ${dim(`· ${s.mode === "app" ? "GitHub App" : "token"} · checked GitHub ${ago(s.last_discovery_at)} · ${state.url}`)}`);
	if (s.github_error) say(red(`GitHub has refused requests since ${s.github_error_since}. Existing backups are frozen and safe.\n  ${s.github_error}`));

	for (const account of s.accounts) {
		const repos = s.repos.filter((r) => r.account === account.login);
		const on = repos.filter((r) => r.backed_up).length;
		say(`\n${bold(accountLabel(account))}  ${account.enabled ? green("backup on") : dim("backup off")}${account.kind === "starred" ? "" : account.include_forks ? ", forks included" : dim(", forks excluded")}  ${dim(`${on}/${repos.length} repos`)}`);
		const shown = repos.filter((r) => r.backed_up || r.gone_at || r.storage);
		const width = Math.min(48, Math.max(0, ...shown.map((r) => r.full_name.length)));
		for (const r of shown) say(`  ${r.full_name.padEnd(width)}  ${repoState(r)}  ${dim(ago(r.last_success_at))}`);
		for (const r of shown.filter((r) => r.last_status === "error" && r.backed_up)) say(red(`  ${r.full_name}: ${String(r.last_error).split("\n")[0].slice(0, 160)}`));
	}
	const active = s.repos.filter((r) => r.backed_up);
	say(`\n${active.length} backed up, ${active.filter((r) => r.last_status === "error").length} failing, ${s.repos.filter((r) => r.gone_at && r.storage).length} kept after leaving GitHub`);
}

async function accounts(state) {
	for (;;) {
		const s = await api(state, "/status");
		const picked = await choose("What should be backed up?", [
			...s.accounts.map((a) => ({
				value: a,
				label: accountLabel(a),
				hint: `${a.enabled ? "on" : "off"}${a.kind === "starred" ? "" : a.include_forks ? ", with forks" : ", no forks"} · ${s.repos.filter((r) => r.account === a.login).length} repos`,
			})),
			{ value: "repo", label: "Override a single repository", hint: "always or never, regardless of its account" },
			{ value: null, label: "Done" },
		]);
		if (picked === null) return;

		if (picked === "repo") {
			const term = (await ask("Part of the repository name:")).toLowerCase();
			const matches = s.repos.filter((r) => r.full_name.toLowerCase().includes(term)).slice(0, 15);
			if (!matches.length) {
				warn("No repository matches that.");
				continue;
			}
			const repo = await choose("Which one?", matches.map((r) => ({ value: r, label: r.full_name, hint: r.override === null ? "follows account" : r.override ? "always" : "never" })));
			const override = await choose(`Back up ${repo.full_name}?`, [
				{ value: null, label: "Follow its account's setting" },
				{ value: 1, label: "Always" },
				{ value: 0, label: "Never" },
			]);
			await api(state, `/repos/${repo.id}`, { override });
			ok("Saved");
			continue;
		}

		const options = [{ value: { enabled: !picked.enabled }, label: picked.enabled ? "Stop backing it up" : "Back it up" }];
		if (picked.kind !== "starred") options.push({ value: { include_forks: !picked.include_forks }, label: picked.include_forks ? "Exclude its forks" : "Include its forks" });
		options.push({ value: null, label: "Back" });
		const change = await choose(accountLabel(picked), options);
		if (!change) continue;
		const result = await api(state, `/accounts/${encodeURIComponent(picked.login)}`, change);
		ok(`Saved; ${result.queued} sync(s) started`);
	}
}

async function findRepo(state, term) {
	const s = await api(state, "/status");
	const query = (term ?? (await ask("Part of the repository name:"))).toLowerCase();
	const matches = s.repos.filter((r) => r.full_name.toLowerCase().includes(query));
	const exact = matches.find((r) => r.full_name.toLowerCase() === query);
	if (exact) return exact;
	if (!matches.length) throw new Abort("No repository matches that.");
	if (matches.length === 1) return matches[0];
	return choose("Which one?", matches.slice(0, 15).map((r) => ({ value: r, label: r.full_name })));
}

async function clone(state, term) {
	const repo = await findRepo(state, term);
	const result = await api(state, `/repos/${repo.id}/clone-token`, {});
	if (result.storage === "r2-bundle") {
		return say(`${repo.full_name} is too large for Artifacts. Its git bundles are in the R2 bucket under bundles/${repo.id}/ ; restore with: git clone --mirror <file>`);
	}
	if (!result.clones.length) return warn(`${repo.full_name} has no backup to clone yet.`);
	for (const c of result.clones) say(`\n${bold(c.label)} ${dim(`(token valid until ${c.expiresAt})`)}\n${c.command}`);
	say(dim("\n--mirror also brings pull request heads and the kept snapshots of rewritten or deleted history."));
}

const COMMANDS = {
	setup,
	status,
	accounts,
	clone,
	discover: async (state) => {
		const r = await api(state, "/discover", {});
		ok(`${r.repos} repositories across ${r.accounts} account(s); ${r.queued} sync(s) started`);
	},
	sync: async (state, term) => {
		if (term) {
			const repo = await findRepo(state, term);
			await api(state, `/repos/${repo.id}/sync`, {});
			return ok(`Sync started for ${repo.full_name}`);
		}
		ok(`${(await api(state, "/sync-all", {})).queued} sync(s) started`);
	},
	open: async (state) => {
		say(`${state.url}\nPassword: ${state.password}`);
		await openBrowser(state.url);
	},
};

async function menu(state) {
	for (;;) {
		const action = await choose(bold("gh-backup"), [
			{ value: "status", label: "Show status" },
			{ value: "accounts", label: "Choose what gets backed up", hint: "accounts, orgs, forks, single repos" },
			{ value: "sync", label: "Sync everything now" },
			{ value: "discover", label: "Refresh the repository list from GitHub" },
			{ value: "clone", label: "Get a clone command to restore a repository" },
			{ value: "open", label: "Open the dashboard" },
			{ value: "setup", label: "Run setup again", hint: "redeploy or reconnect" },
			{ value: null, label: "Quit" },
		]);
		if (!action) return;
		try {
			await COMMANDS[action](state);
		} catch (err) {
			if (err instanceof Abort && /cancelled|input closed/.test(err.message)) throw err;
			say(red(err.message));
		}
	}
}

async function main() {
	const [command, arg] = process.argv.slice(2);
	const state = loadState();
	if (command === "help" || command === "--help" || command === "-h") {
		return say("Usage: npm run cli [-- setup | status | accounts | discover | sync [repo] | clone [repo] | open]");
	}
	if (command && !COMMANDS[command]) throw new Abort(`Unknown command "${command}". Try: npm run cli -- help`);

	const ready = state.url && state.password;
	if (command === "setup" || !ready) {
		if (command && command !== "setup") throw new Abort("Not set up yet. Run: npm run cli -- setup  (or set GH_BACKUP_URL and GH_BACKUP_PASSWORD)");
		await setup(state);
		if (command) return;
	}
	if (command) return COMMANDS[command](state, arg);
	await menu(state);
}

main()
	.catch((err) => {
		if (!(err instanceof Abort)) console.error(err);
		else if (!/cancelled|input closed/.test(err.message)) console.error(red(err.message));
		process.exitCode = 1;
	})
	.finally(closeReader);
