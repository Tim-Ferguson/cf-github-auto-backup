// Limits password guessing. Attempts are counted per client address, and
// across all addresses so a botnet cannot spread its guesses around.
//
// Every attempt is counted before its password is looked at, so a burst of
// simultaneous guesses cannot all slip through ahead of the count. A correct
// password takes its own attempt back.
//
// The global limit trades a little availability for safety: sustained
// attack traffic can pause password sign-in and the CLI for everyone until
// it stops. GitHub sign-in is unaffected.

const IP_LIMIT = 5;
const IP_WINDOW = 15 * 60;
const GLOBAL_LIMIT = 300;
const GLOBAL_WINDOW = 60 * 60;
const GLOBAL_KEY = "*global";

const now = () => Math.floor(Date.now() / 1000);

/** The caller's address. IPv6 is cut to its /64, which is what one network controls. */
export function clientAddress(request: Request): string {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

interface Row {
	count: number;
	window_start: number;
}

/**
 * Counts an attempt. Returns 0 if the password may be checked, otherwise the
 * number of seconds the caller has to wait.
 */
export async function admit(db: D1Database, address: string): Promise<number> {
	const t = now();
	const bump = (key: string, window: number) =>
		db
			.prepare(
				`INSERT INTO auth_failures (key, count, window_start) VALUES (?1, 1, ?2)
				 ON CONFLICT (key) DO UPDATE SET
					count = CASE WHEN window_start + ?3 <= ?2 THEN 1 ELSE count + 1 END,
					window_start = CASE WHEN window_start + ?3 <= ?2 THEN ?2 ELSE window_start END
				 RETURNING count, window_start`,
			)
			.bind(key, t, window);
	const [mine, everyone] = await db.batch<Row>([bump(address, IP_WINDOW), bump(GLOBAL_KEY, GLOBAL_WINDOW)]);
	let wait = 0;
	for (const [row, limit, window] of [
		[mine.results[0], IP_LIMIT, IP_WINDOW],
		[everyone.results[0], GLOBAL_LIMIT, GLOBAL_WINDOW],
	] as const) {
		if (row && row.count > limit) wait = Math.max(wait, row.window_start + window - t);
	}
	return wait;
}

/** A correct password does not count against anyone. */
export async function succeeded(db: D1Database, address: string): Promise<void> {
	await db.batch([
		db.prepare(`DELETE FROM auth_failures WHERE key = ?`).bind(address),
		db.prepare(`UPDATE auth_failures SET count = MAX(count - 1, 0) WHERE key = ?`).bind(GLOBAL_KEY),
	]);
}

export async function pruneFailures(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM auth_failures WHERE window_start < ?`).bind(now() - 24 * 60 * 60).run();
}
