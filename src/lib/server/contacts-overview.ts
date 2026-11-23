// Contacts overview (#423): the section above the /contacts table — KPI tiles, growth,
// by-source / by-list bars, engagement mix and "needs attention", all over the contacts the
// page's filter matches (unfiltered = every active contact; archived only with `?archived=`).
//
// Every tile and attention row is "the page's filter + a few more params": its count is
// `COUNT(*)` of contactsWhere(that merged filter) and its link is that filter's URL, so a
// tile's number is exactly what the table shows after the click. Charts run GROUP BY over
// the scoped ids. Two rounds of batched reads (charts + conversations + engagement together,
// then every count in one batch); no AI.

import {
	contactsFilterParams,
	contactsWhere,
	isFiltered,
	parseContactsFilter,
	resolveContactsFilter,
	type ContactsFilter
} from './contacts-query';
import { CONTACT_ACTIVITY_TYPES, activityExtras, parseFeedTypes, recentActivity } from './activity';
import { csvCell } from '$lib/report-view';
import { awaitingIdsFrom, listedThreads } from './conversations';
import { engagementSummary } from './engagement-query';
import { tierTrend, type TierTrend } from './engagement-insights';
import {
	fillGrowth,
	growthBuckets,
	growthSince,
	offsetModifier,
	parsePeriod,
	periodDef,
	periodSince,
	periodStartDate,
	topWithOther,
	tzOffsetMinutes,
	type GrowthPoint,
	type PeriodKey
} from '$lib/contacts-overview';
import type { TierName } from '$lib/engagement-view';
import type { SegmentRule } from './segment-query';

/** Above this many contacts in scope the charts read the first 50,000 only ("approximate"). */
export const OVERVIEW_SCOPE_CAP = 50_000;

export type OverviewTile = { key: string; label: string; value: number; sub?: string; href: string | null };
export type OverviewBar = { label: string; n: number; href: string | null };
export type AttentionRow = { key: string; label: string; n: number; action: string; href: string };

export type ContactsOverview = {
	period: PeriodKey;
	periodStart: string; // YYYY-MM-DD (UTC)
	scopeCount: number;
	approximate: boolean;
	filtered: boolean;
	tiles: OverviewTile[];
	growth: GrowthPoint[];
	growthUnit: 'day' | 'week' | 'month';
	sources: OverviewBar[];
	lists: OverviewBar[];
	engagement: {
		tiers: Record<TierName, number>;
		average_score: number | null;
		opened_last_30d: number;
		clicked_last_30d: number;
	};
	trend: TierTrend | null; // only unfiltered (the snapshots are audience-wide)
	attention: AttentionRow[];
};

type Params = Record<string, string>;

/** The page filter with `extra` params laid over it (a key set to '' is dropped). */
export function mergedFilter(base: ContactsFilter, extra: Params): ContactsFilter {
	const p = new URLSearchParams(contactsFilterParams(base));
	for (const [k, v] of Object.entries(extra)) {
		if (v === '') p.delete(k);
		else p.set(k, v);
	}
	return parseContactsFilter(p);
}

/** `/contacts?…` for a filter (plus the overview period when it isn't the default). */
export function contactsHref(f: ContactsFilter, period?: PeriodKey): string {
	const p = new URLSearchParams(contactsFilterParams(f));
	if (period && period !== '30d') p.set('period', period);
	const q = p.toString();
	return q ? `/contacts?${q}` : '/contacts';
}

function withSort(href: string, sort?: string): string {
	return sort ? `${href}${href.includes('?') ? '&' : '?'}${sort}` : href;
}

// `sort` lands the click on a sorted table (score ascending = the coldest first).
type TileDef = { key: string; label: string; extra: Params; sub?: string; sort?: string };

function tileDefs(period: PeriodKey, start: string): TileDef[] {
	const days = String(periodDef(period).days);
	return [
		{ key: 'subscribed', label: 'Subscribed', extra: { status: 'subscribed' } },
		{ key: 'new', label: 'New in period', extra: { added_from: start }, sub: `added since ${start}` },
		{ key: 'unsubscribed', label: 'Unsubscribed in period', extra: { unsub_from: start, status: 'all' }, sub: `since ${start}` },
		{ key: 'never_opened', label: 'Never opened', extra: { never_opened: '1' }, sub: 'sent to, no open yet' },
		{ key: 'going_cold', label: 'Going cold', extra: { cooled_days: days }, sub: 'dropped to cool / cold', sort: 'sort=score&dir=asc' },
		{ key: 'awaiting', label: 'Awaiting our reply', extra: { awaiting: '1' }, sub: 'they wrote last' },
		{ key: 'in_pipeline', label: 'In pipeline', extra: { pipeline: 'any' }, sub: 'on the board' },
		{ key: 'hot_no_pipeline', label: 'Hot, no pipeline card', extra: { tier: 'hot', pipeline: 'none' }, sub: 'worth a deal?' }
	];
}

