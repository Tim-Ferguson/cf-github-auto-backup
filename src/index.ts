import { hmacHex, randomToken, sign, timingSafeEqual, unsign } from "./crypto.ts";
import { ensureSchema, getAccount, getAllConfig, getConfig, getRepo, isBackedUp, listAccounts, listRepos, type Run, setConfig, updateRepo } from "./db.ts";
import { discover, queueDue, startBackup } from "./discovery.ts";
import { type AppConfig, gh, loadApp } from "./github.ts";
import { type CloneInfo, dashboardPage, loginPage, messagePage, repoPage, setupPage } from "./ui.ts";

export { GitRunner } from "./runner.ts";
export { BackupWorkflow } from "./workflow.ts";

const SESSION_COOKIE = "ghb_session";
const STATE_COOKIE = "ghb_state";
const SESSION_TTL = 30 * 24 * 60 * 60;

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

/** Signs cookies before the GitHub App exists, and sessions afterwards. */
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

async function refresh(env: Env, app: AppConfig, trigger: string): Promise<void> {
	await discover(env, app);
	await queueDue(env, trigger);
}

async function handleSetup(request: Request, env: Env, url: URL): Promise<Response> {
	const secret = await sessionSecret(env.DB);

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

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext, app: AppConfig): Promise<Response> {
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
		ctx.waitUntil(refresh(env, app, "webhook").catch((err) => console.error("refresh after webhook failed", err)));
	}
	return new Response("ok");
}

async function handleAuth(request: Request, env: Env, url: URL, app: AppConfig): Promise<Response> {
	if (url.pathname === "/auth/login") {
		const { state, cookie: stateCookie } = await newState(app.sessionSecret);
		const target = new URL("https://github.com/login/oauth/authorize");
		target.searchParams.set("client_id", app.clientId);
		target.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
		target.searchParams.set("state", state);
		return redirect(target.toString(), [stateCookie]);
	}

	if (url.pathname === "/auth/callback") {
		const code = url.searchParams.get("code");
		if (!code || !(await checkState(request, app.sessionSecret, url.searchParams.get("state")))) {
			return messagePage("Sign-in expired", "Please try signing in again.", 400, { href: "/auth/login", label: "Sign in" });
		}
		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: `${url.origin}/auth/callback` }),
		});
		const token = (await tokenRes.json<{ access_token?: string }>()).access_token;
		if (!token) return messagePage("Sign-in failed", "GitHub did not accept the sign-in. Please try again.", 400, { href: "/auth/login", label: "Sign in" });
		const user = await gh<{ login: string }>(token, "/user");
		if (user.login.toLowerCase() !== app.owner.toLowerCase()) {
			return messagePage("Not your backup", `This deployment belongs to ${app.owner}. You are signed in to GitHub as ${user.login}.`, 403);
		}
		const session = await sign(app.sessionSecret, { login: user.login }, SESSION_TTL);
		return redirect("/", [setCookie(SESSION_COOKIE, session, SESSION_TTL), setCookie(STATE_COOKIE, "", 0)]);
	}

	return new Response("not found", { status: 404 });
}

async function cloneCommands(env: Env, names: { label: string; name: string }[]): Promise<CloneInfo[]> {
	const out: CloneInfo[] = [];
	for (const { label, name } of names) {
		let repo: ArtifactsRepo;
		try {
			repo = await env.ARTIFACTS.get(name);
		} catch {
			continue;
		}
		try {
			const info = await repo.info();
			if (!info.lastPushAt) continue;
			const token = await repo.createToken("read", 3600);
			// Basic auth takes the token without its ?expires= suffix.
			const secret = token.plaintext.split("?")[0];
			out.push({ label, command: `git clone --mirror https://x:${secret}@${info.remote.replace(/^https:\/\//, "")}`, expiresAt: token.expiresAt });
		} finally {
			repo[Symbol.dispose]();
		}
	}
	return out;
}

