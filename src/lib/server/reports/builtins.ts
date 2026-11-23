// Built-in report library (#357). Read-only reports seeded in code, keyed by `key`
// (/reports/b/[key]). Nothing here is stored in the DB.
//
// Each built-in has a spec builder. The engine runs that spec, and "Duplicate to
// customize" copies it. A few reports need something the spec can't say: a second
// sort key, an open-rate threshold, an automation name, a 90-day campaign window,
// the dashboard heatmap or the tier snapshots. Those also have `run`, which either
// post-processes an engine run or reads the same server helpers the dashboard uses.
// `run` returning null falls back to the engine.
//
// Params (X%, N sends, a path pattern, a custom-field key, …) come from the URL as
// `p_<key>` and are shown as inline inputs on the report page.

import { TIERS, TIER_LABELS, isTier } from '$lib/engagement-view';
import { HEAT_DAYS, HEAT_SAMPLED_NOTE, hourLong } from '$lib/engagement-insights-view';
import { stepNumbers } from '$lib/automation-action-labels';
import { reportPct, type MetricFormat } from '$lib/report-metrics';
import {
	adminOnlyMessage,
	parseReportSpec,
	ReportError,
	validFieldKey,
	type ReportChart,
	type ReportSpec,
	type ReportViewer,
	type TimePreset
} from '$lib/report-spec';
import { specMentionsSensitive, type ReportFolder } from '$lib/report-view';
import { engagementHeatmap, goingCold, tierTrend } from '$lib/server/engagement-insights';
import { readZohoOrg, secretRow, ZOHO_PROVIDER } from '$lib/server/integrations/secrets';
import { CAMPAIGN_FETCH_CAP, runReport, type HeatmapMeta, type ReportColumn, type ReportResult } from '$lib/server/reports/engine';
import { rateTrend } from '$lib/server/reports/rate-trend';
import { getTimezone } from '$lib/server/settings';
import { resendPassBreakdown } from '$lib/server/resend-read';
import { applyCounts, campaignCounts } from '$lib/server/reports/campaign-counts';
import { MANUAL_LABEL, pickScore, scoreDistribution, scoreMovers, scoreRuleActivity } from '$lib/server/scoring/reports';
import {
	companyHistory,
	listHistory,
	pivotHistory,
	type CompanyHistoryMetric,
	type HistoryBucket,
	type Pivot
} from '$lib/server/reports/history';

/** `score` (#468) = a score slug, picked from the active scores; blank = the first active one. */
export type BuiltInParamKind = 'number' | 'text' | 'select' | 'field' | 'date' | 'score';

export type BuiltInParam = {
	key: string;
	label: string;
	kind: BuiltInParamKind;
	default: string;
	min?: number;
	max?: number;
	suffix?: string;
	help?: string;
	options?: { value: string; label: string }[];
	/** Shown (and used) only while another param has this value — #456's custom from / to. */
	when?: { key: string; value: string };
};

export type ParamValues = Record<string, string>;

type RunContext = { db: D1Database; viewer: ReportViewer; params: ParamValues; now: Date };

export type BuiltInDef = {
	key: string;
	name: string;
	description: string;
	folder: ReportFolder;
	chart: ReportChart;
	params?: BuiltInParam[];
	/** The report shows hours, billing or pipeline value through `run`, outside the spec. */
	adminOnly?: boolean;
	/** Hidden until that integration is connected. */
	requires?: 'zoho';
	spec: (params: ParamValues, viewer: ReportViewer) => ReportSpec;
	run?: (ctx: RunContext, spec: ReportSpec) => Promise<ReportResult | null>;
	/** Whether Duplicate copies a spec that is the same report. Default: true without `run`. */
	duplicable?: boolean | ((params: ParamValues) => boolean);
};

/** What the page gets: no functions, params with their current values. */
export type BuiltInInfo = {
	key: string;
	name: string;
	description: string;
	folder: ReportFolder;
	chart: ReportChart;
	params: (BuiltInParam & { value: string })[];
	/** Results come from `run`, so the spec panel doesn't describe them. */
	custom: boolean;
	duplicable: boolean;
	/** The current params as `p_<key>=…` (CSV link, pin). */
	query: string;
	/** Pinned to Reports home (#456), and whether the pin uses these params. */
	pinned: boolean;
	pinnedHere: boolean;
	/** #468: a plain-English line for built-ins the spec readback can't describe. */
	readback: string | null;
};

const FETCH_ALL = 5000;
const NO_FILTERS = { match: 'all', rules: [] } as const;

const RANGE_OPTIONS: { value: TimePreset; label: string }[] = [
	{ value: '7d', label: 'Last 7 days' },
	{ value: '30d', label: 'Last 30 days' },
	{ value: '90d', label: 'Last 90 days' },
	{ value: '12m', label: 'Last 12 months' },
	{ value: 'all', label: 'All time' }
];

/** #456: the longest custom range, in days. A longer one keeps `to` and moves `from` up. */
export const MAX_CUSTOM_RANGE_DAYS = 730;
const CUSTOM_RANGE_DEFAULT_DAYS = 30;

/** The range select (presets + Custom) and its `from` / `to` dates, shown only for Custom. */
function rangeParams(defaultValue: TimePreset, options: TimePreset[] = ['7d', '30d', '90d', '12m', 'all']): BuiltInParam[] {
	const when = { key: 'range', value: 'custom' };
	return [
		{
			key: 'range',
			label: 'Time range',
			kind: 'select',
			default: defaultValue,
			options: [...RANGE_OPTIONS.filter((option) => options.includes(option.value)), { value: 'custom', label: 'Custom range' }]
		},
		{ key: 'from', label: 'From', kind: 'date', default: '', when },
		{ key: 'to', label: 'To', kind: 'date', default: '', when, help: 'UTC dates, at most 2 years apart.' }
	];
}

/** The spec's time range for a `rangeParams` built-in. */
function timeRangeFor(p: ParamValues): ReportSpec['timeRange'] {
	if (p.range === 'custom') return { from: p.from!, to: p.to! };
	return { preset: p.range as TimePreset };
}

const RATE_PARAM: BuiltInParam = {
	key: 'rate',
	label: 'Open rate below',
	kind: 'number',
	default: '20',
	min: 0,
	max: 100,
	suffix: '%'
};

const SENDS_PARAM: BuiltInParam = {
	key: 'sends',
	label: 'At least this many sends',
	kind: 'number',
	default: '3',
	min: 1,
	max: 1000
};

// #358: the history reports (company_metrics_daily, list_size_daily).
const HISTORY_DAYS_PARAM: BuiltInParam = {
	key: 'days',
	label: 'Look back',
	kind: 'select',
	default: '365',
	options: [
		{ value: '90', label: 'Last 90 days' },
		{ value: '365', label: 'Last 12 months' },
		{ value: '1095', label: 'Last 3 years' }
	]
};

function historyBucketParam(withDay: boolean): BuiltInParam {
	const options = [
		{ value: 'week', label: 'Week' },
		{ value: 'month', label: 'Month' }
	];
	return { key: 'by', label: 'Per', kind: 'select', default: 'week', options: withDay ? [{ value: 'day', label: 'Day' }, ...options] : options };
}

const HISTORY_TOP = 10;

// #468: the scoring reports.
const SCORE_PARAM: BuiltInParam = { key: 'score', label: 'Score', kind: 'score', default: '', help: 'An active score (Settings → Scoring).' };
const SCORE_RANGE_PARAM: BuiltInParam = {
	key: 'range',
	label: 'Time range',
	kind: 'select',
	default: '30',
	options: [
		{ value: '7', label: 'Last 7 days' },
		{ value: '30', label: 'Last 30 days' },
		{ value: '90', label: 'Last 90 days' }
	]
};
const TOP_SCORE_CONTACTS = 25;

function noScoreResult(): ReportResult {
	const result = makeResult([col('score', 'Score', 'text', 'No score is active (Settings → Scoring).')], [], { chart: 'table' });
	result.note = 'No active score';
	return result;
}

export const DEFAULT_INTENT_PATHS = '/pricing, /contact, /services';
const MAX_PATHS = 10;

// --- the library ----------------------------------------------------------------------

