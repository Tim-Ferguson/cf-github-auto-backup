import { hmacHex, randomToken, sha256Hex, sign, timingSafeEqual, unsign } from "./crypto.ts";
import { ensureSchema, getAccount, getAllConfig, getConfig, getRepo, isBackedUp, listAccounts, listRepos, type Repo, type Run, setConfig, updateRepo } from "./db.ts";
import { discover, queueDue, startBackup } from "./discovery.ts";
import { type AppConfig, type Deployment, gh, GitHubError, loadDeployment } from "./github.ts";
import { type CloneInfo, dashboardPage, loginPage, messagePage, repoPage, setupPage } from "./ui.ts";

export { GitRunner } from "./runner.ts";
export { BackupWorkflow } from "./workflow.ts";

const SESSION_COOKIE = "ghb_session";
const STATE_COOKIE = "ghb_state";
const SESSION_TTL = 30 * 24 * 60 * 60;
/** Session identity of someone who signed in with the CLI's admin token. */
const ADMIN = "*admin";

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

async function isAdminToken(adminHash: string | undefined, token: string | null | undefined): Promise<boolean> {
	return !!adminHash && !!token && timingSafeEqual(adminHash, await sha256Hex(token));
}

async function refresh(env: Env, dep: Deployment, trigger: string): Promise<{ accounts: number; repos: number; queued: number }> {
	const found = await discover(env, dep);
	return { ...found, queued: await queueDue(env, trigger) };
}

const refreshLater = (env: Env, ctx: ExecutionContext, dep: Deployment, trigger: string) =>
	ctx.waitUntil(refresh(env, dep, trigger).catch((err) => console.error(`refresh (${trigger}) failed`, err)));

// --- Actions shared by the dashboard forms and the JSON API ---

async function setAccount(env: Env, login: string, fields: { enabled?: unknown; include_forks?: unknown }): Promise<boolean> {
	if (!(await getAccount(env.DB, login))) return false;
	for (const field of ["enabled", "include_forks"] as const) {
		const value = fields[field];
		if (value === undefined || value === null) continue;
		const on = value === true || value === 1 || value === "1";
		await env.DB.prepare(`UPDATE accounts SET ${field} = ? WHERE login = ?`).bind(on ? 1 : 0, login).run();
	}
	return true;
}

