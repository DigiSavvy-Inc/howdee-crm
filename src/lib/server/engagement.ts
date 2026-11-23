// Contact engagement rollup (#111/#113). `contact_engagement` (migration 0036) is a
// 1-row-per-contact summary of how a contact interacts with our mail: counts, recency,
// a recency-weighted score, a tier, and inferred best send time. Everything here is
// derived from `events` + `recipients`/`campaigns` + `replies` — the table can be
// dropped and rebuilt from scratch at any time (that's also what a full recompute does).
//
// Compute model:
//   - `dirty = 1` on a `contact_engagement` row means "needs recompute". New contacts
//     get a row lazily (insert-missing, see `computeEngagement`) with `dirty = 1`.
//   - The heartbeat tick (`runEngagementJob`) marks everyone dirty once every 24h (a
//     full recompute, including the very first run after deploy — the backfill) and
//     otherwise just drains whatever is dirty, 150 contacts per tick (~8 ticks to
//     drain today's ~1.1k contacts after a full mark).
//   - The webhook (`/api/webhook`, `/api/inbound`) calls `markDirty([contactId])`
//     right after recording a new event/reply, so a contact's profile is at most one
//     heartbeat tick (≤60s) stale after a new open/click/reply.
//
// Score: Σ weight(type) × 0.5^(ageDays / halfLifeDays), then squashed to 0–100 via
// `normalizeScore`. Weights/half-life/tier thresholds default to the named, documented
// constants in `ENGAGEMENT_DEFAULTS` below, tunable in Settings since #116 (approved defaults from #111/#113:
// clicks ×3, replies ×5, opens ×1, proxy opens ×0.25, 60-day half-life). Site tracking
// (#153) also feeds the score: pageviews ×0.5, custom site events ×2, same half-life —
// score only; tiers' "real engagement" (the `never` tier) stays about email.
//
// Proxy-open heuristic (`classifyProxyOpen`): Apple Mail Privacy Protection (and some
// other mail-client prefetchers) fire the open pixel automatically on delivery, which
// would otherwise look like instant, universal opens. We flag an open as a "proxy open"
// when the client/user-agent looks like Apple Mail, OR the first open landed suspiciously
// fast (< 60s) after delivery. This is a heuristic, not a certainty — see the function
// doc for exactly what it matches. Proxy opens still count toward `open_count` (we saw
// *something*), but score far less (0.25x) and don't count toward "real" engagement for
// the `never` tier or the hour/day-of-week histograms (which would otherwise mostly show
// "shortly after send" for Apple Mail users, i.e. noise, not their real reading time).
//
// Timezone inference (`inferTz`): we never observe a contact's real local time. We keep
// a *country/region → UTC offset* lookup for when Postmark's Geo payload includes one,
// with a confidence score — never a certainty. (A best-hour from the UTC histogram is a
// separate, complementary signal; #111 phase 3+ can combine them for actual send-time
// optimization. This phase only stores the inputs.)

import { CLICK_LINK_SQL } from './event-detail';

export type EngagementConfig = {
	wOpen: number;
	wProxyOpen: number;
	wClick: number;
	wReply: number;
	wPageview: number; // site tracking (#153)
	wSiteEvent: number; // site tracking (#153): a named custom event (e.g. booked_call)
	halfLifeDays: number;
	tiers: { hot: number; warm: number; cool: number };
	minEventsForBestHour: number;
	// #518: security-scanner click bursts (see `classifyScannerClicks`).
	scannerWindowSeconds: number;
	scannerMinLinks: number;
};

export const ENGAGEMENT_DEFAULTS: EngagementConfig = {
	wOpen: 1,
	wProxyOpen: 0.25,
	wClick: 3,
	wReply: 5,
	wPageview: 0.5,
	wSiteEvent: 2,
	halfLifeDays: 60,
	tiers: { hot: 60, warm: 30, cool: 10 },
	minEventsForBestHour: 3,
	scannerWindowSeconds: 10,
	scannerMinLinks: 3
};

// ---------------------------------------------------------------------------
// Tunable config (#116): Settings → Engagement overrides the weights, half-life and tier
// thresholds above. Stored as JSON in `app_state.engagement_config`; anything missing or
// invalid falls back to the default, so a bad row can never break the compute.
// ---------------------------------------------------------------------------

export const ENGAGEMENT_CONFIG_KEY = 'engagement_config';

/** The operator-tunable numbers: form field name, label, and the allowed range. */
export const TUNABLE_FIELDS = [
	{ key: 'wOpen', label: 'Open', min: 0, max: 100 },
	{ key: 'wProxyOpen', label: 'Auto-open (Apple MPP)', min: 0, max: 100 },
	{ key: 'wClick', label: 'Click', min: 0, max: 100 },
	{ key: 'wReply', label: 'Reply', min: 0, max: 100 },
	{ key: 'wPageview', label: 'Site pageview', min: 0, max: 100 },
	{ key: 'wSiteEvent', label: 'Site event', min: 0, max: 100 },
	{ key: 'halfLifeDays', label: 'Half-life (days)', min: 1, max: 3650 },
	// #518: these two apply to clicks recorded from now on (classified rows keep their type).
	{ key: 'scannerWindowSeconds', label: 'Scanner burst window (s)', min: 1, max: 120 },
	{ key: 'scannerMinLinks', label: 'Scanner burst links', min: 2, max: 20 },
	{ key: 'hot', label: 'Hot ≥', min: 0, max: 100 },
	{ key: 'warm', label: 'Warm ≥', min: 0, max: 100 },
	{ key: 'cool', label: 'Cool ≥', min: 0, max: 100 }
] as const;

export type TunableKey = (typeof TUNABLE_FIELDS)[number]['key'];
export type TunableValues = Record<TunableKey, number>;