export const BUILT_IN_REPORTS: readonly BuiltInDef[] = [
	// Email & campaigns
	{
		key: 'campaign-performance',
		name: 'Campaign performance',
		description:
			'Every campaign sent in the range: sent, delivered, open, click, CTOR, unsubscribe and bounce rates, complaints and replies. Counted per contact: a contact who got the original and the resend is one recipient, and an opener on either pass is one opener. Resent campaigns add the resend pass on its own.',
		folder: 'Email',
		chart: 'table',
		params: rangeParams('90d'),
		// #457: the run recounts per contact and adds the resend columns; the spec can't say
		// either, so a copy would be a different report.
		duplicable: false,
		spec: (p) =>
			parseReportSpec({
				entity: 'campaigns',
				filters: NO_FILTERS,
				entityFilters: [
					{ field: 'status', op: 'is', value: 'sent' },
					{ field: 'kind', op: 'is', value: 'campaign' }
				],
				columns: ['subject', 'recipients', 'rejected', 'delivered', 'open_rate', 'click_rate', 'ctor', 'unsub_rate', 'bounce_rate', 'spam', 'replies', 'sent_at'],
				sort: { key: 'sent_at', dir: 'desc' },
				timeRange: timeRangeFor(p),
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer }, spec) => perContactCampaigns(db, await runReport(db, spec, viewer), { chart: 'table' })
	},
	{
		key: 'campaign-comparison',
		name: 'Campaign comparison',
		description:
			"Open and click rate of the last 10 campaigns sent, newest first. Counted per contact, so a resend to non-openers doesn't lower the rate; resent campaigns add the resend pass on its own.",
		folder: 'Email',
		chart: 'bar',
		// #457: per-contact rates and resend columns come from the run, not the spec.
		duplicable: false,
		spec: () =>
			parseReportSpec({
				entity: 'campaigns',
				filters: NO_FILTERS,
				entityFilters: [
					{ field: 'status', op: 'is', value: 'sent' },
					{ field: 'kind', op: 'is', value: 'campaign' }
				],
				columns: ['subject', 'open_rate', 'click_rate', 'recipients', 'sent_at'],
				sort: { key: 'sent_at', dir: 'desc' },
				timeRange: { preset: 'all' },
				limit: 10,
				chart: 'bar'
			}),
		run: async ({ db, viewer }, spec) => {
			const result = await runReport(db, spec, viewer);
			// "Last 10" is the whole report: the count line says 10 campaigns, not "15 rows · showing first 10".
			return perContactCampaigns(db, result, { chart: 'bar', yKeys: ['open_rate', 'click_rate'], total: result.rows.length });
		}
	},
	{
		key: 'rate-trend',
		name: 'Open & click rate trend',
		description: 'Weekly open and click rate over 12 months, weeks starting Monday in Settings → Timezone. Campaigns and automation emails are separate series.',
		folder: 'Email',
		chart: 'line',
		// #456: the rows come from `rateTrend` (campaign + automation series), not the
		// spec, so a copy would be a different (campaigns-only, UTC-week) report.
		duplicable: false,
		spec: () => trendSpec(),
		run: async ({ db, now }) => {
			const tz = await getTimezone(db);
			const rows = await rateTrend(db, now, tz);
			return makeResult(
				[
					col('week', 'Week', 'text', `The Monday (Settings → Timezone, ${tz}) of the week the sends fall in.`),
					col('open_rate', 'Campaign open rate', 'pct', 'Unique openers (human open or click) ÷ sent, for campaigns sent that week.'),
					col('click_rate', 'Campaign click rate', 'pct', 'Unique clickers ÷ sent, for campaigns sent that week.'),
					col('automation_open_rate', 'Automation open rate', 'pct', 'Unique openers (human open or click) ÷ sent, for automation emails whose first delivery or bounce fell in that week.'),
					col('automation_click_rate', 'Automation click rate', 'pct', 'Unique clickers ÷ sent, for automation emails whose first delivery or bounce fell in that week.'),
					col('sent', 'Campaign sent', 'count', 'Recipients Postmark accepted, for campaigns sent that week. 0 = no rate (a gap in the chart).'),
					col('automation_sent', 'Automation sent', 'count', 'Automation recipients whose first delivery or bounce fell in that week. 0 = no rate (a gap in the chart).')
				],
				rows,
				{ chart: 'line', xKey: 'week', yKeys: ['open_rate', 'click_rate', 'automation_open_rate', 'automation_click_rate'] }
			);
		}
	},
	{
		key: 'automation-email-performance',
		name: 'Automation email performance',
		description:
			'Each automation email step in flow order (sorted by automation, then step position; a deleted step last) with sent, delivered, open, click, CTOR, unsubscribe and bounce rates, complaints and replies. The range counts the emails sent in it. A/B tested steps add a row per variant.',
		folder: 'Email',
		chart: 'table',
		// #456: the run adds the Automation column and sorts by automation and step; the
		// spec can't say either, so a copy would be a different report.
		duplicable: false,
		params: rangeParams('all'),
		spec: (p) =>
			parseReportSpec({
				entity: 'campaigns',
				filters: NO_FILTERS,
				entityFilters: [{ field: 'kind', op: 'is', value: 'automation' }],
				columns: ['subject', 'recipients', 'rejected', 'delivered', 'open_rate', 'click_rate', 'ctor', 'unsub_rate', 'bounce_rate', 'spam', 'replies'],
				timeRange: timeRangeFor(p),
				limit: 200,
				chart: 'table'
			}),
		run: async ({ db, viewer, now }, spec) => {
			// Every step campaign: a step first sent long ago can still send in the range, so the
			// range applies to the recipients (campaignCounts), not to the campaign row.
			const result = await runReport(db, { ...spec, timeRange: { preset: 'all' }, limit: FETCH_ALL }, viewer);
			const ids = (result.recordIds ?? []).filter((id): id is number => id != null);
			// A preset counts from its start to now; a custom range (#456) has both ends.
			const range = spec.timeRange;
			const since = !range ? null : 'preset' in range ? rangeSince(range.preset, now) : range.from;
			const until = range && !('preset' in range) ? range.to : null;
			const { counts, variants } = await campaignCounts(db, ids, { since, until, byVariant: true });
			const info = await automationStepInfo(db, ids);
			type Item = {
				row: Record<string, unknown>;
				id: number | null;
				order: [string, number, number, number];
				automationId: number;
				stepId: number;
			};
			const items: Item[] = [];
			result.rows.forEach((source, index) => {
				const id = result.recordIds?.[index] ?? null;
				const step = id != null ? info.get(id) : undefined;
				const c = id != null ? counts.get(String(id)) : undefined;
				if ((since || until) && !c) return; // nothing sent in the range
				// A deleted step keeps its sends (automation_id stays, the step id is nulled).
				const deleted = !step?.step_id;
				const subject = deleted ? `${String(source.subject ?? '')} (deleted step)`.trim() : String(source.subject ?? '');
				const automation = step?.automation ?? '(deleted automation)';
				const base = {
					id,
					order: [automation, step?.automation_id ?? 0, step?.position ?? Number.MAX_SAFE_INTEGER, id ?? 0] as Item['order'],
					automationId: step?.automation_id ?? 0,
					stepId: step?.step_id ?? 0
				};
				const row: Record<string, unknown> = { ...source, subject, automation, variant: null };
				if (c) applyCounts(row, c);
				items.push({ row, ...base });
				for (const v of id != null ? (variants.get(id) ?? []) : []) {
					const vc = counts.get(`${id}:${v}`);
					if (!vc) continue;
					const vrow: Record<string, unknown> = { ...source, subject: `${subject} (variant ${v})`, automation, variant: v };
					applyCounts(vrow, vc);
					items.push({ row: vrow, ...base });
				}
			});
			// Stable sort, so a step's variant rows stay right under it.
			items.sort(
				(a, b) =>
					a.order[0].localeCompare(b.order[0]) || a.order[1] - b.order[1] || a.order[2] - b.order[2] || a.order[3] - b.order[3]
			);
			const page = items.slice(0, spec.limit);
			const [subjectCol, ...rest] = result.columns;
			const hasVariants = items.some((item) => item.row.variant != null);
			return makeResult(
				[
					{ ...subjectCol!, label: 'Step email' },
					col('automation', 'Automation', 'text', 'The automation the step belongs to.'),
					...(hasVariants
						? [col('variant', 'A/B variant', 'text', 'The A/B variant (recipients.ab_variant) of the sends on this row; blank = every send of the step.')]
						: []),
					...rest
				],
				page.map((item) => item.row),
				{
					chart: 'table',
					total: items.length,
					recordIds: page.map((item) => item.id),
					links: {
						subject: page.map((item) => (item.automationId && item.stepId ? `/automations/${item.automationId}#step-node-${item.stepId}` : null)),
						automation: page.map((item) => (item.automationId ? `/automations/${item.automationId}` : null))
					}
				}
			);
		}
	},
	{
		key: 'best-send-times',
		name: 'Best send times',
		description:
			"How many people open or click, by weekday and hour in Settings → Timezone: each person counts once per slot, auto-opens and review / 1:1 sends are left out. The same data as the dashboard heatmap. Best-time sending uses each contact's own best hour; this is the audience-wide picture.",
		folder: 'Email',
		chart: 'heatmap',
		duplicable: false,
		params: [
			{
				key: 'days',
				label: 'Look back',
				kind: 'select',
				default: '90',
				options: [
					{ value: '30', label: 'Last 30 days' },
					{ value: '90', label: 'Last 90 days' },
					{ value: '180', label: 'Last 180 days' }
				]
			}
		],
		spec: () => placeholderSpec('heatmap'),
		run: async ({ db, params, now }) => {
			const tz = await getTimezone(db);
			const heat = await engagementHeatmap(db, tz, now, Number(params.days) || 90);
			// The full 7 × 24 grid, Monday first, so the API has every weekday and hour.
			const rows: Record<string, unknown>[] = [];
			for (const day of HEAT_DAYS) {
				for (let hour = 0; hour < 24; hour++) {
					const n = heat.grid[day.dow]?.[hour] ?? 0;
					rows.push({ weekday: day.label, hour, count: n, pct: reportPct(n, heat.total) });
				}
			}
			const top = rows
				.map((row, index) => ({ row, index }))
				.filter(({ row }) => Number(row.count) > 0)
				.sort((a, b) => Number(b.row.count) - Number(a.row.count) || a.index - b.index)
				.slice(0, 5)
				.map(({ row }) => ({ slot: `${row.weekday} ${hourLong(Number(row.hour))}`, count: row.count, pct: row.pct }));
			const countCol = col(
				'count',
				'People',
				'count',
				'Distinct people with a real open or click in that hour. Proxy (Apple MPP) opens are left out, like the dashboard heatmap.'
			);
			const pctCol = col('pct', 'Share', 'pct', 'That slot ÷ everyone who opened or clicked in the window (a person can be in several slots).');
			const result = makeResult(
				[col('weekday', 'Weekday', 'text', `Weekday in ${tz}.`), col('hour', 'Hour', 'count', `Hour of the day (0–23) in ${tz}.`), countCol, pctCol],
				rows,
				{
					chart: 'heatmap',
					xKey: 'weekday',
					yKey: 'count',
					truncated: false,
					heatmap: { tz, days: heat.days, proxySkipped: heat.proxySkipped, truncated: heat.truncated, total: heat.total }
				}
			);
			result.secondary = { title: 'Top 5 slots', columns: [col('slot', 'Time slot', 'text', `Weekday and hour in ${tz}.`), countCol, pctCol], rows: top };
			if (heat.truncated) result.note = HEAT_SAMPLED_NOTE;
			return result;
		}
	},

	// Contacts & engagement
	{
		key: 'most-active-contacts',
		name: 'Most active contacts',
		description: 'Top 100 contacts by engagement score, with opens, clicks, replies, site visits (90 days) and last activity.',
		folder: 'Contacts',
		chart: 'table',
		spec: () =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['email', 'name', 'engagement_score', 'opens', 'clicks', 'replies', 'site_visits', 'days_since_engagement', 'last_site_visit'],
				sort: { key: 'engagement_score', dir: 'desc' },
				limit: 100,
				chart: 'table'
			})
	},
	{
		key: 'least-active-contacts',
		name: 'Least active contacts',
		description: 'Subscribed contacts sent at least 3 campaigns, lowest open rate first, then the oldest last engagement.',
		folder: 'Contacts',
		chart: 'table',
		duplicable: true,
		spec: () =>
			parseReportSpec({
				entity: 'contacts',
				filters: { match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] },
				columns: ['email', 'name', 'sent', 'open_rate', 'click_rate', 'days_since_engagement', 'last_open'],
				sort: { key: 'open_rate', dir: 'asc' },
				thresholds: { minSent: 3 },
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer }, spec) => {
			const all = await runReport(db, { ...spec, limit: FETCH_ALL }, viewer);
			return refine(all, spec, {
				sort: (a, b) => nullsLast(a.open_rate, b.open_rate, 1) || staleFirst(a.days_since_engagement, b.days_since_engagement)
			});
		}
	},
	{
		key: 'below-open-rate',
		name: 'Below an open-rate threshold',
		description: 'Contacts whose open rate is under X% after at least N sends.',
		folder: 'Contacts',
		chart: 'table',
		duplicable: true,
		params: [RATE_PARAM, SENDS_PARAM],
		spec: (p) =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['email', 'name', 'sent', 'unique_opens', 'open_rate', 'last_open'],
				sort: { key: 'open_rate', dir: 'asc' },
				thresholds: { minSent: Number(p.sends) },
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer, params }, spec) => {
			const all = await runReport(db, { ...spec, limit: FETCH_ALL }, viewer);
			const rate = Number(params.rate);
			return refine(all, spec, { keep: (row) => exactRate(row.unique_opens, row.sent) < rate });
		}
	},
	{
		key: 'clients-not-opening',
		name: 'Clients not opening',
		description: 'Contacts linked to a company or tagged Client whose open rate is under X%, or who haven\'t opened in N days.',
		folder: 'Contacts',
		chart: 'table',
		duplicable: true,
		params: [
			RATE_PARAM,
			{ key: 'days', label: 'Or no open in', kind: 'number', default: '60', min: 1, max: 365, suffix: 'days' }
		],
		spec: () =>
			parseReportSpec({
				entity: 'contacts',
				filters: {
					match: 'any',
					rules: [
						{ field: 'company_id', op: 'exists' },
						{ field: 'tag', op: 'is', value: 'Client' }
					]
				},
				columns: ['email', 'name', 'sent', 'unique_opens', 'open_rate', 'last_open'],
				sort: { key: 'open_rate', dir: 'asc' },
				thresholds: { minSent: 1 },
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer, params, now }, spec) => {
			const all = await runReport(db, { ...spec, limit: FETCH_ALL }, viewer);
			const rate = Number(params.rate);
			const days = Number(params.days);
			const result = refine(all, spec, {
				keep: (row) => {
					if (exactRate(row.unique_opens, row.sent) < rate) return true;
					const age = ageDays(row.last_open, now);
					return age == null || age > days;
				}
			});
			const companies = await companyNames(db, (result.recordIds ?? []).filter((id): id is number => id != null));
			const rows = result.rows.map((row, index) => ({ ...row, company: companies.get(result.recordIds?.[index] ?? 0) ?? null }));
			const [email, name, ...rest] = result.columns;
			return {
				...result,
				columns: [email!, name!, col('company', 'Company', 'text', 'The linked company, else the company text on the contact.'), ...rest],
				rows
			};
		}
	},
	{
		key: 'never-opened',
		name: 'Never opened',
		description: 'Contacts sent at least 3 emails with no real opens (proxy opens don\'t count).',
		folder: 'Contacts',
		chart: 'table',
		duplicable: true,
		spec: () =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['email', 'name', 'sent', 'opens', 'clicks', 'created'],
				sort: { key: 'sent', dir: 'desc' },
				thresholds: { minSent: 3 },
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer }, spec) => {
			const all = await runReport(db, { ...spec, limit: FETCH_ALL }, viewer);
			return refine(all, spec, { keep: (row) => num(row.opens) <= 0 });
		}
	},
	{
		key: 'going-cold',
		name: 'Going cold',
		description: 'Subscribed contacts who moved down into cool or cold in the last 30 days, the same list as the dashboard card.',
		folder: 'Contacts',
		chart: 'table',
		duplicable: false,
		spec: () =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['email', 'name', 'engagement_tier', 'engagement_score'],
				limit: 500,
				chart: 'table'
			}),
		run: async ({ db, now }, spec) => {
			const cold = await goingCold(db, { limit: spec.limit, now });
			return makeResult(
				[
					col('email', 'Email', 'text', 'The contact email address.'),
					col('name', 'Name', 'text', 'The contact name.'),
					col('prev_tier', 'Was', 'text', 'The tier before the last change.'),
					col('tier', 'Now', 'text', 'The current engagement tier.'),
					col('tier_changed_at', 'Changed', 'date', 'When the tier changed (contact_engagement.tier_changed_at).'),
					col('score', 'Engagement score', 'count', 'The 0–100 engagement score.')
				],
				cold.contacts.map((contact) => ({
					email: contact.email,
					name: contact.name,
					prev_tier: tierLabel(contact.prev_tier),
					tier: tierLabel(contact.tier),
					tier_changed_at: contact.tier_changed_at,
					score: contact.score
				})),
				{ chart: 'table', total: cold.total, recordIds: cold.contacts.map((contact) => contact.id) }
			);
		}
	},
	{
		key: 'tier-mix',
		name: 'Engagement tier mix over time',
		description: 'Contacts per engagement tier from the daily snapshots. The trend starts with the first snapshot.',
		folder: 'Contacts',
		chart: 'line',
		duplicable: false,
		params: [
			{
				key: 'days',
				label: 'Look back',
				kind: 'select',
				default: '90',
				options: [
					{ value: '30', label: 'Last 30 days' },
					{ value: '90', label: 'Last 90 days' },
					{ value: '365', label: 'Last 12 months' }
				]
			},
			{
				key: 'tier',
				label: 'Chart',
				kind: 'select',
				default: 'hot',
				options: TIERS.map((tier) => ({ value: tier, label: TIER_LABELS[tier] }))
			}
		],
		spec: () => placeholderSpec('line'),
		run: async ({ db, params, now }) => {
			const trend = await tierTrend(db, now, Number(params.days) || 90);
			const rows: Record<string, unknown>[] = [];
			trend.days.forEach((day, index) => {
				if (trend.series.hot[index] == null) return;
				const row: Record<string, unknown> = { day };
				for (const tier of TIERS) row[tier] = trend.series[tier][index];
				rows.push(row);
			});
			const yKey = isTier(params.tier) ? params.tier : 'hot';
			return makeResult(
				[
					col('day', 'Day', 'text', 'The UTC day of the snapshot.'),
					...TIERS.map((tier) => col(tier, TIER_LABELS[tier], 'count', `Contacts in the ${TIER_LABELS[tier]} tier that day (engagement_tier_daily).`))
				],
				rows,
				{ chart: 'line', xKey: 'day', yKey }
			);
		}
	},
	// Scoring (#468): the named scores of #466.
	{
		key: 'score-distribution',
		name: 'Score distribution',
		description:
			'How many contacts sit in each band of a score (10-point buckets when the score has no bands), with the top 25 contacts by value. Archived contacts are left out; a contact with no points counts as 0.',
		folder: 'Contacts',
		chart: 'bar',
		duplicable: false,
		params: [SCORE_PARAM],
		spec: () => placeholderSpec('bar'),
		run: async ({ db, params }) => {
			const score = await pickScore(db, params.score);
			if (!score) return noScoreResult();
			const dist = await scoreDistribution(db, score, TOP_SCORE_CONTACTS);
			const banded = score.bands.length > 0;
			const result = makeResult(
				[
					col('band', banded ? 'Band' : 'Points', 'text', banded ? `The band of ${score.name} (Settings → Scoring).` : `10-point buckets of ${score.name}.`),
					col('range', 'Range', 'text', 'The values the band covers.'),
					col('contacts', 'Contacts', 'count', 'Active (unarchived) contacts whose current value falls in the band.'),
					col('share', 'Share', 'pct', 'That band ÷ every active contact.')
				],
				dist.rows.map((row) => ({ band: row.label, range: row.range, contacts: row.contacts, share: row.share })),
				{ chart: 'bar', xKey: 'band', yKey: 'contacts' }
			);
			result.rowLabel = { one: banded ? 'band' : 'bucket', many: banded ? 'bands' : 'buckets' };
			result.note = `${score.name} · ${dist.total} contact${dist.total === 1 ? '' : 's'}`;
			if (dist.top.length) {
				result.secondary = {
					title: `Top ${TOP_SCORE_CONTACTS} by ${score.name}`,
					columns: [
						col('email', 'Email', 'text', 'The contact email address.'),
						col('name', 'Name', 'text', 'The contact name.'),
						col('value', 'Value', 'count', `The current ${score.name} value (contact_scores).`),
						col('band', 'Band', 'text', 'The band that value falls in.')
					],
					rows: dist.top.map((c) => ({ email: c.email, name: c.name, value: c.value, band: c.band })),
					links: { email: dist.top.map((c) => `/contacts/${c.contact_id}`) }
				};
			}
			return result;
		}
	},
	{
		key: 'score-movers',
		name: 'Score movers',
		description:
			'Contacts whose score changed the most, up or down, in the range: points earned in it minus points that expired in it, from the score ledger. Shows the current value and the rule that contributed most.',
		folder: 'Contacts',
		chart: 'table',
		duplicable: false,
		params: [SCORE_PARAM, SCORE_RANGE_PARAM],
		spec: () => placeholderSpec('table'),
		run: async ({ db, params, now }, spec) => {
			const score = await pickScore(db, params.score);
			if (!score) return noScoreResult();
			const days = Number(params.range) || 30;
			const movers = await scoreMovers(db, score, days, now, spec.limit);
			const result = makeResult(
				[
					col('email', 'Email', 'text', 'The contact email address.'),
					col('name', 'Name', 'text', 'The contact name.'),
					col('value', 'Now', 'count', `The current ${score.name} value.`),
					col('delta', 'Change', 'count', `Points earned in the range and still held, minus points that expired in the range.${score.decay_mode === 'half_life' ? ' Half-life decay is not included.' : ''} A condition rule's points that went away when the contact stopped matching aren't in the ledger.`),
					col('top_rule', 'Main rule', 'text', `The rule that moved the value most in the same direction ("${MANUAL_LABEL}" = admin adjustments).`),
					col('top_rule_points', 'Rule points', 'count', 'That rule’s share of the change.')
				],
				movers.rows,
				{ chart: 'table', total: movers.total, links: { email: movers.rows.map((m) => `/contacts/${m.contact_id}`) } }
			);
			result.rowLabel = { one: 'contact', many: 'contacts' };
			return result;
		}
	},
	{
		key: 'score-rule-activity',
		name: 'Score rule activity',
		description:
			'One row per rule of a score: points awarded in the range, how many awards and contacts, and the rule’s share of all points awarded — which rules actually do the work.',
		folder: 'Contacts',
		chart: 'bar',
		duplicable: false,
		params: [SCORE_PARAM, SCORE_RANGE_PARAM],
		spec: () => placeholderSpec('bar'),
		run: async ({ db, params, now }) => {
			const score = await pickScore(db, params.score);
			if (!score) return noScoreResult();
			const rows = await scoreRuleActivity(db, score, Number(params.range) || 30, now);
			const result = makeResult(
				[
					col('rule', 'Rule', 'text', `A rule of ${score.name}${rows.some((r) => r.rule_id == null) ? `, plus "${MANUAL_LABEL}"` : ''}.`),
					col('kind', 'Kind', 'text', 'Event (per action), condition (while the contact matches) or manual.'),
					col('rule_points', 'Points per award', 'count', 'The rule’s points setting.'),
					col('awarded', 'Points awarded', 'count', 'Sum of the ledger rows the rule earned in the range (expired ones included).'),
					col('awards', 'Awards', 'count', 'Ledger rows earned in the range.'),
					col('contacts', 'Contacts', 'count', 'Distinct active contacts awarded in the range.'),
					col('share', 'Share', 'pct', 'This rule’s points ÷ all points awarded in the range (by size, so minus points count too).')
				],
				rows.map((r) => ({ ...r, rule: r.active ? r.rule : `${r.rule} (off)` })),
				{ chart: 'bar', xKey: 'rule', yKey: 'awarded' }
			);
			result.rowLabel = { one: 'rule', many: 'rules' };
			return result;
		}
	},
	{
		key: 'new-contacts-by-week',
		name: 'New contacts by week',
		description: 'Contacts created each week (UTC Monday) over the last 12 months.',
		folder: 'Contacts',
		chart: 'line',
		spec: () =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['contacts'],
				groupBy: 'week',
				sort: { key: 'week', dir: 'asc' },
				timeRange: { preset: '12m' },
				limit: 60,
				chart: 'line'
			})
	},
	{
		key: 'new-contacts-by-source',
		name: 'New contacts by source',
		description: 'Contacts created in the range, counted by source.',
		folder: 'Contacts',
		chart: 'bar',
		params: rangeParams('90d'),
		spec: (p) =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['contacts'],
				groupBy: 'source',
				sort: { key: 'contacts', dir: 'desc' },
				timeRange: timeRangeFor(p),
				limit: 100,
				chart: 'bar'
			})
	},
	{
		key: 'custom-field-breakdown',
		name: 'Breakdown by custom field',
		description: 'Pick a custom field: contacts and open rate for each of its values.',
		folder: 'Contacts',
		chart: 'bar',
		duplicable: (p) => p.field !== '',
		params: [{ key: 'field', label: 'Custom field', kind: 'field', default: '', help: 'A key in the contact\'s custom fields.' }],
		spec: (p) =>
			parseReportSpec({
				entity: 'contacts',
				filters: NO_FILTERS,
				columns: ['contacts', 'open_rate'],
				...(p.field ? { groupBy: `field:${p.field}` } : {}),
				sort: { key: 'contacts', dir: 'desc' },
				limit: 100,
				chart: 'bar'
			}),
		run: async ({ params }) => {
			if (params.field) return null;
			return makeResult(
				[
					col('value', 'Value', 'text', 'The custom field value.'),
					col('contacts', 'Contacts', 'count', 'How many contacts have that value.'),
					col('open_rate', 'Open rate', 'pct', 'Unique campaigns opened ÷ campaigns sent, pooled over the contacts with that value.')
				],
				[],
				{ chart: 'bar' }
			);
		}
	},

	// Site activity
	{
		key: 'top-pages',
		name: 'Top pages',
		description: 'Page views and unique known contacts per page.',
		folder: 'Site',
		chart: 'bar',
		params: rangeParams('30d', ['7d', '30d', '90d', '12m']),
		spec: (p) =>
			parseReportSpec({
				entity: 'site_pages',
				filters: NO_FILTERS,
				columns: ['views', 'unique_contacts'],
				groupBy: 'path',
				sort: { key: 'views', dir: 'desc' },
				timeRange: timeRangeFor(p),
				limit: 100,
				chart: 'bar'
			})
	},
	{
		key: 'high-intent-visitors',
		name: 'High-intent visitors',
		description: 'Contacts who viewed a page whose path contains one of the patterns in the last N days.',
		folder: 'Site',
		chart: 'table',
		params: [
			{ key: 'paths', label: 'Path contains (comma-separated)', kind: 'text', default: DEFAULT_INTENT_PATHS },
			{ key: 'days', label: 'In the last', kind: 'number', default: '14', min: 1, max: 180, suffix: 'days' }
		],
		spec: (p) =>
			parseReportSpec({
				entity: 'contacts',
				filters: {
					match: 'any',
					rules: intentPaths(p.paths).map((path) => ({ field: 'visited', op: 'contains', value: path, value2: p.days }))
				},
				columns: ['email', 'name', 'site_visits', 'last_site_visit', 'engagement_score', 'pipeline_stage'],
				sort: { key: 'last_site_visit', dir: 'desc' },
				limit: 100,
				chart: 'table'
			})
	},
	{
		key: 'visiting-not-opening',
		name: 'Visiting but not opening',
		description: 'Contacts with site visits in the last 30 days and no email open in 60 days.',
		folder: 'Site',
		chart: 'table',
		params: [
			{ key: 'visit_days', label: 'Visited in the last', kind: 'number', default: '30', min: 1, max: 180, suffix: 'days' },
			{ key: 'open_days', label: 'No open in', kind: 'number', default: '60', min: 1, max: 365, suffix: 'days' }
		],
		spec: (p) =>
			parseReportSpec({
				entity: 'contacts',
				filters: {
					match: 'all',
					rules: [
						{ field: 'visited', op: 'contains', value: '/', value2: p.visit_days },
						{ field: 'last_open_within_days', op: 'not', value: p.open_days }
					]
				},
				columns: ['email', 'name', 'site_visits', 'last_site_visit', 'last_open', 'engagement_tier'],
				sort: { key: 'last_site_visit', dir: 'desc' },
				limit: 100,
				chart: 'table'
			})
	},
	{
		key: 'traffic-sources',
		name: 'Traffic sources',
		description: 'Known-contact page views by referrer host, UTM source or UTM campaign.',
		folder: 'Site',
		chart: 'bar',
		params: [
			{
				key: 'by',
				label: 'Group by',
				kind: 'select',
				default: 'referrer_host',
				options: [
					{ value: 'referrer_host', label: 'Referrer' },
					{ value: 'utm_source', label: 'UTM source' },
					{ value: 'utm_campaign', label: 'UTM campaign' }
				]
			},
			...rangeParams('30d', ['7d', '30d', '90d', '12m'])
		],
		spec: (p) =>
			parseReportSpec({
				entity: 'site_pages',
				filters: NO_FILTERS,
				columns: ['views', 'unique_contacts'],
				groupBy: p.by,
				sort: { key: 'views', dir: 'desc' },
				timeRange: timeRangeFor(p),
				limit: 100,
				chart: 'bar'
			})
	},

	// Segments & lists
	{
		key: 'segment-health',
		name: 'Segment health',
		description: 'Each list and segment: members, subscribed, average member open and click rate, campaigns sent to it in 90 days and their open rate.',
		folder: 'Segments',
		chart: 'table',
		duplicable: true,
		spec: () =>
			parseReportSpec({
				entity: 'segments',
				filters: NO_FILTERS,
				columns: ['name', 'member_count', 'subscribed_count', 'avg_open_rate', 'avg_click_rate', 'campaigns_sent', 'campaign_open_rate'],
				limit: 200,
				chart: 'table'
			}),
		run: async ({ db, viewer }, spec) => {
			const result = await runReport(db, spec, viewer);
			const sent = await runReport(
				db,
				parseReportSpec({
					entity: 'campaigns',
					filters: NO_FILTERS,
					entityFilters: [{ field: 'status', op: 'is', value: 'sent' }],
					columns: ['recipients', 'opens'],
					timeRange: { preset: '90d' },
					limit: FETCH_ALL
				}),
				viewer
			);
			const byCampaign = new Map<number, { recipients: number; opens: number }>();
			sent.rows.forEach((row, index) => {
				const id = sent.recordIds?.[index];
				if (id != null) byCampaign.set(id, { recipients: num(row.recipients), opens: num(row.opens) });
			});
			const pooled = new Map<number, { campaigns: number; recipients: number; opens: number }>();
			for (const slice of chunks([...byCampaign.keys()], 80)) {
				const rows = await db
					.prepare(
						`SELECT DISTINCT campaign_id, list_id FROM campaign_audiences WHERE mode = 'include' AND campaign_id IN (${marks(slice.length)})`
					)
					.bind(...slice)
					.all<{ campaign_id: number; list_id: number }>();
				for (const row of rows.results ?? []) {
					const stats = byCampaign.get(row.campaign_id);
					if (!stats) continue;
					const bucket = pooled.get(row.list_id) ?? { campaigns: 0, recipients: 0, opens: 0 };
					bucket.campaigns += 1;
					bucket.recipients += stats.recipients;
					bucket.opens += stats.opens;
					pooled.set(row.list_id, bucket);
				}
			}
			const rows = result.rows.map((row, index) => {
				const bucket = pooled.get(result.recordIds?.[index] ?? 0);
				return { ...row, campaigns_sent: bucket?.campaigns ?? 0, campaign_open_rate: bucket ? reportPct(bucket.opens, bucket.recipients) : null };
			});
			const columns = result.columns.map((column) => {
				if (column.key === 'campaigns_sent') {
					return { ...column, label: 'Campaigns (90 days)', definition: 'Sent campaigns in the last 90 days that include this group (campaign_audiences).' };
				}
				if (column.key === 'campaign_open_rate') {
					return { ...column, label: 'Campaign open rate (90 days)', definition: 'Human opens ÷ accepted recipients, pooled across those campaigns.' };
				}
				return column;
			});
			return { ...result, columns, rows };
		}
	},

	{
		key: 'list-growth',
		name: 'List and segment growth',
		description:
			'Members (or subscribed members) of each list, segment and tag over time, from the daily snapshots (the size on the last snapshot of each period). Largest 10 plus the total.',
		folder: 'Segments',
		chart: 'line',
		duplicable: false,
		params: [
			{
				key: 'measure',
				label: 'Count',
				kind: 'select',
				default: 'members',
				options: [
					{ value: 'members', label: 'Members' },
					{ value: 'subscribed', label: 'Subscribed members' }
				]
			},
			historyBucketParam(true),
			HISTORY_DAYS_PARAM,
			{ key: 'list', label: 'List id (0 = largest 10)', kind: 'number', default: '0', min: 0, max: Number.MAX_SAFE_INTEGER }
		],
		spec: () => placeholderSpec('line'),
		run: async ({ db, params, now }) => {
			const bucket: HistoryBucket = params.by === 'day' || params.by === 'month' ? params.by : 'week';
			const measure = params.measure === 'subscribed' ? 'subscribed' : 'members';
			const points = await listHistory(db, measure, { days: Number(params.days) || 365, now, listId: Number(params.list) || null });
			const pivot = pivotHistory(points, bucket);
			const names = await listNamesById(db, pivot.ids.slice(0, HISTORY_TOP));
			return historyResult(pivot, names, {
				bucket,
				format: 'count',
				totalLabel: 'All groups',
				definition: `${measure === 'subscribed' ? 'Subscribed members' : 'Members'} on the last snapshot of the period (list_size_daily). Archived contacts are never members.`
			});
		}
	},

	// Pipeline
	{
		key: 'pipeline-by-stage',
		name: 'Pipeline by stage',
		description: 'Cards per pipeline stage, and their value for admins.',
		folder: 'Pipeline',
		chart: 'bar',
		spec: (_p, viewer) =>
			parseReportSpec({
				entity: 'pipeline',
				filters: NO_FILTERS,
				columns: viewer.role === 'admin' ? ['cards', 'pipeline_value'] : ['cards'],
				groupBy: 'pipeline_stage',
				sort: { key: 'cards', dir: 'desc' },
				limit: 100,
				chart: 'bar'
			})
	},
	{
		key: 'stage-aging',
		name: 'Stage aging',
		description: 'Open pipeline cards, longest in their current stage first.',
		folder: 'Pipeline',
		chart: 'table',
		duplicable: true,
		spec: (_p, viewer) =>
			parseReportSpec({
				entity: 'pipeline',
				filters: NO_FILTERS,
				entityFilters: [{ field: 'kind', op: 'is', value: 'open' }],
				columns: viewer.role === 'admin' ? ['pipeline_stage', 'avg_days_in_stage', 'pipeline_value'] : ['pipeline_stage', 'avg_days_in_stage'],
				sort: { key: 'avg_days_in_stage', dir: 'desc' },
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer }, spec) => {
			const result = await runReport(db, spec, viewer);
			const ids = (result.recordIds ?? []).filter((id): id is number => id != null);
			const people = await contactLabels(db, ids);
			const rows = result.rows.map((row, index) => {
				const who = people.get(result.recordIds?.[index] ?? 0);
				return { contact: who?.name ?? who?.email ?? null, email: who?.email ?? null, ...row };
			});
			const columns = [
				col('contact', 'Contact', 'text', 'The contact on the card.'),
				col('email', 'Email', 'text', 'The contact email address.'),
				...result.columns.map((column) =>
					column.key === 'avg_days_in_stage' ? { ...column, label: 'Days in stage', definition: 'Days since the card entered its current stage.' } : column
				)
			];
			return { ...result, columns, rows };
		}
	},
	{
		key: 'pipeline-movement',
		name: 'Pipeline movement',
		description: 'Stage moves in the range from the pipeline history, per destination stage, including won and lost.',
		folder: 'Pipeline',
		chart: 'bar',
		duplicable: false,
		params: rangeParams('30d', ['7d', '30d', '90d', '12m']),
		spec: (p) =>
			parseReportSpec({
				entity: 'pipeline',
				filters: NO_FILTERS,
				columns: ['moves', 'won', 'lost'],
				groupBy: 'pipeline_stage',
				timeRange: timeRangeFor(p),
				limit: 100,
				chart: 'bar'
			}),
		run: async ({ db, viewer, params, now }) => {
			const bounds = rangeBounds(params, now);
			const admin = viewer.role === 'admin';
			const rows = await db
				.prepare(
					`SELECT ps.name AS stage, ps.kind AS kind, COUNT(*) AS moves, COUNT(DISTINCT h.contact_id) AS contacts,
					        (SELECT SUM(pc.value) FROM pipeline_cards pc
					          WHERE pc.contact_id IN (SELECT h2.contact_id FROM pipeline_history h2
					                                  WHERE h2.to_stage_id = ps.id AND h2.created_at >= ? AND h2.created_at <= ?)) AS value
					 FROM pipeline_history h JOIN pipeline_stages ps ON ps.id = h.to_stage_id
					 WHERE h.created_at >= ? AND h.created_at <= ?
					   AND (h.from_stage_id IS NULL OR h.from_stage_id != h.to_stage_id)
					 GROUP BY ps.id
					 ORDER BY ps.position, ps.id`
				)
				.bind(bounds.from, bounds.to, bounds.from, bounds.to)
				.all<{ stage: string; kind: string; moves: number; contacts: number; value: number | null }>();
			const columns = [
				col('stage', 'Stage', 'text', 'The stage the card moved into.'),
				col('kind', 'Kind', 'text', 'Open, won or lost.'),
				col('moves', 'Moves', 'count', 'Moves into the stage in the range (pipeline_history). A card added to the board counts as a move.'),
				col('contacts', 'Contacts', 'count', 'Distinct contacts moved into the stage.')
			];
			if (admin) columns.push(col('value', 'Value', 'currency', 'Current card value of those contacts, in whole currency units.'));
			return makeResult(
				columns,
				(rows.results ?? []).map((row) => (admin ? { ...row } : { stage: row.stage, kind: row.kind, moves: row.moves, contacts: row.contacts })),
				{ chart: 'bar', xKey: 'stage' }
			);
		}
	},

	// Clients & integrations
	{
		key: 'clients-by-time',
		name: 'Clients by time spent',
		description: 'Companies by Timing hours: 30 days, 90 days and all time. Admins only.',
		folder: 'Clients & integrations',
		chart: 'bar',
		spec: () =>
			parseReportSpec({
				entity: 'companies',
				filters: NO_FILTERS,
				entityFilters: [{ field: 'hours_total', op: 'gt', value: '0' }],
				columns: ['name', 'hours_30d', 'hours_90d', 'hours_total'],
				sort: { key: 'hours_30d', dir: 'desc' },
				limit: 100,
				chart: 'bar'
			})
	},
	{
		key: 'clients-by-github',
		name: 'Clients by GitHub activity',
		description: 'Companies by GitHub issues opened and closed in 30 days, open issues and last activity.',
		folder: 'Clients & integrations',
		chart: 'bar',
		spec: () =>
			parseReportSpec({
				entity: 'companies',
				filters: NO_FILTERS,
				entityFilters: [{ field: 'issues_open', op: 'gte', value: '0' }],
				columns: ['name', 'issues_opened_30d', 'issues_closed_30d', 'issues_open', 'last_issue_at'],
				sort: { key: 'issues_opened_30d', dir: 'desc' },
				limit: 100,
				chart: 'bar'
			})
	},
	{
		key: 'client-hours-trend',
		name: 'Hours per client over time',
		description:
			'Timing hours per company per week or month, from the daily snapshots (the 7-day total on the last snapshot of each week, the 30-day total for a month). Top 10 companies plus the total. Admins only.',
		folder: 'Clients & integrations',
		chart: 'line',
		adminOnly: true,
		duplicable: false,
		params: [
			historyBucketParam(false),
			HISTORY_DAYS_PARAM,
			{ key: 'company', label: 'Company id (0 = top 10)', kind: 'number', default: '0', min: 0, max: Number.MAX_SAFE_INTEGER }
		],
		spec: () => placeholderSpec('line'),
		run: async ({ db, params, now }) => {
			const bucket: HistoryBucket = params.by === 'month' ? 'month' : 'week';
			const metric: CompanyHistoryMetric = bucket === 'month' ? 'hours_30d' : 'hours_7d';
			const points = await companyHistory(db, metric, { days: Number(params.days) || 365, now, companyId: Number(params.company) || null });
			const pivot = pivotHistory(points, bucket);
			const names = await companyNamesById(db, pivot.ids.slice(0, HISTORY_TOP));
			return historyResult(pivot, names, {
				bucket,
				format: 'hours',
				totalLabel: 'All clients',
				definition: bucket === 'month' ? 'Hours tracked in the 30 days up to the last snapshot of the month (Timing).' : 'Hours tracked in the 7 days up to the last snapshot of the week (Timing).'
			});
		}
	},
	{
		key: 'client-github-trend',
		name: 'GitHub activity per client over time',
		description:
			'Issues opened or closed in 30 days, or open issues, per company per week or month, from the daily snapshots (the value on the last snapshot of each period). Top 10 companies plus the total.',
		folder: 'Clients & integrations',
		chart: 'line',
		duplicable: false,
		params: [
			{
				key: 'metric',
				label: 'Measure',
				kind: 'select',
				default: 'issues_opened_30d',
				options: [
					{ value: 'issues_opened_30d', label: 'Issues opened (30 days)' },
					{ value: 'issues_closed_30d', label: 'Issues closed (30 days)' },
					{ value: 'open_issues', label: 'Open issues' }
				]
			},
			historyBucketParam(false),
			HISTORY_DAYS_PARAM,
			{ key: 'company', label: 'Company id (0 = top 10)', kind: 'number', default: '0', min: 0, max: Number.MAX_SAFE_INTEGER }
		],
		spec: () => placeholderSpec('line'),
		run: async ({ db, params, now }) => {
			const bucket: HistoryBucket = params.by === 'month' ? 'month' : 'week';
			const metric: CompanyHistoryMetric =
				params.metric === 'issues_closed_30d' || params.metric === 'open_issues' ? params.metric : 'issues_opened_30d';
			const points = await companyHistory(db, metric, { days: Number(params.days) || 365, now, companyId: Number(params.company) || null });
			const pivot = pivotHistory(points, bucket);
			const names = await companyNamesById(db, pivot.ids.slice(0, HISTORY_TOP));
			const what = metric === 'open_issues' ? 'Open issues' : metric === 'issues_closed_30d' ? 'Issues closed in the last 30 days' : 'Issues opened in the last 30 days';
			return historyResult(pivot, names, {
				bucket,
				format: 'count',
				totalLabel: 'All clients',
				definition: `${what} on the last snapshot of the period (GitHub, company_metrics_daily).`
			});
		}
	},
	{
		key: 'effort-vs-engagement',
		name: 'Effort vs engagement',
		description: 'Companies with Timing hours in 90 days next to their contacts\' open rate and last reply. Admins only.',
		folder: 'Clients & integrations',
		chart: 'table',
		duplicable: true,
		spec: () =>
			parseReportSpec({
				entity: 'companies',
				filters: NO_FILTERS,
				entityFilters: [{ field: 'hours_90d', op: 'gt', value: '0' }],
				columns: ['name', 'hours_90d', 'contact_count', 'avg_open_rate'],
				sort: { key: 'hours_90d', dir: 'desc' },
				limit: 100,
				chart: 'table'
			}),
		run: async ({ db, viewer }, spec) => {
			const result = await runReport(db, spec, viewer);
			const ids = (result.recordIds ?? []).filter((id): id is number => id != null);
			const replies = new Map<number, string | null>();
			for (const slice of chunks(ids, 80)) {
				const rows = await db
					.prepare(
						`SELECT c.company_id AS company_id, MAX(ce.last_reply_at) AS last_reply
						 FROM contacts c JOIN contact_engagement ce ON ce.contact_id = c.id
						 WHERE c.archived_at IS NULL AND c.company_id IN (${marks(slice.length)})
						 GROUP BY c.company_id`
					)
					.bind(...slice)
					.all<{ company_id: number; last_reply: string | null }>();
				for (const row of rows.results ?? []) replies.set(row.company_id, row.last_reply);
			}
			return {
				...result,
				columns: [...result.columns, col('last_reply', 'Last reply', 'date', 'The newest reply from any of the company\'s contacts.')],
				rows: result.rows.map((row, index) => ({ ...row, last_reply: replies.get(result.recordIds?.[index] ?? 0) ?? null }))
			};
		}
	},
	{
		key: 'revenue-per-hour',
		name: 'Revenue per hour',
		description: 'Invoiced in Zoho Books ÷ Timing hours, per company, over the last 90 days (Timing keeps no 12-month total). Admins only.',
		folder: 'Clients & integrations',
		chart: 'bar',
		adminOnly: true,
		requires: 'zoho',
		duplicable: false,
		spec: () =>
			parseReportSpec({
				entity: 'companies',
				filters: NO_FILTERS,
				columns: ['name', 'hours_90d'],
				limit: 100,
				chart: 'bar'
			}),
		run: async ({ db }, spec) => {
			const org = await readZohoOrg(db);
			const currency = org?.currency_code ?? null;
			const rows = await db
				.prepare(
					`SELECT co.id AS id, co.name AS name, cm.hours_90d AS hours_90d, cm.invoiced_12m AS invoiced_12m,
					        (SELECT SUM(zi.total) FROM zoho_invoices zi
					          JOIN company_zoho_contacts z ON z.zoho_contact_id = zi.zoho_contact_id
					          WHERE z.company_id = co.id
					            AND LOWER(COALESCE(zi.status, '')) NOT IN ('draft', 'void')
					            AND zi.date >= date('now', '-90 days')
					            AND (? IS NULL OR zi.currency_code IS NULL OR zi.currency_code = ?)) AS invoiced_90d
					 FROM companies co LEFT JOIN company_metrics cm ON cm.company_id = co.id
					 WHERE EXISTS (SELECT 1 FROM company_zoho_contacts z WHERE z.company_id = co.id)`
				)
				.bind(currency, currency)
				.all<{ id: number; name: string; hours_90d: number | null; invoiced_12m: number | null; invoiced_90d: number | null }>();
			const computed = (rows.results ?? []).map((row) => {
				const hours = num(row.hours_90d);
				const invoiced = row.invoiced_90d == null ? null : Number(row.invoiced_90d);
				return {
					id: row.id,
					row: {
						name: row.name,
						invoiced_90d: invoiced == null ? null : Math.round(invoiced),
						hours_90d: row.hours_90d,
						revenue_per_hour: invoiced != null && hours > 0 ? Math.round(invoiced / hours) : null,
						invoiced_12m: row.invoiced_12m == null ? null : Math.round(Number(row.invoiced_12m))
					}
				};
			});
			computed.sort((a, b) => nullsLast(a.row.revenue_per_hour, b.row.revenue_per_hour, -1));
			const page = computed.slice(0, spec.limit);
			const suffix = currency ? ` (${currency})` : '';
			return makeResult(
				[
					col('name', 'Company', 'text', 'Companies linked to a Zoho Books customer.'),
					col('revenue_per_hour', `Revenue per hour${suffix}`, 'currency', 'Invoiced in the last 90 days ÷ Timing hours in the last 90 days. Blank without hours.'),
					col('invoiced_90d', `Invoiced (90 days)${suffix}`, 'currency', 'Zoho invoices dated in the last 90 days, draft and void left out, base currency only.'),
					col('hours_90d', 'Hours (90 days)', 'hours', 'Hours tracked in the last 90 days (Timing).'),
					col('invoiced_12m', `Invoiced (12 months)${suffix}`, 'currency', 'Invoiced in the last 12 months (company_metrics.invoiced_12m).')
				],
				page.map((item) => item.row),
				{ chart: 'bar', xKey: 'name', total: computed.length, recordIds: page.map((item) => item.id) }
			);
		}
	}
];

