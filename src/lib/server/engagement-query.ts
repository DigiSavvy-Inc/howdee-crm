// Engagement reads (#114): SQL conditions shared by the /contacts filters and dynamic
// segment rules, plus the per-contact profile (contact page card + Data API) and the
// Data API's summary. `idExpr` is the outer query's contact-id column (`contacts.id` on
// /contacts, `c.id` in segment-query) — every value is a bound parameter.
//
// Tier/score come from the `contact_engagement` rollup (#113; ≤ one heartbeat stale, and a
// contact with no row yet counts as `new` / 0). The open-based conditions read `events`
// directly so they're exact and live; they count every open, including proxy (Apple MPP)
// opens — the rollup's proxy classification is a JS heuristic with no SQL equivalent.

import { TIERS, fillMonths, lastMonths, proxyShare, type MonthPoint, type TierName } from '$lib/engagement-view';

export type Clause = { clause: string; binds: unknown[] };

/** The contact's tier is (or, with `negate`, isn't) `tier`. */
export function tierClause(tier: TierName, idExpr: string, negate = false): Clause {
	return {
		clause: `COALESCE((SELECT ce.tier FROM contact_engagement ce WHERE ce.contact_id = ${idExpr}), 'new') ${negate ? '!=' : '='} ?`,
		binds: [tier]
	};
}

