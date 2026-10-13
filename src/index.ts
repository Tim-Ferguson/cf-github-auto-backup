import { appJwt, hmacHex, randomToken, sha256Hex, sign, timingSafeEqual, unsign } from "./crypto.ts";
import { ensureSchema, getAccount, getAllConfig, getConfig, getRepo, isBackedUp, listAccounts, listRepos, type Repo, type Run, setConfig, updateRepo } from "./db.ts";
import { discover, queueDue, startBackup } from "./discovery.ts";
import { type AppConfig, type Deployment, gh, GitHubError, loadDeployment } from "./github.ts";
import { handleCode, serveAsset } from "./code.ts";
import { handleMeta, metaCounts } from "./metaview.ts";
import { admit, clientAddress, pruneFailures, succeeded } from "./ratelimit.ts";
import { lfsKey, lfsManifestKey, metaPrefix } from "./storage.ts";
import { type CloneInfo, dashboardPage, lockedPage, loginPage, messagePage, repoPage, setupPage } from "./ui.ts";

export { GitRunner } from "./runner.ts";
export { BackupWorkflow } from "./workflow.ts";

const SESSION_COOKIE = "ghb_session";
const STATE_COOKIE = "ghb_state";
const SESSION_TTL = 30 * 24 * 60 * 60;
/** Session identity of someone who signed in with the deployment password. */
const ADMIN = "*admin";
const MIN_PASSWORD_LENGTH = 12;

function cookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") ?? "").split(/;\s*/)) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
	}
}

function setCookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: string[] = []): Response {
	const headers = new Headers({ Location: location });
	for (const c of cookies) headers.append("Set-Cookie", c);
	return new Response(null, { status: 302, headers });
}

const flash = (path: string, message: string) => redirect(`${path}?m=${encodeURIComponent(message)}`);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Signs cookies. Created on first use, before anything else is configured. */
async function sessionSecret(db: D1Database): Promise<string> {
	const existing = await getConfig(db, "session_secret");
	if (existing) return existing;
	await db.prepare(`INSERT INTO config (key, value) VALUES ('session_secret', ?) ON CONFLICT (key) DO NOTHING`).bind(randomToken(32)).run();
	return (await getConfig(db, "session_secret"))!;
}

async function newState(secret: string): Promise<{ state: string; cookie: string }> {
	const state = randomToken(16);
	return { state, cookie: setCookie(STATE_COOKIE, await sign(secret, { state }, 900), 900) };
}

async function checkState(request: Request, secret: string, state: string | null): Promise<boolean> {
	const saved = await unsign<{ state: string }>(secret, cookie(request, STATE_COOKIE));
	return !!saved && !!state && timingSafeEqual(saved.state, state);
}

/** Browsers label where a request came from; fall back to Origin for older ones. */
function isSameOrigin(request: Request, url: URL): boolean {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site) return site === "same-origin";
	return request.headers.get("Origin") === url.origin;
}

/**
 * The ADMIN_PASSWORD secret is set at deploy time, so there is never a moment
 * when a stranger who finds the URL could claim the deployment. Without a
 * usable password everything stays locked.
 */
function deploymentPassword(env: Env): string | null {
	const password = (env as { ADMIN_PASSWORD?: string }).ADMIN_PASSWORD;
	return password && password.length >= MIN_PASSWORD_LENGTH ? password : null;
}

async function isPassword(password: string, candidate: string | null | undefined): Promise<boolean> {
	// Hash both sides so the comparison is constant-time whatever the lengths.
	return !!candidate && timingSafeEqual(await sha256Hex(password), await sha256Hex(candidate));
}

async function refresh(env: Env, dep: Deployment, trigger: string): Promise<{ accounts: number; repos: number; queued: number }> {
	try {
		const found = await discover(env, dep);
		return { ...found, queued: await queueDue(env, trigger) };
	} catch (err) {
		// GitHub being unreachable must not stop known repos from syncing.
		await queueDue(env, trigger).catch(() => {});
		throw err;
	}
}