// --- lookup, params, visibility ---------------------------------------------------------

const BY_KEY = new Map(BUILT_IN_REPORTS.map((report) => [report.key, report]));

export function builtInByKey(key: string): BuiltInDef | null {
	return BY_KEY.get(key) ?? null;
}

/** Each param from `source` (`p_<key>`), checked and clamped; anything unusable is the default. */
export function resolveParams(def: BuiltInDef, source?: { get(name: string): unknown } | null, now: Date = new Date()): ParamValues {
	const out: ParamValues = {};
	for (const param of def.params ?? []) {
		const raw = source?.get(`p_${param.key}`);
		out[param.key] = cleanParam(param, typeof raw === 'string' ? raw : null);
	}
	const kinds = new Map((def.params ?? []).map((param) => [param.key, param.kind]));
	if (kinds.get('from') === 'date' && kinds.get('to') === 'date') Object.assign(out, customRange(out.from ?? '', out.to ?? '', now));
	return out;
}

/**
 * #456: a usable custom range. A missing `to` is today (UTC), a missing `from` 30 days
 * before it; reversed dates are swapped; a span over {@link MAX_CUSTOM_RANGE_DAYS} keeps
 * `to` and moves `from` up.
 */
export function customRange(fromRaw: string, toRaw: string, now: Date = new Date()): { from: string; to: string } {
	let to = dayMs(toRaw) ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	let from = dayMs(fromRaw) ?? to - CUSTOM_RANGE_DEFAULT_DAYS * 86_400_000;
	if (from > to) [from, to] = [to, from];
	if (to - from > MAX_CUSTOM_RANGE_DAYS * 86_400_000) from = to - MAX_CUSTOM_RANGE_DAYS * 86_400_000;
	return { from: dayKey(from), to: dayKey(to) };
}

