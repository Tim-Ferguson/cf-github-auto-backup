// Read-only code browser over the Artifacts copy of a repository: file tree,
// file view with syntax highlighting, rendered READMEs and commit history.
//
// Everything shown here comes from repository content, which is untrusted.
// These pages therefore use a stricter CSP than the dashboard (no inline
// script, no forms), and raw files are served sandboxed.

import darkTheme from "@highlightjs/cdn-assets/styles/github-dark.min.css?raw";
import lightTheme from "@highlightjs/cdn-assets/styles/github.min.css?raw";
import highlightJs from "@highlightjs/cdn-assets/highlight.min.js?raw";
import type { Repo } from "./db.ts";
import { type LinkContext, renderMarkdown } from "./markdown.ts";
import { ago, bytes, html, messagePage, page, raw, repoTabs } from "./ui.ts";

export const CODE_CSP = "default-src 'none'; style-src 'unsafe-inline' 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const RAW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const MAX_VIEW_BYTES = 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const MAX_AUTODETECT_BYTES = 40 * 1024;
const MAX_REFS_PER_GROUP = 300;
const COMMITS_PER_PAGE = 30;
const REFS_CACHE_SECONDS = 60;

const CLIENT_JS = `
(function () {
	var pane = document.getElementById("pane");
	var tree = document.getElementById("tree");

	function highlight(root) {
		root.querySelectorAll("pre code").forEach(function (el) {
			if (el.hasAttribute("data-plain") || el.dataset.highlighted) return;
			var lang = (el.className.match(/language-([\\w+#-]+)/) || [])[1];
			if (lang && !hljs.getLanguage(lang)) el.className = "";
			if (!lang && !el.hasAttribute("data-auto")) return;
			hljs.highlightElement(el);
		});
	}
	highlight(document);

	document.addEventListener("change", function (e) {
		if (e.target.matches && e.target.matches("select[data-nav]")) location.href = e.target.value;
	});
	if (!pane || !tree) return;

	function here() { return location.pathname + location.search; }
	function linkFor(target) {
		var found = null;
		tree.querySelectorAll("a").forEach(function (a) { if (a.getAttribute("href") === target) found = a; });
		return found;
	}
	function mark() {
		// On a first load the server has already marked the current entry.
		var a = linkFor(here()) || tree.querySelector("[aria-current]");
		tree.querySelectorAll("[aria-current]").forEach(function (el) { el.removeAttribute("aria-current"); });
		if (a) { a.setAttribute("aria-current", "page"); if (a.scrollIntoView) a.scrollIntoView({ block: "nearest" }); }
	}

	// Swap the right-hand pane for the one in the fetched page.
	function load(href, push) {
		pane.classList.add("loading");
		return fetch(href, { credentials: "same-origin" })
			.then(function (res) { return res.text(); })
			.then(function (text) {
				var doc = new DOMParser().parseFromString(text, "text/html");
				var next = doc.getElementById("pane");
				if (!next) { location.href = href; return; }
				pane.innerHTML = next.innerHTML;
				document.title = doc.title;
				if (push) history.pushState({}, "", href);
				// Keep the tree in step: open the folder just entered, or take the
				// server's tree when the jump went somewhere not opened yet.
				var nextTree = doc.getElementById("tree");
				var target = linkFor(here());
				if (!target && nextTree) tree.innerHTML = nextTree.innerHTML;
				else if (target && target.dataset.tree && target.getAttribute("aria-expanded") !== "true") toggle(target);
				highlight(pane);
				mark();
				pane.classList.remove("loading");
				window.scrollTo(0, 0);
			})
			.catch(function () { location.href = href; });
	}

	function toggle(a) {
		var li = a.parentNode;
		var list = li.querySelector(":scope > ul");
		if (list) {
			var open = list.hidden;
			list.hidden = !open;
			a.setAttribute("aria-expanded", String(open));
			return Promise.resolve(open);
		}
		a.setAttribute("aria-busy", "true");
		return fetch(a.dataset.tree, { credentials: "same-origin" })
			.then(function (res) { return res.ok ? res.text() : ""; })
			.then(function (markup) {
				a.removeAttribute("aria-busy");
				if (!markup) return false;
				li.insertAdjacentHTML("beforeend", markup);
				a.setAttribute("aria-expanded", "true");
				return true;
			})
			.catch(function () { location.href = a.getAttribute("href"); return false; });
	}

	function plainClick(e) { return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button); }

	tree.addEventListener("click", function (e) {
		var a = e.target.closest("a");
		if (!a || !plainClick(e)) return;
		e.preventDefault();
		if (a.dataset.tree) {
			// Opening a folder also shows it; closing one only folds it away.
			toggle(a).then(function (opened) { if (opened) load(a.getAttribute("href"), true); });
		} else {
			load(a.getAttribute("href"), true);
		}
	});
	pane.addEventListener("click", function (e) {
		var a = e.target.closest("a[data-pane]");
		if (!a || !plainClick(e)) return;
		e.preventDefault();
		load(a.getAttribute("href"), true);
	});
	window.addEventListener("popstate", function () { load(here(), false); });
	mark();
})();
`;

