// #509: a small fixed-window rate limiter on D1 (`rate_limits`), shared across isolates
// (unlike the in-memory buckets of site tracking / MCP). One upsert per call: a window that
// has run out restarts at 1, otherwise the count goes up. Pruned by `pruneRateLimits`.

export type LimitResult = { ok: boolean; count: number; retryAfter: number };

const ts = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Count one hit for `key`; `ok` is false once more than `max` hits fall in the window. */
export async function limit(
	db: D1Database,
	key: string,
	opts: { max: number; windowSec: number; now?: Date }
): Promise<LimitResult> {
	const now = opts.now ?? new Date();
	const cutoff = ts(new Date(now.getTime() - opts.windowSec * 1000));
	const row = await db
		.prepare(
			`INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
			 ON CONFLICT(key) DO UPDATE SET
			   count = CASE WHEN rate_limits.window_start <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
			   window_start = CASE WHEN rate_limits.window_start <= ?3 THEN ?2 ELSE rate_limits.window_start END
			 RETURNING count, window_start`
		)
		.bind(key, ts(now), cutoff)
		.first<{ count: number; window_start: string }>();
	const count = row?.count ?? 1;
	const started = row ? Date.parse(`${row.window_start.replace(' ', 'T')}Z`) : now.getTime();
	const retryAfter = Math.max(1, Math.ceil((started + opts.windowSec * 1000 - now.getTime()) / 1000));
	return { ok: count <= opts.max, count, retryAfter };
}

/** Drop windows older than a day. */
export async function pruneRateLimits(db: D1Database, now: Date = new Date()): Promise<number> {
	const res = await db
		.prepare('DELETE FROM rate_limits WHERE window_start < ?')
		.bind(ts(new Date(now.getTime() - 86_400_000)))
		.run();
	return res.meta.changes ?? 0;
}

/** First 16 hex chars of SHA-256(ip + secret). The raw IP is never stored. */
export async function ipHash(ip: string | null | undefined, secret: string | undefined): Promise<string | null> {
	const v = String(ip ?? '').trim();
	if (!v) return null;
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v + String(secret ?? '')));
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 16);
}