function dayMs(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return null;
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
	const d = new Date(ms);
	return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? ms : null;
}

function dayKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** The params as a query string (`p_<key>=…`); params hidden by `when` are left out. */
export function paramQuery(def: BuiltInDef, params: ParamValues): string {
	const query = new URLSearchParams();
	for (const param of def.params ?? []) {
		if (param.when && params[param.when.key] !== param.when.value) continue;
		query.set(`p_${param.key}`, params[param.key] ?? param.default);
	}
	return query.toString();
}

function cleanParam(param: BuiltInParam, raw: string | null): string {
	const value = raw?.trim() ?? '';
	if (raw == null) return param.default;
	switch (param.kind) {
		case 'number': {
			const n = Number(value);
			if (!value || !Number.isFinite(n)) return param.default;
			const clamped = Math.min(param.max ?? Number.MAX_SAFE_INTEGER, Math.max(param.min ?? 0, Math.floor(n)));
			return String(clamped);
		}
		case 'select':
			return param.options?.some((option) => option.value === value) ? value : param.default;
		case 'field':
			return value && validFieldKey(value) ? value : '';
		case 'text':
			return value ? value.slice(0, 300) : param.default;
		case 'date':
			return dayMs(value) != null ? value : param.default;
		case 'score':
			return /^[a-z0-9-]{1,80}$/.test(value) ? value : param.default;
		default: {
			const never: never = param.kind;
			return never;
		}
	}
}

