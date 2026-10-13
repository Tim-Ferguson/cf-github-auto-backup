// Server-rendered dashboard. No client framework: forms post back to the Worker.

import { type Account, isBackedUp, type Repo, type Run } from "./db.ts";
import { metaPrefix } from "./storage.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Html {
	constructor(public value: string) {}
	toString() {
		return this.value;
	}
}

/** Tagged template that escapes every interpolation except nested html``. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
	let out = strings[0];
	values.forEach((v, i) => {
		const parts = Array.isArray(v) ? v : [v];
		out += parts.map((p) => (p instanceof Html ? p.value : p === false || p == null ? "" : esc(p))).join("") + strings[i + 1];
	});
	return new Html(out);
}

const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1c2330; --muted:#667085; --line:#d9dee6; --accent:#f6821f; --ok:#16794c; --bad:#b42318; --warn:#8a5a00; --chip:#eef0f4; --link:#b45309; --merged:#8250df; color-scheme:light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0f1319; --card:#171c25; --text:#e6e9ef; --muted:#98a2b3; --line:#283040; --ok:#4ccf8f; --bad:#ff8a7a; --warn:#f0b849; --chip:#222a37; --link:#f6821f; --merged:#b392f0; color-scheme:dark; } }
:root[data-theme="dark"] { --bg:#0f1319; --card:#171c25; --text:#e6e9ef; --muted:#98a2b3; --line:#283040; --ok:#4ccf8f; --bad:#ff8a7a; --warn:#f0b849; --chip:#222a37; --link:#f6821f; --merged:#b392f0; color-scheme:dark; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1080px; margin:0 auto; padding:24px 16px 64px; }
header.top { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:20px; }
h1 { font-size:20px; margin:0; } h2 { font-size:16px; margin:0; } h3 { font-size:14px; margin:20px 0 8px; }
a { color:inherit; } a.link { color:var(--link); text-decoration:none; } a.link:hover { text-decoration:underline; }
.muted { color:var(--muted); } .small { font-size:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
.row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.spread { justify-content:space-between; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:16px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.tile b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
button, .btn { font:inherit; padding:6px 12px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; text-decoration:none; display:inline-block; }
button.primary, .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
button.on:not(.switch), .btn.on { border-color:var(--accent); color:var(--text); box-shadow:inset 0 -2px 0 var(--accent); }
select { font:inherit; padding:4px 6px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text); max-width:100%; }
form { margin:0; display:inline; }
.scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 10px; border-top:1px solid var(--line); vertical-align:middle; white-space:nowrap; }
th { font-size:12px; color:var(--muted); font-weight:600; border-top:0; }
td.name { white-space:normal; min-width:180px; }
.chip { display:inline-block; font-size:11px; padding:1px 7px; border-radius:99px; background:var(--chip); color:var(--muted); margin-left:4px; }
.ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
.banner { border:1px solid var(--bad); border-radius:10px; padding:12px 16px; margin-bottom:16px; }
.flash { border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:8px; padding:10px 14px; margin-bottom:16px; background:var(--card); }
pre { background:var(--chip); padding:12px; border-radius:8px; overflow-x:auto; margin:8px 0; font:12px/1.5 ui-monospace,Menlo,monospace; }
code { font:12px ui-monospace,Menlo,monospace; }
ol, ul { padding-left:20px; } li { margin:4px 0; }
.filterbar { margin-bottom:16px; } .filterbar input { flex:1 1 220px; max-width:360px; font:inherit; padding:6px 10px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--text); }
.tabs { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid var(--line); margin-bottom:16px; }
.tabs a { padding:8px 12px; text-decoration:none; border-bottom:2px solid transparent; margin-bottom:-1px; color:var(--muted); }
.tabs a:hover { color:var(--text); } .tabs a[aria-current] { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
.topbar { display:flex; align-items:center; gap:12px; margin-bottom:18px; font-size:13px; }
.topbar .brand { font-weight:700; text-decoration:none; } .topbar .grow { flex:1; }
button.ghost { border-color:transparent; background:transparent; color:var(--muted); padding:4px 8px; } button.ghost:hover { color:var(--text); background:var(--chip); }
button:focus-visible, .btn:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
/* An on/off control that is still a plain submit button underneath. */
.switch { position:relative; display:inline-flex; align-items:center; gap:8px; border:0; background:none; padding:4px 2px; color:var(--text); }
.switch::before { content:""; flex:none; width:30px; height:18px; border-radius:99px; background:var(--line); transition:background .12s; }
.switch::after { content:""; position:absolute; left:4px; top:50%; width:12px; height:12px; margin-top:-6px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.35); transition:transform .12s; }
.switch.on::before { background:var(--accent); } .switch.on::after { transform:translateX(12px); }
.auto { display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; padding:10px 0 2px; margin-top:10px; border-top:1px solid var(--line); }
.auto .label { color:var(--muted); font-size:12px; }
input[type=text], input[type=password] { font:inherit; padding:6px 8px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text); width:100%; max-width:320px; }
`;

const DEFAULT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'";

export function page(title: string, body: Html, opts: { status?: number; csp?: string; head?: Html } = {}): Response {
	const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${new Html(CSS)}</style>
<script src="/assets/theme.js"></script>
${opts.head ?? ""}
</head>
<body><main><div class="topbar"><a class="brand" href="/">gh-backup</a><span class="grow"></span><button type="button" class="ghost" data-theme-toggle title="Switch between light, dark and your system setting">Theme</button></div>${body}</main></body>
</html>`;
	return new Response(doc.value, {
		status: opts.status ?? 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": opts.csp ?? DEFAULT_CSP,
			"referrer-policy": "same-origin",
			"x-content-type-options": "nosniff",
		},
	});
}

