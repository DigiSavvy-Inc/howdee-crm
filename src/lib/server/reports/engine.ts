// Reports (#354): turn a validated spec into parameterized SQL and run it.
// Contact filters go through `compileSegment`. Tier, pipeline, bounce/spam and
// company-metric clauses are the same helpers the contacts page uses. Rates go
// through `reportPct` (one decimal, two below 1 % for unsubscribe / bounce /
// complaint; accepted recipients for campaigns; the engagement rollup's
// unique-campaigns ÷ sent for contacts). Proxy opens use `classifyProxyOpen`; a
// campaign opener is a human open or a click (#453).

import { normalizeCondition } from '$lib/company-metrics';
import { isTier } from '$lib/engagement-view';
import {
	findMetric,
	FINE_RATE_KEYS,
	reportPct,
	type MetricContext,
	type MetricDef,
	type MetricFormat
} from '$lib/report-metrics';
import {
	adminOnlyKeys,
	adminOnlyMessage,
	fieldColumnKey,
	groupLabel,
	parseReportSpec,
	presetModifier,
	ReportError,
	utcMonth,
	utcWeekStart,
	type EntityFilter,
	type ReportSpec,
	type ReportViewer,
	type TimeRange
} from '$lib/report-spec';
import { bouncedClause, spamClause } from '$lib/server/bounce-filter';
import { metricClause } from '$lib/server/company-metrics';
import { classifyProxyOpen } from '$lib/server/engagement';
import { tierClause } from '$lib/server/engagement-query';
import { pipelineClause, type PipelineFilter } from '$lib/server/pipeline-query';
import { compileSegment, parseRules, type SegmentRules } from '$lib/server/segment-query';
import { visibleCampaignSql } from '$lib/server/system-mail';
import { activeContactSql, segmentAudienceSql } from '$lib/server/active-audience';

export type ReportColumn = {
	key: string;
	label: string;
	format: MetricFormat;
	definition: string;
};

export type ChartSeries = {
	xKey: string;
	yKey: string;
	/** #454: the columns to chart as series (2–4). Unset = `yKey` plus the numeric columns sharing its format. */
	yKeys?: string[];
	points: { x: string; y: number | null }[];
};

/** #454: what the weekday × hour heatmap shows beside the grid (rows `{ weekday, hour, count, pct }`). */
export type HeatmapMeta = {
	tz: string;
	days: number;
	proxySkipped: number;
	truncated: boolean;
	/** #457: distinct people over the whole grid (a person in two slots counts once). */
	total?: number;
};

export type ReportResult = {
	columns: ReportColumn[];
	rows: Record<string, unknown>[];
	total: number;
	truncated: boolean;
	chartSeries?: ChartSeries;
	heatmap?: HeatmapMeta;
	/**
	 * One record id per row, parallel to `rows`, so the builder can link a contact,
	 * company, campaign, segment or pipeline card to its page. Omitted when the
	 * report is grouped (no single record) or the entity has no record id.
	 * Not a column — `rows` stays the metric cells only.
	 */
	recordIds?: (number | null)[];
	/** #457: per-column links, parallel to `rows` (wins over the record link for that column). */
	links?: Record<string, (string | null)[]>;
	/** #457: what one row is in the count line ("10 campaigns"); default row / rows. */
	rowLabel?: { one: string; many: string };
	/** #457: shown in the count line instead of "showing first N" (e.g. a sampling note). */
	note?: string;
	/** #457: a second small table under the main one (e.g. Best send times' top slots). #468: optional per-column links. */
	secondary?: { title: string; columns: ReportColumn[]; rows: Record<string, unknown>[]; links?: Record<string, (string | null)[]> };
};

type Bind = string | number | null;

type Built = { sql: string; binds: Bind[] };

/** The most rows any run fetches (also #456's ceiling for a raised built-in limit). */
export const CAMPAIGN_FETCH_CAP = 5000;

/** The SQL `runReport` executes for this spec, with every value in `binds`. */
export function compileReportQuery(input: ReportSpec, viewer: ReportViewer): Built {
	const spec = parseReportSpec(input);
	assertViewer(spec, viewer);
	return statementFor(spec);
}

export async function runReport(db: D1Database, input: ReportSpec, viewer: ReportViewer): Promise<ReportResult> {
	const spec = parseReportSpec(input);
	assertViewer(spec, viewer);
	switch (spec.entity) {
		case 'contacts':
			return runContacts(db, spec);
		case 'companies':
			return runCompanies(db, spec);
		case 'campaigns':
			return runCampaigns(db, spec);
		case 'segments':
			return runSegments(db, spec);
		case 'pipeline':
			return runPipeline(db, spec);
		case 'site_pages':
			return runSitePages(db, spec);
		default: {
			const never: never = spec.entity;
			throw new ReportError(`Unknown entity "${String(never)}".`);
		}
	}
}

/**
 * Contact ids a contacts report matches. The same set `compileSegment` returns
 * when `specToSegmentRules` can express the spec.
 */
export async function reportContactIds(db: D1Database, input: ReportSpec, viewer: ReportViewer): Promise<number[]> {
	const spec = parseReportSpec(input);
	assertViewer(spec, viewer);
	if (spec.entity !== 'contacts') throw new ReportError('Contact ids are only available for contacts reports.');
	const where = contactWhere(spec);
	const sql = `SELECT DISTINCT c.id AS id FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id WHERE ${where.sql} ORDER BY c.id`;
	const rows = await queryAll(db, sql, where.binds);
	return rows.map((row) => Number(row.id));
}

/**
 * The contacts behind a contacts or companies report, as a `SELECT id` query (#356).
 * Contacts: every matching contact (no row limit). Companies: every active contact
 * of every matching company. Null for the other entities.
 */
export function reportAudienceQuery(input: ReportSpec, viewer: ReportViewer): Built | null {
	const spec = parseReportSpec(input);
	assertViewer(spec, viewer);
	if (spec.entity === 'contacts') {
		const where = contactWhere(spec);
		return {
			sql: `SELECT DISTINCT c.id AS id FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id WHERE ${where.sql}`,
			binds: where.binds
		};
	}
	if (spec.entity === 'companies') {
		const where = companyWhere(spec);
		return {
			sql: `SELECT c.id AS id FROM contacts c WHERE ${activeContactSql('c')} AND c.company_id IN (SELECT co.id FROM companies co LEFT JOIN company_metrics cm ON cm.company_id = co.id WHERE ${where.sql})`,
			binds: where.binds
		};
	}
	return null;
}

/**
 * Segment rules when the report is a contacts filter the segment engine can
 * express. Thresholds, entity filters and a narrowing time range return null.
 */
export function specToSegmentRules(input: ReportSpec, viewer: ReportViewer): SegmentRules | null {
	const spec = parseReportSpec(input);
	assertViewer(spec, viewer);
	if (spec.entity !== 'contacts') return null;
	if (spec.thresholds?.minSent != null) return null;
	if (spec.entityFilters?.length) return null;
	if (spec.timeRange && !('preset' in spec.timeRange && spec.timeRange.preset === 'all')) return null;
	return {
		match: spec.filters.match,
		rules: spec.filters.rules.map((rule) => ({ ...rule }))
	};
}

function assertViewer(spec: ReportSpec, viewer: ReportViewer): void {
	if (viewer?.role === 'admin') return;
	const blocked = adminOnlyKeys(spec);
	if (blocked.length) throw new ReportError(adminOnlyMessage(blocked));
}

