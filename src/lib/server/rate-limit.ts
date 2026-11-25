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

/**
 * Rate-limit bucket for a client address: IPv4 as is, IPv6 by its /64 (one host usually owns
 * a whole /64). Null when there is no address.
 */
export function clientBucket(ip: string | null | undefined): string | null {
	const v = String(ip ?? '').trim().toLowerCase().split('%')[0];
	if (!v) return null;
	if (!v.includes(':')) return v;
	// An IPv4-mapped IPv6 address (::ffff:1.2.3.4) counts as its IPv4 address.
	if (v.includes('.')) return v.slice(v.lastIndexOf(':') + 1);
	const [head, tail = ''] = v.split('::');
	const h = head ? head.split(':') : [];
	const t = v.includes('::') && tail ? tail.split(':') : [];
	const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
	return groups
		.slice(0, 4)
		.map((g) => (g || '0').replace(/^0+(?=.)/, ''))
		.join(':') + '::/64';
}

/**
 * #744: the rate-limit id of a client: a hash of its address bucket (`clientBucket`: IPv4 as
 * is, IPv6 by its /64), or null when there is no address.
 */
export async function clientHash(ip: string | null | undefined, secret: string | undefined): Promise<string | null> {
	return ipHash(clientBucket(ip), secret);
}
