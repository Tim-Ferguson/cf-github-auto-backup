// Read-only views over the metadata backup: issues, pull requests with their
// reviews and comments, and releases with their assets. Lists come from the
// meta_items index in D1; the content is the raw GitHub JSON kept in R2.
//
// Bodies are other people's Markdown, so they go through the same sanitizer
// and strict CSP as READMEs in the code browser.

import { CODE_CSP, HEAD } from "./code.ts";
import type { Repo } from "./db.ts";
import { renderMarkdown } from "./markdown.ts";
import { metaPrefix } from "./storage.ts";
import { ago, bytes, html, messagePage, page, raw, repoTabs } from "./ui.ts";

const PER_PAGE = 50;
const RAW_CSP = "sandbox; default-src 'none'";

interface IndexRow {
	kind: "issue" | "pull" | "release";
	number: number;
	title: string;
	state: string;
	author: string | null;
	created_at: string | null;
	updated_at: string | null;
	comments: number;
}

interface GhUser {
	login: string;
}
interface GhLabel {
	name: string;
	color?: string;
}
interface GhIssue {
	number: number;
	title: string;
	state: string;
	body: string | null;
	user: GhUser | null;
	created_at: string;
	closed_at: string | null;
	labels?: GhLabel[];
	milestone?: { title: string } | null;
	assignees?: GhUser[];
}
interface GhPull extends GhIssue {
	merged_at: string | null;
	draft?: boolean;
	head?: { ref: string; label?: string };
	base?: { ref: string };
}
interface GhComment {
	id: number;
	body: string | null;
	user: GhUser | null;
	created_at: string;
	path?: string;
	diff_hunk?: string;
	line?: number | null;
}
interface GhReview {
	id: number;
	body: string | null;
	user: GhUser | null;
	state: string;
	submitted_at?: string;
}
interface GhRelease {
	id: number;
	tag_name: string;
	name: string | null;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
	author: GhUser | null;
	created_at: string;
	published_at: string | null;
	assets?: { id: number; name: string; size: number }[];
}

export async function metaCounts(db: D1Database, repoId: number): Promise<Record<string, number>> {
	const { results } = await db.prepare(`SELECT kind, COUNT(*) AS n FROM meta_items WHERE repo_id = ? GROUP BY kind`).bind(repoId).all<{ kind: string; n: number }>();
	return Object.fromEntries(results.map((r) => [r.kind, r.n]));
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
	const object = await bucket.get(key);
	return object ? object.json<T>() : null;
}

/** Every JSON file under a prefix, for small collections such as one issue's comments. */
async function readAll<T>(bucket: R2Bucket, prefix: string, limit = 500): Promise<T[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const listing = await bucket.list({ prefix, cursor });
		keys.push(...listing.objects.filter((o) => o.key.endsWith(".json")).map((o) => o.key));
		cursor = listing.truncated && keys.length < limit ? listing.cursor : undefined;
	} while (cursor);
	const out: T[] = [];
	const wanted = keys.slice(0, limit);
	for (let i = 0; i < wanted.length; i += 6) {
		const batch = await Promise.all(wanted.slice(i, i + 6).map((key) => readJson<T>(bucket, key)));
		for (const item of batch) if (item) out.push(item);
	}
	return out;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

function stateChip(state: string) {
	const tone = state === "open" || state === "published" ? "ok" : state === "merged" ? "merged" : state === "closed" ? "bad" : "muted";
	return html`<span class="state ${tone}">${state}</span>`;
}