function statementFor(spec: ReportSpec): Built {
	switch (spec.entity) {
		case 'contacts':
			return contactStatement(spec);
		case 'companies':
			return companyStatement(spec);
		case 'campaigns':
			return campaignStatement(spec, spec.groupBy === 'week' || spec.groupBy === 'month' ? CAMPAIGN_FETCH_CAP : spec.limit);
		case 'pipeline':
			return pipelineStatement(spec);
		case 'site_pages':
			return siteStatement(spec);
		case 'segments':
			return segmentListStatement(spec);
		default: {
			const never: never = spec.entity;
			throw new ReportError(`Unknown entity "${String(never)}".`);
		}
	}
}

// --- contacts ------------------------------------------------------------------------

async function runContacts(db: D1Database, spec: ReportSpec): Promise<ReportResult> {
	const built = contactStatement(spec);
	const where = contactWhere(spec);
	const group = spec.groupBy ? contactGroup(spec.groupBy) : null;
	const total = await countGrouped(db, contactFrom(spec), where, group != null, group?.expr ?? null, group?.binds ?? []);
	const rows = mapPieces(await queryAll(db, built.sql, built.binds), spec);
	return finish(spec, rows, total);
}

function contactStatement(spec: ReportSpec): Built {
	const where = contactWhere(spec);
	const group = spec.groupBy ? contactGroup(spec.groupBy) : null;
	const pieces = selectPieces(spec, metricContext(spec), spec.groupBy != null);
	const select: string[] = [];
	const binds: Bind[] = [];
	if (group) {
		select.push(`${group.expr} AS g`);
		binds.push(...group.binds);
	}
	for (const piece of pieces) {
		select.push(piece.sql);
		binds.push(...piece.binds);
	}
	// Ungrouped rows link to the contact. Grouped rows have no single id.
	if (!group) select.unshift('c.id AS __id');
	if (!select.length) select.push('c.id AS id');
	const order = orderBy(spec, pieces, 'c.id ASC');
	const sql = `SELECT ${select.join(', ')} ${contactFrom(spec, group?.join ?? '')} WHERE ${where.sql}${
		group ? ' GROUP BY g' : ''
	}${order} LIMIT ?`;
	return { sql, binds: [...binds, ...where.binds, spec.limit] };
}

function contactFrom(spec: ReportSpec, extraJoin = ''): string {
	const groupJoin = extraJoin || (spec.groupBy ? contactGroup(spec.groupBy).join : '');
	return `FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id ${groupJoin}`;
}

function contactWhere(spec: ReportSpec): Built {
	const compiled = compileSegment(spec.filters as SegmentRules);
	// #705: a report's people are the active audience, unless its rules ask about subscription.
	const parts = [segmentAudienceSql(spec.filters as SegmentRules, 'c'), `c.id IN (${compiled.sql})`];
	const binds: Bind[] = compiled.binds.map(asBind);
	const extra = contactEntitySql(spec.entityFilters);
	if (extra.sql) {
		parts.push(extra.sql);
		binds.push(...extra.binds);
	}
	const time = timeSql('c.created_at', spec.timeRange, 'optional');
	if (time.sql) {
		parts.push(time.sql);
		binds.push(...time.binds);
	}
	if (spec.thresholds?.minSent != null) {
		parts.push('COALESCE(ce.sent_count, 0) >= ?');
		binds.push(spec.thresholds.minSent);
	}
	return { sql: parts.join(' AND '), binds };
}

/** Entity filters that the contacts page already knows how to compile. */
function contactEntitySql(filters: EntityFilter[] | undefined): Built {
	const parts: string[] = [];
	const binds: Bind[] = [];
	for (const filter of filters ?? []) {
		if (filter.field === 'pipeline') {
			const value: PipelineFilter = filter.op === 'any' || filter.op === 'none' ? filter.op : Number(filter.value);
			const clause = pipelineClause(value, 'c.id', filter.op === 'not');
			parts.push(`(${clause.clause})`);
			binds.push(...clause.binds.map(asBind));
		} else if (filter.field === 'bounced') {
			const clause =
				filter.op === 'none' ? bouncedClause('any', 'c.id', true) : bouncedClause(filter.op === 'hard' ? 'hard' : 'any', 'c.id');
			parts.push(`(${clause.clause})`);
			binds.push(...clause.binds.map(asBind));
		} else if (filter.field === 'spam') {
			const clause = spamClause('c.id', filter.op === 'no');
			parts.push(`(${clause.clause})`);
			binds.push(...clause.binds.map(asBind));
		} else if (filter.field === 'tier') {
			if (!isTier(filter.value)) throw new ReportError(`Unknown engagement tier "${filter.value ?? ''}".`);
			const clause = tierClause(filter.value, 'c.id', filter.op === 'not');
			parts.push(`(${clause.clause})`);
			binds.push(...clause.binds.map(asBind));
		} else if (filter.field === 'company_metric') {
			const cond = normalizeCondition(filter.value2 ?? '', filter.op, filter.value ?? '');
			const clause = cond ? metricClause(cond, 'c.company_id') : null;
			if (!clause) throw new ReportError('Unknown company metric filter.');
			parts.push(`(${clause.clause})`);
			binds.push(...clause.binds);
		} else {
			throw new ReportError(`Unknown filter "${filter.field}" for contacts.`);
		}
	}
	return { sql: parts.join(' AND '), binds };
}

function contactGroup(groupBy: string): { join: string; expr: string; binds: Bind[] } {
	switch (groupBy) {
		case 'tag':
			return {
				join: "JOIN list_members lm ON lm.contact_id = c.id JOIN lists l ON l.id = lm.list_id AND l.kind = 'tag'",
				expr: 'l.name',
				binds: []
			};
		case 'list':
			return {
				join: "JOIN list_members lm ON lm.contact_id = c.id JOIN lists l ON l.id = lm.list_id AND l.kind = 'list'",
				expr: 'l.name',
				binds: []
			};
		case 'source':
			return { join: '', expr: "COALESCE(c.source, '')", binds: [] };
		case 'company':
			return {
				join: 'LEFT JOIN companies co ON co.id = c.company_id',
				expr: "COALESCE(co.name, c.company, '')",
				binds: []
			};
		case 'engagement_tier':
			return { join: '', expr: "COALESCE(ce.tier, 'new')", binds: [] };
		case 'pipeline_stage':
			return {
				join: 'LEFT JOIN pipeline_cards gpc ON gpc.contact_id = c.id LEFT JOIN pipeline_stages gps ON gps.id = gpc.stage_id',
				expr: "COALESCE(gps.name, '')",
				binds: []
			};
		case 'week':
			return { join: '', expr: utcWeekSql('c.created_at'), binds: [] };
		case 'month':
			return { join: '', expr: utcMonthSql('c.created_at'), binds: [] };
		default: {
			const field = fieldColumnKey(groupBy);
			if (!field) throw new ReportError(`Unknown group "${groupBy}" for contacts.`);
			return { join: '', expr: "COALESCE(json_extract(c.meta, ?), '')", binds: [jsonPath(field)] };
		}
	}
}

// --- companies -----------------------------------------------------------------------