const ATTENTION: { key: string; label: string; action: string; extra: Params }[] = [
	{ key: 'hard_bounced', label: 'Hard-bounced, still subscribed', action: 'Review and unsubscribe', extra: { status: 'subscribed', bounced: 'hard' } },
	{ key: 'spam', label: 'Spam complaint, still subscribed', action: 'Review and unsubscribe', extra: { status: 'subscribed', spam: '1' } },
	{ key: 'awaiting_3d', label: 'Awaiting our reply for over 3 days', action: 'Open them', extra: { awaiting: '1', awaiting_days: '3' } },
	{ key: 'hot_no_company', label: 'Hot contacts with no company', action: 'Add companies', extra: { tier: 'hot', has_company: 'no' } },
	{ key: 'hygiene_invalid', label: 'Invalid addresses (no mail server / disposable)', action: 'Review', extra: { hygiene: 'invalid' } },
	{ key: 'hygiene_typo', label: 'Likely typos in the address', action: 'Fix', extra: { hygiene: 'typo' } },
	{ key: 'no_list', label: 'In no list', action: 'Add to a list', extra: { no_list: '1' } }
];

export async function loadContactsOverview(
	db: D1Database,
	filter: ContactsFilter,
	opts: { period: PeriodKey; tz: string; now?: Date }
): Promise<ContactsOverview> {
	const now = opts.now ?? new Date();
	const period = opts.period;
	const def = periodDef(period);
	const start = periodStartDate(period, now);
	// A page filter that itself asks for `awaiting` must be resolved before it can scope anything.
	const base = filter.awaiting ? await resolveContactsFilter(db, filter) : filter;
	const scope = contactsWhere(base);
	const filtered = isFiltered(base) || !!base.q;

	const offset = tzOffsetMinutes(opts.tz, now);
	const buckets = growthBuckets(period, now, offset);
	const since = growthSince(buckets, offset);
	const mod = offsetModifier(offset);
	// The charts read at most OVERVIEW_SCOPE_CAP scoped ids (the scope count says when that bit).
	const ids = `SELECT id FROM contacts ${scope.where} LIMIT ${OVERVIEW_SCOPE_CAP}`;

	// Round 1, all at once: the conversations (the awaiting tiles thread them in JS), the charts,
	// the engagement mix and — unfiltered only — the audience-wide tier trend.
	const [threads, charts, summary, trend] = await Promise.all([
		listedThreads(db),
		db.batch([
			db
				.prepare(`SELECT date(created_at, ?) AS d, COUNT(*) AS n FROM contacts WHERE id IN (${ids}) AND created_at >= ? GROUP BY d`)
				.bind(mod, ...scope.params, since),
			db
				.prepare(
					`SELECT date(u.created_at, ?) AS d, COUNT(DISTINCT u.email) AS n FROM unsubscribes u
					 WHERE u.created_at >= ? AND u.email IN (SELECT email FROM contacts WHERE id IN (${ids})) GROUP BY d`
				)
				.bind(mod, since, ...scope.params),
			db
				.prepare(
					`SELECT COALESCE(NULLIF(TRIM(source), ''), '') AS label, COUNT(*) AS n FROM contacts
					 WHERE id IN (${ids}) GROUP BY 1 ORDER BY n DESC`
				)
				.bind(...scope.params),
			db
				.prepare(
					`SELECT l.id, l.name AS label, COUNT(*) AS n FROM list_members lm JOIN lists l ON l.id = lm.list_id
					 WHERE l.kind = 'list' AND lm.contact_id IN (${ids})
					 GROUP BY l.id ORDER BY n DESC, l.name COLLATE NOCASE LIMIT 8`
				)
				.bind(...scope.params)
		]),
		engagementSummary(db, { scope: { where: scope.where, binds: scope.params } }),
		filtered ? Promise.resolve(null) : tierTrend(db, now)
	]);
	const [addedRows, unsubRows, sourceRows, listRows] = charts;

	// Round 2: every count — the scope itself, then each tile and attention row's merged filter.
	const resolve = (f: ContactsFilter): ContactsFilter =>
		f.awaiting ? { ...f, awaitingIds: awaitingIdsFrom(threads, f.awaitingDays ?? 0, now) } : f;
	const tiles = tileDefs(period, start);
	const counted = [...tiles.map((t) => t.extra), ...ATTENTION.map((a) => a.extra)];
	const merged = counted.map((extra) => resolve(mergedFilter(base, extra)));
	const counts = await db.batch<{ n: number }>(
		[scope, ...merged.map((f) => contactsWhere(f))].map((w) => db.prepare(`SELECT COUNT(*) AS n FROM contacts ${w.where}`).bind(...w.params))
	);
	const scopeCount = counts[0].results[0]?.n ?? 0;
	const approximate = scopeCount > OVERVIEW_SCOPE_CAP;

	const countOf = (i: number) => counts[i + 1]?.results[0]?.n ?? 0;
	const subscribed = countOf(0);
	const tileOut: OverviewTile[] = [
		{ key: 'contacts', label: base.archived === 'archived' ? 'Archived contacts' : 'Contacts', value: scopeCount, href: null, sub: filtered ? 'matching the filter' : 'active' },
		...tiles.map((t, i) => ({
			key: t.key,
			label: t.label,
			value: countOf(i),
			sub: t.key === 'subscribed' ? `${scopeCount ? Math.round((subscribed / scopeCount) * 100) : 0}% of contacts` : t.sub,
			href: withSort(contactsHref(merged[i], period), t.sort)
		}))
	];

	const attention = ATTENTION.map((a, i) => ({
		key: a.key,
		label: a.label,
		action: a.action,
		n: countOf(tiles.length + i),
		href: contactsHref(merged[tiles.length + i], period)
	})).filter((a) => a.n > 0);

	const sources = topWithOther(
		(sourceRows.results as { label: string; n: number }[]).map((r) => ({ label: r.label, n: r.n })),
		8
	).map((r) => ({
		label: r.label || '(no source)',
		n: r.n,
		href: 'other' in r || !r.label ? null : contactsHref(mergedFilter(base, { source: r.label }), period)
	}));
	const lists = (listRows.results as { id: number; label: string; n: number }[]).map((r) => ({
		label: r.label,
		n: r.n,
		href: contactsHref(mergedFilter(base, { in: String(r.id) }), period)
	}));

	return {
		period,
		periodStart: start,
		scopeCount,
		approximate,
		filtered,
		tiles: tileOut,
		growth: fillGrowth(buckets, def.unit, addedRows.results as { d: string; n: number }[], unsubRows.results as { d: string; n: number }[]),
		growthUnit: def.unit,
		sources,
		lists,
		engagement: {
			tiers: summary.tiers,
			average_score: summary.average_score,
			opened_last_30d: summary.opened_last_30d,
			clicked_last_30d: summary.clicked_last_30d
		},
		trend,
		attention
	};
}