export function tunableValues(cfg: EngagementConfig): TunableValues {
	const { tiers, minEventsForBestHour: _m, ...weights } = cfg;
	return { ...weights, ...tiers };
}

function fromTunable(v: TunableValues): EngagementConfig {
	const { hot, warm, cool, ...weights } = v;
	return { ...weights, tiers: { hot, warm, cool }, minEventsForBestHour: ENGAGEMENT_DEFAULTS.minEventsForBestHour };
}

/**
 * Validate operator input (numbers or numeric strings). Blank = the default. Ranges per
 * TUNABLE_FIELDS, and tier thresholds must step down: hot > warm > cool.
 */
export function validateEngagementConfig(
	input: Partial<Record<TunableKey, unknown>>
): { ok: true; cfg: EngagementConfig } | { ok: false; error: string } {
	const defaults = tunableValues(ENGAGEMENT_DEFAULTS);
	const out = { ...defaults };
	for (const f of TUNABLE_FIELDS) {
		const raw = input[f.key];
		if (raw === undefined || raw === null || String(raw).trim() === '') continue;
		const n = Number(String(raw).trim());
		if (!Number.isFinite(n) || n < f.min || n > f.max) {
			return { ok: false, error: `${f.label} must be a number from ${f.min} to ${f.max}.` };
		}
		out[f.key] = n;
	}
	if (!(out.hot > out.warm && out.warm > out.cool)) {
		return { ok: false, error: 'Tier thresholds must step down: Hot > Warm > Cool.' };
	}
	return { ok: true, cfg: fromTunable(out) };
}

/** Parse the stored JSON; anything unreadable or invalid → the defaults. */
export function parseEngagementConfig(raw: string | null | undefined): EngagementConfig {
	if (!raw) return ENGAGEMENT_DEFAULTS;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return ENGAGEMENT_DEFAULTS;
		const v = validateEngagementConfig(parsed);
		return v.ok ? v.cfg : ENGAGEMENT_DEFAULTS;
	} catch {
		return ENGAGEMENT_DEFAULTS;
	}
}

export async function getEngagementConfig(db: D1Database): Promise<EngagementConfig> {
	const row = await db
		.prepare(`SELECT value FROM app_state WHERE key = ?`)
		.bind(ENGAGEMENT_CONFIG_KEY)
		.first<{ value: string | null }>();
	return parseEngagementConfig(row?.value);
}

/** Store a config (null = back to defaults) and mark every contact dirty so it applies. */
export async function setEngagementConfig(db: D1Database, cfg: EngagementConfig | null): Promise<void> {
	if (cfg) {
		await db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(ENGAGEMENT_CONFIG_KEY, JSON.stringify(tunableValues(cfg)))
			.run();
	} else {
		await db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(ENGAGEMENT_CONFIG_KEY).run();
	}
	await ensureRowsExist(db);
	await db.prepare(`UPDATE contact_engagement SET dirty = 1`).run();
}

// `normalizeScore` squashes an unbounded raw score into 0–100 with diminishing
// returns: `100 * (1 - exp(-raw / SCORE_SATURATION))`. SCORE_SATURATION=4 was picked
// so the examples in #113 land where the owner expects: 1 fresh click (raw=3) ≈ 53, 1 fresh
// open (raw=1) ≈ 22, 3 fresh clicks + 1 reply (raw=14) ≈ 97.
const SCORE_SATURATION = 4;

const DIRTY_BATCH_LIMIT = 200; // computeEngagement() default when no contactIds given
const SQL_ID_CHUNK = 90; // stay under D1's ~100-bound-variable-per-query cap

// ---------------------------------------------------------------------------
// Date helpers — SQLite's `datetime('now')` (and our own `recorded_at`/`sent_at`
// columns) are plain "YYYY-MM-DD HH:MM:SS" UTC strings with no zone marker. Treat
// every stored timestamp as UTC explicitly so `Date.parse` doesn't read them as
// local time in a non-UTC host timezone.
// ---------------------------------------------------------------------------

function toUtcMs(s: string | null | undefined): number {
	if (!s) return NaN;
	let iso = s.trim();
	if (!iso) return NaN;
	if (iso.includes(' ') && !iso.includes('T')) iso = iso.replace(' ', 'T');
	if (!/[zZ]|[+-]\d\d:\d\d$/.test(iso)) iso += 'Z';
	return Date.parse(iso);
}

// ---------------------------------------------------------------------------
// Proxy-open classification
// ---------------------------------------------------------------------------

/**
 * True when an open looks machine-generated (Apple Mail Privacy Protection or a
 * similar prefetcher) rather than a human reading the email. Matches when:
 *   - the user-agent or Client name/family looks like Apple Mail
 *     (`/Apple Mail|Mail\/\d|iPhone Mail|Mac OS X Mail/i`, or `Client.Family`/
 *     `Client.Name === 'Apple Mail'`), OR
 *   - `FirstOpen === true` and the open landed under 60s after delivery (MPP
 *     prefetches the pixel the moment the message is delivered — a human rarely
 *     opens that fast).
 * Pragmatic, not exact — false positives (a very fast human open) and false
 * negatives (an MPP variant we don't recognize) are both possible; see #111.
 */
export function classifyProxyOpen(
	detail: any,
	deliveredAt?: string | null,
	openedAt?: string
): boolean {
	const ua = String(detail?.UserAgent ?? '');
	const clientName = String(detail?.Client?.Name ?? '');
	const clientFamily = String(detail?.Client?.Family ?? '');
	if (/Apple Mail|Mail\/\d|iPhone Mail|Mac OS X Mail/i.test(ua)) return true;
	if (clientFamily === 'Apple Mail' || clientName === 'Apple Mail') return true;

	if (detail?.FirstOpen === true && deliveredAt && openedAt) {
		const deliveredMs = toUtcMs(deliveredAt);
		const openedMs = toUtcMs(openedAt);
		if (Number.isFinite(deliveredMs) && Number.isFinite(openedMs) && openedMs >= deliveredMs) {
			if (openedMs - deliveredMs < 60_000) return true;
		}
	}
	return false;
}