const DASHBOARD_JS = `
(function () {
	var q = document.getElementById("q");
	if (!q) return;
	var state = "all";
	function apply() {
		var term = q.value.trim().toLowerCase();
		var shown = 0;
		document.querySelectorAll("tr[data-name]").forEach(function (tr) {
			var s = tr.dataset.state;
			var match = (state === "all" || (state === "on" ? s === "on" || s === "error" : s === state)) && tr.dataset.name.indexOf(term) !== -1;
			tr.hidden = !match;
			if (match) shown++;
		});
		var filtering = term !== "" || state !== "all";
		document.querySelectorAll("[data-account]").forEach(function (card) {
			card.hidden = filtering && !card.querySelector("tr[data-name]:not([hidden])");
		});
		document.getElementById("shown").textContent = filtering ? shown + " shown" : "";
	}
	q.addEventListener("input", apply);
	document.querySelectorAll("button[data-filter]").forEach(function (button) {
		button.addEventListener("click", function () {
			state = button.dataset.filter;
			document.querySelectorAll("button[data-filter]").forEach(function (other) { other.classList.toggle("on", other === button); });
			apply();
		});
	});
	document.addEventListener("keydown", function (e) {
		if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
		if (e.key === "Escape" && document.activeElement === q) { q.value = ""; apply(); q.blur(); }
	});
})();
`;

