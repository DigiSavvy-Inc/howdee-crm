// Company dashboard (#564, 1 of 4): everything the at-a-glance strip on /companies/[id] reads,
// in one `db.batch` (plus the conversations, threaded in JS like the contacts overview, #423).
//
// Scope: the company's active contacts (archived ones never count). A "touch" is human
// engagement: an open that `proxyOpenSql` doesn't flag as an Apple Mail / prefetch auto-open, a
// click (`scanner_click` / `unsubscribe_click` are other types, so never), a reply or a site
// event. Deliveries never count. Last touch also takes the Timing and GitHub dates (#436).
// Billing columns are read only when the caller passes `billing: true` (`canSeeBilling`).

import { proxyOpenSql } from './engagement';
import { awaitingIdsFrom, listedThreads } from './conversations';
import { offsetModifier, tzOffsetMinutes, growthSince } from '$lib/contacts-overview';
import {
	ENGAGED_DAYS,
	engagementBuckets,
	fillEngagement,
	isGoingQuiet,
	newestOf,
	visibleTiles,
	type DashboardSources,
	type EngagementPoint,
	type TileKey
} from '$lib/company-dashboard';
import { TIERS, type TierName } from '$lib/engagement-view';

export type DashboardContact = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
};

export type CompanyDashboard = {
	tiles: TileKey[];
	sources: DashboardSources;
	contacts: { total: number; subscribed: number };
	engaged30d: number;
	lastTouchAt: string | null;
	awaiting: number;
	deals: { open: number; value: number };
	hours: { hours_30d: number | null; hours_90d: number | null } | null;
	issuesOpen: number | null;
	billing: { outstanding: number | null; overdue: number | null; currency: string | null } | null;
	goingQuiet: boolean;
	series: EngagementPoint[];
	/**
	 * Up to 5 by engagement score (then Lead score, then id). `lead_score` is null when the seeded
	 * Lead score no longer exists (no row = 0); `last_activity_at` = their newest touch.
	 */
	topContacts: (DashboardContact & { score: number; tier: TierName; lead_score: number | null; last_activity_at: string | null })[];
	/** The Lead score's current name (it can be renamed), null when it was deleted. */
	leadScoreName: string | null;
	openDeals: (DashboardContact & {
		card_id: number;
		value: number | null;
		stage: string;
		color: string | null;
		entered_stage_at: string;
	})[];
	tiers: Record<TierName, number>;
};

type MetricsRow = {
	hours_30d: number | null;
	hours_90d: number | null;
	last_tracked_at: string | null;
	timing_synced_at: string | null;
	issues_open: number | null;
	last_issue_at: string | null;
	github_synced_at: string | null;
	ar_outstanding?: number | null;
	ar_overdue?: number | null;
	billing_currency?: string | null;
	zoho_synced_at?: string | null;
};

/** The seeded Lead score (#466), found by its slug. */
const LEAD_SCORE_ID = `SELECT id FROM score_defs WHERE slug = 'lead-score'`;
const TOP_CONTACTS = 5;