// ---------------------------------------------------------------------------
// The filter as rules: "Save this view as a segment" (live) and "Create report from this"
// ---------------------------------------------------------------------------

/**
 * The contacts filter as dynamic-segment / report rules (segment-query's vocabulary).
 * `unmapped` lists the filter keys the rule set can't say (search, company text, the overview
 * keys, …) — with any of those the view is saved as a hand-picked snapshot instead.
 */
export function filterToRules(f: ContactsFilter): { rules: SegmentRule[]; unmapped: string[] } {
	const rules: SegmentRule[] = [];
	const unmapped: string[] = [];
	if (f.q) unmapped.push('search');
	if (f.status === 'pending') unmapped.push('status');
	else if (f.status === 'subscribed' || f.status === 'unsubscribed') rules.push({ field: 'subscribed', op: f.status === 'subscribed' ? 'yes' : 'no' });
	if (f.source) rules.push({ field: 'source', op: 'contains', value: f.source });
	if (f.company) unmapped.push('company');
	if (f.companyId) rules.push({ field: 'company_id', op: 'is', value: String(f.companyId) });
	if (f.addedFrom) rules.push({ field: 'created', op: 'after', value: f.addedFrom });
	if (f.addedTo) {
		const next = new Date(Date.parse(`${f.addedTo}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
		rules.push({ field: 'created', op: 'before', value: next });
	}
	if (f.inGroup) rules.push({ field: 'list', op: 'in', value: String(f.inGroup) });
	if (f.notInGroup) rules.push({ field: 'list', op: 'not', value: String(f.notInGroup) });
	if (f.visited) rules.push({ field: 'visited', op: 'contains', value: f.visited, ...(f.visitedDays ? { value2: String(f.visitedDays) } : {}) });
	if (f.site !== 'all') unmapped.push('site');
	if (f.hasCompany) rules.push({ field: 'company_id', op: f.hasCompany === 'yes' ? 'exists' : 'missing' });
	for (const m of f.metrics) rules.push({ field: 'company_metric', op: m.op, value: String(m.value), value2: m.metric });
	if (f.tier) rules.push({ field: 'engagement_tier', op: 'is', value: f.tier });
	if (f.openedDays) rules.push({ field: 'last_open_within_days', op: 'within', value: String(f.openedDays) });
	if (f.neverOpened) rules.push({ field: 'never_opened', op: 'yes' });
	if (f.openedN) unmapped.push('opened_n');
	if (f.pipeline) {
		rules.push(
			f.pipeline === 'any' || f.pipeline === 'none'
				? { field: 'pipeline_stage', op: f.pipeline }
				: { field: 'pipeline_stage', op: 'is', value: String(f.pipeline) }
		);
	}
	if (f.bounced) rules.push({ field: 'bounced', op: f.bounced });
	if (f.spam) rules.push({ field: 'spam_complaint', op: 'yes' });
	if (f.campaign) unmapped.push('campaign');
	if (f.hygiene) unmapped.push('hygiene');
	if (f.archived) unmapped.push('archived');
	if (f.unsubFrom) unmapped.push('unsub_from');
	if (f.cooledDays) unmapped.push('cooled_days');
	if (f.awaiting) unmapped.push('awaiting');
	if (f.noList) unmapped.push('no_list');
	if (f.topicOut) rules.push({ field: 'topic', op: 'out', value: String(f.topicOut) });
	if (f.createdDays) rules.push({ field: 'created', op: 'within', value: String(f.createdDays) });
	// #516: the same clause as the filter.
	if (f.form) {
		rules.push({ field: 'form_submitted', op: 'yes', value: f.form === 'any' ? '' : String(f.form), value2: f.formDays ? String(f.formDays) : '' });
	}
	return { rules, unmapped };
}

// ---------------------------------------------------------------------------
// "Export feed CSV" (/contacts/activity/export) — same scope and feed options as the page
// ---------------------------------------------------------------------------

export const FEED_EXPORT_CAP = 5000;

const FEED_CSV_HEADER = ['at_utc', 'type', 'contact_id', 'email', 'name', 'company', 'tier', 'campaign_id', 'subject', 'automation', 'detail'];

/** The scoped feed as CSV rows (newest first, ≤ `cap`), with the same formula guard as report CSVs. */
export async function feedExportCsv(
	db: D1Database,
	src: URLSearchParams,
	opts: { cap?: number; now?: Date } = {}
): Promise<{ csv: string; rows: number }> {
	const cap = Math.max(1, Math.min(FEED_EXPORT_CAP, opts.cap ?? FEED_EXPORT_CAP));
	const filter = await resolveContactsFilter(db, parseContactsFilter(src));
	const { where, params } = contactsWhere(filter);
	const picked = parseFeedTypes(src.get('feed_types'));
	const items = await recentActivity(db, {
		limit: cap,
		types: picked.length ? picked : CONTACT_ACTIVITY_TYPES,
		scope: { where, binds: params },
		since: src.get('feed_period') === '1' ? periodSince(parsePeriod(src.get('period')), opts.now ?? new Date()) : undefined
	});
	const extras = await activityExtras(db, items);
	const lines = [FEED_CSV_HEADER.join(',')];
	for (const a of items) {
		const x = a.contact_id != null ? extras[a.contact_id] : undefined;
		const detail = a.type === 'visited' && a.site_name ? `${a.detail ?? ''} (${a.site_name})` : a.detail;
		lines.push(
			[a.at, a.type, a.contact_id, a.email, a.name, x?.company, x?.tier, a.campaign_id, a.subject, a.automation_name, detail]
				.map(csvCell)
				.join(',')
		);
	}
	return { csv: lines.join('\r\n') + '\r\n', rows: items.length };
}