export function intentPaths(raw: string): string[] {
	const paths = raw
		.split(/[,\n]/)
		.map((path) => path.trim())
		.filter(Boolean)
		.slice(0, MAX_PATHS);
	return paths.length ? paths : intentPaths(DEFAULT_INTENT_PATHS);
}

export function builtInSpec(def: BuiltInDef, params: ParamValues, viewer: ReportViewer): ReportSpec {
	return def.spec(params, viewer);
}

export function isDuplicable(def: BuiltInDef, params: ParamValues): boolean {
	if (typeof def.duplicable === 'function') return def.duplicable(params);
	return def.duplicable ?? !def.run;
}

export function builtInInfo(def: BuiltInDef, params: ParamValues): BuiltInInfo {
	return {
		key: def.key,
		name: def.name,
		description: def.description,
		folder: def.folder,
		chart: def.chart,
		params: (def.params ?? []).map((param) => ({ ...param, value: params[param.key] ?? param.default })),
		custom: !!def.run && !isDuplicable(def, params),
		duplicable: isDuplicable(def, params),
		query: paramQuery(def, params),
		pinned: false,
		pinnedHere: false,
		readback: null
	};
}

async function zohoConnected(db: D1Database): Promise<boolean> {
	const [secret, org] = await Promise.all([secretRow(db, ZOHO_PROVIDER), readZohoOrg(db)]);
	return secret != null && org != null;
}