export async function handleMeta(env: Env, url: URL, repo: Repo, section: "issues" | "pulls" | "releases" | "asset", rest: string[]): Promise<Response> {
	const base = `/repos/${repo.id}`;
	const prefix = metaPrefix(repo);
	const counts = await metaCounts(env.DB, repo.id);
	const markdown = (text: string | null | undefined) =>
		text ? html`<article class="md">${raw(renderMarkdown(text, { dir: "", fileUrl: (p) => `${base}/blob?path=${encodeURIComponent(p)}`, rawUrl: (p) => `${base}/raw?path=${encodeURIComponent(p)}` }))}</article>` : html`<p class="muted">No description.</p>`;
	// List pages hold no rendered Markdown, so they may carry the search form.
	const show = (title: string, active: string, body: unknown, status = 200, csp = CODE_CSP) =>
		page(`${title} · ${repo.full_name}`, html`<header class="top"><div><a class="link small" href="/">← All repositories</a><h1>${repo.full_name}</h1></div></header>${repoTabs(repo, active, counts)}${body}`, { csp, head: HEAD, status });

	if (section === "asset") {
		// /repos/:id/asset/<asset id>/<file name>
		const [assetId, ...nameParts] = rest;
		const name = nameParts.join("/");
		if (!/^\d+$/.test(assetId ?? "") || !name) return messagePage("Not found", "No such release asset.", 404, { href: `${base}/releases`, label: "Back" });
		const object = await env.BUCKET.get(`${prefix}release-assets/${assetId}/${name}`);
		if (!object) return messagePage("Not found", "That asset is not in this backup.", 404, { href: `${base}/releases`, label: "Back" });
		return new Response(object.body, {
			headers: {
				"content-type": "application/octet-stream",
				"content-length": String(object.size),
				"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name.split("/").pop()!)}`,
				"content-security-policy": RAW_CSP,
				"x-content-type-options": "nosniff",
				"cache-control": "private, no-store",
			},
		});
	}

	if (section === "releases") {
		const releases = (await readAll<GhRelease>(env.BUCKET, `${prefix}releases/`, 200)).sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
		return show(
			"Releases",
			"releases",
			releases.length
				? releases.map(
						(r) => html`<div class="card">
	<div class="row spread"><h2>${r.name || r.tag_name}</h2><span class="muted small"><code>${r.tag_name}</code> · ${r.author?.login ?? "unknown"} · ${day(r.published_at ?? r.created_at)} ${stateChip(r.draft ? "draft" : r.prerelease ? "prerelease" : "published")}</span></div>
	${markdown(r.body)}
	${r.assets?.length ? html`<h3>Assets</h3><ul>${r.assets.map((a) => html`<li><a class="link" href="${base}/asset/${a.id}/${encodeURIComponent(a.name)}">${a.name}</a> <span class="muted small">${bytes(a.size)}</span></li>`)}</ul>` : ""}
</div>`,
					)
				: html`<div class="card"><p class="muted">No releases in this backup.</p></div>`,
		);
	}

	const kind = section === "pulls" ? "pull" : "issue";
	const noun = kind === "pull" ? "pull request" : "issue";

	if (rest[0]) {
		const number = Number(rest[0]);
		if (!Number.isInteger(number) || number < 1) return show("Not found", section, html`<div class="card"><p>No such ${noun}.</p></div>`, 404);
		const issue = await readJson<GhIssue>(env.BUCKET, `${prefix}issues/${number}.json`);
		const pull = await readJson<GhPull>(env.BUCKET, `${prefix}pulls/${number}.json`);
		const item = pull ?? issue;
		if (!item) return show("Not found", section, html`<div class="card"><p>#${number} is not in this backup.</p></div>`, 404);
		// The issue record carries labels and assignees even for pull requests.
		const meta = issue ?? item;

		const [comments, reviews, reviewComments] = await Promise.all([
			readAll<GhComment>(env.BUCKET, `${prefix}issue-comments/${number}/`),
			pull ? readJson<GhReview[]>(env.BUCKET, `${prefix}pull-reviews/${number}.json`) : null,
			pull ? readAll<GhComment>(env.BUCKET, `${prefix}pull-comments/${number}/`) : [],
		]);
		type Event = { at: string; body: unknown };
		const events: Event[] = [
			...comments.map((c) => ({
				at: c.created_at,
				body: html`<div class="card"><div class="muted small"><b>${c.user?.login ?? "unknown"}</b> commented on ${day(c.created_at)}</div>${markdown(c.body)}</div>`,
			})),
			...(reviews ?? [])
				.filter((r) => r.body || r.state !== "COMMENTED")
				.map((r) => ({
					at: r.submitted_at ?? "",
					body: html`<div class="card"><div class="muted small"><b>${r.user?.login ?? "unknown"}</b> reviewed on ${day(r.submitted_at)} ${stateChip(r.state.toLowerCase().replace(/_/g, " "))}</div>${r.body ? markdown(r.body) : ""}</div>`,
				})),
			...reviewComments.map((c) => ({
				at: c.created_at,
				body: html`<div class="card"><div class="muted small"><b>${c.user?.login ?? "unknown"}</b> commented on <code>${c.path}</code>${c.line ? html` line ${c.line}` : ""} · ${day(c.created_at)}</div>${c.diff_hunk ? html`<pre><code class="language-diff">${c.diff_hunk}</code></pre>` : ""}${markdown(c.body)}</div>`,
			})),
		].sort((a, b) => a.at.localeCompare(b.at));

		const state = pull?.merged_at ? "merged" : item.state;
		return show(
			`#${number} ${item.title}`,
			pull ? "pulls" : "issues",
			html`<div class="card">
	<div class="row spread"><h2>${item.title} <span class="muted">#${number}</span></h2>${stateChip(state)}</div>
	<p class="muted small"><b>${item.user?.login ?? "unknown"}</b> opened this ${noun} on ${day(item.created_at)}${item.closed_at ? html` · closed ${day(item.closed_at)}` : ""}${
		pull?.head && pull.base ? html` · <code>${pull.head.label ?? pull.head.ref}</code> → <code>${pull.base.ref}</code> · <a class="link" href="${base}/code?ref=${encodeURIComponent(`refs/pull/${number}/head`)}">browse its code</a>` : ""
	}</p>
	${meta.labels?.length ? html`<p>${meta.labels.map((l) => html`<span class="chip">${l.name}</span>`)}</p>` : ""}
	${meta.milestone ? html`<p class="muted small">Milestone: ${meta.milestone.title}</p>` : ""}
	${markdown(item.body)}
</div>
${events.map((e) => e.body)}
${events.length === 0 ? html`<p class="muted small">No comments.</p>` : ""}`,
		);
	}

	const state = url.searchParams.get("state") ?? "open";
	const q = (url.searchParams.get("q") ?? "").trim();
	const pageNo = Math.max(0, Number(url.searchParams.get("page")) || 0);
	const where = [`repo_id = ?`, `kind = ?`];
	const args: (string | number)[] = [repo.id, kind];
	if (state === "open") where.push(`state = 'open'`);
	else if (state === "closed") where.push(`state != 'open'`);
	if (q) {
		where.push(/^#?\d+$/.test(q) ? `number = ?` : `title LIKE ? ESCAPE '\\'`);
		args.push(/^#?\d+$/.test(q) ? Number(q.replace("#", "")) : `%${q.replace(/[\\%_]/g, "\\$&")}%`);
	}
	const { results } = await env.DB.prepare(`SELECT * FROM meta_items WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ? OFFSET ?`)
		.bind(...args, PER_PAGE + 1, pageNo * PER_PAGE)
		.all<IndexRow>();
	const totals = await env.DB.prepare(`SELECT SUM(state = 'open') AS open, SUM(state != 'open') AS closed FROM meta_items WHERE repo_id = ? AND kind = ?`).bind(repo.id, kind).first<{ open: number | null; closed: number | null }>();

	const query = (extra: Record<string, string | number>) => {
		const params = new URLSearchParams({ state, ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
		return `${base}/${section}?${params}`;
	};
	const tab = (value: string, label: string) => html`<a class="btn ${state === value ? "on" : ""}" href="${query({ state: value, page: 0 })}">${label}</a>`;
	const indexed = (counts.issue ?? 0) + (counts.pull ?? 0) > 0;

	return show(
		kind === "pull" ? "Pull requests" : "Issues",
		section,
		html`<div class="card">
	<div class="bar">
		<div class="row">${tab("open", `Open ${totals?.open ?? 0}`)}${tab("closed", `Closed ${totals?.closed ?? 0}`)}${tab("all", "All")}</div>
		<form method="get" action="${base}/${section}" class="row"><input type="hidden" name="state" value="${state}"><input type="search" name="q" value="${q}" placeholder="Search titles or #number" aria-label="Search ${noun}s"><button type="submit">Search</button></form>
	</div>
	${
		results.length
			? html`<div class="scroll"><table><tbody>${results.slice(0, PER_PAGE).map(
					(r) => html`<tr><td class="name"><a class="link" href="${base}/${section}/${r.number}">${r.title || "(no title)"}</a><div class="muted small">#${r.number} opened ${day(r.created_at)} by ${r.author ?? "unknown"} · updated ${ago(r.updated_at)}</div></td><td>${stateChip(r.state)}</td><td class="muted small">${r.comments ? `${r.comments} comment${r.comments === 1 ? "" : "s"}` : ""}</td></tr>`,
				)}</tbody></table></div>`
			: html`<p class="muted">${
					indexed || repo.meta_cursor === null
						? q || state !== "all"
							? `No ${noun}s match.`
							: `No ${noun}s in this backup.`
						: `This backup predates the ${noun} browser. Run a sync and its ${noun}s will appear here.`
				}</p>`
	}
	<div class="row">${pageNo > 0 ? html`<a class="btn" href="${query({ page: pageNo - 1 })}">Newer</a>` : ""}${results.length > PER_PAGE ? html`<a class="btn" href="${query({ page: pageNo + 1 })}">Older</a>` : ""}</div>
</div>`,
		200,
		CODE_CSP.replace("form-action 'none'", "form-action 'self'"),
	);
}
