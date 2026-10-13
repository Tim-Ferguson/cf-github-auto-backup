// Keeps the accounts and repos tables in step with GitHub, and decides which
// repos need a sync. Nothing here ever deletes backed-up data: repos that
// disappear are only marked gone, which freezes their backup.

import { appJwt } from "./crypto.ts";
import { type Account, batched, isBackedUp, listAccounts, listRepos, type Repo, setConfig, STARRED } from "./db.ts";
import { type AppConfig, type Deployment, ghAll, type GhInstallation, type GhRepo, GitHubError, installationToken } from "./github.ts";
import type { BackupParams } from "./workflow.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function upsertRepo(db: D1Database, account: string, r: GhRepo, now: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO repos (id, account, full_name, private, fork, archived, has_wiki, default_branch, pushed_at, seen_at, gone_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			 ON CONFLICT (id) DO UPDATE SET
				account = CASE WHEN excluded.account = '${STARRED}' AND repos.account != '${STARRED}' AND repos.gone_at IS NULL THEN repos.account ELSE excluded.account END,
				full_name = excluded.full_name, private = excluded.private, fork = excluded.fork, archived = excluded.archived,
				has_wiki = excluded.has_wiki, default_branch = excluded.default_branch, pushed_at = excluded.pushed_at,
				seen_at = excluded.seen_at, gone_at = NULL`,
		)
		.bind(r.id, account, r.full_name, +r.private, +r.fork, +r.archived, +r.has_wiki, r.default_branch, r.pushed_at, now);
}

const markUnseen = (db: D1Database, account: string, now: string) =>
	db.prepare(`UPDATE repos SET gone_at = ? WHERE account = ? AND gone_at IS NULL AND (seen_at IS NULL OR seen_at < ?)`).bind(now, account, now);

async function recordGitHubError(db: D1Database, err: unknown, now: string): Promise<void> {
	// The app, the token or the account behind them may be suspended. Record
	// it and leave every backup exactly as it is.
	const message = err instanceof Error ? err.message : String(err);
	const since = (await db.prepare(`SELECT value FROM config WHERE key = 'github_error_since'`).first<{ value: string }>())?.value ?? now;
	await setConfig(db, { github_error: message, github_error_since: since });
}

/** GitHub App mode: one account per installation. */
async function discoverInstallations(db: D1Database, dep: Deployment, app: AppConfig, now: string): Promise<{ accounts: number; repos: number; token: string | null }> {
	let installations: GhInstallation[];
	try {
		installations = await ghAll<GhInstallation>(await appJwt(app.appId, app.privateKey), "/app/installations?per_page=100");
	} catch (err) {
		await recordGitHubError(db, err, now);
		throw err;
	}

	const known = new Map((await listAccounts(db)).map((a) => [a.login, a]));
	let repoCount = 0;
	let anyToken: string | null = null;

	for (const inst of installations) {
		const login = inst.account.login;
		// Only the owner's own account is on by default; every other
		// installation waits for an explicit toggle.
		const enabledDefault = login.toLowerCase() === dep.owner.toLowerCase() ? 1 : 0;
		await db
			.prepare(
				`INSERT INTO accounts (login, kind, installation_id, enabled, suspended) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (login) DO UPDATE SET kind = excluded.kind, installation_id = excluded.installation_id, suspended = excluded.suspended, uninstalled_at = NULL`,
			)
			.bind(login, inst.account.type, inst.id, enabledDefault, inst.suspended_at ? 1 : 0)
			.run();
		known.delete(login);
		if (inst.suspended_at) continue;

		let repos: GhRepo[];
		try {
			const token = await installationToken(app, inst.id);
			anyToken ??= token;
			repos = await ghAll<GhRepo>(token, "/installation/repositories?per_page=100");
		} catch (err) {
			console.error(`listing repos for ${login} failed`, err);
			continue;
		}
		await batched(db, repos.map((r) => upsertRepo(db, login, r, now)));
		// Only after a complete listing: whatever was not seen is gone.
		await markUnseen(db, login, now).run();
		repoCount += repos.length;
	}

	for (const account of known.values()) {
		if (account.kind === "starred" || account.uninstalled_at) continue;
		await db.batch([
			db.prepare(`UPDATE accounts SET uninstalled_at = ?, installation_id = NULL WHERE login = ?`).bind(now, account.login),
			db.prepare(`UPDATE repos SET gone_at = ? WHERE account = ? AND gone_at IS NULL`).bind(now, account.login),
		]);
	}
	return { accounts: installations.length, repos: repoCount, token: anyToken };
}

/** Token mode: everything the token can see, grouped by owner. */
async function discoverWithToken(db: D1Database, dep: Deployment, token: string, now: string): Promise<{ accounts: number; repos: number; token: string | null }> {
	let repos: GhRepo[];
	try {
		repos = await ghAll<GhRepo>(token, "/user/repos?per_page=100&affiliation=owner,organization_member");
	} catch (err) {
		await recordGitHubError(db, err, now);
		throw err;
	}

	const owners = new Map<string, "User" | "Organization">();
	owners.set(dep.owner, "User");
	for (const r of repos) if (!owners.has(r.owner.login)) owners.set(r.owner.login, r.owner.type);
	const stmts: D1PreparedStatement[] = [];
	for (const [login, kind] of owners) {
		const enabledDefault = login.toLowerCase() === dep.owner.toLowerCase() ? 1 : 0;
		stmts.push(
			db.prepare(`INSERT INTO accounts (login, kind, enabled) VALUES (?, ?, ?) ON CONFLICT (login) DO UPDATE SET kind = excluded.kind, uninstalled_at = NULL`).bind(login, kind, enabledDefault),
		);
	}
	for (const r of repos) stmts.push(upsertRepo(db, r.owner.login, r, now));
	await batched(db, stmts);

	// The listing was complete, so anything unseen under a real account is gone.
	const known = (await listAccounts(db)).filter((a) => a.kind !== "starred");
	await batched(db, known.map((a) => markUnseen(db, a.login, now)));
	return { accounts: owners.size, repos: repos.length, token };
}

export async function discover(env: Env, dep: Deployment): Promise<{ accounts: number; repos: number }> {
	const db = env.DB;
	const now = new Date().toISOString();

	const found = dep.app ? await discoverInstallations(db, dep, dep.app, now) : await discoverWithToken(db, dep, dep.token!, now);
	await setConfig(db, { github_error: null, github_error_since: null, last_discovery_at: now });
	let repoCount = found.repos;

	await db.prepare(`INSERT INTO accounts (login, kind, enabled) VALUES (?, 'starred', 0) ON CONFLICT (login) DO NOTHING`).bind(STARRED).run();
	const starred = await db.prepare(`SELECT enabled FROM accounts WHERE login = ?`).bind(STARRED).first<{ enabled: number }>();
	if (starred?.enabled) {
		try {
			const stars = await ghAll<GhRepo>(found.token, `/users/${dep.owner}/starred?per_page=100`);
			// Private stars are not listed here, and public ones clone without a token.
			const publicStars = stars.filter((r) => !r.private);
			await batched(db, publicStars.map((r) => upsertRepo(db, STARRED, r, now)));
			await markUnseen(db, STARRED, now).run();
			repoCount += publicStars.length;
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			console.error("listing starred repos failed", err);
		}
	}

	return { accounts: found.accounts, repos: repoCount };
}

function needsSync(repo: Repo): boolean {
	if (repo.last_status === "running" && repo.last_run_at && Date.now() - Date.parse(repo.last_run_at) < DAY_MS / 4) return false;
	if (repo.last_status !== "ok") return true;
	if (repo.pushed_at !== repo.synced_pushed_at) return true;
	// Issues and releases change without a push, so refresh daily regardless.
	return !repo.last_success_at || Date.now() - Date.parse(repo.last_success_at) > DAY_MS - 60 * 60 * 1000;
}

export async function startBackup(env: Env, repoId: number, trigger: string, opts: { force?: boolean; dedupe?: string } = {}): Promise<boolean> {
	const params: BackupParams = { repoId, trigger, force: opts.force ?? false };
	try {
		await env.BACKUP_WORKFLOW.create({ id: `repo-${repoId}-${opts.dedupe ?? Date.now()}`, params });
		return true;
	} catch (err) {
		// An instance with this id already exists: that sync is already queued.
		if (opts.dedupe) return false;
		throw err;
	}
}

export async function queueDue(env: Env, trigger: string, opts: { all?: boolean } = {}): Promise<number> {
	const accounts = new Map<string, Account>((await listAccounts(env.DB)).map((a) => [a.login, a]));
	const due = (await listRepos(env.DB)).filter((r) => isBackedUp(r, accounts.get(r.account)) && (opts.all || needsSync(r)));
	const stamp = Date.now();
	for (let i = 0; i < due.length; i += 100) {
		const instances = due.slice(i, i + 100).map((repo) => ({
			id: `repo-${repo.id}-${stamp}`,
			params: { repoId: repo.id, trigger, force: false } satisfies BackupParams,
		}));
		await env.BACKUP_WORKFLOW.createBatch({ instances });
	}
	return due.length;
}
