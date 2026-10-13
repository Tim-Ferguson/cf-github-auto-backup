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
];

let ready: Promise<unknown> | undefined;

export function ensureSchema(db: D1Database): Promise<unknown> {
	ready ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((err) => {
		ready = undefined;
		throw err;
	});
	return ready;
}

export interface Account {
	login: string;
	kind: "User" | "Organization" | "starred";
	installation_id: number | null;
	enabled: number;
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

/** A per-repo override wins; otherwise the owning account's toggles decide. */
export function isBackedUp(repo: Repo, account: Account | undefined): boolean {
	if (repo.gone_at) return false;
	if (repo.override !== null) return repo.override === 1;
	if (!account?.enabled) return false;
	return !repo.fork || account.include_forks === 1;
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