const refreshLater = (env: Env, ctx: ExecutionContext, dep: Deployment, trigger: string) =>
	ctx.waitUntil(refresh(env, dep, trigger).catch((err) => console.error(`refresh (${trigger}) failed`, err)));

/**
 * Notices when the deployment is being served from a new address (it was
 * renamed or given a custom domain) and points the GitHub App's webhook at
 * it. The app's sign-in callback can only be changed by hand on GitHub, so
 * the old address is remembered for a reminder on the dashboard.
 */
async function adoptOrigin(env: Env, dep: Deployment, origin: string): Promise<void> {
	const known = await getConfig(env.DB, "base_url");
	if (known === origin) return;
	try {
		if (dep.app) {
			await gh(await appJwt(dep.app.appId, dep.app.privateKey), "/app/hook/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: `${origin}/webhooks/github` }),
			});
		}
		await setConfig(env.DB, { base_url: origin, ...(known && dep.app ? { moved_from: known } : {}) });
	} catch (err) {
		console.error("could not point the GitHub App at the new address", err);
	}
}

// --- Actions shared by the dashboard forms and the JSON API ---

const isOn = (value: unknown) => value === true || value === 1 || value === "1";

/**
 * Account settings. `auto_public` and `auto_private` decide whether repos
 * discovered from now on start out backed up; `auto_all` sets both.
 * `select` switches every repo the account already has: "all" or "none".
 */
async function setAccount(env: Env, login: string, fields: Record<string, unknown>): Promise<boolean> {
	const account = await getAccount(env.DB, login);
	if (!account) return false;
	const changes: Record<string, number> = {};
	if (fields.auto_all !== undefined && fields.auto_all !== null) changes.auto_public = changes.auto_private = isOn(fields.auto_all) ? 1 : 0;
	for (const field of ["auto_public", "auto_private", "include_forks"] as const) {
		if (fields[field] !== undefined && fields[field] !== null) changes[field] = isOn(fields[field]) ? 1 : 0;
	}
	for (const [field, value] of Object.entries(changes)) {
		await env.DB.prepare(`UPDATE accounts SET ${field} = ? WHERE login = ?`).bind(value, login).run();
	}
	if (fields.select === "all") {
		const forks = (changes.include_forks ?? account.include_forks) === 1;
		await env.DB.prepare(`UPDATE repos SET override = 1 WHERE account = ? AND gone_at IS NULL ${forks ? "" : "AND fork = 0"}`).bind(login).run();
	} else if (fields.select === "none") {
		await env.DB.prepare(`UPDATE repos SET override = 0 WHERE account = ?`).bind(login).run();
	}
	return true;
}

const parseOverride = (value: unknown): 0 | 1 => (isOn(value) ? 1 : 0);

async function cloneCommands(env: Env, repo: Repo): Promise<CloneInfo[]> {
	const out: CloneInfo[] = [];
	if (!repo.artifacts_name) return out;
	for (const [label, name] of [
		["Repository", repo.artifacts_name],
		["Wiki", `${repo.artifacts_name}.wiki`],
	]) {
		let handle: ArtifactsRepo;
		try {
			handle = await env.ARTIFACTS.get(name);
		} catch {
			continue;
		}
		try {
			const info = await handle.info();
			const token = await handle.createToken("read", 3600);
			// Basic auth takes the token without its ?expires= suffix.
			const secret = token.plaintext.split("?")[0];
			out.push({ label, command: `git clone --mirror https://x:${secret}@${info.remote.replace(/^https:\/\//, "")}`, expiresAt: token.expiresAt });
		} finally {
			handle[Symbol.dispose]();
		}
	}
	return out;
}

// --- GitHub App creation (browser) ---

