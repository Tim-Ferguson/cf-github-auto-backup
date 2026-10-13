// Backs up what `git clone` does not carry: issues, pull requests, reviews,
// comments, labels, milestones and releases. Each item is one JSON object in
// R2, exactly as the GitHub REST API returned it.

import { ghFetch, ghPage, GitHubError } from "./github.ts";
import { metaPrefix, putStream } from "./storage.ts";

/**
 * Layout version of the metadata in R2 and its index in D1. Repos synced
 * under an older version get one full metadata resync.
 *   1: comments are grouped by issue and pull request number, and issues,
 *      pull requests and releases are indexed in the meta_items table.
 */
export const META_VERSION = 1;

interface Item {
	id: number;
	number?: number;
	name?: string;
	title?: string;
	state?: string;
	tag_name?: string;
	draft?: boolean;
	prerelease?: boolean;
	user?: { login: string } | null;
	author?: { login: string } | null;
	created_at?: string;
	updated_at?: string;
	published_at?: string | null;
	merged_at?: string | null;
	comments?: number;
	pull_request?: unknown;
	issue_url?: string;
	pull_request_url?: string;
}

/** Row for the meta_items index, or null for resources that are not indexed. */
type IndexRow = { kind: "issue" | "pull" | "release"; number: number; title: string; state: string; author: string | null; created: string | null; updated: string | null; comments: number };

const trailingNumber = (url: string | undefined) => /\/(\d+)$/.exec(url ?? "")?.[1] ?? "0";

interface ReleaseAsset {
	id: number;
	name: string;
	size: number;
	url: string;
}

export interface Resource {
	name: string;
	/** First page; later pages come from the Link header. */
	path: (repo: string, since: string | null) => string;
	key: (item: Item) => string;
	/** For lists sorted newest-first without a `since` filter. */
	stopBefore?: boolean;
	extra?: (ctx: PageContext, item: Item) => Promise<void>;
	index?: (item: Item) => IndexRow;
}

interface PageContext {
	bucket: R2Bucket;
	token: string | null;
	fullName: string;
	prefix: string;
}

const sinceParam = (since: string | null) => (since ? `&since=${encodeURIComponent(since)}` : "");