async function runCompanies(db: D1Database, spec: ReportSpec): Promise<ReportResult> {
	const built = companyStatement(spec);
	const where = companyWhere(spec);
	const total = await scalarCount(
		db,
		`SELECT COUNT(*) AS n FROM companies co LEFT JOIN company_metrics cm ON cm.company_id = co.id WHERE ${where.sql}`,
		where.binds
	);
	let rows = mapPieces(await queryAll(db, built.sql, built.binds), spec);
	rows = await fillCompanyRates(db, spec, rows);
	return finish(spec, rows, total);
}

function companyStatement(spec: ReportSpec): Built {
	const where = companyWhere(spec);
	const pieces = selectPieces(spec, metricContext(spec), false);
	const select = ['co.id AS __id', ...pieces.map((piece) => piece.sql)];
	const binds = pieces.flatMap((piece) => piece.binds);
	const sql = `SELECT ${select.join(', ')} FROM companies co LEFT JOIN company_metrics cm ON cm.company_id = co.id WHERE ${where.sql}${orderBy(
		spec,
		pieces,
		'co.name ASC, co.id ASC'
	)} LIMIT ?`;
	return { sql, binds: [...binds, ...where.binds, spec.limit] };
}

function companyWhere(spec: ReportSpec): Built {
	const parts = ['1=1'];
	const binds: Bind[] = [];
	if (spec.filters.rules.length) {
		const compiled = compileSegment(spec.filters as SegmentRules);
		parts.push(
			`EXISTS (SELECT 1 FROM contacts cf WHERE cf.company_id = co.id AND cf.id IN (${compiled.sql}))`
		);
		binds.push(...compiled.binds.map(asBind));
	}
	for (const filter of spec.entityFilters ?? []) {
		if (filter.field === 'name' && filter.op === 'is') {
			parts.push('LOWER(co.name) = ?');
			binds.push((filter.value ?? '').toLowerCase());
		} else if (filter.field === 'name' && filter.op === 'contains') {
			parts.push(`LOWER(co.name) LIKE ? ESCAPE '\\'`);
			binds.push(likeContains((filter.value ?? '').toLowerCase()));
		} else {
			const cond = normalizeCondition(filter.field, filter.op, filter.value ?? '');
			const clause = cond ? metricClause(cond, 'co.id') : null;
			if (!clause) throw new ReportError(`Unknown filter "${filter.field}" for companies.`);
			parts.push(`(${clause.clause})`);
			binds.push(...clause.binds);
		}
	}
	const time = timeSql('co.created_at', spec.timeRange, 'optional');
	if (time.sql) {
		parts.push(time.sql);
		binds.push(...time.binds);
	}
	return { sql: parts.join(' AND '), binds };
}

async function fillCompanyRates(
	db: D1Database,
	spec: ReportSpec,
	rows: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
	const ids = rows.map((row) => Number(row.__id)).filter((id) => Number.isInteger(id) && id > 0);
	if (spec.columns.includes('avg_open_rate')) {
		for (const row of rows) row.avg_open_rate = storedRatePct(row.avg_open_rate);
	}
	if (spec.columns.includes('median_open_rate') && ids.length) {
		const rates = await openRatesByCompany(db, ids);
		for (const row of rows) row.median_open_rate = medianPct(rates.get(Number(row.__id)) ?? []);
	}
	if (spec.columns.includes('opens') && ids.length) {
		const opens = await humanOpenEventsByCompany(db, ids, spec.timeRange);
		for (const row of rows) row.opens = opens.get(Number(row.__id)) ?? 0;
	}
	return rows;
}

async function openRatesByCompany(db: D1Database, ids: number[]): Promise<Map<number, number[]>> {
	const out = new Map<number, number[]>();
	for (const slice of chunks(ids, 80)) {
		const rows = await queryAll(
			db,
			`SELECT c.company_id AS company_id, ce.open_rate AS open_rate
			 FROM contacts c JOIN contact_engagement ce ON ce.contact_id = c.id
			 WHERE c.archived_at IS NULL AND ce.open_rate IS NOT NULL
			   AND c.company_id IN (${marks(slice.length)})`,
			slice
		);
		for (const row of rows) {
			const id = Number(row.company_id);
			const list = out.get(id) ?? [];
			list.push(Number(row.open_rate));
			out.set(id, list);
		}
	}
	return out;
}