/** Whether this viewer may see the report at all (library row and route). */
export async function builtInVisible(db: D1Database, def: BuiltInDef, viewer: ReportViewer): Promise<boolean> {
	if (def.adminOnly && viewer.role !== 'admin') return false;
	if (viewer.role !== 'admin' && specMentionsSensitive(def.spec(resolveParams(def), viewer))) return false;
	if (def.requires === 'zoho' && !(await zohoConnected(db))) return false;
	return true;
}

export async function builtInsFor(db: D1Database, viewer: ReportViewer): Promise<BuiltInDef[]> {
	const out: BuiltInDef[] = [];
	for (const def of BUILT_IN_REPORTS) if (await builtInVisible(db, def, viewer)) out.push(def);
	return out;
}

/** Run a built-in. Members get the engine's "Admins only" refusal for an admin report. */
export async function runBuiltIn(
	db: D1Database,
	def: BuiltInDef,
	params: ParamValues,
	viewer: ReportViewer,
	now: Date = new Date(),
	opts: { limit?: number | null } = {}
): Promise<ReportResult> {
	if (def.adminOnly && viewer.role !== 'admin') throw new ReportError(adminOnlyMessage([def.name]));
	let spec = def.spec(params, viewer);
	// #456: API and CSV runs may raise (or lower) the built-in's row limit, up to the engine cap.
	if (opts.limit != null && Number.isFinite(opts.limit) && opts.limit >= 1) {
		spec = { ...spec, limit: Math.min(Math.floor(opts.limit), CAMPAIGN_FETCH_CAP) };
	}
	const custom = def.run ? await def.run({ db, viewer, params, now }, spec) : null;
	return custom ?? (await runReport(db, spec, viewer));
}