async function handleSetup(request: Request, env: Env, url: URL, secret: string): Promise<Response> {
	if (url.pathname === "/setup") {
		const { state, cookie: stateCookie } = await newState(secret);
		const manifest = {
			name: `gh-backup-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`,
			url: url.origin,
			description: "Personal, self-hosted backup of my repositories to Cloudflare.",
			hook_attributes: { url: `${url.origin}/webhooks/github`, active: true },
			redirect_url: `${url.origin}/setup/callback`,
			callback_urls: [`${url.origin}/auth/callback`],
			setup_url: `${url.origin}/setup/installed`,
			setup_on_update: true,
			public: true,
			default_permissions: { contents: "read", metadata: "read", issues: "read", pull_requests: "read" },
			default_events: ["push", "repository"],
		};
		const res = setupPage(url.origin, state, manifest);
		res.headers.append("Set-Cookie", stateCookie);
		return res;
	}

	if (url.pathname === "/setup/callback") {
		const code = url.searchParams.get("code");
		if (!code || !(await checkState(request, secret, url.searchParams.get("state")))) {
			return messagePage("Setup link expired", "Start the setup again from the beginning.", 400, { href: "/setup", label: "Restart setup" });
		}
		const created = await gh<{
			id: number;
			slug: string;
			pem: string;
			webhook_secret: string;
			client_id: string;
			client_secret: string;
			owner: { login: string; id: number };
		}>(null, `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
		await setConfig(env.DB, {
			app_id: String(created.id),
			app_slug: created.slug,
			private_key: created.pem,
			webhook_secret: created.webhook_secret,
			client_id: created.client_id,
			client_secret: created.client_secret,
			owner: created.owner.login,
			owner_id: String(created.owner.id),
			// A token used before the app existed is no longer needed, and may
			// carry far more access than the app does.
			github_token: null,
		});
		// Whoever just created the app is the owner, so sign them in directly.
		const session = await sign(secret, { login: created.owner.login }, SESSION_TTL);
		return redirect(`https://github.com/apps/${created.slug}/installations/new`, [setCookie(SESSION_COOKIE, session, SESSION_TTL), setCookie(STATE_COOKIE, "", 0)]);
	}

	return redirect("/setup");
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext, dep: Deployment, app: AppConfig): Promise<Response> {
	const body = await request.text();
	const expected = `sha256=${await hmacHex(app.webhookSecret, body)}`;
	if (!timingSafeEqual(expected, request.headers.get("X-Hub-Signature-256") ?? "")) return new Response("bad signature", { status: 401 });

	const event = request.headers.get("X-GitHub-Event");
	const payload = JSON.parse(body) as { repository?: { id: number } };
	if (event === "push" && payload.repository) {
		const repo = await getRepo(env.DB, payload.repository.id);
		const account = repo && (await getAccount(env.DB, repo.account));
		if (repo && isBackedUp(repo, account ?? undefined)) {
			// Marks the push as not yet fetched. A sync clears this when it
			// starts, and runs again at its end if it was set meanwhile.
			await env.DB.prepare(`UPDATE repos SET dirty = 1 WHERE id = ?`).bind(repo.id).run();
			// Bursts of pushes collapse into one sync per two-minute window.
			await startBackup(env, repo.id, "push", { force: true, dedupe: `push-${Math.floor(Date.now() / 120_000)}` });
		}
	} else if (event === "installation" || event === "installation_repositories" || event === "repository") {
		refreshLater(env, ctx, dep, "webhook");
	}
	return new Response("ok");
}

/** Sign-in with GitHub, available once a GitHub App exists. */
async function handleOAuth(request: Request, env: Env, url: URL, dep: Deployment, app: AppConfig, secret: string): Promise<Response> {
	if (url.pathname === "/auth/login") {
		const { state, cookie: stateCookie } = await newState(secret);
		const target = new URL("https://github.com/login/oauth/authorize");
		target.searchParams.set("client_id", app.clientId);
		target.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
		target.searchParams.set("state", state);
		return redirect(target.toString(), [stateCookie]);
	}

	const code = url.searchParams.get("code");
	if (!code || !(await checkState(request, secret, url.searchParams.get("state")))) {
		return messagePage("Sign-in expired", "Please try signing in again.", 400, { href: "/", label: "Sign in" });
	}
	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: `${url.origin}/auth/callback` }),
	});
	const token = (await tokenRes.json<{ access_token?: string }>()).access_token;
	if (!token) return messagePage("Sign-in failed", "GitHub did not accept the sign-in. Please try again.", 400, { href: "/", label: "Sign in" });
	const user = await gh<{ login: string; id: number }>(token, "/user");
	// The numeric id is the identity. A login can be given up and registered
	// by someone else; an id cannot.
	const isOwner = dep.ownerId ? user.id === dep.ownerId : user.login.toLowerCase() === dep.owner.toLowerCase();
	if (!isOwner) {
		return messagePage("Not your backup", `This deployment belongs to ${dep.owner}. You are signed in to GitHub as ${user.login}.`, 403);
	}
	if (!dep.ownerId || user.login !== dep.owner) await setConfig(env.DB, { owner: user.login, owner_id: String(user.id) });
	const session = await sign(secret, { login: user.login }, SESSION_TTL);
	return redirect("/", [setCookie(SESSION_COOKIE, session, SESSION_TTL), setCookie(STATE_COOKIE, "", 0)]);
}