async function humanOpenEventsByCompany(db: D1Database, ids: number[], range: TimeRange | undefined): Promise<Map<number, number>> {
	const counts = new Map<number, number>();
	const time = timeSql('e.recorded_at', range, 'raw');
	for (const slice of chunks(ids, 80)) {
		const rows = await queryAll(
			db,
			`SELECT c.company_id AS company_id, e.detail AS detail, e.recorded_at AS recorded_at,
			        (SELECT MIN(d.recorded_at) FROM events d
			          WHERE d.campaign_id = e.campaign_id AND d.type = 'delivery' AND d.contact_id = e.contact_id) AS delivered_at
			 FROM events e JOIN contacts c ON c.id = e.contact_id
			 WHERE e.type = 'open' AND c.archived_at IS NULL AND c.company_id IN (${marks(slice.length)})
			   AND (${time.sql})`,
			[...slice, ...time.binds]
		);
		for (const row of rows) {
			if (isProxyEvent(row)) continue;
			const id = Number(row.company_id);
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}
	return counts;
}

// --- campaigns -----------------------------------------------------------------------

/**
 * Campaign columns the engine fills after the query (opener adjustment, rates).
 * SQL can't order by them, so a sort on one sorts in JS after the rates are in.
 */
const CAMPAIGN_POST_COMPUTED = new Set(['opens', 'open_rate', 'click_rate', 'ctor', 'unsub_rate', 'bounce_rate', 'complaint_rate']);

/** Counts summed into a week / month bucket. */
const CAMPAIGN_BUCKET_SUMS = ['recipients', 'rejected', 'delivered', 'opens', 'total_opens', 'clicks', 'total_clicks', 'unsubs', 'bounces', 'spam', 'replies'];

function campaignBucket(spec: ReportSpec): 'week' | 'month' | null {
	return spec.groupBy === 'week' || spec.groupBy === 'month' ? spec.groupBy : null;
}

/** Rows are sorted (and sliced) in JS: time buckets, or a sort on a post-computed column. */
function campaignSortsInJs(spec: ReportSpec): boolean {
	return campaignBucket(spec) != null || (spec.sort != null && CAMPAIGN_POST_COMPUTED.has(spec.sort.key));
}

async function runCampaigns(db: D1Database, spec: ReportSpec): Promise<ReportResult> {
	const bucket = campaignBucket(spec);
	if (bucket) {
		for (const key of spec.columns) {
			const metric = findMetric('campaigns', key);
			if (metric?.format === 'text') throw new ReportError(`Column "${key}" can't be grouped.`);
		}
	}
	const inJs = campaignSortsInJs(spec);
	const limit = inJs ? CAMPAIGN_FETCH_CAP : spec.limit;
	const built = campaignStatement(spec, limit);
	const where = campaignWhere(spec);
	const matched = await scalarCount(db, `SELECT COUNT(*) AS n FROM campaigns cp WHERE ${where.sql}`, where.binds);
	let rows = applyCampaignRates(await adjustCampaignOpens(db, spec, mapPieces(await queryAll(db, built.sql, built.binds), spec)));
	if (bucket) {
		const grouped = bucketCampaigns(rows, bucket);
		// A row limit keeps the most recent buckets (#453), then the spec's sort
		// (default: the bucket, oldest first) orders what is kept.
		const recent = [...grouped].sort((a, b) => String(b[bucket] ?? '').localeCompare(String(a[bucket] ?? ''))).slice(0, spec.limit);
		const page = sortRows(recent, spec);
		return finish(spec, page, grouped.length, matched >= CAMPAIGN_FETCH_CAP || grouped.length > page.length);
	}
	if (inJs) rows = sortRows(rows, spec).slice(0, spec.limit);
	if (spec.groupBy === 'campaign') {
		for (const row of rows) row.campaign = row.subject ?? '';
	}
	return finish(spec, rows, matched);
}

function campaignStatement(spec: ReportSpec, limit: number): Built {
	const widened = campaignColumns(spec);
	const pieces = selectPieces({ ...spec, columns: widened, groupBy: undefined }, metricContext(spec), false);
	const select = ['cp.id AS __id', ...pieces.map((piece) => piece.sql)];
	const where = campaignWhere(spec);
	const binds = [...pieces.flatMap((piece) => piece.binds), ...where.binds, limit];
	const sql = `SELECT ${select.join(', ')} FROM campaigns cp WHERE ${where.sql}${campaignOrder(spec, pieces)} LIMIT ?`;
	return { sql, binds };
}

/**
 * Newest first by default, `id DESC` as the tie-break for an equal `sent_at` (#453).
 * Time buckets and post-computed sorts are ordered in JS, so SQL keeps the newest
 * rows. There is no `g` column here: bucketing happens after the query.
 */
function campaignOrder(spec: ReportSpec, pieces: Piece[]): string {
	const fallback = ' ORDER BY cp.sent_at DESC, cp.id DESC';
	if (!spec.sort || campaignSortsInJs(spec)) return fallback;
	const dir = spec.sort.dir === 'asc' ? 'ASC' : 'DESC';
	if (spec.groupBy === 'campaign' && spec.sort.key === 'campaign') return ` ORDER BY cp.subject ${dir}, cp.id DESC`;
	const piece = pieces.find((item) => item.key === spec.sort!.key);
	if (!piece || piece.rate) return fallback;
	return ` ORDER BY ${piece.alias} ${dir}, cp.id DESC`;
}

function campaignColumns(spec: ReportSpec): string[] {
	const keys = [...spec.columns];
	const add = (key: string) => {
		if (!keys.includes(key)) keys.push(key);
	};
	if (spec.sort && spec.sort.key !== spec.groupBy && findMetric('campaigns', spec.sort.key)) add(spec.sort.key);
	if (keys.includes('open_rate') || keys.includes('ctor') || keys.includes('opens')) {
		add('opens');
		add('recipients');
	}
	if (keys.includes('click_rate') || keys.includes('ctor')) {
		add('clicks');
		add('recipients');
	}
	if (keys.includes('unsub_rate')) {
		add('unsubs');
		add('recipients');
	}
	if (keys.includes('bounce_rate')) {
		add('bounces');
		add('recipients');
	}
	if (keys.includes('complaint_rate')) {
		add('spam');
		add('recipients');
	}
	if (campaignBucket(spec)) add('sent_at');
	return keys;
}

/** An automation send: a step campaign, or one whose step was deleted since (#453). */
const AUTOMATION_SEND_SQL = '(cp.automation_step_id IS NOT NULL OR cp.automation_id IS NOT NULL)';

function campaignWhere(spec: ReportSpec): Built {
	const parts = [visibleCampaignSql('cp')]; // #668: account emails are never report rows
	const binds: Bind[] = [];
	if (spec.filters.rules.length) {
		const compiled = compileSegment(spec.filters as SegmentRules);
		parts.push(`EXISTS (SELECT 1 FROM recipients rf WHERE rf.campaign_id = cp.id AND rf.contact_id IN (${compiled.sql}))`);
		binds.push(...compiled.binds.map(asBind));
	}
	for (const filter of spec.entityFilters ?? []) {
		if (filter.field === 'status') {
			parts.push('cp.status = ?');
			binds.push(filter.value ?? '');
		} else if (filter.field === 'kind' && filter.value === 'automation') {
			parts.push(AUTOMATION_SEND_SQL);
		} else if (filter.field === 'kind' && filter.value === 'direct') {
			parts.push(`NOT ${AUTOMATION_SEND_SQL} AND cp.list_id IS NULL`);
		} else if (filter.field === 'kind' && filter.value === 'campaign') {
			parts.push(`NOT ${AUTOMATION_SEND_SQL} AND cp.list_id IS NOT NULL`);
		} else if (filter.field === 'audience') {
			parts.push(
				'(cp.list_id = ? OR EXISTS (SELECT 1 FROM campaign_audiences ca WHERE ca.campaign_id = cp.id AND ca.list_id = ?))'
			);
			const id = Number(filter.value);
			binds.push(id, id);
		} else if (filter.field === 'sent_at' && filter.op === 'within') {
			parts.push("COALESCE(cp.sent_at, cp.created_at) >= datetime('now', ?)");
			binds.push(`-${Math.max(0, Math.floor(Number(filter.value) || 0))} days`);
		} else if (filter.field === 'sent_at' && filter.op === 'before') {
			parts.push('COALESCE(cp.sent_at, cp.created_at) < ?');
			binds.push(filter.value ?? '');
		} else if (filter.field === 'sent_at' && filter.op === 'after') {
			parts.push('COALESCE(cp.sent_at, cp.created_at) > ?');
			binds.push(filter.value ?? '');
		} else {
			throw new ReportError(`Unknown filter "${filter.field}" for campaigns.`);
		}
	}
	const time = timeSql('COALESCE(cp.sent_at, cp.created_at)', spec.timeRange, 'optional');
	if (time.sql) {
		parts.push(time.sql);
		binds.push(...time.binds);
	}
	if (spec.thresholds?.minSent != null) {
		parts.push("(SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = cp.id AND r.status = 'accepted') >= ?");
		binds.push(spec.thresholds.minSent);
	}
	return { sql: parts.join(' AND '), binds };
}

async function adjustCampaignOpens(
	db: D1Database,
	spec: ReportSpec,
	rows: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
	if (!rows.some((row) => 'opens' in row) && !spec.columns.some((key) => key === 'opens' || key === 'open_rate' || key === 'ctor')) {
		return rows;
	}
	const ids = rows.map((row) => Number(row.__id)).filter((id) => id > 0);
	const openers = await openersByCampaign(db, ids);
	for (const row of rows) row.opens = openers.get(Number(row.__id)) ?? 0;
	return rows;
}

/** Every campaign rate, from the counts on the row, at the report precision. */
function campaignRates(row: Record<string, unknown>): void {
	const recipients = num(row.recipients);
	const opens = num(row.opens);
	const clicks = num(row.clicks);
	row.open_rate = reportPct(opens, recipients);
	row.click_rate = reportPct(clicks, recipients);
	row.ctor = reportPct(clicks, opens);
	row.unsub_rate = reportPct(num(row.unsubs), recipients, true);
	row.bounce_rate = reportPct(num(row.bounces), recipients, true);
	row.complaint_rate = reportPct(num(row.spam), recipients, true);
}

function applyCampaignRates(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	for (const row of rows) campaignRates(row);
	return rows;
}

function bucketCampaigns(rows: Record<string, unknown>[], unit: 'week' | 'month'): Record<string, unknown>[] {
	const buckets = new Map<string, Record<string, number>>();
	for (const row of rows) {
		const at = String(row.sent_at ?? '');
		const key = (unit === 'week' ? utcWeekStart(at) : utcMonth(at)) ?? '';
		const bucket = buckets.get(key) ?? {};
		for (const name of CAMPAIGN_BUCKET_SUMS) {
			if (name in row) bucket[name] = (bucket[name] ?? 0) + num(row[name]);
		}
		buckets.set(key, bucket);
	}
	return [...buckets.entries()].map(([key, sums]) => {
		const row: Record<string, unknown> = { [unit]: key, ...sums };
		campaignRates(row);
		return row;
	});
}

/**
 * Unique openers per campaign (#453): distinct recipients with a human open **or**
 * a click. A click proves the email was opened even when images were blocked or the
 * only open was a proxy (Apple MPP) prefetch, so CTOR can't pass 100 %. Proxy-only
 * openers who never clicked are not counted.
 */
export async function openersByCampaign(db: D1Database, ids: number[]): Promise<Map<number, number>> {
	const human = new Map<string, boolean>();
	for (const slice of chunks(ids, 80)) {
		const rows = await queryAll(
			db,
			`SELECT e.campaign_id AS campaign_id, e.recipient_id AS recipient_id, e.contact_id AS contact_id,
			        e.type AS type, e.detail AS detail, e.recorded_at AS recorded_at,
			        (SELECT MIN(d.recorded_at) FROM events d
			          WHERE d.campaign_id = e.campaign_id AND d.type = 'delivery' AND d.recipient_id = e.recipient_id) AS delivered_at
			 FROM events e
			 WHERE e.type IN ('open', 'click') AND e.campaign_id IN (${marks(slice.length)})`,
			slice
		);
		for (const row of rows) {
			const who = row.recipient_id ?? row.contact_id ?? 0;
			const key = `${row.campaign_id}:${who}`;
			human.set(key, (human.get(key) ?? false) || row.type === 'click' || !isProxyEvent(row));
		}
	}
	const counts = new Map<number, number>();
	for (const [key, ok] of human) {
		if (!ok) continue;
		const id = Number(key.slice(0, key.indexOf(':')));
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

// --- segments ------------------------------------------------------------------------

async function runSegments(db: D1Database, spec: ReportSpec): Promise<ReportResult> {
	const built = segmentListStatement(spec);
	const where = segmentWhere(spec);
	const total = await scalarCount(db, `SELECT COUNT(*) AS n FROM lists l WHERE ${where.sql}`, where.binds);
	const lists = await queryAll(db, built.sql, built.binds);
	const rows: Record<string, unknown>[] = [];
	for (const list of lists) {
		const members = await segmentMemberStats(db, list);
		rows.push({
			name: list.name,
			member_count: members.member_count,
			subscribed_count: members.subscribed_count,
			avg_open_rate: storedRatePct(members.avg_open_rate),
			avg_click_rate: storedRatePct(members.avg_click_rate),
			campaigns_sent: 0,
			campaign_open_rate: null,
			__id: list.id
		});
	}
	if (spec.columns.includes('campaigns_sent') || spec.columns.includes('campaign_open_rate')) {
		await fillSegmentCampaigns(db, rows);
	}
	return finish(spec, rows, total);
}

function segmentListStatement(spec: ReportSpec): Built {
	const where = segmentWhere(spec);
	return {
		sql: `SELECT l.id AS id, l.name AS name, l.kind AS kind, l.rules AS rules FROM lists l WHERE ${where.sql} ORDER BY l.name COLLATE NOCASE, l.id LIMIT ?`,
		binds: [...where.binds, spec.limit]
	};
}

function segmentWhere(spec: ReportSpec): Built {
	const kind = spec.entityFilters?.find((filter) => filter.field === 'kind')?.value;
	if (kind) return { sql: 'l.kind = ?', binds: [kind] };
	return { sql: "l.kind IN ('list', 'segment')", binds: [] };
}

async function segmentMemberStats(
	db: D1Database,
	list: Record<string, unknown>
): Promise<{ member_count: number; subscribed_count: number; avg_open_rate: number | null; avg_click_rate: number | null }> {
	const rules = parseRules(typeof list.rules === 'string' ? list.rules : null);
	const compiled = rules ? compileSegment(rules) : null;
	const sql = compiled
		? compiled.sql
		: 'SELECT c.id FROM contacts c JOIN list_members lm ON lm.contact_id = c.id WHERE lm.list_id = ? AND c.archived_at IS NULL';
	const binds = compiled ? compiled.binds.map(asBind) : [Number(list.id)];
	const row = await queryFirst(
		db,
		`SELECT COUNT(*) AS member_count,
		        COALESCE(SUM(c.subscribed = 1), 0) AS subscribed_count,
		        AVG(ce.open_rate) AS avg_open_rate,
		        AVG(ce.click_rate) AS avg_click_rate
		 FROM contacts c LEFT JOIN contact_engagement ce ON ce.contact_id = c.id
		 WHERE c.id IN (${sql}) AND ${segmentAudienceSql(rules, 'c')}`,
		binds
	);
	return {
		member_count: num(row?.member_count),
		subscribed_count: num(row?.subscribed_count),
		avg_open_rate: row?.avg_open_rate == null ? null : Number(row.avg_open_rate),
		avg_click_rate: row?.avg_click_rate == null ? null : Number(row.avg_click_rate)
	};
}

async function fillSegmentCampaigns(db: D1Database, rows: Record<string, unknown>[]): Promise<void> {
	const ids = rows.map((row) => Number(row.__id)).filter((id) => id > 0);
	if (!ids.length) return;
	const sent = await queryAll(
		db,
		`SELECT ca.list_id AS list_id, cp.id AS campaign_id,
		        (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = cp.id AND r.status = 'accepted') AS accepted
		 FROM campaign_audiences ca JOIN campaigns cp ON cp.id = ca.campaign_id
		 WHERE ca.mode = 'include' AND cp.status = 'sent' AND ca.list_id IN (${marks(ids.length)})`,
		ids
	);
	const campaignIds = [...new Set(sent.map((row) => Number(row.campaign_id)))];
	const opens = await openersByCampaign(db, campaignIds);
	const byList = new Map<number, { campaigns: Set<number>; accepted: number; opens: number }>();
	for (const row of sent) {
		const listId = Number(row.list_id);
		const campaignId = Number(row.campaign_id);
		const bucket = byList.get(listId) ?? { campaigns: new Set<number>(), accepted: 0, opens: 0 };
		if (!bucket.campaigns.has(campaignId)) {
			bucket.campaigns.add(campaignId);
			bucket.accepted += num(row.accepted);
			bucket.opens += opens.get(campaignId) ?? 0;
		}
		byList.set(listId, bucket);
	}
	for (const row of rows) {
		const bucket = byList.get(Number(row.__id));
		row.campaigns_sent = bucket?.campaigns.size ?? 0;
		row.campaign_open_rate = bucket ? reportPct(bucket.opens, bucket.accepted) : null;
	}
}

// --- pipeline ------------------------------------------------------------------------

async function runPipeline(db: D1Database, spec: ReportSpec): Promise<ReportResult> {
	const built = pipelineStatement(spec);
	const where = pipelineWhere(spec);
	const from = 'FROM pipeline_cards pc JOIN pipeline_stages ps ON ps.id = pc.stage_id JOIN contacts c ON c.id = pc.contact_id';
	const total = spec.groupBy
		? await scalarCount(
				db,
				`SELECT COUNT(*) AS n FROM (SELECT ${pipelineGroupExpr(spec.groupBy)} AS g ${from} WHERE ${where.sql} GROUP BY ${
					spec.groupBy === 'pipeline_stage' ? 'ps.id' : 'g'
				}) q`,
				where.binds
			)
		: await scalarCount(db, `SELECT COUNT(*) AS n FROM (SELECT 1 ${from} WHERE ${where.sql}) q`, where.binds);
	const rows = mapPieces(await queryAll(db, built.sql, built.binds), spec);
	return finish(spec, rows, total);
}

function pipelineStatement(spec: ReportSpec): Built {
	const where = pipelineWhere(spec);
	const group = spec.groupBy ? pipelineGroupExpr(spec.groupBy) : null;
	const select: string[] = [];
	const binds: Bind[] = [];
	if (group) {
		select.push(`${group} AS g`);
	}
	for (const key of spec.columns) {
		if (key === spec.groupBy) continue;
		const expr = pipelineExpr(key, spec, group != null);
		select.push(`${expr.sql} AS ${sqlIdent(key)}`);
		binds.push(...expr.binds);
	}
	// Ungrouped rows link to the contact on the card.
	if (!group) select.unshift('c.id AS __id');
	if (!select.length) select.push('pc.id AS id');
	const from = 'FROM pipeline_cards pc JOIN pipeline_stages ps ON ps.id = pc.stage_id JOIN contacts c ON c.id = pc.contact_id';
	const groupBySql = spec.groupBy === 'pipeline_stage' ? 'ps.id' : group ? 'g' : '';
	const sql = `SELECT ${select.join(', ')} ${from} WHERE ${where.sql}${groupBySql ? ` GROUP BY ${groupBySql}` : ''}${orderBy(
		spec,
		[],
		group ? 'g ASC' : 'ps.position ASC, pc.position ASC, pc.id ASC'
	)} LIMIT ?`;
	return { sql, binds: [...binds, ...where.binds, spec.limit] };
}

function pipelineWhere(spec: ReportSpec): Built {
	const parts = ['1=1'];
	const binds: Bind[] = [];
	if (spec.filters.rules.length) {
		const compiled = compileSegment(spec.filters as SegmentRules);
		parts.push(`pc.contact_id IN (${compiled.sql})`);
		binds.push(...compiled.binds.map(asBind));
	}
	for (const filter of spec.entityFilters ?? []) {
		if (filter.field === 'stage') {
			parts.push('pc.stage_id = ?');
			binds.push(Number(filter.value));
		} else if (filter.field === 'kind') {
			parts.push('ps.kind = ?');
			binds.push(filter.value ?? '');
		} else {
			throw new ReportError(`Unknown filter "${filter.field}" for pipeline.`);
		}
	}
	const time = timeSql('pc.entered_stage_at', spec.timeRange, 'optional');
	if (time.sql) {
		parts.push(time.sql);
		binds.push(...time.binds);
	}
	return { sql: parts.join(' AND '), binds };
}

function pipelineGroupExpr(groupBy: string | undefined): string | null {
	if (!groupBy) return null;
	if (groupBy === 'pipeline_stage') return 'ps.name';
	if (groupBy === 'week') return utcWeekSql('pc.entered_stage_at');
	if (groupBy === 'month') return utcMonthSql('pc.entered_stage_at');
	throw new ReportError(`Unknown group "${groupBy}" for pipeline.`);
}

function pipelineExpr(key: string, spec: ReportSpec, grouped: boolean): Built {
	const history = timeSql('h.created_at', spec.timeRange, 'raw');
	const stageMatch =
		spec.groupBy === 'week'
			? `${utcWeekSql('h.created_at')} = ${utcWeekSql('pc.entered_stage_at')}`
			: spec.groupBy === 'month'
				? `${utcMonthSql('h.created_at')} = ${utcMonthSql('pc.entered_stage_at')}`
				: `h.to_stage_id = ${grouped && spec.groupBy === 'pipeline_stage' ? 'ps.id' : 'pc.stage_id'}`;
	switch (key) {
		case 'pipeline_stage':
			if (grouped && spec.groupBy !== 'pipeline_stage') throw new ReportError('Column "pipeline_stage" can\'t be grouped.');
			return { sql: 'ps.name', binds: [] };
		case 'cards':
			return { sql: grouped ? 'COUNT(*)' : '1', binds: [] };
		case 'pipeline_value':
			return { sql: grouped ? 'SUM(pc.value)' : 'pc.value', binds: [] };
		case 'avg_days_in_stage':
			return {
				sql: grouped
					? "CAST(ROUND(AVG(julianday('now') - julianday(pc.entered_stage_at))) AS INTEGER)"
					: "CAST(julianday('now') - julianday(pc.entered_stage_at) AS INTEGER)",
				binds: []
			};
		case 'moves':
			return {
				sql: `(SELECT COUNT(*) FROM pipeline_history h WHERE ${stageMatch} AND (${history.sql}))`,
				binds: history.binds
			};
		case 'won':
			return {
				sql: `(SELECT COUNT(*) FROM pipeline_history h JOIN pipeline_stages ks ON ks.id = h.to_stage_id AND ks.kind = 'won' WHERE ${stageMatch} AND (${history.sql}))`,
				binds: history.binds
			};
		case 'lost':
			return {
				sql: `(SELECT COUNT(*) FROM pipeline_history h JOIN pipeline_stages ks ON ks.id = h.to_stage_id AND ks.kind = 'lost' WHERE ${stageMatch} AND (${history.sql}))`,
				binds: history.binds
			};
		default:
			throw new ReportError(`Unknown column "${key}" for pipeline.`);
	}
}

// --- site pages ----------------------------------------------------------------------

async function runSitePages(db: D1Database, spec: ReportSpec): Promise<ReportResult> {
	const built = siteStatement(spec);
	const where = siteWhere(spec);
	const dim = spec.groupBy ? siteDim(spec.groupBy) : null;
	const total = dim
		? await countGrouped(db, 'FROM site_events se', where, true, dim.sql, dim.binds)
		: 1;
	const rows = mapPieces(await queryAll(db, built.sql, built.binds), spec);
	return finish(spec, rows, dim ? total : rows.length);
}

function siteStatement(spec: ReportSpec): Built {
	const where = siteWhere(spec);
	const dim = spec.groupBy ? siteDim(spec.groupBy) : null;
	const select: string[] = [];
	const binds: Bind[] = [];
	if (dim) {
		select.push(`${dim.sql} AS g`);
		binds.push(...dim.binds);
	}
	for (const key of spec.columns) {
		if (key === spec.groupBy) continue;
		if (key === 'views') select.push('COUNT(*) AS views');
		else if (key === 'unique_contacts') select.push('COUNT(DISTINCT se.contact_id) AS unique_contacts');
		else if (key === 'path') throw new ReportError('Column "path" can\'t be grouped.');
		else throw new ReportError(`Unknown column "${key}" for site_pages.`);
	}
	if (!select.length) select.push('COUNT(*) AS views');
	const sql = `SELECT ${select.join(', ')} FROM site_events se WHERE ${where.sql}${dim ? ' GROUP BY g' : ''}${orderBy(
		spec,
		[],
		dim ? 'g ASC' : ''
	)} LIMIT ?`;
	return { sql, binds: [...binds, ...where.binds, spec.limit] };
}

function siteWhere(spec: ReportSpec): Built {
	const time = timeSql('se.occurred_at', spec.timeRange, 'raw');
	const parts = ["se.kind = 'pageview'", `(${time.sql})`];
	const binds: Bind[] = [...time.binds];
	if (spec.filters.rules.length) {
		const compiled = compileSegment(spec.filters as SegmentRules);
		parts.push(`se.contact_id IN (${compiled.sql})`);
		binds.push(...compiled.binds.map(asBind));
	}
	for (const filter of spec.entityFilters ?? []) {
		if (filter.field === 'path') {
			parts.push(`COALESCE(se.path, '') LIKE ? ESCAPE '\\'`);
			binds.push(likeContains(filter.value ?? ''));
		} else if (filter.field === 'country') {
			parts.push('LOWER(COALESCE(se.country, \'\')) = ?');
			binds.push((filter.value ?? '').toLowerCase());
		} else if (filter.field === 'site') {
			parts.push('se.site_id = ?');
			binds.push(Number(filter.value));
		} else {
			throw new ReportError(`Unknown filter "${filter.field}" for site_pages.`);
		}
	}
	return { sql: parts.join(' AND '), binds };
}

function siteDim(groupBy: string): Built {
	switch (groupBy) {
		case 'path':
			return { sql: "COALESCE(se.path, '')", binds: [] };
		case 'country':
			return { sql: "COALESCE(se.country, '')", binds: [] };
		case 'referrer_host':
			return { sql: "COALESCE(se.referrer_host, '')", binds: [] };
		case 'utm_source':
			return { sql: "COALESCE(json_extract(se.utm, '$.source'), '')", binds: [] };
		case 'utm_campaign':
			return { sql: "COALESCE(json_extract(se.utm, '$.campaign'), '')", binds: [] };
		case 'week':
			return { sql: utcWeekSql('se.occurred_at'), binds: [] };
		case 'month':
			return { sql: utcMonthSql('se.occurred_at'), binds: [] };
		default:
			throw new ReportError(`Unknown group "${groupBy}" for site_pages.`);
	}
}

// --- select list ---------------------------------------------------------------------

type Piece = { key: string; alias: string; sql: string; binds: Bind[]; rate?: { num: string; den: string } };

function selectPieces(spec: ReportSpec, ctx: MetricContext, grouped: boolean): Piece[] {
	const pieces: Piece[] = [];
	let i = 0;
	for (const key of spec.columns) {
		if (spec.groupBy && key === spec.groupBy) continue;
		const metric = findMetric(spec.entity, key);
		if (!metric) {
			const field = spec.entity === 'contacts' ? fieldColumnKey(key) : null;
			if (!field) throw new ReportError(`Unknown column "${key}" for ${spec.entity}.`);
			if (grouped) throw new ReportError(`Column "${key}" can't be grouped.`);
			const alias = `c${i++}`;
			pieces.push({ key, alias, sql: `json_extract(c.meta, ?) AS ${alias}`, binds: [jsonPath(field)] });
			continue;
		}
		if (metric.format === 'text' && grouped) throw new ReportError(`Column "${key}" can't be grouped.`);
		if (metric.rate) {
			const num = `n${i++}`;
			const den = `d${i++}`;
			const numSql = grouped ? `SUM(${metric.rate.num})` : metric.rate.num;
			const denSql = grouped ? `SUM(${metric.rate.den})` : metric.rate.den;
			pieces.push({
				key,
				alias: num,
				sql: `${numSql} AS ${num}, ${denSql} AS ${den}`,
				binds: [],
				rate: { num, den }
			});
			continue;
		}
		const built = metric.select ? metric.select(ctx) : { sql: 'NULL', binds: [] as Bind[] };
		const alias = aliasFor(key, i++);
		pieces.push({ key, alias, sql: `${wrapAgg(built.sql, metric, grouped)} AS ${alias}`, binds: [...built.binds] });
	}
	return pieces;
}

function wrapAgg(sql: string, metric: MetricDef, grouped: boolean): string {
	if (!grouped) {
		if (metric.groupAgg === 'count-distinct') return '1';
		return sql;
	}
	const agg = metric.groupAgg ?? (metric.format === 'date' ? 'max' : 'sum');
	switch (agg) {
		case 'sum':
			return `SUM(${sql})`;
		case 'max':
			return `MAX(${sql})`;
		case 'min':
			return `MIN(${sql})`;
		case 'count-distinct':
			return `COUNT(DISTINCT ${sql})`;
		default: {
			const never: never = agg;
			return never;
		}
	}
}

function mapPieces(raw: Record<string, unknown>[], spec: ReportSpec): Record<string, unknown>[] {
	const pieces = selectPieces(spec, metricContext(spec), spec.groupBy != null && spec.entity !== 'campaigns' && spec.entity !== 'site_pages' && spec.entity !== 'pipeline');
	// Pipeline and site map by alias directly because their SELECT uses aliasFor(key).
	if (spec.entity === 'pipeline' || spec.entity === 'site_pages' || spec.entity === 'segments') {
		return raw.map((row) => renameGroup(row, spec.groupBy));
	}
	if (spec.entity === 'campaigns') {
		const campaignPieces = selectPieces({ ...spec, columns: campaignColumns(spec), groupBy: undefined }, metricContext(spec), false);
		return raw.map((row) => readRow(row, campaignPieces, null));
	}
	const groupKey = spec.groupBy ?? null;
	return raw.map((row) => readRow(row, pieces, groupKey));
}

function readRow(row: Record<string, unknown>, pieces: Piece[], groupKey: string | null): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (groupKey) out[groupKey] = row.g ?? '';
	if ('__id' in row) out.__id = row.__id;
	for (const piece of pieces) {
		if (piece.rate) out[piece.key] = reportPct(num(row[piece.rate.num]), num(row[piece.rate.den]), FINE_RATE_KEYS.has(piece.key));
		else out[piece.key] = row[piece.alias];
	}
	return out;
}

function orderBy(spec: ReportSpec, pieces: Piece[], fallback = ''): string {
	if (spec.sort) {
		const dir = spec.sort.dir === 'asc' ? 'ASC' : 'DESC';
		if (spec.groupBy && spec.sort.key === spec.groupBy) return ` ORDER BY g ${dir}`;
		const piece = pieces.find((item) => item.key === spec.sort!.key);
		if (piece?.rate) {
			return ` ORDER BY CASE WHEN ${piece.rate.den} = 0 THEN NULL ELSE 100.0 * ${piece.rate.num} / ${piece.rate.den} END ${dir}`;
		}
		if (piece) return ` ORDER BY ${piece.alias} ${dir}`;
		// Pipeline and site pages alias a selected metric as its key, and pass no
		// pieces into orderBy. Only that output alias may be ordered. A sort key
		// that isn't selected (pipeline_value with the column omitted) must not
		// become a bare column reference — that orders every row by the value.
		if ((spec.entity === 'pipeline' || spec.entity === 'site_pages') && spec.columns.includes(spec.sort.key)) {
			return ` ORDER BY ${sqlIdent(spec.sort.key)} ${dir}`;
		}
	}
	if (spec.groupBy && spec.entity !== 'campaigns') return ' ORDER BY g ASC';
	return fallback ? ` ORDER BY ${fallback}` : '';
}

function sortRows(rows: Record<string, unknown>[], spec: ReportSpec): Record<string, unknown>[] {
	const key = spec.sort?.key ?? spec.groupBy ?? '';
	const dir = spec.sort?.dir === 'desc' ? -1 : 1;
	if (!key) return rows;
	return [...rows].sort((a, b) => {
		const av = a[key];
		const bv = b[key];
		// No value (a rate with nothing sent) sorts last in either direction.
		if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
		if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
		return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
	});
}

// --- result --------------------------------------------------------------------------

function finish(spec: ReportSpec, rows: Record<string, unknown>[], total: number, forceTruncated = false): ReportResult {
	const recordIds = rows.map((row) => {
		const id = Number(row.__id);
		return Number.isInteger(id) && id > 0 ? id : null;
	});
	const columns = columnMeta(spec);
	const cleaned = rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const column of columns) out[column.key] = row[column.key] ?? null;
		return out;
	});
	const chartSeries = buildChart(spec, columns, cleaned);
	const result: ReportResult = {
		columns,
		rows: cleaned,
		total,
		truncated: forceTruncated || total > cleaned.length
	};
	if (chartSeries) result.chartSeries = chartSeries;
	if (recordIds.some((id) => id != null)) result.recordIds = recordIds;
	return result;
}