/**
 * #412: `classifyProxyOpen` as a SQL expression over an `events` row aliased `ev` (1 = an
 * auto-open), for rule compilers that can't run JS per row (the `step_opened` Condition rule
 * and the segment `opened` rule). Same tests: the Apple Mail user-agent / client, or a
 * `FirstOpen` landing under 60 s after the recipient's first delivery event. A detail that
 * isn't valid JSON (old rows cut at 4,000 characters) is not a proxy open — the JS reads it
 * as `{}` too. `tests/engagement-trigger-412.test.ts` keeps the two in step.
 */
export function proxyOpenSql(ev = 'ev'): string {
	const ua = `LOWER(COALESCE(json_extract(${ev}.detail, '$.UserAgent'), ''))`;
	const delivered = `(SELECT MIN(d.recorded_at) FROM events d WHERE d.recipient_id = ${ev}.recipient_id AND d.type = 'delivery')`;
	const gap = `(julianday(${ev}.recorded_at) - julianday(${delivered})) * 86400.0`;
	// Always 0 or 1, never NULL (a missing field makes a comparison NULL, and `NOT NULL` would
	// drop a real open from the caller's WHERE).
	return `(CASE WHEN json_valid(${ev}.detail) THEN (CASE WHEN
		${ua} LIKE '%apple mail%' OR ${ua} LIKE '%iphone mail%' OR ${ua} LIKE '%mac os x mail%' OR ${ua} GLOB '*mail/[0-9]*'
		OR json_extract(${ev}.detail, '$.Client.Family') = 'Apple Mail' OR json_extract(${ev}.detail, '$.Client.Name') = 'Apple Mail'
		OR (json_extract(${ev}.detail, '$.FirstOpen') = 1 AND ${gap} >= 0 AND ${gap} < 60)
	THEN 1 ELSE 0 END) ELSE 0 END)`;
}

// ---------------------------------------------------------------------------
// Scanner clicks (#518)
// ---------------------------------------------------------------------------
//
// Corporate mail scanners (Microsoft Safe Links, Proofpoint, Mimecast …) fetch every link in a
// message right after delivery, and Postmark reports each fetch as a Click. Those rows get their
// own event type, `scanner_click`, so every reader of `type = 'click'` (counts, score, segments,
// Condition rules, triggers, reports) leaves them out by construction. A real visit to our own
// unsubscribe page is `unsubscribe_click`: kept for the Link clicks table, never engagement.
//
// Rules, per recipient (one recipient row = one campaign), evaluated in the webhook:
//   - burst: ≥ `scannerMinLinks` distinct links within `scannerWindowSeconds` → every click in it;
//   - unsubscribe pair: the unsubscribe link and any other link within the window → the same.
// "Seconds after delivery" is deliberately not a signal: webhook order is unreliable (scanner
// clicks often arrive before the delivery event). Known gap: the clicks before a burst reaches
// its link count (normally just the first) can't be known as one yet, so they are `click` for a
// few seconds — their tag-on-click / "clicked" trigger may already have run when a later click
// reclassifies them (see the webhook). Deferring click triggers ~15 s through the tick would close it.

export const SCANNER_CLICK = 'scanner_click';
export const UNSUBSCRIBE_CLICK = 'unsubscribe_click';

/** Our per-recipient unsubscribe link (`/unsubscribe?t=…`) or the one-click endpoint. Matched by
 *  path + token: the token makes it ours whatever host (custom domain / workers.dev) it was sent on. */
export function isUnsubscribeLink(url: string | null | undefined): boolean {
	if (!url) return false;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	const path = u.pathname.replace(/\/+$/, '');
	if (path.endsWith('/unsubscribe/one-click')) return true;
	return path.endsWith('/unsubscribe') && u.searchParams.has('t');
}

/** The type a new click row is stored with before the burst check. */
export function clickTypeFor(url: string | null | undefined): 'click' | typeof UNSUBSCRIBE_CLICK {
	return isUnsubscribeLink(url) ? UNSUBSCRIBE_CLICK : 'click';
}

export type ClickRow = { id: number; link: string | null; at: string };

/**
 * The ids of `clicks` (one recipient's clicks on one campaign) that are scanner fetches. A window
 * opens at each click and runs `scannerWindowSeconds` (inclusive); a window holding ≥
 * `scannerMinLinks` distinct links, or the unsubscribe link plus any other link, marks every
 * click in it. A lone click minutes later stays a real click.
 */
export function classifyScannerClicks(clicks: ClickRow[], cfg: EngagementConfig = ENGAGEMENT_DEFAULTS): Set<number> {
	const windowMs = cfg.scannerWindowSeconds * 1000;
	const rows = clicks
		.map((c) => ({ ...c, ms: toUtcMs(c.at) }))
		.filter((c) => Number.isFinite(c.ms))
		.sort((a, b) => a.ms - b.ms || a.id - b.id);
	const out = new Set<number>();
	for (let i = 0; i < rows.length; i++) {
		const inWindow = [];
		for (let j = i; j < rows.length && rows[j].ms - rows[i].ms <= windowMs; j++) inWindow.push(rows[j]);
		const links = new Set(inWindow.map((c) => c.link).filter((l): l is string => !!l));
		const unsub = [...links].some((l) => isUnsubscribeLink(l));
		const other = [...links].some((l) => !isUnsubscribeLink(l));
		if (links.size >= cfg.scannerMinLinks || (unsub && other)) for (const c of inWindow) out.add(c.id);
	}
	return out;
}

/**
 * Webhook step: re-run `classifyScannerClicks` over this recipient's click rows and turn the
 * scanner ones into `scanner_click` (earlier rows of a burst the newest click completed too).
 * Points the scoring engine may already have given for a reclassified row are dropped and the
 * contact's scores marked dirty. Returns the ids changed.
 */