/** Marks a string as already-safe HTML. Only for markup this Worker built itself. */
export const raw = (value: string): Html => new Html(value);

/** Section navigation shared by every page of one repository. */
export function repoTabs(repo: { id: number; storage: string | null; has_wiki: number }, active: string, counts: Record<string, number> = {}): Html {
	const base = `/repos/${repo.id}`;
	const count = (n: number | undefined) => (n ? html` <span class="chip">${n}</span>` : "");
	const tab = (key: string, href: string, label: unknown) => html`<a href="${href}" ${key === active ? raw(`aria-current="page"`) : ""}>${label}</a>`;
	return html`<nav class="tabs" aria-label="Repository sections">
	${tab("overview", base, "Overview")}
	${repo.storage === "artifacts" ? tab("code", `${base}/code`, "Code") : ""}
	${tab("issues", `${base}/issues`, html`Issues${count(counts.issue)}`)}
	${tab("pulls", `${base}/pulls`, html`Pull requests${count(counts.pull)}`)}
	${tab("releases", `${base}/releases`, html`Releases${count(counts.release)}`)}
	${repo.storage === "artifacts" && repo.has_wiki ? tab("wiki", `${base}/code?wiki=1`, "Wiki") : ""}
</nav>`;
}

export function ago(iso: string | null): string {
	if (!iso) return "never";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 90) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