export const RESOURCES: Resource[] = [
	{ name: "labels", path: (r) => `/repos/${r}/labels?per_page=100`, key: (i) => `labels/${i.id}.json` },
	{ name: "milestones", path: (r) => `/repos/${r}/milestones?state=all&per_page=100`, key: (i) => `milestones/${i.number}.json` },
	{
		name: "issues",
		path: (r, since) => `/repos/${r}/issues?state=all&sort=updated&direction=asc&per_page=100${sinceParam(since)}`,
		key: (i) => `issues/${i.number}.json`,
		// The issues API lists pull requests too; they share one number space.
		index: (i) => ({ kind: i.pull_request ? "pull" : "issue", number: i.number!, title: i.title ?? "", state: i.state ?? "open", author: i.user?.login ?? null, created: i.created_at ?? null, updated: i.updated_at ?? null, comments: i.comments ?? 0 }),
	},
	{
		name: "issue-comments",
		path: (r, since) => `/repos/${r}/issues/comments?sort=updated&direction=asc&per_page=100${sinceParam(since)}`,
		key: (i) => `issue-comments/${trailingNumber(i.issue_url)}/${i.id}.json`,
	},
	{
		name: "pulls",
		path: (r) => `/repos/${r}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
		key: (i) => `pulls/${i.number}.json`,
		stopBefore: true,
		index: (i) => ({ kind: "pull", number: i.number!, title: i.title ?? "", state: i.merged_at ? "merged" : (i.state ?? "open"), author: i.user?.login ?? null, created: i.created_at ?? null, updated: i.updated_at ?? null, comments: i.comments ?? 0 }),
		extra: async (ctx, pr) => {
			const reviews = await ghPage<unknown>(ctx.token, `/repos/${ctx.fullName}/pulls/${pr.number}/reviews?per_page=100`);
			if (reviews.items.length) await ctx.bucket.put(`${ctx.prefix}pull-reviews/${pr.number}.json`, JSON.stringify(reviews.items));
		},
	},
	{
		name: "pull-comments",
		path: (r, since) => `/repos/${r}/pulls/comments?sort=updated&direction=asc&per_page=100${sinceParam(since)}`,
		key: (i) => `pull-comments/${trailingNumber(i.pull_request_url)}/${i.id}.json`,
	},
	{
		name: "releases",
		path: (r) => `/repos/${r}/releases?per_page=100`,
		key: (i) => `releases/${i.id}.json`,
		index: (i) => ({ kind: "release", number: i.id, title: i.name || i.tag_name || "", state: i.draft ? "draft" : i.prerelease ? "prerelease" : "published", author: i.author?.login ?? null, created: i.created_at ?? null, updated: i.published_at ?? i.created_at ?? null, comments: 0 }),
		extra: async (ctx, release) => {
			for (const asset of (release as Item & { assets?: ReleaseAsset[] }).assets ?? []) {
				const key = `${ctx.prefix}release-assets/${asset.id}/${asset.name}`;
				if ((await ctx.bucket.head(key))?.size === asset.size) continue;
				const res = await ghFetch(ctx.token, asset.url, { headers: { Accept: "application/octet-stream" } });
				if (!res.ok || !res.body) throw new GitHubError(res.status, asset.url, await res.text());
				await putStream(ctx.bucket, key, res.body, asset.size);
			}
		},
	},
];

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

/**
 * Stores one page of a resource and returns the URL of the next page, or
 * null when the resource is finished (or not available for this repo).
 */
export async function syncMetadataPage(
	bucket: R2Bucket,
	token: string | null,
	fullName: string,
	resource: Resource,
	url: string | null,
	since: string | null,
	index?: { db: D1Database; repoId: number },
): Promise<{ next: string | null; stored: number }> {
	const ctx: PageContext = { bucket, token, fullName, prefix: metaPrefix(fullName) };
	let page: { items: Item[]; next: string | null };
	try {
		page = await ghPage<Item>(token, url ?? resource.path(fullName, since));
	} catch (err) {
		// Issues disabled (410), feature off or not permitted (403/404): skip.
		if (err instanceof GitHubError && [403, 404, 410, 451].includes(err.status)) return { next: null, stored: 0 };
		throw err;
	}

	let items = page.items;
	let done = false;
	if (resource.stopBefore && since) {
		const fresh = items.filter((i) => !i.updated_at || i.updated_at >= since);
		done = fresh.length < items.length;
		items = fresh;
	}
	await pool(items, 5, async (item) => {
		await bucket.put(ctx.prefix + resource.key(item), JSON.stringify(item));
		await resource.extra?.(ctx, item);
	});
	const indexRow = resource.index;
	if (index && indexRow && items.length) {
		// The issues listing reports a merged pull request as plain "closed";
		// keep "merged" once the pulls listing has said so.
		const upsert = index.db.prepare(
			`INSERT INTO meta_items (repo_id, kind, number, title, state, author, created_at, updated_at, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (repo_id, kind, number) DO UPDATE SET title = excluded.title, author = excluded.author, created_at = excluded.created_at, updated_at = excluded.updated_at,
				comments = MAX(meta_items.comments, excluded.comments),
				state = CASE WHEN meta_items.state = 'merged' AND excluded.state = 'closed' THEN 'merged' ELSE excluded.state END`,
		);
		const rows = items.map(indexRow);
		for (let i = 0; i < rows.length; i += 50) {
			await index.db.batch(rows.slice(i, i + 50).map((r) => upsert.bind(index.repoId, r.kind, r.number, r.title.slice(0, 500), r.state, r.author, r.created, r.updated, r.comments)));
		}
	}
	return { next: done ? null : page.next, stored: items.length };
}

/**
 * Moves comment files written before they were grouped by issue number to
 * their new place. Nothing is dropped: a comment since deleted on GitHub
 * exists only here, so each file is copied before its old key is removed.
 */
export async function regroupFlatComments(bucket: R2Bucket, fullName: string): Promise<number> {
	let moved = 0;
	for (const [dir, parent] of [
		["issue-comments/", "issue_url"],
		["pull-comments/", "pull_request_url"],
	] as const) {
		const prefix = metaPrefix(fullName) + dir;
		let cursor: string | undefined;
		do {
			// The delimiter limits the listing to files directly in the folder.
			const page = await bucket.list({ prefix, delimiter: "/", cursor });
			for (const object of page.objects) {
				const body = await bucket.get(object.key);
				if (!body) continue;
				const text = await body.text();
				let number = "0";
				try {
					number = trailingNumber((JSON.parse(text) as Item)[parent]);
				} catch {
					// Unreadable JSON is kept as it is, under 0/.
				}
				await bucket.put(`${prefix}${number}/${object.key.slice(prefix.length)}`, text);
				await bucket.delete(object.key);
				moved++;
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	return moved;
}
