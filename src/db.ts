// D1 access. The schema is applied lazily so a fresh deploy needs no
// migration step.

export const STARRED = "*starred";

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS accounts (
		login TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		installation_id INTEGER,
		enabled INTEGER NOT NULL DEFAULT 0,
		include_forks INTEGER NOT NULL DEFAULT 0,
		suspended INTEGER NOT NULL DEFAULT 0,
		uninstalled_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS repos (
		id INTEGER PRIMARY KEY,
		account TEXT NOT NULL,
		full_name TEXT NOT NULL,
		private INTEGER NOT NULL DEFAULT 0,
		fork INTEGER NOT NULL DEFAULT 0,
		archived INTEGER NOT NULL DEFAULT 0,
		has_wiki INTEGER NOT NULL DEFAULT 0,
		default_branch TEXT,
		pushed_at TEXT,
		override INTEGER,
		artifacts_name TEXT,
		storage TEXT,
		size_bytes INTEGER,
		ref_counts TEXT,
		lfs_count INTEGER NOT NULL DEFAULT 0,
		lfs_bytes INTEGER NOT NULL DEFAULT 0,
		synced_pushed_at TEXT,
		meta_cursor TEXT,
		last_run_at TEXT,
		last_success_at TEXT,
		last_status TEXT,
		last_error TEXT,
		seen_at TEXT,
		gone_at TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS repos_account ON repos (account)`,
	`CREATE TABLE IF NOT EXISTS runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_id INTEGER NOT NULL,
		trigger TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT,
		status TEXT NOT NULL,
		detail TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS runs_repo ON runs (repo_id, id DESC)`,
	`CREATE TABLE IF NOT EXISTS auth_failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
	// Searchable index of the issue, pull request and release JSON kept in R2.
	`CREATE TABLE IF NOT EXISTS meta_items (
		repo_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		number INTEGER NOT NULL,
		title TEXT NOT NULL,
		state TEXT NOT NULL,
		author TEXT,
		created_at TEXT,
		updated_at TEXT,
		comments INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (repo_id, kind, number)
	)`,
];

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT
// EXISTS, so each runs on its own and "duplicate column" is the normal case.
const MIGRATIONS = [
	`ALTER TABLE repos ADD COLUMN meta_version INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE repos ADD COLUMN meta_prefix TEXT`,
	`ALTER TABLE repos ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE repos ADD COLUMN run_instance TEXT`,
	`ALTER TABLE accounts ADD COLUMN account_id INTEGER`,
	`ALTER TABLE accounts ADD COLUMN auto_public INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE accounts ADD COLUMN auto_private INTEGER NOT NULL DEFAULT 0`,
	// Backups made before storage was keyed by repo id keep the name-based
	// location they already use, so nothing has to move.
	`UPDATE repos SET meta_prefix = 'meta/' || full_name || '/' WHERE meta_prefix IS NULL AND (meta_cursor IS NOT NULL OR last_success_at IS NOT NULL)`,
];

/**
 * One-time data changes, applied in order and recorded in config.schema_version.
 *   1: every repo gets its own explicit on/off (repos.override), taken from
 *      what the account-wide rule gave it, and that rule becomes the
 *      account's auto-import setting for new repos.
 */
const DATA_MIGRATIONS: string[][] = [
	[
		`UPDATE accounts SET auto_public = enabled, auto_private = enabled`,
		`UPDATE repos SET override = CASE
			WHEN (SELECT a.enabled FROM accounts a WHERE a.login = repos.account) = 1
			 AND (repos.fork = 0 OR (SELECT a.include_forks FROM accounts a WHERE a.login = repos.account) = 1)
			THEN 1 ELSE 0 END
		 WHERE override IS NULL`,
	],
];

let ready: Promise<unknown> | undefined;

export function ensureSchema(db: D1Database): Promise<unknown> {
	ready ??= (async () => {
		await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
		for (const sql of MIGRATIONS) {
			await db.prepare(sql).run().catch((err) => {
				if (!/duplicate column/i.test(String(err))) throw err;
			});
		}
		const done = Number((await db.prepare(`SELECT value FROM config WHERE key = 'schema_version'`).first<{ value: string }>())?.value ?? 0);
		for (let version = done; version < DATA_MIGRATIONS.length; version++) {
			await db.batch([
				...DATA_MIGRATIONS[version].map((sql) => db.prepare(sql)),
				db.prepare(`INSERT INTO config (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(String(version + 1)),
			]);
		}
	})().catch((err) => {
		ready = undefined;
		throw err;
	});
	return ready;
}

export interface Account {
	login: string;
	kind: "User" | "Organization" | "starred";
	/** GitHub's numeric id. Logins can be renamed and re-registered; ids cannot. */
	account_id: number | null;
	installation_id: number | null;
	/** Superseded by auto_public and auto_private; kept for old rows. */
	enabled: number;
	/** New public repos in this account are backed up automatically. */
	auto_public: number;
	/** New private repos in this account are backed up automatically. */
	auto_private: number;
	/** Whether auto-import also takes forks. */
	include_forks: number;
	suspended: number;
	uninstalled_at: string | null;
}

export interface Repo {
	id: number;
	account: string;
	full_name: string;
	private: number;
	fork: number;
	archived: number;
	has_wiki: number;
	default_branch: string | null;
	pushed_at: string | null;
	override: number | null;
	artifacts_name: string | null;
	storage: "artifacts" | "r2-bundle" | null;
	size_bytes: number | null;
	ref_counts: string | null;
	lfs_count: number;
	lfs_bytes: number;
	synced_pushed_at: string | null;
	meta_cursor: string | null;
	/** Layout version of this repo's metadata in R2; see META_VERSION. */
	meta_version: number;
	/** Where this repo's metadata lives in R2, fixed at its first sync. */
	meta_prefix: string | null;
	/** Set when a push arrives, cleared when a sync starts fetching. */
	dirty: number;
	/** Workflow instance that currently owns this repo's sync. */
	run_instance: string | null;
	last_run_at: string | null;
	last_success_at: string | null;
	last_status: "ok" | "error" | "running" | "queued" | null;
	last_error: string | null;
	seen_at: string | null;
	gone_at: string | null;
}

export interface Run {
	id: number;
	repo_id: number;
	trigger: string;
	started_at: string;
	finished_at: string | null;
	status: string;
	detail: string | null;
}

/**
 * Each repo carries its own choice in `override` (1 on, 0 off). It is set
 * when the repo is first seen, from its account's auto-import settings, and
 * only changes when the owner changes it.
 */
export function isBackedUp(repo: Repo, _account?: Account | null): boolean {
	return !repo.gone_at && repo.override === 1;
}

/** Whether a newly discovered repo should start out backed up. */
export function autoImports(account: Pick<Account, "auto_public" | "auto_private" | "include_forks">, repo: { private: boolean; fork: boolean }): boolean {
	if (repo.fork && !account.include_forks) return false;
	return (repo.private ? account.auto_private : account.auto_public) === 1;
}

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare(`SELECT value FROM config WHERE key = ?`).bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function getAllConfig(db: D1Database): Promise<Record<string, string>> {
	const { results } = await db.prepare(`SELECT key, value FROM config`).all<{ key: string; value: string }>();
	return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setConfig(db: D1Database, values: Record<string, string | null>): Promise<void> {
	const stmts = Object.entries(values).map(([key, value]) =>
		value === null
			? db.prepare(`DELETE FROM config WHERE key = ?`).bind(key)
			: db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, value),
	);
	if (stmts.length) await db.batch(stmts);
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
	const { results } = await db.prepare(`SELECT * FROM accounts ORDER BY kind = 'starred', kind DESC, login COLLATE NOCASE`).all<Account>();
	return results;
}

export async function listRepos(db: D1Database): Promise<Repo[]> {
	const { results } = await db.prepare(`SELECT * FROM repos ORDER BY full_name COLLATE NOCASE`).all<Repo>();
	return results;
}

export function getRepo(db: D1Database, id: number): Promise<Repo | null> {
	return db.prepare(`SELECT * FROM repos WHERE id = ?`).bind(id).first<Repo>();
}

export function getAccount(db: D1Database, login: string): Promise<Account | null> {
	return db.prepare(`SELECT * FROM accounts WHERE login = ?`).bind(login).first<Account>();
}

export async function updateRepo(db: D1Database, id: number, fields: Partial<Repo>): Promise<void> {
	const keys = Object.keys(fields) as (keyof Repo)[];
	if (keys.length === 0) return;
	await db
		.prepare(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
		.bind(...keys.map((k) => fields[k] ?? null), id)
		.run();
}

export async function batched(db: D1Database, stmts: D1PreparedStatement[], size = 50): Promise<void> {
	for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}