function columnMeta(spec: ReportSpec): ReportColumn[] {
	const keys: string[] = [];
	if (spec.groupBy) keys.push(spec.groupBy);
	for (const key of spec.columns) if (!keys.includes(key)) keys.push(key);
	return keys.map((key) => {
		const metric = findMetric(spec.entity, key);
		if (metric) return { key, label: metric.label, format: metric.format, definition: metric.definition };
		const field = fieldColumnKey(key);
		if (field) return { key, label: field, format: 'text', definition: `Custom field ${field} (contacts.meta).` };
		return { key, label: groupLabel(key), format: 'text', definition: groupLabel(key) };
	});
}

function buildChart(spec: ReportSpec, columns: ReportColumn[], rows: Record<string, unknown>[]): ChartSeries | undefined {
	if (!spec.chart || spec.chart === 'table') return undefined;
	const y = columns.find((column) => column.format !== 'text' && column.format !== 'date');
	if (!y) return undefined;
	const xKey = spec.groupBy ?? columns.find((column) => column.format === 'text')?.key ?? y.key;
	const source = spec.chart === 'stat' ? rows.slice(0, 1) : rows;
	return {
		xKey,
		yKey: y.key,
		points: source.map((row) => ({
			x: String(row[xKey] ?? ''),
			y: row[y.key] == null ? null : Number(row[y.key])
		}))
	};
}

