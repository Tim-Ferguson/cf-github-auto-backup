import { appJwt } from "./crypto.ts";
import { getAllConfig } from "./db.ts";

const API = "https://api.github.com";
const USER_AGENT = "gh-backup (self-hosted Cloudflare Worker)";

export class GitHubError extends Error {
	constructor(
		public status: number,
		public path: string,
		body: string,
	) {
		super(`GitHub ${status} for ${path}: ${body.slice(0, 300)}`);
	}
}

export interface AppConfig {
	appId: string;
	slug: string;
	privateKey: string;
	clientId: string;
	clientSecret: string;
	webhookSecret: string;
}

/**
 * How this deployment reads GitHub. Either a GitHub App (read-only,
 * per-installation tokens, webhooks) or a single token supplied through the
 * CLI (from `gh auth token` or a personal access token).
 */
export interface Deployment {
	owner: string;
	app: AppConfig | null;
	token: string | null;
}

export async function loadDeployment(db: D1Database): Promise<Deployment | null> {
	const c = await getAllConfig(db);
	if (!c.owner) return null;
	const app: AppConfig | null =
		c.app_id && c.private_key
			? { appId: c.app_id, slug: c.app_slug, privateKey: c.private_key, clientId: c.client_id, clientSecret: c.client_secret, webhookSecret: c.webhook_secret }
			: null;
	const token = c.github_token ?? null;
	if (!app && !token) return null;
	return { owner: c.owner, app, token };
}

/** Token for reading one account's repositories; null means anonymous. */
export async function tokenFor(dep: Deployment, account: { installation_id: number | null } | null): Promise<string | null> {
	if (dep.app && account?.installation_id) return installationToken(dep.app, account.installation_id);
	return dep.token;
}

export function ghFetch(token: string | null, pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("User-Agent", USER_AGENT);
	if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
	headers.set("X-GitHub-Api-Version", "2022-11-28");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return fetch(pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl, { ...init, headers });
}

export async function gh<T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
	const res = await ghFetch(token, path, init);
	if (!res.ok) throw new GitHubError(res.status, path, await res.text());
	return res.json<T>();
}

function nextLink(res: Response): string | null {
	return /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("Link") ?? "")?.[1] ?? null;
}

/** One page of a list endpoint plus the URL of the next page, if any. */
export async function ghPage<T>(token: string | null, pathOrUrl: string): Promise<{ items: T[]; next: string | null }> {
	const res = await ghFetch(token, pathOrUrl);
	if (!res.ok) throw new GitHubError(res.status, pathOrUrl, await res.text());
	const body = await res.json<T[] | Record<string, unknown>>();
	// Some endpoints wrap the list: { total_count, repositories: [...] }.
	const items = Array.isArray(body) ? body : ((Object.values(body).find(Array.isArray) as T[] | undefined) ?? []);
	return { items, next: nextLink(res) };
}

export async function ghAll<T>(token: string | null, path: string): Promise<T[]> {
	const all: T[] = [];
	for (let url: string | null = path; url; ) {
		const page: { items: T[]; next: string | null } = await ghPage<T>(token, url);
		all.push(...page.items);
		url = page.next;
	}
	return all;
}

export async function installationToken(app: AppConfig, installationId: number): Promise<string> {
	const jwt = await appJwt(app.appId, app.privateKey);
	const res = await gh<{ token: string }>(jwt, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
	return res.token;
}

/** Header value git and the LFS API accept for an installation token. */
export function gitBasicAuth(token: string): string {
	return `Basic ${btoa(`x-access-token:${token}`)}`;
}

export interface GhInstallation {
	id: number;
	account: { login: string; type: "User" | "Organization" };
	suspended_at: string | null;
}

export interface GhRepo {
	id: number;
	full_name: string;
	private: boolean;
	fork: boolean;
	archived: boolean;
	has_wiki: boolean;
	default_branch: string;
	pushed_at: string | null;
	owner: { login: string; type: "User" | "Organization" };
}