export async function reclassifyScannerClicks(
	db: D1Database,
	recipientId: number,
	cfg: EngagementConfig = ENGAGEMENT_DEFAULTS
): Promise<number[]> {
	const rows = await db
		.prepare(
			`SELECT id, type, contact_id, recorded_at AS at, ${CLICK_LINK_SQL('ev')} AS link FROM events ev
			 WHERE recipient_id = ? AND type IN ('click', '${SCANNER_CLICK}', '${UNSUBSCRIBE_CLICK}')`
		)
		.bind(recipientId)
		.all<ClickRow & { type: string; contact_id: number | null }>();
	const scanner = classifyScannerClicks(rows.results, cfg);
	const changed = rows.results.filter((r) => scanner.has(r.id) && r.type !== SCANNER_CLICK);
	if (!changed.length) return [];
	const ids = JSON.stringify(changed.map((r) => r.id));
	const contactIds = [...new Set(changed.map((r) => r.contact_id).filter((c): c is number => c != null))];
	await db.batch([
		db.prepare(`UPDATE events SET type = '${SCANNER_CLICK}' WHERE id IN (SELECT value FROM json_each(?))`).bind(ids),
		db
			.prepare(
				`DELETE FROM score_points WHERE source_type = 'events'
				 AND source_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
			)
			.bind(ids),
		db
			.prepare(`UPDATE contact_scores SET dirty = 1 WHERE contact_id IN (SELECT value FROM json_each(?))`)
			.bind(JSON.stringify(contactIds))
	]);
	return changed.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

// `n` (default 1) lets a pre-aggregated bucket (site events grouped per day) count as n events.
export type ScoreEvent = {
	type: 'open' | 'proxy_open' | 'click' | 'reply' | 'pageview' | 'site_event';
	at: string;
	n?: number;
};

function weightFor(type: ScoreEvent['type'], cfg: EngagementConfig): number {
	switch (type) {
		case 'open':
			return cfg.wOpen;
		case 'proxy_open':
			return cfg.wProxyOpen;
		case 'click':
			return cfg.wClick;
		case 'reply':
			return cfg.wReply;
		case 'pageview':
			return cfg.wPageview;
		case 'site_event':
			return cfg.wSiteEvent;
	}
}

/** Raw recency-weighted score: Σ weight(type) × 0.5^(ageDays / halfLifeDays). */
export function scoreFromEvents(events: ScoreEvent[], now: Date, cfg: EngagementConfig = ENGAGEMENT_DEFAULTS): number {
	const nowMs = now.getTime();
	let raw = 0;
	for (const ev of events) {
		const atMs = toUtcMs(ev.at);
		if (!Number.isFinite(atMs)) continue;
		const ageDays = Math.max(0, (nowMs - atMs) / 86_400_000);
		raw += weightFor(ev.type, cfg) * (ev.n ?? 1) * Math.pow(0.5, ageDays / cfg.halfLifeDays);
	}
	return raw;
}

/** Squash a raw score to 0–100 with diminishing returns (see SCORE_SATURATION doc above). */
export function normalizeScore(raw: number, _cfg: EngagementConfig = ENGAGEMENT_DEFAULTS): number {
	if (!Number.isFinite(raw) || raw <= 0) return 0;
	return 100 * (1 - Math.exp(-raw / SCORE_SATURATION));
}

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

export type TierInput = {
	sentCount: number;
	firstSentAt: string | null;
	lastEngagedAt: string | null;
	/** #444: false = unsubscribed → tier `cold` whatever the score. Omitted = subscribed. */
	subscribed?: boolean;
};
export type Tier = 'new' | 'never' | 'hot' | 'warm' | 'cool' | 'cold';

/**
 * #444: an unsubscribed contact is `cold` regardless of score (the score is still computed;
 * resubscribing restores the score-based tier on the next recompute).
 * `new` — never sent anything yet. `never` — sent ≥3 with zero real (non-proxy)
 * engagement ever. Otherwise bucketed by score against `cfg.tiers` thresholds
 * (hot ≥ hot, warm ≥ warm, cool ≥ cool, else cold).
 */
export function tierFor(score: number, input: TierInput, cfg: EngagementConfig = ENGAGEMENT_DEFAULTS): Tier {
	if (input.subscribed === false) return 'cold';
	if (input.sentCount === 0) return 'new';
	if (input.sentCount >= 3 && !input.lastEngagedAt) return 'never';
	if (score >= cfg.tiers.hot) return 'hot';
	if (score >= cfg.tiers.warm) return 'warm';
	if (score >= cfg.tiers.cool) return 'cool';
	return 'cold';
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** 24-bucket UTC hour-of-day + 7-bucket UTC day-of-week (0=Sunday) histograms. */
export function histograms(times: string[]): { hour: number[]; dow: number[] } {
	const hour = new Array(24).fill(0);
	const dow = new Array(7).fill(0);
	for (const t of times) {
		const ms = toUtcMs(t);
		if (!Number.isFinite(ms)) continue;
		const d = new Date(ms);
		hour[d.getUTCHours()]++;
		dow[d.getUTCDay()]++;
	}
	return { hour, dow };
}

/** Index of the largest bucket, or null when the histogram's total is under `min`. */
export function peak(hist: number[], min = ENGAGEMENT_DEFAULTS.minEventsForBestHour): number | null {
	const total = hist.reduce((a, b) => a + b, 0);
	if (total < min) return null;
	let bestIdx = 0;
	let bestVal = -1;
	for (let i = 0; i < hist.length; i++) {
		if (hist[i] > bestVal) {
			bestVal = hist[i];
			bestIdx = i;
		}
	}
	return bestVal > 0 ? bestIdx : null;
}

// ---------------------------------------------------------------------------
// Timezone inference — small, approximate, documented. Never treat as certain.
// ---------------------------------------------------------------------------

const US_STATE_OFFSET: Record<string, number> = {
	CA: -8, WA: -8, OR: -8, NV: -8, AK: -9, HI: -10,
	AZ: -7, CO: -7, ID: -7, MT: -7, NM: -7, UT: -7, WY: -7,
	AL: -6, AR: -6, IA: -6, IL: -6, KS: -6, LA: -6, MN: -6, MO: -6,
	MS: -6, ND: -6, NE: -6, OK: -6, SD: -6, TX: -6, WI: -6, TN: -6,
	CT: -5, DE: -5, FL: -5, GA: -5, IN: -5, KY: -5, MA: -5, MD: -5,
	ME: -5, MI: -5, NC: -5, NH: -5, NJ: -5, NY: -5, OH: -5, PA: -5,
	RI: -5, SC: -5, VA: -5, VT: -5, WV: -5, DC: -5
};

const CA_PROVINCE_OFFSET: Record<string, number> = {
	BC: -8, AB: -7, SK: -6, MB: -6, ON: -5, QC: -5, NB: -4, NS: -4, PE: -4
};

// Single-offset countries only (no DST nuance, no multi-zone countries beyond the
// US/CA maps above) — good enough for a low/medium-confidence guess.
const COUNTRY_OFFSET: Record<string, number> = {
	GB: 0, IE: 0, FR: 1, DE: 1, ES: 1, IT: 1, NL: 1,
	AU: 10, IN: 5, JP: 9, BR: -3, MX: -6 // IN is +5:30, rounded to the nearest hour
};

/** Guess a UTC offset (hours) + confidence (0–1) from a Postmark Geo country/region. */
export function inferTz(
	countryIso: string | null | undefined,
	region: string | null | undefined
): { offset: number | null; confidence: number } {
	const country = (countryIso ?? '').trim().toUpperCase();
	const reg = (region ?? '').trim().toUpperCase();
	if (country === 'US' && reg in US_STATE_OFFSET) {
		return { offset: US_STATE_OFFSET[reg], confidence: 0.8 };
	}
	if (country === 'CA' && reg in CA_PROVINCE_OFFSET) {
		return { offset: CA_PROVINCE_OFFSET[reg], confidence: 0.7 };
	}
	if (country in COUNTRY_OFFSET) {
		return { offset: COUNTRY_OFFSET[country], confidence: 0.5 };
	}
	return { offset: null, confidence: 0.2 };
}

// ---------------------------------------------------------------------------
// D1 compute
// ---------------------------------------------------------------------------

type SentRow = { contact_id: number; sent_count: number; first_sent_at: string | null; last_sent_at: string | null };
type DeliveryRow = { contact_id: number; campaign_id: number | null; recorded_at: string };
type EventRow = {
	contact_id: number;
	type: string;
	campaign_id: number | null;
	recorded_at: string;
	detail: string | null;
};
type ReplyRow = { contact_id: number; received_at: string };
type SiteRow = { contact_id: number; kind: string; at: string; n: number };

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function bump(map: Map<string, number>, key: string | null | undefined) {
	if (!key) return;
	map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>): string | null {
	let best: string | null = null;
	let bestN = 0;
	for (const [k, n] of map) {
		if (n > bestN) {
			best = k;
			bestN = n;
		}
	}
	return best;
}

/** Ensure every contact has a (dirty-by-default) contact_engagement row. */
async function ensureRowsExist(db: D1Database): Promise<void> {
	await db
		.prepare(`INSERT OR IGNORE INTO contact_engagement (contact_id, dirty) SELECT id, 1 FROM contacts`)
		.run();
}

/** Mark the given contacts' engagement rows dirty (creating rows if missing). Best-effort caller wraps in try/catch. */
export async function markDirty(db: D1Database, contactIds: number[]): Promise<void> {
	const ids = [...new Set(contactIds.filter((id) => Number.isFinite(id) && id > 0))];
	if (!ids.length) return;
	for (const batch of chunk(ids, SQL_ID_CHUNK)) {
		const placeholders = batch.map(() => '?').join(',');
		await db
			.prepare(
				`INSERT OR IGNORE INTO contact_engagement (contact_id, dirty) SELECT id, 1 FROM contacts WHERE id IN (${placeholders})`
			)
			.bind(...batch)
			.run();
		await db
			.prepare(`UPDATE contact_engagement SET dirty = 1 WHERE contact_id IN (${placeholders})`)
			.bind(...batch)
			.run();
	}
}

// #460: an override is active while `tier_override_until` is NULL (until cleared) or later
// than this compute (ISO strings compare in order). The effective tier is the active
// override, else the computed one (`tier_auto`); an expired override is dropped here.
const OVERRIDE_ACTIVE_SQL = `contact_engagement.tier_override IS NOT NULL
	AND (contact_engagement.tier_override_until IS NULL OR contact_engagement.tier_override_until > excluded.computed_at)`;
const OVERRIDE_EXPIRED_SQL = `(contact_engagement.tier_override_until IS NOT NULL
	AND contact_engagement.tier_override_until <= excluded.computed_at)`;
const EFFECTIVE_TIER_SQL = `(CASE WHEN ${OVERRIDE_ACTIVE_SQL} THEN contact_engagement.tier_override ELSE excluded.tier_auto END)`;

async function computeBatch(db: D1Database, ids: number[], now: Date, cfg: EngagementConfig): Promise<void> {
	if (!ids.length) return;
	const placeholders = ids.map(() => '?').join(',');

	const [sentRes, deliveryRes, eventRes, replyRes, siteRes, unsubRes] = await Promise.all([
		db
			.prepare(
				`SELECT r.contact_id AS contact_id, COUNT(*) AS sent_count,
				        MIN(c.sent_at) AS first_sent_at, MAX(c.sent_at) AS last_sent_at
				 FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
				 WHERE r.contact_id IN (${placeholders}) AND r.status = 'accepted'
				 GROUP BY r.contact_id`
			)
			.bind(...ids)
			.all<SentRow>(),
		db
			.prepare(
				`SELECT contact_id, campaign_id, recorded_at FROM events
				 WHERE contact_id IN (${placeholders}) AND type = 'delivery'`
			)
			.bind(...ids)
			.all<DeliveryRow>(),
		db
			.prepare(
				`SELECT contact_id, type, campaign_id, recorded_at, detail FROM events
				 WHERE contact_id IN (${placeholders}) AND type IN ('open', 'click')
				 ORDER BY contact_id, recorded_at`
			)
			.bind(...ids)
			.all<EventRow>(),
		db
			.prepare(`SELECT contact_id, received_at FROM replies WHERE contact_id IN (${placeholders})`)
			.bind(...ids)
			.all<ReplyRow>(),
		// Site tracking (#153): bucketed per contact/kind/day (a contact can hold up to 5k
		// rows) — day precision is plenty against a 60-day half-life.
		db
			.prepare(
				`SELECT contact_id, kind, MAX(occurred_at) AS at, COUNT(*) AS n FROM site_events
				 WHERE contact_id IN (${placeholders})
				 GROUP BY contact_id, kind, date(occurred_at)`
			)
			.bind(...ids)
			.all<SiteRow>(),
		// #444: unsubscribed contacts are tiered `cold`.
		db
			.prepare(`SELECT id FROM contacts WHERE id IN (${placeholders}) AND subscribed = 0`)
			.bind(...ids)
			.all<{ id: number }>()
	]);
	const unsubscribed = new Set(unsubRes.results.map((r) => r.id));

	const sentByContact = new Map(sentRes.results.map((r) => [r.contact_id, r]));

	const deliveredCountByContact = new Map<number, number>();
	const deliveryTimeByKey = new Map<string, string>(); // `${contact_id}:${campaign_id}` -> earliest recorded_at
	for (const d of deliveryRes.results) {
		deliveredCountByContact.set(d.contact_id, (deliveredCountByContact.get(d.contact_id) ?? 0) + 1);
		if (d.campaign_id != null) {
			const key = `${d.contact_id}:${d.campaign_id}`;
			const existing = deliveryTimeByKey.get(key);
			if (!existing || d.recorded_at < existing) deliveryTimeByKey.set(key, d.recorded_at);
		}
	}

	const eventsByContact = new Map<number, EventRow[]>();
	for (const e of eventRes.results) {
		if (!eventsByContact.has(e.contact_id)) eventsByContact.set(e.contact_id, []);
		eventsByContact.get(e.contact_id)!.push(e);
	}

	const repliesByContact = new Map<number, ReplyRow[]>();
	for (const r of replyRes.results) {
		if (!repliesByContact.has(r.contact_id)) repliesByContact.set(r.contact_id, []);
		repliesByContact.get(r.contact_id)!.push(r);
	}

	const siteByContact = new Map<number, SiteRow[]>();
	for (const r of siteRes.results) {
		if (!siteByContact.has(r.contact_id)) siteByContact.set(r.contact_id, []);
		siteByContact.get(r.contact_id)!.push(r);
	}

	const nowIso = now.toISOString();
	const stmts: D1PreparedStatement[] = [];

	for (const contactId of ids) {
		const sent = sentByContact.get(contactId);
		const sentCount = sent?.sent_count ?? 0;
		const deliveredCount = deliveredCountByContact.get(contactId) ?? 0;

		const contactEvents = eventsByContact.get(contactId) ?? [];
		const contactReplies = repliesByContact.get(contactId) ?? [];

		let openCount = 0;
		let proxyOpenCount = 0;
		let clickCount = 0;
		let lastOpenAt: string | null = null;
		let lastClickAt: string | null = null;
		let lastRealEngagedAt: string | null = null; // non-proxy open, click, or reply
		const openCampaigns = new Set<number>();
		const clickCampaigns = new Set<number>();
		const clientCounts = new Map<string, number>();
		const platformCounts = new Map<string, number>();
		const countryCounts = new Map<string, number>();
		const realTimes: string[] = []; // non-proxy open/click times, for hour/dow histograms
		const scoreEvents: ScoreEvent[] = [];
		let lastGeo: { country: string | null; region: string | null } | null = null;

		for (const ev of contactEvents) {
			let detail: any = {};
			if (ev.detail) {
				try {
					detail = JSON.parse(ev.detail);
				} catch {
					detail = {};
				}
			}

			bump(clientCounts, detail?.Client?.Name ?? detail?.Client?.Family ?? null);
			bump(platformCounts, detail?.Platform ?? null);
			// Prefer the ISO code (compact, and what inferTz's lookup keys on) — fall back to
			// the full country name when Postmark's Geo payload lacks one.
			const country = detail?.Geo?.CountryISOCode ?? detail?.Geo?.Country ?? null;
			bump(countryCounts, country);
			if (country || detail?.Geo?.Region) {
				lastGeo = { country, region: detail?.Geo?.Region ?? null };
			}

			if (ev.type === 'open') {
				openCount++;
				if (ev.campaign_id != null) openCampaigns.add(ev.campaign_id);
				if (!lastOpenAt || ev.recorded_at > lastOpenAt) lastOpenAt = ev.recorded_at;
				const deliveredAt = ev.campaign_id != null ? deliveryTimeByKey.get(`${contactId}:${ev.campaign_id}`) : undefined;
				const isProxy = classifyProxyOpen(detail, deliveredAt, ev.recorded_at);
				if (isProxy) {
					proxyOpenCount++;
					scoreEvents.push({ type: 'proxy_open', at: ev.recorded_at });
				} else {
					scoreEvents.push({ type: 'open', at: ev.recorded_at });
					realTimes.push(ev.recorded_at);
					if (!lastRealEngagedAt || ev.recorded_at > lastRealEngagedAt) lastRealEngagedAt = ev.recorded_at;
				}
			} else if (ev.type === 'click') {
				clickCount++;
				if (ev.campaign_id != null) clickCampaigns.add(ev.campaign_id);
				if (!lastClickAt || ev.recorded_at > lastClickAt) lastClickAt = ev.recorded_at;
				scoreEvents.push({ type: 'click', at: ev.recorded_at });
				realTimes.push(ev.recorded_at);
				if (!lastRealEngagedAt || ev.recorded_at > lastRealEngagedAt) lastRealEngagedAt = ev.recorded_at;
			}
		}

		let lastReplyAt: string | null = null;
		for (const r of contactReplies) {
			scoreEvents.push({ type: 'reply', at: r.received_at });
			if (!lastReplyAt || r.received_at > lastReplyAt) lastReplyAt = r.received_at;
			if (!lastRealEngagedAt || r.received_at > lastRealEngagedAt) lastRealEngagedAt = r.received_at;
		}
		const replyCount = contactReplies.length;

		for (const r of siteByContact.get(contactId) ?? []) {
			scoreEvents.push({ type: r.kind === 'event' ? 'site_event' : 'pageview', at: r.at, n: r.n });
		}

		const { hour, dow } = histograms(realTimes);
		const bestHour = peak(hour, cfg.minEventsForBestHour);
		const bestDow = peak(dow, cfg.minEventsForBestHour);

		const tz = inferTz(lastGeo?.country ?? null, lastGeo?.region ?? null);

		const raw = scoreFromEvents(scoreEvents, now, cfg);
		const score = normalizeScore(raw, cfg);
		const tier = tierFor(score, { sentCount, firstSentAt: sent?.first_sent_at ?? null, lastEngagedAt: lastRealEngagedAt, subscribed: !unsubscribed.has(contactId) }, cfg);

		const openRate = sentCount > 0 ? openCampaigns.size / sentCount : null;
		const clickRate = sentCount > 0 ? clickCampaigns.size / sentCount : null;

		stmts.push(
			db
				.prepare(
					`INSERT INTO contact_engagement (
						contact_id, sent_count, delivered_count, open_count, proxy_open_count, unique_open_campaigns,
						click_count, unique_click_campaigns, reply_count, first_sent_at, last_sent_at, last_open_at,
						last_click_at, last_reply_at, open_rate, click_rate, hour_hist, dow_hist, best_hour_utc, best_dow,
						tz_offset_guess, tz_confidence, top_client, top_platform, top_country, score, tier, tier_auto, dirty, computed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
					ON CONFLICT(contact_id) DO UPDATE SET
						sent_count = excluded.sent_count, delivered_count = excluded.delivered_count,
						open_count = excluded.open_count, proxy_open_count = excluded.proxy_open_count,
						unique_open_campaigns = excluded.unique_open_campaigns, click_count = excluded.click_count,
						unique_click_campaigns = excluded.unique_click_campaigns, reply_count = excluded.reply_count,
						first_sent_at = excluded.first_sent_at, last_sent_at = excluded.last_sent_at,
						last_open_at = excluded.last_open_at, last_click_at = excluded.last_click_at,
						last_reply_at = excluded.last_reply_at, open_rate = excluded.open_rate, click_rate = excluded.click_rate,
						hour_hist = excluded.hour_hist, dow_hist = excluded.dow_hist, best_hour_utc = excluded.best_hour_utc,
						best_dow = excluded.best_dow, tz_offset_guess = excluded.tz_offset_guess,
						tz_confidence = excluded.tz_confidence, top_client = excluded.top_client,
						top_platform = excluded.top_platform, top_country = excluded.top_country, score = excluded.score,
						prev_tier = CASE WHEN contact_engagement.tier IS NOT ${EFFECTIVE_TIER_SQL}
						                 THEN contact_engagement.tier ELSE contact_engagement.prev_tier END,
						tier_changed_at = CASE WHEN contact_engagement.tier IS NOT ${EFFECTIVE_TIER_SQL}
						                       THEN excluded.computed_at ELSE contact_engagement.tier_changed_at END,
						tier = ${EFFECTIVE_TIER_SQL}, tier_auto = excluded.tier_auto,
						tier_override = CASE WHEN ${OVERRIDE_EXPIRED_SQL} THEN NULL ELSE contact_engagement.tier_override END,
						tier_override_until = CASE WHEN ${OVERRIDE_EXPIRED_SQL} THEN NULL ELSE contact_engagement.tier_override_until END,
						tier_override_source = CASE WHEN ${OVERRIDE_EXPIRED_SQL} THEN NULL ELSE contact_engagement.tier_override_source END,
						tier_override_at = CASE WHEN ${OVERRIDE_EXPIRED_SQL} THEN NULL ELSE contact_engagement.tier_override_at END,
						dirty = 0, computed_at = excluded.computed_at`
				)
				.bind(
					contactId,
					sentCount,
					deliveredCount,
					openCount,
					proxyOpenCount,
					openCampaigns.size,
					clickCount,
					clickCampaigns.size,
					replyCount,
					sent?.first_sent_at ?? null,
					sent?.last_sent_at ?? null,
					lastOpenAt,
					lastClickAt,
					lastReplyAt,
					openRate,
					clickRate,
					JSON.stringify(hour),
					JSON.stringify(dow),
					bestHour,
					bestDow,
					tz.offset,
					tz.confidence,
					top(clientCounts),
					top(platformCounts),
					top(countryCounts),
					score,
					tier,
					tier,
					nowIso
				)
		);
	}

	if (stmts.length) await db.batch(stmts);
}

/**
 * Compute (or recompute) engagement rows. Picks `contactIds` when given, otherwise up
 * to `limit` (default 200) dirty rows — inserting missing rows first so every contact
 * eventually gets one. Returns how many were computed this call and how many dirty
 * rows remain (0 once the backlog is drained).
 */
export async function computeEngagement(
	db: D1Database,
	opts: { contactIds?: number[]; limit?: number; now?: Date; cfg?: EngagementConfig } = {}
): Promise<{ computed: number; remaining: number }> {
	const now = opts.now ?? new Date();
	await ensureRowsExist(db);
	const cfg = opts.cfg ?? (await getEngagementConfig(db));

	let targetIds: number[];
	if (opts.contactIds && opts.contactIds.length) {
		targetIds = [...new Set(opts.contactIds.filter((id) => Number.isFinite(id) && id > 0))];
	} else {
		const limit = opts.limit ?? DIRTY_BATCH_LIMIT;
		const rows = await db
			.prepare(`SELECT contact_id FROM contact_engagement WHERE dirty = 1 LIMIT ?`)
			.bind(limit)
			.all<{ contact_id: number }>();
		targetIds = rows.results.map((r) => r.contact_id);
	}

	let computed = 0;
	for (const batch of chunk(targetIds, SQL_ID_CHUNK)) {
		await computeBatch(db, batch, now, cfg);
		computed += batch.length;
	}

	const remainingRow = await db
		.prepare(`SELECT COUNT(*) AS n FROM contact_engagement WHERE dirty = 1`)
		.first<{ n: number }>();
	return { computed, remaining: remainingRow?.n ?? 0 };
}

export type EngagementJobResult = { computed: number; remaining: number; full: boolean; snapshot: boolean };

const FULL_RECOMPUTE_KEY = 'engagement_full_at';
const FULL_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TICK_BATCH = 150; // ~8 ticks (minutes) to drain today's ~1.1k contacts after a full mark

/**
 * Heartbeat hook (#113): once every 24h, mark every contact dirty (a full recompute —
 * this is also how the very first run after deploy backfills everyone) and stamp
 * `app_state.engagement_full_at`; every call then drains up to `TICK_BATCH` dirty rows.
 * Bounded per tick on purpose — see TICK_BATCH doc above.
 */
export async function runEngagementJob(db: D1Database, now: Date = new Date()): Promise<EngagementJobResult> {
	const row = await db
		.prepare(`SELECT value FROM app_state WHERE key = ?`)
		.bind(FULL_RECOMPUTE_KEY)
		.first<{ value: string | null }>();
	const lastFullMs = row?.value ? Date.parse(row.value) : NaN;
	const full = !Number.isFinite(lastFullMs) || now.getTime() - lastFullMs > FULL_RECOMPUTE_INTERVAL_MS;

	if (full) {
		await ensureRowsExist(db);
		await db.prepare(`UPDATE contact_engagement SET dirty = 1`).run();
		await db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(FULL_RECOMPUTE_KEY, now.toISOString())
			.run();
	}

	// #460: an override whose time has passed goes back to automatic on this tick, not at the
	// next 24 h full recompute.
	await db
		.prepare(
			`UPDATE contact_engagement SET dirty = 1
			 WHERE dirty = 0 AND tier_override IS NOT NULL AND tier_override_until IS NOT NULL AND tier_override_until <= ?`
		)
		.bind(now.toISOString())
		.run();

	const { computed, remaining } = await computeEngagement(db, { limit: TICK_BATCH, now });
	const snapshot = remaining === 0 ? await snapshotTierCounts(db, now) : false;
	return { computed, remaining, full, snapshot };
}

const SNAPSHOT_KEEP_DAYS = 400;

/**
 * Daily tier counts for the dashboard trend (#116): once per UTC day, after the backlog
 * is drained (so the counts are current), copy `tier → count` into
 * `engagement_tier_daily` and prune rows older than SNAPSHOT_KEEP_DAYS. Returns true
 * when a snapshot was written.
 */
export async function snapshotTierCounts(db: D1Database, now: Date = new Date()): Promise<boolean> {
	const day = now.toISOString().slice(0, 10);
	const have = await db
		.prepare(`SELECT 1 AS x FROM engagement_tier_daily WHERE day = ? LIMIT 1`)
		.bind(day)
		.first<{ x: number }>();
	if (have) return false;
	const cutoff = new Date(now.getTime() - SNAPSHOT_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
	await db.batch([
		db
			.prepare(
				`INSERT OR REPLACE INTO engagement_tier_daily (day, tier, n)
				 SELECT ?, tier, COUNT(*) FROM contact_engagement GROUP BY tier`
			)
			.bind(day),
		db.prepare(`DELETE FROM engagement_tier_daily WHERE day < ?`).bind(cutoff)
	]);
	return true;
}

export type EngagementStatus = {
	computedAt: string | null;
	dirty: number;
	total: number;
	tiers: Record<string, number>;
};

/** Settings-page summary: last full recompute time, dirty backlog, totals by tier. */
export async function engagementStatus(db: D1Database): Promise<EngagementStatus> {
	const fullAt = await db
		.prepare(`SELECT value FROM app_state WHERE key = ?`)
		.bind(FULL_RECOMPUTE_KEY)
		.first<{ value: string | null }>();
	const totals = await db
		.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(dirty), 0) AS dirty FROM contact_engagement`)
		.first<{ total: number; dirty: number }>();
	const tierRows = await db
		.prepare(`SELECT tier, COUNT(*) AS n FROM contact_engagement GROUP BY tier`)
		.all<{ tier: string; n: number }>();
	const tiers: Record<string, number> = {};
	for (const r of tierRows.results) tiers[r.tier] = r.n;
	return {
		computedAt: fullAt?.value ?? null,
		dirty: totals?.dirty ?? 0,
		total: totals?.total ?? 0,
		tiers
	};
}
