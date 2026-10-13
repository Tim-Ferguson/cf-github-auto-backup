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
import { ago, bytes, html, messagePage, page, raw } from "./ui.ts";

const CODE_CSP = "default-src 'none'; style-src 'unsafe-inline' 'self'; script-src 'self'; img-src 'self' https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const RAW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const MAX_VIEW_BYTES = 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const MAX_AUTODETECT_BYTES = 40 * 1024;
const MAX_REFS_PER_GROUP = 300;
const COMMITS_PER_PAGE = 30;
const REFS_CACHE_SECONDS = 60;

const CLIENT_JS = `
document.querySelectorAll("pre code").forEach(function (el) {
	if (el.hasAttribute("data-plain")) return;
	var lang = (el.className.match(/language-([\\w+#-]+)/) || [])[1];
	if (lang && !hljs.getLanguage(lang)) el.className = "";
	if (!lang && !el.hasAttribute("data-auto")) return;
	hljs.highlightElement(el);
});
document.querySelectorAll("select[data-nav]").forEach(function (el) {
	el.addEventListener("change", function () { location.href = el.value; });
});
`;

const CODE_CSS = `
.crumbs { font-size:15px; word-break:break-all; } .crumbs a { color:var(--accent); text-decoration:none; }
.bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin-bottom:12px; }
.files td { white-space:normal; } .files td.size, .files td.kind { white-space:nowrap; width:1%; color:var(--muted); }
.files a { text-decoration:none; } .files a:hover { text-decoration:underline; }
.codebox { display:flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--card); }
.codebox pre { margin:0; border-radius:0; background:transparent; padding:12px; line-height:1.5; font-size:12px; }
.codebox pre.ln { text-align:right; color:var(--muted); user-select:none; border-right:1px solid var(--line); flex:none; }
.codebox pre.src { flex:1; overflow-x:auto; } .codebox code { font:inherit; padding:0; background:transparent; }
.preview { text-align:center; padding:16px; } .preview img { max-width:100%; }
.md { line-height:1.6; overflow-wrap:anywhere; } .md img { max-width:100%; }
.md h1, .md h2 { border-bottom:1px solid var(--line); padding-bottom:6px; margin:24px 0 12px; font-size:22px; } .md h2 { font-size:18px; } .md h3 { font-size:15px; }
.md a { color:var(--accent); } .md pre { padding:12px; } .md code { background:var(--chip); padding:1px 5px; border-radius:4px; } .md pre code { background:transparent; padding:0; }
.md blockquote { margin:0; padding-left:14px; border-left:3px solid var(--line); color:var(--muted); }
.md table { width:auto; } .md th, .md td { border:1px solid var(--line); white-space:normal; }
.commit-msg { white-space:normal; }
${lightTheme}
@media (prefers-color-scheme: dark) { ${darkTheme} }
.hljs { background:transparent; }
`;

const HEAD = raw(`<link rel="stylesheet" href="/assets/code.css"><script src="/assets/highlight.js" defer></script><script src="/assets/code.js" defer></script>`);