const CODE_CSS = `
.crumbs { font-size:15px; word-break:break-all; } .crumbs a { color:var(--accent); text-decoration:none; }
.bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin-bottom:12px; }
.files td { white-space:normal; } .files td.size, .files td.kind { white-space:nowrap; width:1%; color:var(--muted); }
.files a { text-decoration:none; } .files a:hover { text-decoration:underline; }
.codebox { display:flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--card); }
.codebox pre { margin:0; border-radius:0; background:transparent; padding:12px; line-height:1.5; font-size:12px; }
.codebox pre.ln { text-align:right; color:var(--muted); user-select:none; border-right:1px solid var(--line); flex:none; }
.codebox pre.src { flex:1; overflow-x:auto; tab-size:4; } .codebox code { font:inherit; padding:0; background:transparent; }
.preview { text-align:center; padding:16px; } .preview img { max-width:100%; }
.md { line-height:1.6; overflow-wrap:anywhere; } .md img { max-width:100%; }
.md h1, .md h2 { border-bottom:1px solid var(--line); padding-bottom:6px; margin:24px 0 12px; font-size:22px; } .md h2 { font-size:18px; } .md h3 { font-size:15px; }
.md a { color:var(--accent); } .md pre { padding:12px; } .md code { background:var(--chip); padding:1px 5px; border-radius:4px; } .md pre code { background:transparent; padding:0; }
.md blockquote { margin:0; padding-left:14px; border-left:3px solid var(--line); color:var(--muted); }
.md table { width:auto; } .md th, .md td { border:1px solid var(--line); white-space:normal; }
.commit-msg { white-space:normal; }
.state { display:inline-block; font-size:12px; font-weight:600; padding:1px 9px; border-radius:99px; border:1px solid currentColor; white-space:nowrap; }
.state.merged { color:#8250df; } @media (prefers-color-scheme: dark) { .state.merged { color:#b392f0; } }
.bar input[type=search] { font:inherit; padding:6px 10px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--text); width:240px; max-width:100%; }
main:has(.browser) { max-width:1560px; }
.browser { display:grid; grid-template-columns:290px minmax(0,1fr); gap:16px; align-items:start; }
.side { position:sticky; top:12px; max-height:calc(100vh - 24px); overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 8px; font-size:13px; }
.side summary { display:none; }
.side ul { list-style:none; margin:0; padding:0; } .side ul ul { padding-left:14px; }
.side li { margin:0; }
.side a { display:block; padding:3px 8px; border-radius:6px; text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.side a:hover { background:var(--chip); }
.side a[aria-current] { background:var(--chip); font-weight:600; box-shadow:inset 2px 0 0 var(--accent); }
.side a[data-tree]::before { content:"▸"; display:inline-block; width:14px; color:var(--muted); }
.side a[data-tree][aria-expanded="true"]::before { content:"▾"; }
.side a[aria-busy]::before { content:"…"; }
.side a:not([data-tree]) { padding-left:22px; }
.side .repo { font-weight:600; padding:2px 8px 8px; border-bottom:1px solid var(--line); margin-bottom:6px; }
#pane { min-width:0; transition:opacity .12s; } #pane.loading { opacity:.45; }
@media (max-width: 860px) {
	.browser { grid-template-columns:minmax(0,1fr); }
	.side { position:static; max-height:none; }
	.side summary { display:block; cursor:pointer; padding:2px 8px; font-weight:600; }
	.side:not([open]) > :not(summary) { display:none; }
}
${lightTheme}
@media (prefers-color-scheme: dark) { ${darkTheme} }
.hljs { background:transparent; }
pre code.hljs { padding:0; overflow-x:visible; }
`;

export const HEAD = raw(`<link rel="stylesheet" href="/assets/code.css"><script src="/assets/highlight.js" defer></script><script src="/assets/code.js" defer></script>`);

export function serveAsset(path: string): Response | null {
	const assets: Record<string, [string, string]> = {
		"/assets/highlight.js": [highlightJs, "text/javascript; charset=utf-8"],
		"/assets/code.js": [CLIENT_JS, "text/javascript; charset=utf-8"],
		"/assets/dash.js": [DASHBOARD_JS, "text/javascript; charset=utf-8"],
		"/assets/code.css": [CODE_CSS, "text/css; charset=utf-8"],
	};
	const asset = assets[path];
	if (!asset) return null;
	return new Response(asset[0], { headers: { "content-type": asset[1], "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
}

const LANGUAGES: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp",
	hpp: "cpp", cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini",
	ini: "ini", cfg: "ini", md: "markdown", markdown: "markdown", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", css: "css", scss: "scss",
	less: "less", sql: "sql", lua: "lua", pl: "perl", r: "r", m: "objectivec", diff: "diff", patch: "diff", graphql: "graphql", gql: "graphql",
	makefile: "makefile", mk: "makefile", txt: "plaintext",
};
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif" };

const extension = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name).toLowerCase();
const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
const README = /^readme(\.(md|markdown|txt|rst))?$/i;
const WIKI_HOME = /^home\.(md|markdown)$/i;

interface Ref {
	name: string;
	sha: string;
}

/**
 * The binding has no call to list refs, so ask the repo the way git does:
 * the smart-HTTP ref advertisement, with a short-lived read token.
 */
async function listRefs(handle: ArtifactsRepo, cacheKey: string): Promise<Ref[]> {
	const cache = await caches.open("refs");
	const key = `https://refs.invalid/${encodeURIComponent(cacheKey)}`;
	const hit = await cache.match(key);
	if (hit) return hit.json<Ref[]>();

	const info = await handle.info();
	const token = await handle.createToken("read", 120);
	const res = await fetch(`${info.remote}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${token.plaintext}`, "User-Agent": "git/2.47.0" } });
	if (!res.ok) throw new Error(`could not list refs: ${res.status}`);

	const data = new Uint8Array(await res.arrayBuffer());
	const decoder = new TextDecoder();
	const shas = new Map<string, string>();
	for (let pos = 0; pos + 4 <= data.length; ) {
		const length = parseInt(decoder.decode(data.subarray(pos, pos + 4)), 16);
		if (!Number.isFinite(length) || length < 4) {
			pos += 4; // flush packet
			continue;
		}
		const line = decoder.decode(data.subarray(pos + 4, pos + length)).split("\0")[0].trimEnd();
		pos += length;
		const space = line.indexOf(" ");
		if (space !== 40) continue;
		shas.set(line.slice(space + 1), line.slice(0, space));
	}
	const refs: Ref[] = [];
	for (const [name, sha] of shas) {
		// "name^{}" carries the commit an annotated tag points at.
		if (!name.startsWith("refs/") || name.endsWith("^{}")) continue;
		refs.push({ name, sha: shas.get(`${name}^{}`) ?? sha });
	}
	refs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	await cache.put(key, Response.json(refs, { headers: { "cache-control": `max-age=${REFS_CACHE_SECONDS}` } }));
	return refs;
}