// --- JSON API for the CLI, authenticated with the deployment password ---

async function handleApi(request: Request, env: Env, url: URL, dep: Deployment | null, password: string): Promise<Response> {
	const path = url.pathname.slice("/api".length);
	const post = request.method === "POST";

	const bearer = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
	if (!bearer) return json({ error: "missing password" }, 401);
	const address = clientAddress(request);
	const wait = await admit(env.DB, address);
	if (wait > 0) return Response.json({ error: `too many wrong passwords; try again in ${Math.ceil(wait / 60)} minute(s)` }, { status: 429, headers: { "Retry-After": String(wait) } });
	if (!(await isPassword(password, bearer))) return json({ error: "wrong password" }, 401);
	await succeeded(env.DB, address);
	// Nothing from the request is read until the caller has proved who they are.
	const body = post ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

	if (path === "/github-token" && post) {
		const token = body.token;
		if (typeof token !== "string" || !token) return json({ error: "token is required" }, 400);
		let user: { login: string; id: number };
		try {
			user = await gh<{ login: string; id: number }>(token, "/user");
		} catch (err) {
			return json({ error: `GitHub rejected the token: ${errorText(err)}` }, 400);
		}
		if (dep && (dep.ownerId ? dep.ownerId !== user.id : dep.owner.toLowerCase() !== user.login.toLowerCase())) {
			return json({ error: `this deployment belongs to ${dep.owner}, but the token is for ${user.login}` }, 409);
		}
		await setConfig(env.DB, { github_token: token, owner: user.login, owner_id: String(user.id) });
		const next = (await loadDeployment(env.DB))!;
		return json({ owner: user.login, ...(await refresh(env, next, "setup")) });
	}

	if (path === "/status" && !post) {
		if (dep) await adoptOrigin(env, dep, url.origin);
		const [accounts, repos, config] = await Promise.all([listAccounts(env.DB), listRepos(env.DB), getAllConfig(env.DB)]);
		const byLogin = new Map(accounts.map((a) => [a.login, a]));
		return json({
			configured: !!dep,
			mode: dep?.app ? "app" : dep?.token ? "token" : null,
			owner: dep?.owner ?? null,
			app_slug: dep?.app?.slug ?? null,
			last_discovery_at: config.last_discovery_at ?? null,
			github_error: config.github_error ?? null,
			github_error_since: config.github_error_since ?? null,
			accounts,
			repos: repos.map((r) => ({ ...r, backed_up: isBackedUp(r, byLogin.get(r.account)) })),
		});
	}

	if (!dep) return json({ error: "GitHub is not connected yet" }, 409);

	if (path === "/discover" && post) {
		try {
			return json(await refresh(env, dep, "manual"));
		} catch (err) {
			return json({ error: errorText(err) }, err instanceof GitHubError ? 502 : 500);
		}
	}
	if (path === "/sync-all" && post) return json({ queued: await queueDue(env, "manual", { all: true }) });

	const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
	if (accountMatch && post) {
		if (!(await setAccount(env, decodeURIComponent(accountMatch[1]), body))) return json({ error: "no such account" }, 404);
		if (body.auto_public !== undefined || body.auto_all !== undefined) return json(await refresh(env, dep, "settings"));
		return json({ queued: await queueDue(env, "settings") });
	}

	// Read access to everything a restore needs besides git itself.
	const lfsMatch = /^\/lfs\/([0-9a-f]{64})$/.exec(path);
	if (lfsMatch && !post) {
		const object = await env.BUCKET.get(lfsKey(lfsMatch[1]));
		return object ? new Response(object.body, { headers: { "content-type": "application/octet-stream", "content-length": String(object.size) } }) : json({ error: "not in this backup" }, 404);
	}
	const exportMatch = /^\/repos\/(\d+)\/(files|file|lfs)$/.exec(path);
	if (exportMatch && !post) {
		const repo = await getRepo(env.DB, Number(exportMatch[1]));
		if (!repo) return json({ error: "no such repository" }, 404);
		const prefix = metaPrefix(repo);
		if (exportMatch[2] === "lfs") {
			const manifest = await env.BUCKET.get(lfsManifestKey(repo.id));
			return json(manifest ? await manifest.json() : []);
		}
		if (exportMatch[2] === "files") {
			const listing = await env.BUCKET.list({ prefix: prefix + (url.searchParams.get("prefix") ?? ""), cursor: url.searchParams.get("cursor") ?? undefined });
			return json({ files: listing.objects.map((o) => ({ key: o.key.slice(prefix.length), size: o.size })), cursor: listing.truncated ? listing.cursor : null });
		}
		const object = await env.BUCKET.get(prefix + (url.searchParams.get("key") ?? ""));
		if (!object) return json({ error: "not in this backup" }, 404);
		return new Response(object.body, { headers: { "content-type": "application/octet-stream", "content-length": String(object.size), "cache-control": "no-store" } });
	}

	const repoMatch = /^\/repos\/(\d+)(?:\/(sync|clone-token))?$/.exec(path);
	if (repoMatch && post) {
		const repo = await getRepo(env.DB, Number(repoMatch[1]));
		if (!repo) return json({ error: "no such repository" }, 404);
		if (repoMatch[2] === "sync") {
			await startBackup(env, repo.id, "manual", { force: true });
			return json({ ok: true });
		}
		if (repoMatch[2] === "clone-token") return json({ storage: repo.storage, clones: await cloneCommands(env, repo) });
		await updateRepo(env.DB, repo.id, { override: parseOverride(body.override) });
		return json({ queued: await queueDue(env, "settings") });
	}

	return json({ error: "not found" }, 404);
}

