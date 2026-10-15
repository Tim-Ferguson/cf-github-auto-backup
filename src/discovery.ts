// Keeps the accounts and repos tables in step with GitHub, and decides which
// repos need a sync. Nothing here ever deletes backed-up data: repos that
// disappear are only marked gone, which freezes their backup.

import { appJwt } from "./crypto.ts";
import { type Account, autoImports, batched, getAccount, isBackedUp, listAccounts, listRepos, type Repo, setConfig } from "./db.ts";
import { type AppConfig, type Deployment, ghAll, type GhInstallation, type GhRepo, installationToken } from "./github.ts";
import type { BackupParams } from "./workflow.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 3 * 60 * 1000;

/**
 * A repo seen for the first time gets its on/off from the account's
 * auto-import settings. After that the choice belongs to the owner and a
 * later discovery never changes it.
 */
function upsertRepo(db: D1Database, account: Account, r: GhRepo, now: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO repos (id, account, full_name, private, fork, archived, has_wiki, default_branch, pushed_at, override, seen_at, gone_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			 ON CONFLICT (id) DO UPDATE SET
				account = excluded.account,
				full_name = excluded.full_name, private = excluded.private, fork = excluded.fork, archived = excluded.archived,
				has_wiki = excluded.has_wiki, default_branch = excluded.default_branch, pushed_at = excluded.pushed_at,
				seen_at = MAX(COALESCE(repos.seen_at, ''), excluded.seen_at), gone_at = NULL`,
		)
		.bind(r.id, account.login, r.full_name, +r.private, +r.fork, +r.archived, +r.has_wiki, r.default_branch, r.pushed_at, autoImports(account, r) ? 1 : 0, now);
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

const isOwner = (dep: Deployment, account: { id: number; login: string }) => (dep.ownerId ? account.id === dep.ownerId : account.login.toLowerCase() === dep.owner.toLowerCase());

/**
 * Records an account, following GitHub's numeric id rather than its login.
 * A renamed account keeps its row and settings. A login that now belongs to
 * a different account does not inherit the previous holder's settings.
 */
async function reconcileAccount(
	db: D1Database,
	dep: Deployment,
	account: { id: number; login: string; type: "User" | "Organization" },
	extra: { installationId: number | null; suspended: boolean },
): Promise<Account> {
	const renamed = await db.prepare(`SELECT login FROM accounts WHERE account_id = ? AND login != ?`).bind(account.id, account.login).first<{ login: string }>();
	if (renamed) {
		await db.batch([
			db.prepare(`DELETE FROM accounts WHERE login = ? AND (account_id IS NULL OR account_id != ?)`).bind(account.login, account.id),
			db.prepare(`UPDATE accounts SET login = ? WHERE account_id = ?`).bind(account.login, account.id),
			db.prepare(`UPDATE repos SET account = ? WHERE account = ?`).bind(account.login, renamed.login),
		]);
	}
	const sameName = await getAccount(db, account.login);
	if (sameName?.account_id && sameName.account_id !== account.id) {
		// Someone else holds this name now. Their repos are not ours to back up
		// until the owner says so.
		await db.prepare(`UPDATE accounts SET account_id = ?, auto_public = 0, auto_private = 0, include_forks = 0 WHERE login = ?`).bind(account.id, account.login).run();
	}
	// Only the owner's own account imports automatically by default; every
	// other installation waits for an explicit switch.
	const auto = isOwner(dep, account) ? 1 : 0;
	await db
		.prepare(
			`INSERT INTO accounts (login, kind, account_id, installation_id, enabled, auto_public, auto_private, suspended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (login) DO UPDATE SET kind = excluded.kind, account_id = excluded.account_id, installation_id = excluded.installation_id, suspended = excluded.suspended, uninstalled_at = NULL`,
		)
		.bind(account.login, account.type, account.id, extra.installationId, auto, auto, auto, extra.suspended ? 1 : 0)
		.run();
	return (await getAccount(db, account.login))!;
}

/** GitHub App mode: one account per installation. */
async function discoverInstallations(db: D1Database, dep: Deployment, app: AppConfig, now: string): Promise<{ accounts: number; repos: number }> {
	let installations: GhInstallation[];
	try {
		installations = await ghAll<GhInstallation>(await appJwt(app.appId, app.privateKey), "/app/installations?per_page=100");
	} catch (err) {
		await recordGitHubError(db, err, now);
		throw err;
	}

	const known = new Map((await listAccounts(db)).map((a) => [a.login, a]));
	let repoCount = 0;

	for (const inst of installations) {
		const login = inst.account.login;
		// One installation failing (a huge account, a revoked grant) must not
		// stop the others, so each is handled on its own.
		try {
			const account = await reconcileAccount(db, dep, inst.account, { installationId: inst.id, suspended: !!inst.suspended_at });
			known.delete(login);
			if (inst.suspended_at) continue;
			const token = await installationToken(app, inst.id);
			const repos = await ghAll<GhRepo>(token, "/installation/repositories?per_page=100");
			await batched(db, repos.map((r) => upsertRepo(db, account, r, now)));
			// Only after a complete listing: whatever was not seen is gone.
			await markUnseen(db, login, now).run();
			repoCount += repos.length;
		} catch (err) {
			known.delete(login);
			console.error(`discovery for ${login} failed`, err);
		}
	}

	for (const account of known.values()) {
		// Leftover starred-repo backups from older versions belong to no installation.
		if (account.kind === "starred" || account.uninstalled_at) continue;
		await db.batch([
			db.prepare(`UPDATE accounts SET uninstalled_at = ?, installation_id = NULL WHERE login = ?`).bind(now, account.login),
			db.prepare(`UPDATE repos SET gone_at = ? WHERE account = ? AND gone_at IS NULL`).bind(now, account.login),
		]);
	}
	return { accounts: installations.length, repos: repoCount };
}

/** Token mode: everything the token can see, grouped by owner. */
async function discoverWithToken(db: D1Database, dep: Deployment, token: string, now: string): Promise<{ accounts: number; repos: number }> {
	let repos: GhRepo[];
	try {
		repos = await ghAll<GhRepo>(token, "/user/repos?per_page=100&affiliation=owner,organization_member");
	} catch (err) {
		await recordGitHubError(db, err, now);
		throw err;
	}

	const owners = new Map<string, Account>();
	for (const r of repos) {
		if (!owners.has(r.owner.login)) owners.set(r.owner.login, await reconcileAccount(db, dep, r.owner, { installationId: null, suspended: false }));
	}
	await batched(db, repos.map((r) => upsertRepo(db, owners.get(r.owner.login)!, r, now)));

	// The listing was complete, so anything unseen under a real account is gone.
	const known = (await listAccounts(db)).filter((a) => a.kind !== "starred");
	await batched(db, known.map((a) => markUnseen(db, a.login, now)));
	return { accounts: owners.size, repos: repos.length };
}

/** Lets only one discovery run at a time; overlapping ones would mark each other's repos gone. */
async function takeLock(db: D1Database): Promise<boolean> {
	const now = Date.now();
	const row = await db
		.prepare(
			`INSERT INTO config (key, value) VALUES ('discovery_lock', ?1)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(config.value AS INTEGER) < ?2
			 RETURNING value`,
		)
		.bind(String(now), now - LOCK_MS)
		.first();
	return !!row;
}

export async function discover(env: Env, dep: Deployment): Promise<{ accounts: number; repos: number; skipped?: boolean }> {
	const db = env.DB;
	if (!(await takeLock(db))) return { accounts: 0, repos: 0, skipped: true };
	try {
		const now = new Date().toISOString();
		const found = dep.app ? await discoverInstallations(db, dep, dep.app, now) : await discoverWithToken(db, dep, dep.token!, now);
		await setConfig(db, { github_error: null, github_error_since: null, last_discovery_at: now });
		return found;
	} finally {
		await db.prepare(`DELETE FROM config WHERE key = 'discovery_lock'`).run();
	}
}

function needsSync(repo: Repo): boolean {
	// Already queued or in flight: a second instance would only repeat the work.
	const pending = repo.last_status === "running" || repo.last_status === "queued";
	if (pending && repo.last_run_at && Date.now() - Date.parse(repo.last_run_at) < DAY_MS / 4) return false;
	if (repo.last_status !== "ok" || repo.dirty) return true;
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
	const due = (await listRepos(env.DB)).filter((r) => isBackedUp(r) && (opts.all || needsSync(r)));
	const stamp = Date.now();
	for (let i = 0; i < due.length; i += 100) {
		const instances = due.slice(i, i + 100).map((repo) => ({
			id: `repo-${repo.id}-${stamp}`,
			params: { repoId: repo.id, trigger, force: false } satisfies BackupParams,
		}));
		await env.BACKUP_WORKFLOW.createBatch({ instances });
		const now = new Date().toISOString();
		await batched(
			env.DB,
			instances.map((i) => env.DB.prepare(`UPDATE repos SET last_status = 'queued', last_run_at = ? WHERE id = ? AND last_status IS NOT 'running'`).bind(now, i.params.repoId)),
		);
	}
	return due.length;
}