// --- result helpers ---------------------------------------------------------------------

function col(key: string, label: string, format: MetricFormat, definition: string): ReportColumn {
	return { key, label, format, definition };
}

function makeResult(
	columns: ReportColumn[],
	rows: Record<string, unknown>[],
	opts: {
		chart: ReportChart;
		xKey?: string;
		yKey?: string;
		/** #454: chart these columns as series (2–4). */
		yKeys?: string[];
		total?: number;
		truncated?: boolean;
		recordIds?: (number | null)[];
		heatmap?: HeatmapMeta;
		links?: Record<string, (string | null)[]>;
	}
): ReportResult {
	const cleaned = rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const column of columns) out[column.key] = row[column.key] ?? null;
		return out;
	});
	const total = opts.total ?? cleaned.length;
	const result: ReportResult = { columns, rows: cleaned, total, truncated: opts.truncated ?? total > cleaned.length };
	const series = chartFor(opts.chart, columns, cleaned, opts.xKey, opts.yKey, opts.yKeys);
	if (series) result.chartSeries = series;
	if (opts.heatmap) result.heatmap = opts.heatmap;
	if (opts.recordIds?.some((id) => id != null)) result.recordIds = opts.recordIds;
	if (opts.links) result.links = opts.links;
	return result;
}

const CAMPAIGN_ROW_LABEL = { one: 'campaign', many: 'campaigns' };

/**
 * #457: an engine campaign run recounted per contact (one recipient and one opener per
 * contact over the original and the resend), plus the Resend pair when a campaign in it
 * was resent — from the per-pass breakdown the campaign page shows.
 */
async function perContactCampaigns(
	db: D1Database,
	result: ReportResult,
	opts: { chart: ReportChart; yKeys?: string[]; total?: number }
): Promise<ReportResult> {
	const ids = (result.recordIds ?? []).filter((id): id is number => id != null);
	const { counts, resent } = await campaignCounts(db, ids, { perContact: true });
	const passes = new Map(await Promise.all([...resent].map(async (id) => [id, await resendPassBreakdown(db, id)] as const)));
	const rows = result.rows.map((source, index) => {
		const id = result.recordIds?.[index] ?? null;
		const row: Record<string, unknown> = { ...source };
		const c = id != null ? counts.get(String(id)) : undefined;
		if (c) applyCounts(row, c);
		const pass = id != null ? passes.get(id) : undefined;
		row.resend_sent = pass ? pass.resend.sent : null;
		row.resend_open_rate = pass ? reportPct(pass.resend.opens, pass.resend.sent) : null;
		return row;
	});
	const columns = passes.size
		? [
				...result.columns,
				col('resend_sent', 'Resend sent', 'count', 'Accepted recipients of the resend to non-openers. Sent counts each contact once over both passes.'),
				col('resend_open_rate', 'Resend open rate', 'pct', 'Resend openers ÷ resend sent, from the per-pass breakdown on the campaign page.')
			]
		: result.columns;
	const total = opts.total ?? result.total;
	const out = makeResult(columns, rows, {
		chart: opts.chart,
		yKey: opts.chart === 'table' ? undefined : 'open_rate',
		yKeys: opts.yKeys,
		total,
		truncated: total > rows.length,
		recordIds: result.recordIds
	});
	out.rowLabel = CAMPAIGN_ROW_LABEL;
	return out;
}