// --- Dashboard ---

async function handleApp(request: Request, env: Env, ctx: ExecutionContext, url: URL, dep: Deployment, signedInAs: string): Promise<Response> {
	const path = url.pathname;
	const post = request.method === "POST";
	const message = url.searchParams.get("m");

	if (path === "/setup/installed") {
		refreshLater(env, ctx, dep, "install");
		return flash("/", "Installation updated. Repositories will appear here within a minute; reload to see them.");
	}

	if (path === "/dismiss-move" && post) {
		await setConfig(env.DB, { moved_from: null });
		return redirect("/");
	}

	if (path === "/" && !post) {
		await adoptOrigin(env, dep, url.origin);
		if (!dep.ownerId) {
			// Deployments set up before ids were recorded: pin the owner's id now.
			const found = await gh<{ id: number }>(null, `/users/${encodeURIComponent(dep.owner)}`).catch(() => null);
			if (found) await setConfig(env.DB, { owner_id: String(found.id) });
		}
		const [accounts, repos, config] = await Promise.all([listAccounts(env.DB), listRepos(env.DB), getAllConfig(env.DB)]);
		return dashboardPage({ origin: url.origin, owner: dep.owner, signedInAs: signedInAs === ADMIN ? "the password" : `GitHub (${signedInAs})`, slug: dep.app?.slug ?? null, accounts, repos, config, flash: message });
	}

	if (path === "/discover" && post) {
		try {
			const found = await refresh(env, dep, "manual");
			return flash("/", `Found ${found.repos} repositories across ${found.accounts} account(s); ${found.queued} sync(s) queued.`);
		} catch (err) {
			return flash("/", `GitHub refused the request: ${errorText(err)}`);
		}
	}

	if (path === "/sync-all" && post) {
		const queued = await queueDue(env, "manual", { all: true });
		return flash("/", `${queued} sync(s) queued.`);
	}

	const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
	if (accountMatch && post) {
		const form = await request.formData();
		await setAccount(env, decodeURIComponent(accountMatch[1]), Object.fromEntries(form));
		// Switching on starred repos needs a listing; anything else just needs queueing.
		if (form.has("auto_public") || form.has("auto_all")) refreshLater(env, ctx, dep, "settings");
		else ctx.waitUntil(queueDue(env, "settings").catch((err) => console.error("queueing after settings change failed", err)));
		return redirect("/");
	}

	const metaMatch = /^\/repos\/(\d+)\/(issues|pulls|releases|asset)(?:\/(.+))?$/.exec(path);
	if (metaMatch && !post) {
		const repo = await getRepo(env.DB, Number(metaMatch[1]));
		if (!repo) return messagePage("Not found", "No such repository.", 404, { href: "/", label: "Back" });
		const rest = (metaMatch[3] ?? "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
		return handleMeta(env, url, repo, metaMatch[2] as "issues" | "pulls" | "releases" | "asset", rest);
	}

	const repoMatch = /^\/repos\/(\d+)(?:\/(override|sync|token|code|blob|raw|commits|tree))?$/.exec(path);
	if (repoMatch) {
		const id = Number(repoMatch[1]);
		const action = repoMatch[2];
		const repo = await getRepo(env.DB, id);
		if (!repo) return messagePage("Not found", "No such repository.", 404, { href: "/", label: "Back" });
		if (action === "code" || action === "blob" || action === "raw" || action === "commits" || action === "tree") {
			return post ? redirect(`/repos/${id}/code`) : handleCode(env, url, repo, action);
		}

		if (action === "override" && post) {
			await updateRepo(env.DB, id, { override: parseOverride((await request.formData()).get("override")) });
			ctx.waitUntil(queueDue(env, "settings").catch((err) => console.error("queueing after override failed", err)));
			return redirect("/");
		}
		if (action === "sync" && post) {
			await startBackup(env, id, "manual", { force: true });
			return flash(`/repos/${id}`, "Sync started. Reload in a moment to see the result.");
		}

		let clones: CloneInfo[] | null = null;
		if (action === "token" && post) clones = await cloneCommands(env, repo);
		else if (action) return redirect(`/repos/${id}`);

		const [account, runs, bundles, counts] = await Promise.all([
			getAccount(env.DB, repo.account),
			env.DB.prepare(`SELECT * FROM runs WHERE repo_id = ? ORDER BY id DESC LIMIT 20`).bind(id).all<Run>(),
			repo.storage === "r2-bundle" ? env.BUCKET.list({ prefix: `bundles/${id}/` }) : null,
			metaCounts(env.DB, id),
		]);
		return repoPage({ repo, account, runs: runs.results, clones, bundles: bundles?.objects.map((o) => o.key).sort().reverse() ?? [], flash: message, counts });
	}

	return messagePage("Not found", "There is nothing at this address.", 404, { href: "/", label: "Back" });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === "/healthz") return new Response("ok");
		if (path === "/favicon.ico") return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } });
		const asset = path.startsWith("/assets/") ? serveAsset(path) : null;
		if (asset) return asset;
		try {
			await ensureSchema(env.DB);
			const dep = await loadDeployment(env.DB);
			if (path === "/webhooks/github" && request.method === "POST" && dep?.app) return await handleWebhook(request, env, ctx, dep, dep.app);

			const password = deploymentPassword(env);
			if (!password) {
				if (path.startsWith("/api/")) return json({ error: "locked: set the ADMIN_PASSWORD secret" }, 503);
				return lockedPage(MIN_PASSWORD_LENGTH);
			}
			if (path.startsWith("/api/")) return await handleApi(request, env, url, dep, password);

			// Session cookies are SameSite=Lax; this covers the rest.
			if (request.method === "POST" && !isSameOrigin(request, url)) {
				return new Response("cross-origin request refused", { status: 403 });
			}

			// The password is part of the cookie key, so changing it signs
			// everyone out, including any session an attacker may hold.
			const secret = `${await sessionSecret(env.DB)}:${await sha256Hex(password)}`;
			if (path === "/auth/logout" && request.method === "POST") return redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);
			if (path === "/auth/token" && request.method === "POST") {
				const given = (await request.formData()).get("password");
				const address = clientAddress(request);
				const wait = await admit(env.DB, address);
				if (wait > 0) {
					const res = messagePage("Too many attempts", `Password sign-in is paused for about ${Math.ceil(wait / 60)} minute(s) after repeated wrong passwords.`, 429, { href: "/", label: "Back" });
					res.headers.set("Retry-After", String(wait));
					return res;
				}
				if (!(await isPassword(password, typeof given === "string" ? given : null))) {
					return messagePage("Wrong password", "That is not this deployment's password.", 401, { href: "/", label: "Try again" });
				}
				await succeeded(env.DB, address);
				return redirect("/", [setCookie(SESSION_COOKIE, await sign(secret, { login: ADMIN }, SESSION_TTL), SESSION_TTL)]);
			}
			if ((path === "/auth/login" || path === "/auth/callback") && dep?.app) return await handleOAuth(request, env, url, dep, dep.app, secret);

			const session = await unsign<{ login: string }>(secret, cookie(request, SESSION_COOKIE));
			const signedIn = !!session && (session.login === ADMIN || (!!dep && session.login.toLowerCase() === dep.owner.toLowerCase()));

			if (!dep) {
				// Only someone who knows the password can connect GitHub.
				if (!signedIn) return path === "/" ? loginPage(null, { github: false }) : redirect("/");
				return await handleSetup(request, env, url, secret);
			}
			if (!signedIn) return path === "/" ? loginPage(dep.owner, { github: !!dep.app }) : redirect("/");
			// A token-mode deployment can still be upgraded to a GitHub App.
			if (!dep.app && (path === "/setup" || path === "/setup/callback")) return await handleSetup(request, env, url, secret);
			return await handleApp(request, env, ctx, url, dep, session!.login);
		} catch (err) {
			console.error(err);
			if (path.startsWith("/api/")) return json({ error: errorText(err) }, 500);
			return messagePage("Something went wrong", errorText(err), 500, { href: "/", label: "Back" });
		}
	},

	async scheduled(_controller, env): Promise<void> {
		await ensureSchema(env.DB);
		await pruneFailures(env.DB);
		const dep = await loadDeployment(env.DB);
		if (dep) await refresh(env, dep, "schedule");
	},
} satisfies ExportedHandler<Env>;