async function handleApp(request: Request, env: Env, ctx: ExecutionContext, url: URL, app: AppConfig): Promise<Response> {
	const path = url.pathname;
	const post = request.method === "POST";
	const message = url.searchParams.get("m");

	if (post) {
		// Session cookies are SameSite=Lax; the Origin check covers the rest.
		if (request.headers.get("Origin") !== url.origin) return new Response("cross-origin request refused", { status: 403 });
	}

	if (path === "/setup/installed") {
		ctx.waitUntil(refresh(env, app, "install").catch((err) => console.error("refresh after install failed", err)));
		return flash("/", "Installation updated. Repositories will appear here within a minute; reload to see them.");
	}

	if (path === "/" && !post) {
		const [accounts, repos, config] = await Promise.all([listAccounts(env.DB), listRepos(env.DB), getAllConfig(env.DB)]);
		return dashboardPage({ owner: app.owner, slug: app.slug, accounts, repos, config, flash: message });
	}

	if (path === "/auth/logout" && post) return redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);

	if (path === "/discover" && post) {
		try {
			const found = await discover(env, app);
			const queued = await queueDue(env, "manual");
			return flash("/", `Found ${found.repos} repositories across ${found.accounts} installation(s); ${queued} sync(s) queued.`);
		} catch (err) {
			return flash("/", `GitHub refused the request: ${err instanceof Error ? err.message : err}`);
		}
	}

	if (path === "/sync-all" && post) {
		const queued = await queueDue(env, "manual", { all: true });
		return flash("/", `${queued} sync(s) queued.`);
	}

	const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
	if (accountMatch && post) {
		const login = decodeURIComponent(accountMatch[1]);
		const form = await request.formData();
		for (const field of ["enabled", "include_forks"] as const) {
			const value = form.get(field);
			if (value === "0" || value === "1") await env.DB.prepare(`UPDATE accounts SET ${field} = ? WHERE login = ?`).bind(Number(value), login).run();
		}
		ctx.waitUntil(refresh(env, app, "settings").catch((err) => console.error("refresh after settings change failed", err)));
		return redirect("/");
	}

	const repoMatch = /^\/repos\/(\d+)(?:\/(override|sync|token))?$/.exec(path);
	if (repoMatch) {
		const id = Number(repoMatch[1]);
		const action = repoMatch[2];
		const repo = await getRepo(env.DB, id);
		if (!repo) return messagePage("Not found", "No such repository.", 404, { href: "/", label: "Back" });

		if (action === "override" && post) {
			const value = (await request.formData()).get("override");
			await updateRepo(env.DB, id, { override: value === "1" ? 1 : value === "0" ? 0 : null });
			ctx.waitUntil(queueDue(env, "settings").catch((err) => console.error("queueing after override failed", err)));
			return redirect("/");
		}
		if (action === "sync" && post) {
			await startBackup(env, id, "manual", { force: true });
			return flash(`/repos/${id}`, "Sync started. Reload in a moment to see the result.");
		}

		let clones: CloneInfo[] | null = null;
		if (action === "token" && post && repo.artifacts_name) {
			clones = await cloneCommands(env, [
				{ label: "Repository", name: repo.artifacts_name },
				{ label: "Wiki", name: `${repo.artifacts_name}.wiki` },
			]);
		} else if (action) {
			return redirect(`/repos/${id}`);
		}
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
		if (url.pathname === "/healthz") return new Response("ok");
		try {
			await ensureSchema(env.DB);
			const app = await loadApp(env.DB);

			if (!app) return handleSetup(request, env, url);
			if (url.pathname === "/webhooks/github" && request.method === "POST") return handleWebhook(request, env, ctx, app);
			if (url.pathname.startsWith("/auth/") && url.pathname !== "/auth/logout") return handleAuth(request, env, url, app);

			const session = await unsign<{ login: string }>(app.sessionSecret, cookie(request, SESSION_COOKIE));
			if (!session || session.login.toLowerCase() !== app.owner.toLowerCase()) {
				return url.pathname === "/" ? loginPage(app.owner) : redirect("/");
			}
			return handleApp(request, env, ctx, url, app);
		} catch (err) {
			console.error(err);
			return messagePage("Something went wrong", err instanceof Error ? err.message : String(err), 500, { href: "/", label: "Back" });
		}
	},

	async scheduled(_controller, env): Promise<void> {
		await ensureSchema(env.DB);
		const app = await loadApp(env.DB);
		if (!app) return;
		await refresh(env, app, "schedule");
	},
} satisfies ExportedHandler<Env>;