/** Opened any email in the last `days` days (`negate`: not in that window). */
export function openedWithinClause(days: number, idExpr: string, negate = false): Clause {
	const inner = `SELECT 1 FROM events eo WHERE eo.contact_id = ${idExpr} AND eo.type = 'open'
		AND eo.recorded_at >= datetime('now', ?)`;
	return { clause: negate ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`, binds: [`-${days} days`] };
}

/**
 * Never opened: was sent at least one email (an accepted recipient row) and has no open
 * event at all. `negate` = has opened at least once. A contact never mailed matches neither.
 */
export function neverOpenedClause(idExpr: string, negate = false): Clause {
	const opened = `EXISTS (SELECT 1 FROM events eo WHERE eo.contact_id = ${idExpr} AND eo.type = 'open')`;
	if (negate) return { clause: opened, binds: [] };
	return {
		clause: `EXISTS (SELECT 1 FROM recipients rs WHERE rs.contact_id = ${idExpr} AND rs.status = 'accepted') AND NOT ${opened}`,
		binds: []
	};
}

const COUNT_OPS: Record<string, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=' };
export const COUNT_OP_KEYS = Object.keys(COUNT_OPS);

/** Number of open events in the last `days` days compared with `n` (`op` ∈ COUNT_OPS). */
export function opensInWindowClause(op: string, n: number, days: number, idExpr: string): Clause | null {
	const sql = COUNT_OPS[op];
	if (!sql) return null;
	return {
		clause: `(SELECT COUNT(*) FROM events eo WHERE eo.contact_id = ${idExpr} AND eo.type = 'open'
			AND eo.recorded_at >= datetime('now', ?)) ${sql} ?`,
		binds: [`-${days} days`, n]
	};
}

/**
 * Opened at least `n` of the contact's last `m` sends (accepted recipient rows, newest by
 * the campaign's send time). A contact with fewer than `n` sends can't match.
 */
export function openedOfLastClause(n: number, m: number, idExpr: string): Clause {
	return {
		clause: `(SELECT COUNT(*) FROM recipients rl
			WHERE rl.id IN (
				SELECT r2.id FROM recipients r2 JOIN campaigns c2 ON c2.id = r2.campaign_id
				WHERE r2.contact_id = ${idExpr} AND r2.status = 'accepted'
				ORDER BY COALESCE(c2.sent_at, c2.created_at) DESC, r2.id DESC LIMIT ?)
			AND EXISTS (SELECT 1 FROM events eo WHERE eo.contact_id = ${idExpr}
				AND eo.campaign_id = rl.campaign_id AND eo.type = 'open')) >= ?`,
		binds: [m, n]
	};
}

// ---- Profile ---------------------------------------------------------------------------

type EngagementRow = {
	sent_count: number;
	delivered_count: number;
	open_count: number;
	proxy_open_count: number;
	unique_open_campaigns: number;
	click_count: number;
	unique_click_campaigns: number;
	reply_count: number;
	first_sent_at: string | null;
	last_sent_at: string | null;
	last_open_at: string | null;
	last_click_at: string | null;
	last_reply_at: string | null;
	open_rate: number | null;
	click_rate: number | null;
	best_hour_utc: number | null;
	best_dow: number | null;
	tz_offset_guess: number | null;
	tz_confidence: number | null;
	top_client: string | null;
	top_platform: string | null;
	top_country: string | null;
	score: number;
	tier: string;
	tier_auto: string | null;
	tier_override: string | null;
	tier_override_until: string | null;
	tier_override_source: string | null;
	tier_override_at: string | null;
	dirty: number;
	computed_at: string | null;
};

export type EngagementProfile = {
	tier: TierName; // effective: the override while it lasts, else the automatic tier (#460)
	tier_auto: TierName; // #460: the computed tier underneath any override
	tier_override: TierName | null; // #460: null = automatic
	tier_override_until: string | null; // ISO; null = until cleared (or no override)
	tier_override_source: string | null; // automation:<id> | user:<login> | bulk:<login> | assistant:<login> | api:<key id>
	tier_override_at: string | null;
	score: number; // 0–100, rounded
	sent_count: number;
	delivered_count: number;
	open_count: number;
	proxy_open_count: number;
	proxy_open_share: number | null; // 0–1
	click_count: number;
	reply_count: number;
	open_rate: number | null;
	click_rate: number | null;
	first_sent_at: string | null;
	last_sent_at: string | null;
	last_open_at: string | null;
	last_click_at: string | null;
	last_reply_at: string | null;
	last_activity_at: string | null; // newest of open/click/reply
	best_hour_utc: number | null;
	best_dow: number | null; // 0 = Sunday, UTC
	tz_offset_guess: number | null;
	tz_confidence: number | null;
	top_client: string | null;
	top_platform: string | null;
	top_country: string | null;
	monthly: MonthPoint[]; // last 12 calendar months (UTC), oldest first
	computed_at: string | null; // null = not computed yet
	stale: boolean; // marked dirty, waiting for the next heartbeat
};

function newest(...ts: (string | null)[]): string | null {
	let best: string | null = null;
	for (const t of ts) if (t && (!best || t > best)) best = t;
	return best;
}

/** One contact's engagement profile. Defaults (tier `new`) when the rollup has no row yet. */
export async function engagementProfile(db: D1Database, contactId: number, now: Date = new Date()): Promise<EngagementProfile> {
	const months = lastMonths(now, 12);
	const [row, monthRows] = await Promise.all([
		db.prepare('SELECT * FROM contact_engagement WHERE contact_id = ?').bind(contactId).first<EngagementRow>(),
		db
			.prepare(
				`SELECT strftime('%Y-%m', recorded_at) AS month,
				        SUM(type = 'open') AS opens, SUM(type = 'click') AS clicks
				 FROM events
				 WHERE contact_id = ? AND type IN ('open', 'click') AND recorded_at >= ?
				 GROUP BY month`
			)
			.bind(contactId, `${months[0]}-01 00:00:00`)
			.all<{ month: string; opens: number; clicks: number }>()
	]);
	const r = row;
	const tier = TIERS.includes(r?.tier as TierName) ? (r!.tier as TierName) : 'new';
	const override = TIERS.includes(r?.tier_override as TierName) ? (r!.tier_override as TierName) : null;
	return {
		tier,
		tier_auto: TIERS.includes(r?.tier_auto as TierName) ? (r!.tier_auto as TierName) : override ? 'new' : tier,
		tier_override: override,
		tier_override_until: override ? (r?.tier_override_until ?? null) : null,
		tier_override_source: override ? (r?.tier_override_source ?? null) : null,
		tier_override_at: override ? (r?.tier_override_at ?? null) : null,
		score: Math.round(r?.score ?? 0),
		sent_count: r?.sent_count ?? 0,
		delivered_count: r?.delivered_count ?? 0,
		open_count: r?.open_count ?? 0,
		proxy_open_count: r?.proxy_open_count ?? 0,
		proxy_open_share: proxyShare(r?.open_count ?? 0, r?.proxy_open_count ?? 0),
		click_count: r?.click_count ?? 0,
		reply_count: r?.reply_count ?? 0,
		open_rate: r?.open_rate ?? null,
		click_rate: r?.click_rate ?? null,
		first_sent_at: r?.first_sent_at ?? null,
		last_sent_at: r?.last_sent_at ?? null,
		last_open_at: r?.last_open_at ?? null,
		last_click_at: r?.last_click_at ?? null,
		last_reply_at: r?.last_reply_at ?? null,
		last_activity_at: newest(r?.last_open_at ?? null, r?.last_click_at ?? null, r?.last_reply_at ?? null),
		best_hour_utc: r?.best_hour_utc ?? null,
		best_dow: r?.best_dow ?? null,
		tz_offset_guess: r?.tz_offset_guess ?? null,
		tz_confidence: r?.tz_confidence ?? null,
		top_client: r?.top_client ?? null,
		top_platform: r?.top_platform ?? null,
		top_country: r?.top_country ?? null,
		monthly: fillMonths(months, monthRows.results),
		computed_at: r?.computed_at ?? null,
		stale: !r || r.dirty === 1
	};
}

// ---- Summary (Data API) ----------------------------------------------------------------

export type EngagementSummary = {
	total_contacts: number;
	tiers: Record<TierName, number>;
	average_score: number | null; // over contacts that have been sent something
	opened_last_30d: number; // contacts with an open in the last 30 days
	clicked_last_30d: number;
	last_full_recompute_at: string | null;
	pending_recompute: number; // dirty rollup rows
};

/**
 * Audience-wide engagement totals. Contacts without a rollup row count as `new`.
 * #423: `scope` (a `WHERE …` over unaliased `contacts`, e.g. contactsWhere) narrows every
 * number to those contacts; `excludeArchived` leaves archived contacts out. Neither set =
 * every contact, as the Data API has always reported.
 */
export async function engagementSummary(
	db: D1Database,
	opts: { scope?: { where: string; binds: unknown[] }; excludeArchived?: boolean } = {}
): Promise<EngagementSummary> {
	const conds: string[] = [];
	const binds: unknown[] = [];
	if (opts.scope) {
		conds.push(`c.id IN (SELECT id FROM contacts ${opts.scope.where})`);
		binds.push(...opts.scope.binds);
	}
	if (opts.excludeArchived) conds.push('c.archived_at IS NULL');
	const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
	// Events carry contact_id only; scope them through the same contact predicate.
	const evScope = conds.length ? ` AND contact_id IN (SELECT c.id FROM contacts c ${where})` : '';
	const [tierRows, agg, opened, clicked, fullAt] = await Promise.all([
		db
			.prepare(
				`SELECT COALESCE(ce.tier, 'new') AS tier, COUNT(*) AS n
				 FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id
				 ${where}
				 GROUP BY 1`
			)
			.bind(...binds)
			.all<{ tier: string; n: number }>(),
		db
			.prepare(
				`SELECT AVG(CASE WHEN ce.sent_count > 0 THEN ce.score END) AS avg_score,
				        COALESCE(SUM(ce.dirty), 0) AS dirty
				 FROM contacts c JOIN contact_engagement ce ON ce.contact_id = c.id
				 ${where}`
			)
			.bind(...binds)
			.first<{ avg_score: number | null; dirty: number }>(),
		db
			.prepare(
				`SELECT COUNT(DISTINCT contact_id) AS n FROM events
				 WHERE type = 'open' AND contact_id IS NOT NULL AND recorded_at >= datetime('now', '-30 days')${evScope}`
			)
			.bind(...binds)
			.first<{ n: number }>(),
		db
			.prepare(
				`SELECT COUNT(DISTINCT contact_id) AS n FROM events
				 WHERE type = 'click' AND contact_id IS NOT NULL AND recorded_at >= datetime('now', '-30 days')${evScope}`
			)
			.bind(...binds)
			.first<{ n: number }>(),
		db.prepare(`SELECT value FROM app_state WHERE key = 'engagement_full_at'`).first<{ value: string | null }>()
	]);
	const tiers = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<TierName, number>;
	let total = 0;
	for (const r of tierRows.results) {
		total += r.n;
		if (TIERS.includes(r.tier as TierName)) tiers[r.tier as TierName] += r.n;
	}
	return {
		total_contacts: total,
		tiers,
		average_score: agg?.avg_score == null ? null : Math.round(agg.avg_score * 10) / 10,
		opened_last_30d: opened?.n ?? 0,
		clicked_last_30d: clicked?.n ?? 0,
		last_full_recompute_at: fullAt?.value ?? null,
		pending_recompute: agg?.dirty ?? 0
	};
}

// ---- Best-time lift (#115) -------------------------------------------------------------

export type CohortStats = { sent: number; opened: number; clicked: number; queued: number };
export type BestTimeLift = { best: CohortStats; default: CohortStats };

/**
 * A best-time campaign's two cohorts (recipients.send_cohort): unique openers/clickers
 * among accepted sends, plus rows still waiting. Opens count as-is (proxy opens included,
 * like the other open-based reads). Null for an ordinary campaign (no cohort rows).
 */
export async function bestTimeLift(db: D1Database, campaignId: number): Promise<BestTimeLift | null> {
	const rows = await db
		.prepare(
			`SELECT r.send_cohort AS cohort,
			        SUM(CASE WHEN r.status = 'accepted' THEN 1 ELSE 0 END) AS sent,
			        SUM(CASE WHEN r.status IN ('queued', 'sending') THEN 1 ELSE 0 END) AS queued,
			        SUM(CASE WHEN r.status = 'accepted' AND EXISTS (
			              SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.type = 'open') THEN 1 ELSE 0 END) AS opened,
			        SUM(CASE WHEN r.status = 'accepted' AND EXISTS (
			              SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.type = 'click') THEN 1 ELSE 0 END) AS clicked
			 FROM recipients r
			 WHERE r.campaign_id = ? AND r.send_cohort IN ('best', 'default')
			 GROUP BY r.send_cohort`
		)
		.bind(campaignId)
		.all<{ cohort: 'best' | 'default'; sent: number; queued: number; opened: number; clicked: number }>();
	if (rows.results.length === 0) return null;
	const empty = (): CohortStats => ({ sent: 0, opened: 0, clicked: 0, queued: 0 });
	const out: BestTimeLift = { best: empty(), default: empty() };
	for (const r of rows.results) {
		out[r.cohort] = { sent: r.sent ?? 0, opened: r.opened ?? 0, clicked: r.clicked ?? 0, queued: r.queued ?? 0 };
	}
	return out;
}
