// Site tracking (#151): link decoration for the send path, beacon sanitising, the
// per-site rate limit, CORS helpers for /api/track*, and the heartbeat prune.
// Identity tokens live in track-token.ts.

export type TrackingSite = {
	id: number;
	name: string;
	domain: string;
	origins: string;
	site_key: string;
	enabled: number;
};

/* ------------------------------------------------------------------ sites / origins */

function normOrigin(o: string): string {
	return o.trim().toLowerCase().replace(/\/+$/, '');
}

function normDomain(d: string): string {
	return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

/** The site's allowed Origin values. An empty `origins` list falls back to
 *  `https://<domain>` and `https://www.<domain>`. */
export function siteOrigins(site: Pick<TrackingSite, 'domain' | 'origins'>): string[] {
	let list: string[] = [];
	try {
		const parsed = JSON.parse(site.origins || '[]');
		if (Array.isArray(parsed)) list = parsed.filter((o): o is string => typeof o === 'string').map(normOrigin);
	} catch {
		list = [];
	}
	list = list.filter(Boolean);
	if (list.length) return list;
	const d = normDomain(site.domain);
	return d ? [`https://${d}`, `https://www.${d}`] : [];
}

export function originAllowed(site: Pick<TrackingSite, 'domain' | 'origins'>, origin: string | null): boolean {
	if (!origin) return false;
	return siteOrigins(site).includes(normOrigin(origin));
}

export async function findSiteByKey(db: D1Database, siteKey: unknown): Promise<TrackingSite | null> {
	if (typeof siteKey !== 'string' || !siteKey || siteKey.length > 100) return null;
	return db
		.prepare('SELECT id, name, domain, origins, site_key, enabled FROM tracking_sites WHERE site_key = ? AND enabled = 1')
		.bind(siteKey)
		.first<TrackingSite>();
}

async function enabledSites(db: D1Database): Promise<TrackingSite[]> {
	const r = await db
		.prepare('SELECT id, name, domain, origins, site_key, enabled FROM tracking_sites WHERE enabled = 1')
		.all<TrackingSite>();
	return r.results;
}

/** Preflight has no body (no site_key), so allow any enabled site's origin. */
export async function originAllowedForAnySite(db: D1Database, origin: string | null): Promise<boolean> {
	if (!origin) return false;
	return (await enabledSites(db)).some((s) => originAllowed(s, origin));
}

export function corsHeaders(origin: string): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'content-type, x-dsv-id',
		'Access-Control-Max-Age': '86400',
		Vary: 'Origin'
	};
}

/* ------------------------------------------------------------------ link decoration */

/** Settings key `site_tracking_links` (app_state). Unset = on: adding an enabled
 *  tracking site is the opt-in; `off` turns decoration off for every send. */
export async function siteTrackingLinksEnabled(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare(`SELECT value FROM app_state WHERE key = 'site_tracking_links'`)
		.first<{ value: string | null }>();
	const v = (row?.value ?? '').trim().toLowerCase();
	return !['off', '0', 'false', 'no'].includes(v);
}

export type LinkMatcher = { domains: string[]; hosts: string[] };

export function linkMatcherFor(sites: Pick<TrackingSite, 'domain' | 'origins'>[]): LinkMatcher | null {
	const domains = new Set<string>();
	const hosts = new Set<string>();
	for (const s of sites) {
		const d = normDomain(s.domain);
		if (d) domains.add(d);
		for (const o of siteOrigins(s)) {
			try {
				hosts.add(new URL(o).hostname);
			} catch {
				/* skip a malformed origin */
			}
		}
	}
	return domains.size || hosts.size ? { domains: [...domains], hosts: [...hosts] } : null;
}

/** The matcher for this send, or null when the toggle is off / no site is enabled. */
export async function loadLinkMatcher(db: D1Database): Promise<LinkMatcher | null> {
	if (!(await siteTrackingLinksEnabled(db))) return null;
	return linkMatcherFor(await enabledSites(db));
}

function hostMatches(host: string, m: LinkMatcher): boolean {
	const h = host.toLowerCase();
	if (m.hosts.includes(h)) return true;
	return m.domains.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * Append `dsv=<token>` to every `href` in `html` that points at a tracking site.
 * Keeps the existing query and #hash (the param goes before the hash). Skips mailto:/
 * tel:/relative links, anything on the app's own host (unsubscribe, hosted pages /p/,
 * media), any `/unsubscribe` path, and links that already carry `dsv=`.
 */
