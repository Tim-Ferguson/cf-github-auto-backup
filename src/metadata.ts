// Backs up what `git clone` does not carry: issues, pull requests, reviews,
// comments, labels, milestones and releases. Each item is one JSON object in
// R2, exactly as the GitHub REST API returned it.

import { ghFetch, ghPage, GitHubError } from "./github.ts";
import { metaPrefix, putStream } from "./storage.ts";

interface Item {
	id: number;
	number?: number;
	name?: string;
	updated_at?: string;
}

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
	},
	{
		name: "issue-comments",
		path: (r, since) => `/repos/${r}/issues/comments?sort=updated&direction=asc&per_page=100${sinceParam(since)}`,
		key: (i) => `issue-comments/${i.id}.json`,
	},
	{
		name: "pulls",
		path: (r) => `/repos/${r}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
		key: (i) => `pulls/${i.number}.json`,
		stopBefore: true,
		extra: async (ctx, pr) => {
			const reviews = await ghPage<unknown>(ctx.token, `/repos/${ctx.fullName}/pulls/${pr.number}/reviews?per_page=100`);
			if (reviews.items.length) await ctx.bucket.put(`${ctx.prefix}pull-reviews/${pr.number}.json`, JSON.stringify(reviews.items));
		},
	},
	{
		name: "pull-comments",
		path: (r, since) => `/repos/${r}/pulls/comments?sort=updated&direction=asc&per_page=100${sinceParam(since)}`,
		key: (i) => `pull-comments/${i.id}.json`,
	},
	{
		name: "releases",
		path: (r) => `/repos/${r}/releases?per_page=100`,
		key: (i) => `releases/${i.id}.json`,
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
	return { next: done ? null : page.next, stored: items.length };
}