export function bytes(n: number | null): string {
	if (n == null) return "–";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function messagePage(title: string, text: string, status = 200, action?: { href: string; label: string }): Response {
	return page(
		title,
		html`<div class="card"><h1>${title}</h1><p>${text}</p>${action ? html`<p><a class="btn primary" href="${action.href}">${action.label}</a></p>` : ""}</div>`,
		{ status },
	);
}

export function setupPage(origin: string, state: string, manifest: object): Response {
	return page(
		"Set up gh-backup",
		html`
<div class="card">
	<h1>Set up gh-backup</h1>
	<p>This creates a GitHub App that belongs to you and can only <b>read</b> the repositories you install it on. Its credentials are stored in this Worker's own D1 database and never leave your Cloudflare account.</p>
	<ol>
		<li>GitHub asks you to confirm the app (you can rename it).</li>
		<li>You choose which accounts, organizations and repositories it may read.</li>
		<li>The first backup starts right away, then runs on a schedule and on every push.</li>
	</ol>
	<form method="post" action="https://github.com/settings/apps/new?state=${state}">
		<input type="hidden" name="manifest" value="${JSON.stringify(manifest)}">
		<button class="primary" type="submit">Create the GitHub App</button>
	</form>
	<p class="muted small">Prefer the terminal? <code>npm run cli</code> can connect GitHub with a token from the <code>gh</code> CLI instead, with no app at all.</p>
	<p class="muted small">The app is created as public so that it can also be installed on organizations you belong to. Installations from anyone else show up switched off and are never backed up unless you enable them. The GitHub account that completes this step becomes the owner of this deployment (${origin}).</p>
</div>`,
	);
}

export function loginPage(owner: string | null, methods: { github: boolean }): Response {
	return page(
		"gh-backup",
		html`<div class="card">
	<h1>gh-backup</h1>
	<p>${owner ? html`Sign in to manage the backup of <b>${owner}</b>.` : "Enter the password you chose when deploying to connect GitHub and start backing up."}</p>
	<form method="post" action="/auth/token"><p><label for="password" class="muted small">Password</label><br><input id="password" type="password" name="password" autocomplete="current-password" required autofocus> <button type="submit" class="primary">Sign in</button></p></form>
	${methods.github ? html`<p><a class="btn" href="/auth/login">Sign in with GitHub instead</a></p>` : ""}
	<p class="muted small">Forgot it? Set a new one by updating the <code>ADMIN_PASSWORD</code> secret on this Worker in the Cloudflare dashboard.</p>
</div>`,
	);
}

/** Shown for every request until a usable password secret exists. */
export function lockedPage(minLength: number): Response {
	return page(
		"gh-backup is locked",
		html`<div class="card">
	<h1>This deployment is locked</h1>
	<p>No password has been set, so nobody can use it yet, including whoever finds this address.</p>
	<p>To unlock it, add a secret named <code>ADMIN_PASSWORD</code> (at least ${minLength} characters) to this Worker: in the Cloudflare dashboard open the Worker, then <b>Settings → Variables and Secrets → Add</b>. Or run <code>npm run cli</code> from the project, which sets one for you.</p>
</div>`,
		{ status: 503 },
	);
}

function statusCell(repo: Repo, backedUp: boolean): Html {
	if (repo.gone_at) return html`<span class="warn" title="No longer visible on GitHub since ${repo.gone_at}. The backup is frozen and kept.">gone from GitHub · kept</span>`;
	if (repo.last_status === "running") return html`<span class="muted">syncing…</span>`;
	if (repo.last_status === "error") return html`<span class="bad" title="${repo.last_error}">failed</span>`;
	if (repo.last_status === "ok") return html`<span class="ok">ok</span>`;
	return html`<span class="muted">${backedUp ? "queued" : "–"}</span>`;
}

/** One word per repo for the dashboard filter. */
function filterState(repo: Repo, backedUp: boolean): string {
	if (repo.gone_at) return "gone";
	if (!backedUp) return "off";
	return repo.last_status === "error" ? "error" : "on";
}

/** A switch that posts its opposite value, so it works without any script. */
function toggle(action: string, field: string, on: boolean, label: unknown, title = ""): Html {
	return html`<form method="post" action="${action}"><input type="hidden" name="${field}" value="${on ? "0" : "1"}"><button class="switch ${on ? "on" : ""}" type="submit" role="switch" aria-checked="${on ? "true" : "false"}" title="${title}">${label}</button></form>`;
}

function accountTitle(account: Account): Html {
	if (account.kind === "starred") return html`<h2>★ Starred repositories</h2><span class="chip">public only · git history only</span>`;
	return html`<h2>${account.login}</h2><span class="chip">${account.kind === "Organization" ? "organization" : "user"}</span>${account.suspended ? html`<span class="chip bad">installation suspended</span>` : ""}${account.uninstalled_at ? html`<span class="chip warn">app uninstalled · backups kept</span>` : ""}`;
}

export interface DashboardData {
	origin: string;
	owner: string;
	signedInAs: string;
	/** GitHub App slug, or null when a plain token is used instead. */
	slug: string | null;
	accounts: Account[];
	repos: Repo[];
	config: Record<string, string>;
	flash: string | null;
}

export function dashboardPage(d: DashboardData): Response {
	const byAccount = new Map<string, Repo[]>();
	for (const repo of d.repos) byAccount.set(repo.account, [...(byAccount.get(repo.account) ?? []), repo]);
	const accounts = new Map(d.accounts.map((a) => [a.login, a]));
	const active = d.repos.filter((r) => isBackedUp(r, accounts.get(r.account)));
	const failing = active.filter((r) => r.last_status === "error").length;
	const kept = d.repos.filter((r) => r.gone_at && r.storage).length;
	const size = d.repos.reduce((n, r) => n + (r.size_bytes ?? 0) + r.lfs_bytes, 0);

	const sections = d.accounts.map((account) => {
		const repos = byAccount.get(account.login) ?? [];
		const base = `/accounts/${encodeURIComponent(account.login)}`;
		const rows = repos.map((repo) => {
			const backedUp = isBackedUp(repo, account);
			return html`<tr data-name="${repo.full_name.toLowerCase()}" data-state="${filterState(repo, backedUp)}">
	<td class="name"><a class="link" href="/repos/${repo.id}">${repo.full_name}</a>${repo.private ? html`<span class="chip">private</span>` : ""}${repo.fork ? html`<span class="chip">fork</span>` : ""}${repo.archived ? html`<span class="chip">archived</span>` : ""}${repo.storage === "r2-bundle" ? html`<span class="chip" title="Too large for Artifacts; stored as a git bundle in R2">bundle</span>` : ""}</td>
	<td>${repo.gone_at ? "" : toggle(`/repos/${repo.id}/override`, "override", backedUp, backedUp ? "On" : html`<span class="muted">Off</span>`, `Back up ${repo.full_name}`)}</td>
	<td>${statusCell(repo, backedUp)}</td>
	<td class="muted">${ago(repo.last_success_at)}</td>
	<td class="muted">${bytes(repo.size_bytes === null ? null : repo.size_bytes + repo.lfs_bytes)}</td>
</tr>`;
		});
		return html`<div class="card" data-account>
	<div class="row spread">
		<div class="row">${accountTitle(account)}<span class="muted small">${repos.length} repos</span></div>
		<div class="row">
			<form method="post" action="${base}"><input type="hidden" name="select" value="all"><button type="submit" title="Switch on every repository listed here${account.include_forks ? "" : " except forks"}">Back up all</button></form>
			<form method="post" action="${base}"><input type="hidden" name="select" value="none"><button type="submit" title="Switch off every repository listed here. Existing backups are kept.">Stop all</button></form>
		</div>
	</div>
	<div class="auto">
		${
			account.kind === "starred"
				? toggle(base, "auto_public", account.auto_public === 1, "Back up repositories I star", "Lists your public stars and backs up new ones automatically")
				: html`<span class="label">Automatically import new repos</span>
		${toggle(base, "auto_all", account.auto_public === 1 && account.auto_private === 1, "All", "New public and private repositories are backed up as soon as they appear")}
		${toggle(base, "auto_public", account.auto_public === 1, "Public")}
		${toggle(base, "auto_private", account.auto_private === 1, "Private")}
		${toggle(base, "include_forks", account.include_forks === 1, "Include forks", "Whether automatic import and Back up all also take forks")}`
		}
	</div>
	${repos.length ? html`<div class="scroll"><table><thead><tr><th>Repository</th><th>Backup</th><th>Status</th><th>Last success</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table></div>` : html`<p class="muted small">${account.kind === "starred" ? "Switch on \"Back up repositories I star\" to list and back up your public stars." : "No repositories visible to the app here."}</p>`}
</div>`;
	});

	return page(
		"gh-backup",
		html`
<header class="top">
	<div><h1>gh-backup</h1><span class="muted small">Backing up ${d.owner} · signed in with ${d.signedInAs} · checked GitHub ${ago(d.config.last_discovery_at ?? null)}</span></div>
	<div class="row">
		<form method="post" action="/discover"><button type="submit">Refresh from GitHub</button></form>
		<form method="post" action="/sync-all"><button class="primary" type="submit">Sync everything now</button></form>
		${d.slug ? html`<a class="btn" href="https://github.com/apps/${d.slug}/installations/new">Add account or org</a>` : html`<a class="btn" href="/setup" title="Replace the stored token with a read-only GitHub App that also sends push notifications">Switch to a GitHub App</a>`}
		<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>
	</div>
</header>
${d.flash ? html`<div class="flash">${d.flash}</div>` : ""}
${
	d.config.moved_from && d.slug
		? html`<div class="flash"><b>This backup moved here from ${d.config.moved_from}.</b> Push notifications already point at the new address. To keep "Sign in with GitHub" and "Add account or org" working, open <a class="link" href="https://github.com/settings/apps/${d.slug}">the app's settings on GitHub</a> and set <b>Callback URL</b> to <code>${d.origin}/auth/callback</code> and <b>Setup URL</b> to <code>${d.origin}/setup/installed</code>. Signing in with the password is unaffected.
	<form method="post" action="/dismiss-move"><button type="submit">Done</button></form></div>`
		: ""
}
${d.config.github_error ? html`<div class="banner"><b class="bad">GitHub has been refusing this app since ${d.config.github_error_since}.</b><br>Nothing has been deleted: every backup below is frozen as it was and can still be cloned from Cloudflare.<br><span class="muted small">${d.config.github_error}</span></div>` : ""}
<div class="tiles">
	<div class="tile"><b>${active.length}</b><span class="muted">repos backed up</span></div>
	<div class="tile"><b class="${failing ? "bad" : ""}">${failing}</b><span class="muted">failing</span></div>
	<div class="tile"><b>${kept}</b><span class="muted">kept after leaving GitHub</span></div>
	<div class="tile"><b>${bytes(size)}</b><span class="muted">stored</span></div>
</div>
${
	d.repos.length
		? html`<div class="row filterbar" role="search">
	<input id="q" type="search" placeholder="Filter repositories (press /)" aria-label="Filter repositories" autocomplete="off">
	<button type="button" class="on" data-filter="all">All ${d.repos.length}</button>
	<button type="button" data-filter="on">Backed up ${active.length}</button>
	<button type="button" data-filter="error">Failing ${failing}</button>
	<button type="button" data-filter="off">Off ${d.repos.filter((r) => !r.gone_at && !isBackedUp(r, accounts.get(r.account))).length}</button>
	<button type="button" data-filter="gone">Gone ${d.repos.filter((r) => r.gone_at).length}</button>
	<span id="shown" class="muted small" aria-live="polite"></span>
</div>`
		: ""
}
${sections.length ? sections : html`<div class="card"><p>Nothing here yet. ${d.slug ? html`<a class="link" href="https://github.com/apps/${d.slug}/installations/new">Install the app</a> on your account to start.` : "Use Refresh from GitHub to list your repositories."}</p></div>`}`,
		{ head: html`<script src="/assets/dash.js" defer></script>` },
	);
}

export interface CloneInfo {
	label: string;
	command: string;
	expiresAt: string;
}

export function repoPage(d: { repo: Repo; account: Account | null; runs: Run[]; clones: CloneInfo[] | null; bundles: string[]; flash: string | null; counts: Record<string, number> }): Response {
	const { repo } = d;
	const refs = repo.ref_counts ? (JSON.parse(repo.ref_counts) as Record<string, number>) : null;
	const backedUp = isBackedUp(repo, d.account ?? undefined);
	const runRows = d.runs.map((run) => {
		const detail = run.detail ? (JSON.parse(run.detail) as { error?: string; git?: { updated?: number; newSnapshots?: string[] } | string }) : {};
		const git = typeof detail.git === "object" ? detail.git : null;
		const note = detail.error ?? (detail.git === "unchanged" ? "no new commits; metadata refreshed" : git ? `${git.updated ?? 0} refs updated${git.newSnapshots?.length ? `, ${git.newSnapshots.length} snapshot(s) of rewritten or deleted history kept` : ""}` : "");
		return html`<tr><td>${run.started_at}</td><td>${run.trigger}</td><td class="${run.status === "ok" ? "ok" : run.status === "error" ? "bad" : "muted"}">${run.status}</td><td class="name muted small">${note}</td></tr>`;
	});

	return page(
		repo.full_name,
		html`
<header class="top">
	<div><a class="link small" href="/">← All repositories</a><h1>${repo.full_name}</h1></div>
	<div class="row">
		<form method="post" action="/repos/${repo.id}/sync"><button class="primary" type="submit">Sync now</button></form>
		${repo.gone_at ? "" : html`<a class="btn" href="https://github.com/${repo.full_name}">Open on GitHub</a>`}
	</div>
</header>
${repoTabs(repo, "overview", d.counts)}
${d.flash ? html`<div class="flash">${d.flash}</div>` : ""}
${repo.gone_at ? html`<div class="banner"><b class="warn">This repository has not been visible on GitHub since ${repo.gone_at}.</b><br>Its backup is frozen and kept until you delete it yourself.</div>` : ""}
<div class="tiles">
	<div class="tile"><b>${backedUp ? "on" : "off"}</b><span class="muted">backup</span></div>
	<div class="tile"><b>${ago(repo.last_success_at)}</b><span class="muted">last success</span></div>
	<div class="tile"><b>${refs ? `${refs.heads} / ${refs.tags}` : "–"}</b><span class="muted">branches / tags</span></div>
	<div class="tile"><b>${refs?.snapshots ?? "–"}</b><span class="muted">history snapshots kept</span></div>
	<div class="tile"><b>${bytes(repo.size_bytes)}</b><span class="muted">git data</span></div>
	<div class="tile"><b>${repo.lfs_count}</b><span class="muted">LFS objects (${bytes(repo.lfs_bytes)})</span></div>
</div>
${repo.last_status === "error" ? html`<div class="banner"><b class="bad">Last sync failed</b><pre>${repo.last_error}</pre></div>` : ""}

<div class="card">
	<h2>Restore</h2>
	${
		repo.storage === "artifacts"
			? html`<p>The full history lives in Cloudflare Artifacts as <code>${repo.artifacts_name}</code>. Create a short-lived read token to clone it with plain git.</p>
		<form method="post" action="/repos/${repo.id}/token"><button type="submit">Create a 1-hour clone token</button></form>
		${d.clones ? d.clones.map((c) => html`<h3>${c.label}</h3><pre>${c.command}</pre><p class="muted small">Valid until ${c.expiresAt}. <code>--mirror</code> also brings pull request heads (<code>refs/pull/*</code>) and the retained snapshots of force-pushed or deleted history (<code>refs/backup/*</code>). To move it to a new host: <code>git push --mirror &lt;new remote&gt;</code>.</p>`) : ""}`
			: repo.storage === "r2-bundle"
				? html`<p>This repository exceeds the Artifacts limits (1 GB per repo, 32 MB per file), so each sync stores a complete <code>git bundle</code> in R2. Download the newest one and run <code>git clone --mirror repo.bundle</code>.</p><pre>${d.bundles.length ? d.bundles.join("\n") : "no bundle stored yet"}</pre>`
				: html`<p class="muted">Nothing has been backed up yet.</p>`
	}
	<h3>Where the rest is stored (R2 bucket)</h3>
	<ul class="small">
		<li>Issues, pull requests, reviews, comments, labels, milestones, releases and release assets: <code>${metaPrefix(repo)}</code></li>
		<li>LFS objects: <code>lfs/&lt;first two hex chars&gt;/&lt;oid&gt;</code>, listed per repo in <code>lfs-manifests/${repo.id}.json</code></li>
	</ul>
</div>

<div class="card">
	<h2>Recent runs</h2>
	${d.runs.length ? html`<div class="scroll"><table><thead><tr><th>Started (UTC)</th><th>Trigger</th><th>Result</th><th>Notes</th></tr></thead><tbody>${runRows}</tbody></table></div>` : html`<p class="muted">No runs yet.</p>`}
</div>`,
	);
}