export function decorateLinks(html: string, m: LinkMatcher, token: string, appHost: string | null): string {
	const app = appHost?.toLowerCase() ?? null;
	return html.replace(/(\bhref\s*=\s*)(["'])(.*?)\2/gis, (whole, pre: string, q: string, raw: string) => {
		const href = raw.trim();
		if (!/^https?:\/\//i.test(href)) return whole;
		let url: URL;
		try {
			url = new URL(href.replace(/&amp;/gi, '&'));
		} catch {
			return whole;
		}
		if (app && url.hostname.toLowerCase() === app) return whole;
		if (!hostMatches(url.hostname, m)) return whole;
		if (/\/unsubscribe\b/i.test(url.pathname)) return whole;
		if (url.searchParams.has('dsv')) return whole;
		const hashAt = href.indexOf('#');
		const base = hashAt >= 0 ? href.slice(0, hashAt) : href;
		const hash = hashAt >= 0 ? href.slice(hashAt) : '';
		const amp = /&amp;/i.test(base) ? '&amp;' : '&';
		const sep = base.includes('?') ? (/[?&]$/.test(base) || base.endsWith('&amp;') ? '' : amp) : '?';
		return `${pre}${q}${base}${sep}dsv=${encodeURIComponent(token)}${hash}${q}`;
	});
}

/* ------------------------------------------------------------------ beacon sanitising */

export const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;
const PATH_MAX = 500;
const TITLE_MAX = 200;
const NAME_MAX = 100;
const UTM_VALUE_MAX = 200;
export const PROPS_MAX_BYTES = 2048;

const BOT_UA =
	/bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|facebookexternalhit|embedly|preview|curl\/|wget|python-requests|httpclient|phantomjs|puppeteer|playwright|selenium|monitor|uptime/i;

export function isBotUserAgent(ua: string | null): boolean {
	if (!ua || !ua.trim()) return true;
	return BOT_UA.test(ua);
}

/** DNT / GPC opt-outs, plus prefetch/prerender requests. */
export function privacyOrPrefetch(headers: Headers): boolean {
	if (headers.get('sec-gpc') === '1' || headers.get('dnt') === '1') return true;
	const purpose = `${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''} ${headers.get('x-purpose') ?? ''} ${headers.get('x-moz') ?? ''}`;
	return /prefetch|prerender|preview/i.test(purpose);
}

/** Path without query/hash, plus any UTM values found in that query. */
export function cleanPath(raw: unknown): { path: string | null; utm: Record<string, string> } {
	const utm: Record<string, string> = {};
	if (typeof raw !== 'string' || !raw.trim()) return { path: null, utm };
	let url: URL;
	try {
		url = new URL(raw.trim(), 'https://site.invalid');
	} catch {
		return { path: null, utm };
	}
	for (const k of UTM_KEYS) {
		const v = url.searchParams.get(`utm_${k}`);
		if (v && v.trim()) utm[k] = v.trim().slice(0, UTM_VALUE_MAX);
	}
	return { path: url.pathname.slice(0, PATH_MAX) || '/', utm };
}

/** Allowlisted UTM keys only (accepts `source` or `utm_source`). */
export function cleanUtm(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	const r = raw as Record<string, unknown>;
	for (const k of UTM_KEYS) {
		const v = r[k] ?? r[`utm_${k}`];
		if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, UTM_VALUE_MAX);
	}
	return out;
}

export function referrerHost(raw: unknown): string | null {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	try {
		return new URL(raw.trim()).hostname.toLowerCase().slice(0, 255) || null;
	} catch {
		return null;
	}
}

export function cleanText(raw: unknown, max: number): string | null {
	if (typeof raw !== 'string') return null;
	const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	return t ? t.slice(0, max) : null;
}

export function cleanProps(raw: unknown): string | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const s = JSON.stringify(raw);
	if (s === '{}' || new TextEncoder().encode(s).length > PROPS_MAX_BYTES) return null;
	return s;
}