export function serveAsset(path: string): Response | null {
	const assets: Record<string, [string, string]> = {
		"/assets/highlight.js": [highlightJs, "text/javascript; charset=utf-8"],
		"/assets/code.js": [CLIENT_JS, "text/javascript; charset=utf-8"],
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
type Found = { kind: "tree"; entries: Entry[] } | { kind: "blob"; entry: Entry } | null;

async function walk(handle: ArtifactsRepo, treeHash: string, path: string): Promise<Found> {
	let entries = await handle.readTree(treeHash);
	if (!entries) return null;
	const parts = path.split("/").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const entry: Entry | undefined = entries.find((e) => e.name === parts[i]);
		if (!entry) return null;
		if (entry.type !== "tree") return i === parts.length - 1 ? { kind: "blob", entry } : null;
		entries = await handle.readTree(entry.hash);
		if (!entries) return null;
	}
	return { kind: "tree", entries };
}

function looksBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

export async function handleCode(env: Env, url: URL, repo: Repo, view: "code" | "blob" | "raw" | "commits"): Promise<Response> {
	const back = { href: `/repos/${repo.id}`, label: "Back" };
	if (repo.storage !== "artifacts" || !repo.artifacts_name) {
		return messagePage("Nothing to browse", repo.storage === "r2-bundle" ? "This repository is stored as a git bundle in R2, which cannot be browsed here. Download the bundle to look inside." : "This repository has not been backed up yet.", 404, back);
	}

	let handle: ArtifactsRepo;
	try {
		handle = await env.ARTIFACTS.get(repo.artifacts_name);
	} catch {
		return messagePage("Nothing to browse", "The backup for this repository could not be opened.", 404, back);
	}
	try {
		return await render(handle, url, repo, view);
	} finally {
		handle[Symbol.dispose]();
	}
}

async function render(handle: ArtifactsRepo, url: URL, repo: Repo, view: "code" | "blob" | "raw" | "commits"): Promise<Response> {
	const base = `/repos/${repo.id}`;
	const back = { href: base, label: "Back" };
	const refs = await listRefs(handle, repo.artifacts_name!);
	if (refs.length === 0) return messagePage("Empty repository", "This repository has no commits.", 404, back);

	const wanted = url.searchParams.get("ref");
	const fallback = refs.find((r) => r.name === `refs/heads/${repo.default_branch}`) ?? refs.find((r) => r.name.startsWith("refs/heads/")) ?? refs[0];
	const current: Ref | undefined = !wanted ? fallback : /^[0-9a-f]{40}$/.test(wanted) ? { name: wanted, sha: wanted } : refs.find((r) => r.name === wanted);
	if (!current) return messagePage("No such branch", `${wanted} is not in this backup.`, 404, { href: `${base}/code`, label: "Browse the default branch" });

	const path = (url.searchParams.get("path") ?? "").split("/").filter(Boolean).join("/");
	const link = (kind: string, p = "", ref = current.name) => `${base}/${kind}?ref=${encodeURIComponent(ref)}${p ? `&path=${encodeURIComponent(p)}` : ""}`;

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
	const crumbs = html`<span class="crumbs"><a href="${link("code")}"><b>${repo.full_name.split("/")[1]}</b></a>${parts.map(
		(part, i) => html` / ${i === parts.length - 1 ? part : html`<a href="${link("code", parts.slice(0, i + 1).join("/"))}">${part}</a>`}`,
	)}</span>`;
	const header = (title: string, extra: unknown = "") => html`
<header class="top">
	<div><a class="link small" href="${base}">← ${repo.full_name}</a><h1>${title}</h1></div>
	<div class="row">${picker}<a class="btn" href="${link("code")}">Files</a><a class="btn" href="${link("commits")}">History</a>${extra}</div>
</header>`;
	const show = (title: string, body: unknown, status = 200) => page(`${title} · ${repo.full_name}`, html`${body}`, { csp: CODE_CSP, head: HEAD, status });

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

	const found = await walk(handle, commit.treeHash, path);
	if (!found) return show("Not found", html`${header("Not found")}<div class="card">${crumbs}<p>There is no <code>${path}</code> at ${refLabel(current.name)}.</p></div>`, 404);

	const markdownContext = (dir: string): LinkContext => ({ dir, fileUrl: (p) => link("blob", p), rawUrl: (p) => link("raw", p) });

	if (found.kind === "tree") {
		if (view !== "code") return Response.redirect(new URL(link("code", path), url).toString(), 302);
		const entries = [...found.entries].sort((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name));
		const child = (name: string) => (path ? `${path}/${name}` : name);

		let readme: unknown = "";
		const readmeEntry = entries.find((e) => e.type !== "tree" && README.test(e.name));
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
	${path ? html`<tr><td><a href="${link("code", parts.slice(0, -1).join("/"))}">..</a></td><td></td></tr>` : ""}
	${entries.map((e) =>
		e.type === "tree"
			? html`<tr><td>📁 <a href="${link("code", child(e.name))}">${e.name}</a></td><td class="kind"></td></tr>`
			: e.type === "gitlink"
				? html`<tr><td>↗ ${e.name}</td><td class="kind">submodule</td></tr>`
				: html`<tr><td>📄 <a href="${link("blob", child(e.name))}">${e.name}</a></td><td class="kind">${e.type === "symlink" ? "symlink" : ""}</td></tr>`,
	)}
	</tbody></table></div>
</div>
${readme}`,
		);
	}

	// A file.
	if (view === "code") return Response.redirect(new URL(link("blob", path), url).toString(), 302);
	const name = parts[parts.length - 1];
	const ext = extension(name);
	const blob = await handle.readBlob(found.entry.hash);
	if (!blob) return messagePage("Not found", "That file is not in this backup.", 404, back);

	if (view === "raw") {
		const head = new Uint8Array(await blob.slice(0, 8000).arrayBuffer());
		const type = IMAGE_TYPES[ext] ?? (looksBinary(head) ? "application/octet-stream" : "text/plain; charset=utf-8");
		return new Response(blob.stream(), {
			headers: {
				"content-type": type,
				"content-length": String(blob.size),
				"content-disposition": `${IMAGE_TYPES[ext] || type.startsWith("text/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
				"content-security-policy": RAW_CSP,
				"x-content-type-options": "nosniff",
				"cache-control": "private, no-store",
			},
		});
	}

	const rawButton = html`<a class="btn" href="${link("raw", path)}">Raw</a>`;
	const frame = (body: unknown) => show(name, html`${header(name, rawButton)}<div class="card"><div class="bar">${crumbs}<span class="muted small">${bytes(blob.size)}</span></div>${body}</div>`);

	if (IMAGE_TYPES[ext]) return frame(html`<div class="preview"><img src="${link("raw", path)}" alt="${name}"></div>`);
	if (blob.size > MAX_VIEW_BYTES) return frame(html`<p class="muted">This file is too large to show here. Use Raw to download it.</p>`);
	const data = new Uint8Array(await blob.arrayBuffer());
	if (looksBinary(data)) return frame(html`<p class="muted">Binary file. Use Raw to download it.</p>`);

	const text = new TextDecoder().decode(data);
	const plain = url.searchParams.get("plain") === "1";
	if (isMarkdown(name) && !plain) {
		return frame(html`<p class="small"><a class="link" href="${link("blob", path)}&plain=1">View source</a></p><article class="md">${raw(renderMarkdown(text, markdownContext(parts.slice(0, -1).join("/"))))}</article>`);
	}

	const language = LANGUAGES[ext];
	const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
	const numbers = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
	// Unknown types are auto-detected only when small; detection is slow on big files.
	const mode = language ? "" : blob.size <= MAX_AUTODETECT_BYTES ? raw("data-auto") : raw("data-plain");
	return frame(html`<div class="codebox"><pre class="ln">${numbers}</pre><pre class="src"><code class="${language ? `language-${language}` : ""}" ${mode}>${text}</code></pre></div>`);
}