/** A range param as a SQLite datetime cut-off (null = all time). */
function rangeSince(range: string, now: Date): string | null {
	if (range === 'all') return null;
	const d = new Date(now.getTime());
	if (range === '12m') d.setUTCMonth(d.getUTCMonth() - 12);
	else d.setTime(d.getTime() - (range === '7d' ? 7 : range === '30d' ? 30 : 90) * 86_400_000);
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

type StepInfo = { automation_id: number; automation: string; step_id: number; position: number | null };

/** #457: each step campaign's automation and the step's place in the flow (canvas order). */
async function automationStepInfo(db: D1Database, campaignIds: number[]): Promise<Map<number, StepInfo>> {
	const out = new Map<number, StepInfo>();
	const automations = new Set<number>();
	for (const slice of chunks(campaignIds, 80)) {
		const rows = await db
			.prepare(
				`SELECT cp.id AS id, a.id AS automation_id, a.name AS automation, COALESCE(cp.automation_step_id, 0) AS step_id
				 FROM campaigns cp LEFT JOIN automations a ON a.id = cp.automation_id
				 WHERE cp.id IN (${marks(slice.length)})`
			)
			.bind(...slice)
			.all<{ id: number; automation_id: number | null; automation: string | null; step_id: number }>();
		for (const row of rows.results ?? []) {
			out.set(row.id, {
				automation_id: row.automation_id ?? 0,
				automation: row.automation ?? '(deleted automation)',
				step_id: row.step_id,
				position: null
			});
			if (row.automation_id) automations.add(row.automation_id);
		}
	}
	type StepRow = { id: number; automation_id: number; parent_step_id: number | null; branch_label: string | null; position: number; type: string };
	const numbers = new Map<number, number>();
	for (const slice of chunks([...automations], 80)) {
		const steps = await db
			.prepare(
				`SELECT id, automation_id, parent_step_id, branch_label, position, type
				 FROM automation_steps WHERE automation_id IN (${marks(slice.length)})`
			)
			.bind(...slice)
			.all<StepRow>();
		const byAutomation = new Map<number, StepRow[]>();
		for (const step of steps.results ?? []) {
			const list = byAutomation.get(step.automation_id) ?? [];
			list.push(step);
			byAutomation.set(step.automation_id, list);
		}
		for (const list of byAutomation.values()) for (const [id, n] of stepNumbers(list)) numbers.set(id, n);
	}
	for (const info of out.values()) info.position = info.step_id ? (numbers.get(info.step_id) ?? null) : null;
	return out;
}

function chartFor(
	chart: ReportChart,
	columns: ReportColumn[],
	rows: Record<string, unknown>[],
	xKey?: string,
	yKey?: string,
	yKeys?: string[]
): ReportResult['chartSeries'] {
	if (chart === 'table') return undefined;
	const y = (yKey ? columns.find((column) => column.key === yKey) : null) ?? columns.find((column) => column.format !== 'text' && column.format !== 'date');
	if (!y) return undefined;
	const x = xKey ?? columns.find((column) => column.format === 'text')?.key ?? y.key;
	const source = chart === 'stat' ? rows.slice(0, 1) : rows;
	// A heatmap keeps a bar series as its fallback. An explicit yKey is one series; with
	// neither, the client charts the numeric columns of y's format (chartSeriesKeys).
	const keys = yKeys ?? (yKey ? [y.key] : undefined);
	return {
		xKey: x,
		yKey: y.key,
		...(keys ? { yKeys: keys } : {}),
		points: source.map((row) => ({ x: String(row[x] ?? ''), y: row[y.key] == null ? null : Number(row[y.key]) }))
	};
}

/** Filter and/or re-sort an engine result fetched with a large limit, then cut to the spec's limit. */
function refine(
	all: ReportResult,
	spec: ReportSpec,
	opts: { keep?: (row: Record<string, unknown>) => boolean; sort?: (a: Record<string, unknown>, b: Record<string, unknown>) => number }
): ReportResult {
	let items = all.rows.map((row, index) => ({ row, id: all.recordIds?.[index] ?? null }));
	if (opts.keep) items = items.filter((item) => opts.keep!(item.row));
	if (opts.sort) items = [...items].sort((a, b) => opts.sort!(a.row, b.row));
	const page = items.slice(0, spec.limit);
	const result = makeResult(
		all.columns,
		page.map((item) => item.row),
		{ chart: spec.chart ?? 'table', xKey: spec.groupBy, total: items.length, recordIds: page.map((item) => item.id) }
	);
	result.truncated = items.length > page.length || all.truncated;
	return result;
}

/** The engine spec behind rate-trend: campaigns only, UTC weeks (the built-in itself runs `rateTrend`, #455). */
function trendSpec(): ReportSpec {
	return parseReportSpec({
		entity: 'campaigns',
		filters: NO_FILTERS,
		entityFilters: [{ field: 'status', op: 'is', value: 'sent' }, { field: 'kind', op: 'is', value: 'campaign' }],
		columns: ['open_rate', 'click_rate'],
		groupBy: 'week',
		// No sort: weekly campaign buckets come back oldest first, and a sort on the
		// group key would ORDER BY a column the campaign query doesn't select.
		timeRange: { preset: '12m' },
		limit: 60,
		chart: 'line'
	});
}

/** A stand-in spec for reports that aren't an engine query (chart kind for the results view). */
function placeholderSpec(chart: ReportChart): ReportSpec {
	return parseReportSpec({ entity: 'campaigns', filters: NO_FILTERS, columns: ['subject'], limit: 100, chart });
}

/** SQLite UTC bounds of a `rangeParams` range: a preset ends now, a custom range covers whole UTC days. */
function rangeBounds(params: ParamValues, now: Date): { from: string; to: string } {
	if (params.range === 'custom' && params.from && params.to) {
		return { from: `${params.from} 00:00:00`, to: `${params.to} 23:59:59` };
	}
	const start = new Date(now.getTime());
	switch (params.range) {
		case '7d':
			start.setUTCDate(start.getUTCDate() - 7);
			break;
		case '90d':
			start.setUTCDate(start.getUTCDate() - 90);
			break;
		case '12m':
			start.setUTCMonth(start.getUTCMonth() - 12);
			break;
		default:
			start.setUTCDate(start.getUTCDate() - 30);
	}
	return { from: sqliteTime(start), to: sqliteTime(now) };
}

function sqliteTime(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

function tierLabel(tier: string | null): string {
	return isTier(tier) ? TIER_LABELS[tier] : (tier ?? '');
}

async function companyNames(db: D1Database, ids: number[]): Promise<Map<number, string | null>> {
	const out = new Map<number, string | null>();
	for (const slice of chunks(ids, 80)) {
		const rows = await db
			.prepare(
				`SELECT c.id AS id, COALESCE(co.name, NULLIF(TRIM(c.company), '')) AS company
				 FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
				 WHERE c.id IN (${marks(slice.length)})`
			)
			.bind(...slice)
			.all<{ id: number; company: string | null }>();
		for (const row of rows.results ?? []) out.set(row.id, row.company);
	}
	return out;
}

async function companyNamesById(db: D1Database, ids: number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	for (const slice of chunks(ids, 80)) {
		const rows = await db
			.prepare(`SELECT id, name FROM companies WHERE id IN (${marks(slice.length)})`)
			.bind(...slice)
			.all<{ id: number; name: string }>();
		for (const row of rows.results ?? []) out.set(row.id, row.name);
	}
	return out;
}

async function listNamesById(db: D1Database, ids: number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	for (const slice of chunks(ids, 80)) {
		const rows = await db
			.prepare(`SELECT id, name, kind FROM lists WHERE id IN (${marks(slice.length)})`)
			.bind(...slice)
			.all<{ id: number; name: string; kind: string }>();
		for (const row of rows.results ?? []) out.set(row.id, row.kind === 'list' ? row.name : `${row.name} (${row.kind})`);
	}
	return out;
}

/**
 * #358: one row per period (oldest first), a total over every series and one column per
 * series for the largest {@link HISTORY_TOP}. The line charts the total.
 */
function historyResult(
	pivot: Pivot,
	names: Map<number, string>,
	opts: { bucket: HistoryBucket; format: MetricFormat; totalLabel: string; definition: string }
): ReportResult {
	const top = pivot.ids.slice(0, HISTORY_TOP);
	const periodLabel = opts.bucket === 'day' ? 'Day' : opts.bucket === 'week' ? 'Week (UTC Monday)' : 'Month';
	const columns: ReportColumn[] = [
		col('period', periodLabel, 'text', 'The UTC period the snapshots fall in.'),
		col('total', opts.totalLabel, opts.format, `Sum over every series. ${opts.definition}`),
		...top.map((id) => col(`id_${id}`, names.get(id) ?? `#${id}`, opts.format, opts.definition))
	];
	const rows = pivot.periods.map((period) => {
		const values = pivot.values.get(period)!;
		let total = 0;
		for (const value of values.values()) total += value ?? 0;
		const row: Record<string, unknown> = { period, total: Math.round(total * 100) / 100 };
		for (const id of top) row[`id_${id}`] = values.has(id) ? values.get(id) : null;
		return row;
	});
	return makeResult(columns, rows, { chart: 'line', xKey: 'period', yKey: 'total' });
}

async function contactLabels(db: D1Database, ids: number[]): Promise<Map<number, { email: string; name: string | null }>> {
	const out = new Map<number, { email: string; name: string | null }>();
	for (const slice of chunks(ids, 80)) {
		const rows = await db
			.prepare(
				`SELECT id, email,
				        COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')) AS name
				 FROM contacts WHERE id IN (${marks(slice.length)})`
			)
			.bind(...slice)
			.all<{ id: number; email: string; name: string | null }>();
		for (const row of rows.results ?? []) out.set(row.id, { email: row.email, name: row.name });
	}
	return out;
}

/** Exact unique-opens ÷ sent as a percentage (not the rounded display rate). */
function exactRate(opens: unknown, sent: unknown): number {
	const d = num(sent);
	if (d <= 0) return 0;
	return (num(opens) / d) * 100;
}

function ageDays(value: unknown, now: Date): number | null {
	if (value == null || value === '') return null;
	const s = String(value).trim();
	const iso = s.includes('T') ? s : s.replace(' ', 'T');
	const ms = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
	if (Number.isNaN(ms)) return null;
	return (now.getTime() - ms) / 86_400_000;
}

/** Ascending (dir 1) or descending (dir -1), nulls after every number either way. */
function nullsLast(a: unknown, b: unknown, dir: 1 | -1): number {
	const an = a == null ? null : Number(a);
	const bn = b == null ? null : Number(b);
	if (an == null && bn == null) return 0;
	if (an == null) return 1;
	if (bn == null) return -1;
	return (an - bn) * dir;
}

/** Oldest engagement first: never engaged (null days) before any number, then the most days. */
function staleFirst(a: unknown, b: unknown): number {
	if (a == null && b == null) return 0;
	if (a == null) return -1;
	if (b == null) return 1;
	return Number(b) - Number(a);
}

function num(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function marks(n: number): string {
	return Array.from({ length: n }, () => '?').join(', ');
}

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