function parseOverride(value: unknown): 0 | 1 | null {
	if (value === 1 || value === "1" || value === true) return 1;
	if (value === 0 || value === "0" || value === false) return 0;
	return null;
}

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
			if (!info.lastPushAt) continue;
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
			owner: { login: string };
		}>(null, `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
		await setConfig(env.DB, {
			app_id: String(created.id),
			app_slug: created.slug,
			private_key: created.pem,
			webhook_secret: created.webhook_secret,
			client_id: created.client_id,
			client_secret: created.client_secret,
			owner: created.owner.login,
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
			// Bursts of pushes collapse into one sync per two-minute window.
			await startBackup(env, repo.id, "push", { force: true, dedupe: `push-${Math.floor(Date.now() / 120_000)}` });
		}
	} else if (event === "installation" || event === "installation_repositories" || event === "repository") {
		refreshLater(env, ctx, dep, "webhook");
	}
	return new Response("ok");
}

/** Sign-in with GitHub, available once a GitHub App exists. */
async function handleOAuth(request: Request, url: URL, dep: Deployment, app: AppConfig, secret: string): Promise<Response> {
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
	const user = await gh<{ login: string }>(token, "/user");
	if (user.login.toLowerCase() !== dep.owner.toLowerCase()) {
		return messagePage("Not your backup", `This deployment belongs to ${dep.owner}. You are signed in to GitHub as ${user.login}.`, 403);
	}
	const session = await sign(secret, { login: user.login }, SESSION_TTL);
	return redirect("/", [setCookie(SESSION_COOKIE, session, SESSION_TTL), setCookie(STATE_COOKIE, "", 0)]);
}

// --- JSON API for the CLI, authenticated with the admin token ---

async function handleApi(request: Request, env: Env, url: URL, dep: Deployment | null, adminHash: string | undefined): Promise<Response> {
	const path = url.pathname.slice("/api".length);
	const post = request.method === "POST";
	const body = post ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

	if (path === "/bootstrap" && post) {
		// Same first-come rule as the browser setup: only an unclaimed
		// deployment accepts an admin token.
		if (adminHash || dep) return json({ error: "this deployment is already set up" }, 409);
		const hash = body.admin_token_hash;
		if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return json({ error: "admin_token_hash must be a SHA-256 hex digest" }, 400);
		await setConfig(env.DB, { admin_token_hash: hash });
		return json({ ok: true });
	}

	const bearer = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
	if (!(await isAdminToken(adminHash, bearer))) return json({ error: "missing or wrong admin token" }, 401);

	if (path === "/github-token" && post) {
		const token = body.token;
		if (typeof token !== "string" || !token) return json({ error: "token is required" }, 400);
		let user: { login: string };
		try {
			user = await gh<{ login: string }>(token, "/user");
		} catch (err) {
			return json({ error: `GitHub rejected the token: ${errorText(err)}` }, 400);
		}
		if (dep && dep.owner.toLowerCase() !== user.login.toLowerCase()) {
			return json({ error: `this deployment belongs to ${dep.owner}, but the token is for ${user.login}` }, 409);
		}
		await setConfig(env.DB, { github_token: token, owner: user.login });
		const next = (await loadDeployment(env.DB))!;
		return json({ owner: user.login, ...(await refresh(env, next, "setup")) });
	}

	if (path === "/status" && !post) {
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
		return json(await refresh(env, dep, "settings"));
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

	if (path === "/" && !post) {
		const [accounts, repos, config] = await Promise.all([listAccounts(env.DB), listRepos(env.DB), getAllConfig(env.DB)]);
		return dashboardPage({ owner: dep.owner, signedInAs: signedInAs === ADMIN ? "admin token" : signedInAs, slug: dep.app?.slug ?? null, accounts, repos, config, flash: message });
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
		await setAccount(env, decodeURIComponent(accountMatch[1]), { enabled: form.get("enabled"), include_forks: form.get("include_forks") });
		refreshLater(env, ctx, dep, "settings");
		return redirect("/");
	}

	const repoMatch = /^\/repos\/(\d+)(?:\/(override|sync|token))?$/.exec(path);
	if (repoMatch) {
		const id = Number(repoMatch[1]);
		const action = repoMatch[2];
		const repo = await getRepo(env.DB, id);
		if (!repo) return messagePage("Not found", "No such repository.", 404, { href: "/", label: "Back" });

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

		const [account, runs, bundles] = await Promise.all([
			getAccount(env.DB, repo.account),
			env.DB.prepare(`SELECT * FROM runs WHERE repo_id = ? ORDER BY id DESC LIMIT 20`).bind(id).all<Run>(),
			repo.storage === "r2-bundle" ? env.BUCKET.list({ prefix: `bundles/${id}/` }) : null,
		]);
		return repoPage({ repo, account, runs: runs.results, clones, bundles: bundles?.objects.map((o) => o.key).sort().reverse() ?? [], flash: message });
	}

	return messagePage("Not found", "There is nothing at this address.", 404, { href: "/", label: "Back" });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === "/healthz") return new Response("ok");
		try {
			await ensureSchema(env.DB);
			const dep = await loadDeployment(env.DB);
			const adminHash = (await getConfig(env.DB, "admin_token_hash")) ?? undefined;

			if (path.startsWith("/api/")) return await handleApi(request, env, url, dep, adminHash);
			if (path === "/webhooks/github" && request.method === "POST" && dep?.app) return await handleWebhook(request, env, ctx, dep, dep.app);

			// Session cookies are SameSite=Lax; the Origin check covers the rest.
			if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
				return new Response("cross-origin request refused", { status: 403 });
			}

			const secret = await sessionSecret(env.DB);
			if (path === "/auth/logout" && request.method === "POST") return redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);
			if (path === "/auth/token" && request.method === "POST") {
				const token = (await request.formData()).get("token");
				if (!(await isAdminToken(adminHash, typeof token === "string" ? token.trim() : null))) {
					return messagePage("Wrong token", "That is not this deployment's admin token.", 401, { href: "/", label: "Try again" });
				}
				return redirect("/", [setCookie(SESSION_COOKIE, await sign(secret, { login: ADMIN }, SESSION_TTL), SESSION_TTL)]);
			}
			if ((path === "/auth/login" || path === "/auth/callback") && dep?.app) return await handleOAuth(request, url, dep, dep.app, secret);

			const session = await unsign<{ login: string }>(secret, cookie(request, SESSION_COOKIE));
			const signedIn = !!session && (session.login === ADMIN ? !!adminHash : !!dep && session.login.toLowerCase() === dep.owner.toLowerCase());

			if (!dep) {
				// Unclaimed deployments let the first visitor create the GitHub
				// App. Once the CLI has set an admin token, that token is needed.
				if (adminHash && !signedIn) return path === "/" ? loginPage(null, { github: false, token: true }) : redirect("/");
				return await handleSetup(request, env, url, secret);
			}
			if (!signedIn) return path === "/" ? loginPage(dep.owner, { github: !!dep.app, token: !!adminHash }) : redirect("/");
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
		const dep = await loadDeployment(env.DB);
		if (dep) await refresh(env, dep, "schedule");
	},
} satisfies ExportedHandler<Env>;