function metricContext(spec: ReportSpec): MetricContext {
	return {
		window: (column) => {
			const time = timeSql(column, spec.timeRange, 'raw');
			return { sql: time.sql, binds: time.binds };
		}
	};
}

// --- time, proxy, sql helpers --------------------------------------------------------

function timeSql(column: string, range: TimeRange | undefined, mode: 'optional' | 'raw'): Built {
	if (!range) {
		if (mode === 'raw') return { sql: `${column} >= datetime('now', ?)`, binds: ['-90 days'] };
		return { sql: '', binds: [] };
	}
	if ('preset' in range) {
		if (range.preset === 'all') {
			if (mode === 'raw') return { sql: `${column} >= ?`, binds: ['1970-01-01 00:00:00'] };
			return { sql: '', binds: [] };
		}
		const modifier = presetModifier(range.preset);
		return { sql: `${column} >= datetime('now', ?)`, binds: [modifier ?? '-90 days'] };
	}
	return { sql: `${column} >= ? AND ${column} <= ?`, binds: [range.from, range.to] };
}

/** Monday of the UTC week. `strftime('%w')` is 0 Sunday … 6 Saturday, with no localtime. */
export function utcWeekSql(expr: string): string {
	const w = `CAST(strftime('%w', ${expr}) AS INTEGER)`;
	return `CASE ${w}
		WHEN 0 THEN date(${expr}, '-6 days')
		WHEN 1 THEN date(${expr})
		WHEN 2 THEN date(${expr}, '-1 days')
		WHEN 3 THEN date(${expr}, '-2 days')
		WHEN 4 THEN date(${expr}, '-3 days')
		WHEN 5 THEN date(${expr}, '-4 days')
		WHEN 6 THEN date(${expr}, '-5 days')
	END`;
}

