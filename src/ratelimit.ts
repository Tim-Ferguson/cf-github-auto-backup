// Limits password guessing. Failures are counted per client address, and
// across all addresses so a botnet cannot spread its guesses around.
//
// The global limit trades a little availability for safety: sustained
// attack traffic can pause password sign-in for everyone until it stops.
// GitHub sign-in is unaffected.

const IP_LIMIT = 5;
const IP_WINDOW = 15 * 60;
const GLOBAL_LIMIT = 300;
const GLOBAL_WINDOW = 60 * 60;
const GLOBAL_KEY = "*global";

const now = () => Math.floor(Date.now() / 1000);

export function clientAddress(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

interface Row {
	key: string;
	count: number;
	window_start: number;
}

/** Seconds the caller must wait before another attempt, or 0 if one is allowed. */
export async function retryAfter(db: D1Database, address: string): Promise<number> {
	const { results } = await db.prepare(`SELECT key, count, window_start FROM auth_failures WHERE key IN (?, ?)`).bind(address, GLOBAL_KEY).all<Row>();
	let wait = 0;
	for (const row of results) {
		const [limit, window] = row.key === GLOBAL_KEY ? [GLOBAL_LIMIT, GLOBAL_WINDOW] : [IP_LIMIT, IP_WINDOW];
		const remaining = row.window_start + window - now();
		if (row.count >= limit && remaining > 0) wait = Math.max(wait, remaining);
	}
	return wait;
}

export async function recordFailure(db: D1Database, address: string): Promise<void> {
	const t = now();
	const bump = (key: string, window: number) =>
		db
			.prepare(
				`INSERT INTO auth_failures (key, count, window_start) VALUES (?1, 1, ?2)
				 ON CONFLICT (key) DO UPDATE SET
					count = CASE WHEN window_start + ?3 <= ?2 THEN 1 ELSE count + 1 END,
					window_start = CASE WHEN window_start + ?3 <= ?2 THEN ?2 ELSE window_start END`,
			)
			.bind(key, t, window);
	await db.batch([bump(address, IP_WINDOW), bump(GLOBAL_KEY, GLOBAL_WINDOW)]);
}

export async function clearFailures(db: D1Database, address: string): Promise<void> {
	await db.prepare(`DELETE FROM auth_failures WHERE key = ?`).bind(address).run();
}

export async function pruneFailures(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM auth_failures WHERE window_start < ?`).bind(now() - 24 * 60 * 60).run();
}