export function sqlTime(ms: number): string {
	return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Client time when plausible (last hour, ≤5 min ahead → clamped to now), else now. */
export function occurredAt(ts: unknown, now = Date.now()): string {
	const n = typeof ts === 'number' ? ts : typeof ts === 'string' ? Number(ts) : NaN;
	if (Number.isFinite(n) && n >= now - 3_600_000 && n <= now + 300_000) return sqlTime(Math.min(n, now));
	return sqlTime(now);
}

export type TrackInput = {
	kind: 'pageview' | 'event';
	name: string;
	path: string | null;
	title: string | null;
	referrer_host: string | null;
	utm: string | null;
	props: string | null;
};

/** Normalise a beacon body, or null when it isn't a storable event. */
export function sanitizeBeacon(body: Record<string, unknown>): TrackInput | null {
	const kind = body.kind === 'event' ? 'event' : body.kind === 'pageview' || body.kind == null ? 'pageview' : null;
	if (!kind) return null;
	const name = kind === 'pageview' ? 'pageview' : cleanText(body.name, NAME_MAX);
	if (!name) return null;
	const { path, utm: fromQuery } = cleanPath(body.path);
	const utm = { ...fromQuery, ...cleanUtm(body.utm) };
	return {
		kind,
		name,
		path,
		title: cleanText(body.title, TITLE_MAX),
		referrer_host: referrerHost(body.referrer),
		utm: Object.keys(utm).length ? JSON.stringify(utm) : null,
		props: kind === 'event' ? cleanProps(body.props) : null
	};
}

/* ------------------------------------------------------------------ rate limit */

// Per-isolate token bucket: 600 requests/minute per site_key (refills 10/s). Isolates
// don't share memory, so a busy site spread over many isolates can exceed this — the DB
// count below is the backstop (≤600 stored rows per site per rolling minute). Neither is
// exact; both are cheap.
export const RATE_PER_MINUTE = 600;
const buckets = new Map<string, { tokens: number; at: number }>();

export function takeRateToken(key: string, now = Date.now()): boolean {
	const b = buckets.get(key) ?? { tokens: RATE_PER_MINUTE, at: now };
	b.tokens = Math.min(RATE_PER_MINUTE, b.tokens + ((now - b.at) / 60_000) * RATE_PER_MINUTE);
	b.at = now;
	if (b.tokens < 1) {
		buckets.set(key, b);
		return false;
	}
	b.tokens -= 1;
	buckets.set(key, b);
	if (buckets.size > 1000) buckets.delete(buckets.keys().next().value as string);
	return true;
}

export function resetRateLimits(): void {
	buckets.clear();
}

export async function overDbRateLimit(db: D1Database, siteId: number): Promise<boolean> {
	const r = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM site_events WHERE site_id = ? AND received_at >= datetime('now', '-60 seconds')`
		)
		.bind(siteId)
		.first<{ n: number }>();
	return (r?.n ?? 0) >= RATE_PER_MINUTE;
}

/* ------------------------------------------------------------------ prune */

export const SITE_EVENTS_MAX_AGE_DAYS = 180;
export const SITE_EVENTS_PER_CONTACT_CAP = 5000;
export const SITE_EVENTS_PRUNE_BATCH = 2000;
const PRUNE_KEY = 'site_events_prune_at';

export type PruneResult = { ran: boolean; aged: number; capped: number; done: boolean };

/**
 * Heartbeat prune (nightly). Deletes `site_events` older than 180 days, then trims any
 * contact over 5,000 rows (oldest first) — at most `batch` rows per tick in total. A pass
 * that hits the batch limit leaves `site_events_prune_at` unstamped, so the next tick
 * continues; a pass that finishes stamps it and the job sleeps for 24h.
 */
export async function pruneSiteEvents(
	db: D1Database,
	opts: { now?: Date; maxAgeDays?: number; perContactCap?: number; batch?: number; force?: boolean } = {}
): Promise<PruneResult> {
	const now = opts.now ?? new Date();
	const maxAgeDays = opts.maxAgeDays ?? SITE_EVENTS_MAX_AGE_DAYS;
	const cap = opts.perContactCap ?? SITE_EVENTS_PER_CONTACT_CAP;
	const batch = opts.batch ?? SITE_EVENTS_PRUNE_BATCH;

	if (!opts.force) {
		const last = await db
			.prepare('SELECT value FROM app_state WHERE key = ?')
			.bind(PRUNE_KEY)
			.first<{ value: string | null }>();
		const at = last?.value ? Date.parse(last.value) : NaN;
		if (Number.isFinite(at) && now.getTime() - at < 24 * 3_600_000) {
			return { ran: false, aged: 0, capped: 0, done: true };
		}
	}

	const cutoff = sqlTime(now.getTime() - maxAgeDays * 86_400_000);
	const agedRes = await db
		.prepare(
			`DELETE FROM site_events WHERE id IN (SELECT id FROM site_events WHERE occurred_at < ? LIMIT ?)`
		)
		.bind(cutoff, batch)
		.run();
	const aged = agedRes.meta.changes ?? 0;
	let budget = batch - aged;

	let capped = 0;
	let capLeft = false;
	if (budget > 0) {
		const over = await db
			.prepare(
				`SELECT contact_id, COUNT(*) AS n FROM site_events GROUP BY contact_id HAVING COUNT(*) > ? LIMIT 50`
			)
			.bind(cap)
			.all<{ contact_id: number; n: number }>();
		for (const row of over.results) {
			if (budget <= 0) {
				capLeft = true;
				break;
			}
			const take = Math.min(row.n - cap, budget);
			const r = await db
				.prepare(
					`DELETE FROM site_events WHERE id IN (
					   SELECT id FROM site_events WHERE contact_id = ? ORDER BY occurred_at ASC, id ASC LIMIT ?)`
				)
				.bind(row.contact_id, take)
				.run();
			const n = r.meta.changes ?? 0;
			capped += n;
			budget -= n;
			if (take < row.n - cap) capLeft = true;
		}
		if (over.results.length === 50) capLeft = true;
	}

	const done = aged < batch && !capLeft;
	if (done) {
		await db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(PRUNE_KEY, now.toISOString())
			.run();
	}
	return { ran: true, aged, capped, done };
}