function refLabel(name: string): string {
	if (name.startsWith("refs/heads/")) return name.slice(11);
	if (name.startsWith("refs/tags/")) return name.slice(10);
	const pull = /^refs\/pull\/(\d+)\/head$/.exec(name);
	if (pull) return `#${pull[1]}`;
	if (name.startsWith("refs/backup/")) return name.slice(12);
	return /^[0-9a-f]{40}$/.test(name) ? name.slice(0, 10) : name;
}

type Entry = ArtifactsTreeEntry;
/** `trail[i]` lists the directory `i` levels down the requested path, root first. */
type Found = { kind: "tree"; entries: Entry[]; trail: Entry[][] } | { kind: "blob"; entry: Entry; trail: Entry[][] } | { kind: "missing"; trail: Entry[][] };

async function walk(handle: ArtifactsRepo, treeHash: string, path: string): Promise<Found | null> {
	let entries = await handle.readTree(treeHash);
	if (!entries) return null;
	const trail = [entries];
	const parts = path.split("/").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const entry: Entry | undefined = entries.find((e) => e.name === parts[i]);
		if (!entry) return { kind: "missing", trail };
		if (entry.type !== "tree") return i === parts.length - 1 ? { kind: "blob", entry, trail } : { kind: "missing", trail };
		entries = await handle.readTree(entry.hash);
		if (!entries) return { kind: "missing", trail };
		trail.push(entries);
	}
	return { kind: "tree", entries, trail };
}

const sortEntries = (entries: Entry[]) => [...entries].sort((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name));

function looksBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

export type CodeView = "code" | "blob" | "raw" | "commits" | "tree";

export async function handleCode(env: Env, url: URL, repo: Repo, view: CodeView): Promise<Response> {
	const back = { href: `/repos/${repo.id}`, label: "Back" };
	if (repo.storage !== "artifacts" || !repo.artifacts_name) {
		return messagePage("Nothing to browse", repo.storage === "r2-bundle" ? "This repository is stored as a git bundle in R2, which cannot be browsed here. Download the bundle to look inside." : "This repository has not been backed up yet.", 404, back);
	}

	// The wiki is its own git repository, backed up next to the code.
	const wiki = url.searchParams.get("wiki") === "1";
	const name = wiki ? `${repo.artifacts_name}.wiki` : repo.artifacts_name;
	let handle: ArtifactsRepo;
	try {
		handle = await env.ARTIFACTS.get(name);
	} catch {
		return messagePage("Nothing to browse", wiki ? "There is no wiki in this backup." : "The backup for this repository could not be opened.", 404, back);
	}
	try {
		return await render(handle, url, repo, view, name, wiki);
	} finally {
		handle[Symbol.dispose]();
	}
}