function utcStamp(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export async function loadCompanyDashboard(
	db: D1Database,
	companyId: number,
	opts: { billing: boolean; now?: Date; tz: string }
): Promise<CompanyDashboard> {
	const now = opts.now ?? new Date();
	const offset = tzOffsetMinutes(opts.tz, now);
	const buckets = engagementBuckets(now, offset);
	const seriesSince = growthSince(buckets, offset);
	const since30 = utcStamp(now.getTime() - ENGAGED_DAYS * 86_400_000);
	const mod = offsetModifier(offset);

	const ids = `SELECT id FROM contacts WHERE company_id = ? AND archived_at IS NULL`;
	// One row per touch: (cid, at, kind). Three `?` = the company id, once per source.
	const touches = `
		SELECT e.contact_id AS cid, e.recorded_at AS at, CASE e.type WHEN 'open' THEN 'opens' ELSE 'clicks' END AS kind
		FROM events e WHERE e.contact_id IN (${ids})
		  AND (e.type = 'click' OR (e.type = 'open' AND ${proxyOpenSql('e')} = 0))
		UNION ALL
		SELECT r.contact_id, r.received_at, 'replies' FROM replies r WHERE r.contact_id IN (${ids})
		UNION ALL
		SELECT s.contact_id, s.occurred_at, 'visits' FROM site_events s WHERE s.contact_id IN (${ids})`;
	const t3 = [companyId, companyId, companyId];
	const billingCols = opts.billing ? ', ar_outstanding, ar_overdue, billing_currency, zoho_synced_at' : '';
	const person = 'c.id, c.email, c.name, c.first_name, c.last_name';

	const [batch, threads] = await Promise.all([
		db.batch([
			db
				.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(subscribed = 1), 0) AS subscribed FROM contacts WHERE company_id = ? AND archived_at IS NULL`)
				.bind(companyId),
			db.prepare(`SELECT id FROM contacts WHERE company_id = ? AND archived_at IS NULL`).bind(companyId),
			db
				.prepare(`SELECT COUNT(DISTINCT cid) AS n FROM (${touches}) WHERE datetime(at) >= ?`)
				.bind(...t3, since30),
			db.prepare(`SELECT MAX(datetime(at)) AS at FROM (${touches})`).bind(...t3),
			db
				.prepare(
					// The trend series (#565): the touches plus deliveries (context, never a touch).
					`SELECT date(at, ?) AS d, kind, COUNT(*) AS n FROM (${touches}
					 UNION ALL
					 SELECT e.contact_id, e.recorded_at, 'delivered' FROM events e WHERE e.contact_id IN (${ids}) AND e.type = 'delivery')
					 WHERE datetime(at) >= ? GROUP BY d, kind`
				)
				.bind(mod, ...t3, companyId, seriesSince),
			db
				.prepare(
					`SELECT hours_30d, hours_90d, last_tracked_at, timing_synced_at, issues_open, last_issue_at, github_synced_at${billingCols}
					 FROM company_metrics WHERE company_id = ?`
				)
				.bind(companyId),
			db
				.prepare(
					`SELECT ${person}, ce.score, ce.tier, cs.value AS lead_score FROM contacts c
					 JOIN contact_engagement ce ON ce.contact_id = c.id
					 LEFT JOIN contact_scores cs ON cs.contact_id = c.id AND cs.score_id = (${LEAD_SCORE_ID})
					 WHERE c.company_id = ? AND c.archived_at IS NULL AND ce.score > 0
					 ORDER BY ce.score DESC, COALESCE(cs.value, 0) DESC, c.id LIMIT ${TOP_CONTACTS}`
				)
				.bind(companyId),
			// Last touch per contact, for the top contacts card (#565).
			db.prepare(`SELECT cid, MAX(datetime(at)) AS at FROM (${touches}) GROUP BY cid`).bind(...t3),
			db.prepare(`SELECT id, name FROM score_defs WHERE id = (${LEAD_SCORE_ID})`),
			db
				.prepare(
					`SELECT ${person}, pc.id AS card_id, pc.value, s.name AS stage, s.color, pc.entered_stage_at
					 FROM pipeline_cards pc JOIN pipeline_stages s ON s.id = pc.stage_id JOIN contacts c ON c.id = pc.contact_id
					 WHERE c.company_id = ? AND c.archived_at IS NULL AND s.kind = 'open'
					 ORDER BY s.position, pc.position, pc.id`
				)
				.bind(companyId),
			db
				.prepare(
					`SELECT COUNT(*) AS n FROM pipeline_cards pc JOIN contacts c ON c.id = pc.contact_id
					 WHERE c.company_id = ? AND c.archived_at IS NULL`
				)
				.bind(companyId),
			db
				.prepare(
					`SELECT COALESCE(ce.tier, 'new') AS tier, COUNT(*) AS n FROM contacts c
					 LEFT JOIN contact_engagement ce ON ce.contact_id = c.id
					 WHERE c.company_id = ? AND c.archived_at IS NULL GROUP BY 1`
				)
				.bind(companyId)
		]),
		listedThreads(db)
	]);
	const [countRow, idRows, engagedRow, touchRow, seriesRows, metricsRows, topRows, lastRows, leadRows, dealRows, cardRow, tierRows] = batch;
	const leadDef = (leadRows.results[0] ?? null) as { id: number; name: string } | null;
	const lastByContact = new Map((lastRows.results as { cid: number; at: string | null }[]).map((r) => [r.cid, r.at]));
	const topContacts = (topRows.results as (DashboardContact & { score: number; tier: TierName; lead_score: number | null })[]).map(
		(r) => ({ ...r, lead_score: leadDef ? (r.lead_score ?? 0) : null, last_activity_at: lastByContact.get(r.id) ?? null })
	);

	const counts = (countRow.results[0] ?? { total: 0, subscribed: 0 }) as { total: number; subscribed: number };
	const contactIds = new Set((idRows.results as { id: number }[]).map((r) => r.id));
	const m = (metricsRows.results[0] ?? null) as MetricsRow | null;
	const deals = dealRows.results as CompanyDashboard['openDeals'];
	const awaiting = awaitingIdsFrom(threads, 0, now).filter((id) => contactIds.has(id)).length;

	const lastTouchAt = newestOf((touchRow.results[0] as { at: string | null } | undefined)?.at, m?.last_tracked_at, m?.last_issue_at);

	const sources: DashboardSources = {
		contacts: counts.total > 0,
		pipeline: ((cardRow.results[0] as { n: number } | undefined)?.n ?? 0) > 0,
		timing: !!m?.timing_synced_at,
		github: !!m?.github_synced_at,
		billing: opts.billing && !!m?.zoho_synced_at
	};

	const tiers = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<TierName, number>;
	for (const r of tierRows.results as { tier: string; n: number }[]) {
		if (r.tier in tiers) tiers[r.tier as TierName] += r.n;
	}

	return {
		tiles: visibleTiles(sources, !!lastTouchAt),
		sources,
		contacts: { total: counts.total, subscribed: counts.subscribed },
		engaged30d: (engagedRow.results[0] as { n: number } | undefined)?.n ?? 0,
		lastTouchAt,
		awaiting,
		deals: { open: deals.length, value: deals.reduce((a, d) => a + (d.value ?? 0), 0) },
		hours: sources.timing ? { hours_30d: m!.hours_30d, hours_90d: m!.hours_90d } : null,
		issuesOpen: sources.github ? (m!.issues_open ?? 0) : null,
		billing: sources.billing
			? { outstanding: m!.ar_outstanding ?? null, overdue: m!.ar_overdue ?? null, currency: m!.billing_currency ?? null }
			: null,
		goingQuiet: isGoingQuiet({ hours_90d: m?.hours_90d ?? null, hours_30d: m?.hours_30d ?? null, last_touch_at: lastTouchAt }, now),
		series: fillEngagement(buckets, seriesRows.results as { d: string; kind: string; n: number }[]),
		topContacts,
		leadScoreName: leadDef?.name ?? null,
		openDeals: deals,
		tiers
	};
}