export function utcMonthSql(expr: string): string {
	return `strftime('%Y-%m', ${expr})`;
}

export function isProxyEvent(row: Record<string, unknown>): boolean {
	let detail: unknown = {};
	if (typeof row.detail === 'string' && row.detail) {
		try {
			detail = JSON.parse(row.detail);
		} catch {
			detail = {};
		}
	}
	return classifyProxyOpen(detail, row.delivered_at == null ? null : String(row.delivered_at), String(row.recorded_at ?? ''));
}

function storedRatePct(value: unknown): number | null {
	if (value == null) return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return reportPct(Math.round(n * 10000), 10000);
}

function medianPct(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const raw = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
	return storedRatePct(raw);
}

function jsonPath(key: string): string {
	return `$."${key}"`;
}

function likeContains(value: string): string {
	return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function aliasFor(key: string, index = 0): string {
	const safe = key.replace(/[^A-Za-z0-9_]/g, '_');
	return `m_${safe}_${index}`;
}

/** A column key that is safe to paste as a SQL alias. Rejects anything else. */
function sqlIdent(key: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ReportError(`Unknown column "${key}".`);
	return key;
}

function renameGroup(row: Record<string, unknown>, groupBy: string | undefined): Record<string, unknown> {
	if (!groupBy || !('g' in row)) return { ...row };
	const out = { ...row, [groupBy]: row.g ?? '' };
	delete out.g;
	return out;
}

function asBind(value: unknown): Bind {
	if (typeof value === 'number' || typeof value === 'string') return value;
	if (value == null) return null;
	return String(value);
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

async function queryAll(db: D1Database, sql: string, binds: Bind[]): Promise<Record<string, unknown>[]> {
	const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
	const res = await stmt.all<Record<string, unknown>>();
	return res.results ?? [];
}

async function queryFirst(db: D1Database, sql: string, binds: Bind[]): Promise<Record<string, unknown> | null> {
	const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
	return stmt.first<Record<string, unknown>>();
}

async function scalarCount(db: D1Database, sql: string, binds: Bind[]): Promise<number> {
	const row = await queryFirst(db, sql, binds);
	return num(row?.n);
}

async function countGrouped(
	db: D1Database,
	from: string,
	where: Built,
	grouped: boolean,
	groupExpr?: string | null,
	groupBinds: Bind[] = []
): Promise<number> {
	if (!grouped) return scalarCount(db, `SELECT COUNT(*) AS n FROM (SELECT 1 ${from} WHERE ${where.sql}) q`, where.binds);
	if (!groupExpr) throw new ReportError('Missing group.');
	const inner = `SELECT ${groupExpr} AS g ${from} WHERE ${where.sql} GROUP BY g`;
	return scalarCount(db, `SELECT COUNT(*) AS n FROM (${inner}) q`, [...groupBinds, ...where.binds]);
}