async function render(handle: ArtifactsRepo, url: URL, repo: Repo, view: CodeView, name: string, wiki: boolean): Promise<Response> {
	const base = `/repos/${repo.id}`;
	const back = { href: base, label: "Back" };
	const refs = await listRefs(handle, name);
	if (refs.length === 0) return messagePage(wiki ? "Empty wiki" : "Empty repository", wiki ? "This wiki has no pages." : "This repository has no commits.", 404, back);

	const wanted = url.searchParams.get("ref");
	const fallback = refs.find((r) => r.name === `refs/heads/${repo.default_branch}`) ?? refs.find((r) => r.name.startsWith("refs/heads/")) ?? refs[0];
	const current: Ref | undefined = !wanted ? fallback : /^[0-9a-f]{40}$/.test(wanted) ? { name: wanted, sha: wanted } : refs.find((r) => r.name === wanted);
	if (!current) return messagePage("No such branch", `${wanted} is not in this backup.`, 404, { href: `${base}/code`, label: "Browse the default branch" });

	const path = (url.searchParams.get("path") ?? "").split("/").filter(Boolean).join("/");
	const link = (kind: string, p = "", ref = current.name) => `${base}/${kind}?ref=${encodeURIComponent(ref)}${p ? `&path=${encodeURIComponent(p)}` : ""}${wiki ? "&wiki=1" : ""}`;

	const commit = await handle.readCommit(current.sha);
	if (!commit) return messagePage("Not found", "That commit is not in this backup.", 404, back);

	const groups: [string, string][] = [
		["Branches", "refs/heads/"],
		["Tags", "refs/tags/"],
		["Pull requests", "refs/pull/"],
		["Kept history (rewritten or deleted)", "refs/backup/"],
	];
	const known = refs.some((r) => r.name === current.name);
	const picker = html`<select data-nav aria-label="Branch, tag or snapshot">
	${known ? "" : html`<option selected value="${link(view === "commits" ? "commits" : "code", "")}">commit ${current.sha.slice(0, 10)}</option>`}
	${groups.map(([label, prefix]) => {
		const members = refs.filter((r) => r.name.startsWith(prefix));
		if (!members.length) return "";
		const shown = members.slice(0, MAX_REFS_PER_GROUP);
		return html`<optgroup label="${label}${members.length > shown.length ? ` (first ${shown.length} of ${members.length})` : ""}">${shown.map(
			(r) => html`<option value="${link(view === "commits" ? "commits" : "code", "", r.name)}" ${r.name === current.name ? raw("selected") : ""}>${refLabel(r.name)}</option>`,
		)}</optgroup>`;
	})}
</select>`;

	const parts = path ? path.split("/") : [];
	const crumbs = html`<span class="crumbs"><a data-pane href="${link("code")}"><b>${repo.full_name.split("/")[1]}</b></a>${parts.map(
		(part, i) => html` / ${i === parts.length - 1 ? part : html`<a data-pane href="${link("code", parts.slice(0, i + 1).join("/"))}">${part}</a>`}`,
	)}</span>`;
	const header = (title: string, extra: unknown = "") => html`
<header class="top">
	<div><a class="link small" href="${base}">← ${repo.full_name}</a><h1>${title}</h1></div>
	<div class="row">${picker}<a class="btn" href="${link("code")}">Files</a><a class="btn" href="${link("commits")}">History</a>${extra}</div>
</header>`;

	const found = await walk(handle, commit.treeHash, view === "commits" ? "" : path);
	if (!found) return messagePage("Not found", "That commit's files are not in this backup.", 404, back);

	/** One level of the sidebar tree; `trail` opens the folders leading to the current path. */
	const treeList = (entries: Entry[], dir: string, depth: number): unknown => html`<ul>${sortEntries(entries).map((e) => {
		const full = dir ? `${dir}/${e.name}` : e.name;
		if (e.type === "gitlink") return html`<li><a class="muted" title="submodule">${e.name}</a></li>`;
		const here = full === path ? raw(`aria-current="page"`) : "";
		if (e.type !== "tree") return html`<li><a href="${link("blob", full)}" title="${e.name}" ${here}>${e.name}</a></li>`;
		const open = parts[depth] === e.name && parts.slice(0, depth).join("/") === dir && found.trail.length > depth + 1;
		return html`<li><a href="${link("code", full)}" data-tree="${link("tree", full)}" aria-expanded="${open ? "true" : "false"}" title="${e.name}" ${here}>${e.name}</a>${open ? treeList(found.trail[depth + 1], full, depth + 1) : ""}</li>`;
	})}</ul>`;

	if (view === "tree") {
		if (found.kind !== "tree") return new Response("", { status: 404 });
		return new Response(String(treeList(found.entries, path, parts.length)), {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": CODE_CSP, "x-content-type-options": "nosniff" },
		});
	}

	const show = (title: string, body: unknown, status = 200) =>
		page(
			`${title} · ${repo.full_name}`,
			html`${repoTabs(repo, wiki ? "wiki" : "code")}<div class="browser">
<details class="side" open><summary>Files</summary><div class="repo"><a href="${link("code")}" title="${repo.full_name}">${repo.full_name.split("/")[1]}</a></div><nav id="tree" aria-label="Files">${treeList(found.trail[0], "", 0)}</nav></details>
<div id="pane">${body}</div>
</div>`,
			{ csp: CODE_CSP, head: HEAD, status },
		);

	if (view === "commits") {
		const pageNo = Math.max(0, Number(url.searchParams.get("page")) || 0);
		let commits = await handle.log({ ref: current.sha, limit: COMMITS_PER_PAGE + 1, offset: pageNo * COMMITS_PER_PAGE });
		if (commits.length === 0 && pageNo === 0 && known) commits = await handle.log({ ref: current.name, limit: COMMITS_PER_PAGE + 1 });
		if (commits.length === 0 && pageNo === 0) commits = [commit];
		const more = commits.length > COMMITS_PER_PAGE;
		return show(
			"History",
			html`${header(`History of ${refLabel(current.name)}`)}
<div class="card scroll"><table><thead><tr><th>Commit</th><th>Message</th><th>Author</th><th>When</th></tr></thead><tbody>
${commits.slice(0, COMMITS_PER_PAGE).map(
	(c) => html`<tr><td><a class="link" href="${link("code", "", c.hash)}"><code>${c.hash.slice(0, 10)}</code></a></td><td class="commit-msg">${c.message.split("\n")[0].slice(0, 200)}</td><td>${c.author.name}</td><td class="muted">${new Date(c.committedAt * (c.committedAt < 1e11 ? 1000 : 1)).toISOString().slice(0, 10)}</td></tr>`,
)}
</tbody></table></div>
<div class="row">${pageNo > 0 ? html`<a class="btn" href="${link("commits")}&page=${pageNo - 1}">Newer</a>` : ""}${more ? html`<a class="btn" href="${link("commits")}&page=${pageNo + 1}">Older</a>` : ""}</div>`,
		);
	}

	if (found.kind === "missing") return show("Not found", html`${header("Not found")}<div class="card">${crumbs}<p>There is no <code>${path}</code> at ${refLabel(current.name)}.</p></div>`, 404);

	const markdownContext = (dir: string): LinkContext => ({ dir, fileUrl: (p) => link("blob", p), rawUrl: (p) => link("raw", p) });

	if (found.kind === "tree") {
		if (view !== "code") return Response.redirect(new URL(link("code", path), url).toString(), 302);
		const entries = sortEntries(found.entries);
		const child = (name: string) => (path ? `${path}/${name}` : name);

		let readme: unknown = "";
		const readmeEntry = entries.find((e) => e.type !== "tree" && (README.test(e.name) || (wiki && !path && WIKI_HOME.test(e.name))));
		if (readmeEntry) {
			const blob = await handle.readBlob(readmeEntry.hash);
			if (blob && blob.size <= MAX_README_BYTES) {
				const text = await blob.text();
				readme = html`<div class="card"><h3>${readmeEntry.name}</h3>${isMarkdown(readmeEntry.name) ? html`<article class="md">${raw(renderMarkdown(text, markdownContext(path)))}</article>` : html`<pre>${text}</pre>`}</div>`;
			}
		}
		const when = new Date(commit.committedAt * (commit.committedAt < 1e11 ? 1000 : 1)).toISOString();
		return show(
			path || "Files",
			html`${header(repo.full_name)}
<div class="card">
	<div class="bar">${crumbs}<span class="muted small"><a class="link" href="${link("commits")}"><code>${commit.hash.slice(0, 10)}</code></a> ${commit.message.split("\n")[0].slice(0, 90)} · ${commit.author.name} · ${ago(when)}</span></div>
	<div class="scroll"><table class="files"><tbody>
	${path ? html`<tr><td><a data-pane href="${link("code", parts.slice(0, -1).join("/"))}">..</a></td><td></td></tr>` : ""}
	${entries.map((e) =>
		e.type === "tree"
			? html`<tr><td>📁 <a data-pane href="${link("code", child(e.name))}">${e.name}</a></td><td class="kind"></td></tr>`
			: e.type === "gitlink"
				? html`<tr><td>↗ ${e.name}</td><td class="kind">submodule</td></tr>`
				: html`<tr><td>📄 <a data-pane href="${link("blob", child(e.name))}">${e.name}</a></td><td class="kind">${e.type === "symlink" ? "symlink" : ""}</td></tr>`,
	)}
	</tbody></table></div>
</div>
${readme}`,
		);
	}

	// A file.
	if (view === "code") return Response.redirect(new URL(link("blob", path), url).toString(), 302);
	const fileName = parts[parts.length - 1];
	const ext = extension(fileName);
	const blob = await handle.readBlob(found.entry.hash);
	if (!blob) return messagePage("Not found", "That file is not in this backup.", 404, back);

	if (view === "raw") {
		const head = new Uint8Array(await blob.slice(0, 8000).arrayBuffer());
		const type = IMAGE_TYPES[ext] ?? (looksBinary(head) ? "application/octet-stream" : "text/plain; charset=utf-8");
		return new Response(blob.stream(), {
			headers: {
				"content-type": type,
				"content-length": String(blob.size),
				"content-disposition": `${IMAGE_TYPES[ext] || type.startsWith("text/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
				"content-security-policy": RAW_CSP,
				"x-content-type-options": "nosniff",
				"cache-control": "private, no-store",
			},
		});
	}

	const rawButton = html`<a class="btn" href="${link("raw", path)}">Raw</a>`;
	const frame = (body: unknown) => show(fileName, html`${header(fileName, rawButton)}<div class="card"><div class="bar">${crumbs}<span class="muted small">${bytes(blob.size)}</span></div>${body}</div>`);

	if (IMAGE_TYPES[ext]) return frame(html`<div class="preview"><img src="${link("raw", path)}" alt="${fileName}"></div>`);
	if (blob.size > MAX_VIEW_BYTES) return frame(html`<p class="muted">This file is too large to show here. Use Raw to download it.</p>`);
	const data = new Uint8Array(await blob.arrayBuffer());
	if (looksBinary(data)) return frame(html`<p class="muted">Binary file. Use Raw to download it.</p>`);

	const text = new TextDecoder().decode(data);
	const plain = url.searchParams.get("plain") === "1";
	if (isMarkdown(fileName) && !plain) {
		return frame(html`<p class="small"><a class="link" href="${link("blob", path)}&plain=1">View source</a></p><article class="md">${raw(renderMarkdown(text, markdownContext(parts.slice(0, -1).join("/"))))}</article>`);
	}

	const language = LANGUAGES[ext];
	const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
	const numbers = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
	// Unknown types are auto-detected only when small; detection is slow on big files.
	const mode = language ? "" : blob.size <= MAX_AUTODETECT_BYTES ? raw("data-auto") : raw("data-plain");
	return frame(html`<div class="codebox"><pre class="ln">${numbers}</pre><pre class="src"><code class="${language ? `language-${language}` : ""}" ${mode}>${text}</code></pre></div>`);
}
