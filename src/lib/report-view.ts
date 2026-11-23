// Reports UI (#355): labels, column catalog, CSV, and the shareable-spec encoding.
// Universal — the builder imports it. The engine stays the only thing that runs SQL.

import { visibleMetrics, type CompanyMetricDef } from '$lib/company-metrics';
import {
	findMetric,
	metricsFor,
	zohoReportsEnabled,
	type MetricFormat,
	type ReportEntity
} from '$lib/report-metrics';
import {
	adminOnlyKeys,
	fieldColumnKey,
	groupByOptions,
	groupLabel,
	parseReportSpec,
	ReportError,
	type ReportChart,
	type ReportFilterRule,
	type ReportFilters,
	type ReportSpec,
	type ReportViewer,
	type TimePreset
} from '$lib/report-spec';
import type { SegmentRules } from '$lib/server/segment-query';

type CsvColumn = { key: string; label: string; format: MetricFormat };

export const REPORT_FOLDERS = [
	'Email',
	'Contacts',
	'Site',
	'Segments',
	'Pipeline',
	'Clients & integrations'
] as const;

export type ReportFolder = (typeof REPORT_FOLDERS)[number];

export const ENTITY_LABELS: Record<ReportEntity, string> = {
	contacts: 'Contacts',
	companies: 'Companies',
	campaigns: 'Campaigns',
	segments: 'Segments',
	pipeline: 'Pipeline',
	site_pages: 'Site pages'
};

export const ENTITY_ORDER: readonly ReportEntity[] = [
	'contacts',
	'companies',
	'campaigns',
	'segments',
	'pipeline',
	'site_pages'
];

const TIME_PRESET_LABELS: Record<TimePreset, string> = {
	'7d': 'Last 7 days',
	'30d': 'Last 30 days',
	'90d': 'Last 90 days',
	'12m': 'Last 12 months',
	all: 'All time'
};

export const TIME_PRESET_OPTIONS: { id: TimePreset; label: string }[] = (
	['7d', '30d', '90d', '12m', 'all'] as const
).map((id) => ({ id, label: TIME_PRESET_LABELS[id] }));

export const CHART_OPTIONS: { id: ReportChart; label: string }[] = [
	{ id: 'table', label: 'Table' },
	{ id: 'bar', label: 'Bar chart' },
	{ id: 'line', label: 'Line chart' },
	{ id: 'stat', label: 'Summary numbers' }
];

export const LIMIT_OPTIONS = [25, 50, 100, 250, 500] as const;

const COLUMN_GROUPS: Record<ReportEntity, { label: string; keys: string[] }[]> = {
	contacts: [
		{ label: 'Contact', keys: ['email', 'name', 'created', 'source', 'tags', 'lists', 'contacts'] },
		{ label: 'Sending', keys: ['sent', 'delivered'] },
		{
			label: 'Engagement',
			keys: [
				'opens',
				'unique_opens',
				'clicks',
				'replies',
				'open_rate',
				'click_rate',
				'last_open',
				'last_click',
				'last_reply',
				'days_since_engagement',
				'engagement_score',
				'engagement_tier'
			]
		},
		{ label: 'Site', keys: ['site_visits', 'last_site_visit'] },
		{ label: 'Pipeline', keys: ['pipeline_stage', 'pipeline_value'] }
	],
	companies: [
		{ label: 'Company', keys: ['name', 'contact_count'] },
		{ label: 'Engagement', keys: ['avg_open_rate', 'median_open_rate', 'opens', 'clicks'] },
		{ label: 'Timing', keys: ['hours_7d', 'hours_30d', 'hours_90d', 'hours_total'] },
		{
			label: 'GitHub',
			keys: ['issues_open', 'issues_closed', 'issues_opened_30d', 'issues_closed_30d', 'last_issue_at']
		},
		{ label: 'Pipeline', keys: ['pipeline_value'] },
		{ label: 'Billing', keys: ['zoho_ar', 'zoho_invoiced', 'zoho_paid'] }
	],
	campaigns: [
		{ label: 'Campaign', keys: ['subject', 'sent_at', 'audience', 'kind'] },
		{ label: 'Delivery', keys: ['recipients', 'delivered', 'bounces', 'bounce_rate', 'spam'] },
		{
			label: 'Engagement',
			keys: ['opens', 'open_rate', 'clicks', 'click_rate', 'ctor', 'unsubs', 'unsub_rate', 'replies']
		}
	],
	segments: [
		{ label: 'Segment', keys: ['name', 'member_count', 'subscribed_count'] },
		{ label: 'Engagement', keys: ['avg_open_rate', 'avg_click_rate', 'campaigns_sent', 'campaign_open_rate'] }
	],
	pipeline: [
		{ label: 'Pipeline', keys: ['pipeline_stage', 'cards', 'pipeline_value', 'avg_days_in_stage', 'moves', 'won', 'lost'] }
	],
	site_pages: [{ label: 'Pages', keys: ['path', 'views', 'unique_contacts'] }]
};

export type ColumnChoice = {
	key: string;
	label: string;
	definition: string;
	format: MetricFormat;
	group: string;
};

/** Columns the builder may offer. Sensitive metrics are admins only; Zoho stays off. */
export function columnsFor(entity: ReportEntity, role: ReportViewer['role']): ColumnChoice[] {
	const groupOf = new Map<string, string>();
	for (const group of COLUMN_GROUPS[entity]) {
		for (const key of group.keys) groupOf.set(key, group.label);
	}
	return metricsFor(entity)
		.filter((metric) => metricOffered(entity, metric.key, role))
		.map((metric) => ({
			key: metric.key,
			label: metric.label,
			definition: metric.definition,
			format: metric.format,
			group: groupOf.get(metric.key) ?? 'Other'
		}));
}

export function columnGroups(entity: ReportEntity, role: ReportViewer['role']): { label: string; columns: ColumnChoice[] }[] {
	const order: string[] = [];
	const map = new Map<string, ColumnChoice[]>();
	for (const column of columnsFor(entity, role)) {
		if (!map.has(column.group)) {
			map.set(column.group, []);
			order.push(column.group);
		}
		map.get(column.group)!.push(column);
	}
	return order.map((label) => ({ label, columns: map.get(label)! }));
}

export function metricOffered(entity: ReportEntity, key: string, role: ReportViewer['role']): boolean {
	const metric = findMetric(entity, key);
	if (!metric) return entity === 'contacts' && fieldColumnKey(key) != null;
	if (metric.feature === 'zoho' && !zohoReportsEnabled()) return false;
	if (metric.sensitive && role !== 'admin') return false;
	return true;
}

/** Company-metric filter choices. Hours are the sensitive Timing metrics. */
export function companyMetricsFor(role: ReportViewer['role']): CompanyMetricDef[] {
	// #445: billing metrics never reach reports.
	return visibleMetrics(false).filter((metric) => role === 'admin' || !metric.key.startsWith('hours_'));
}

export function folderForEntity(entity: ReportEntity): ReportFolder {
	switch (entity) {
		case 'campaigns':
			return 'Email';
		case 'contacts':
			return 'Contacts';
		case 'site_pages':
			return 'Site';
		case 'segments':
			return 'Segments';
		case 'pipeline':
			return 'Pipeline';
		case 'companies':
			return 'Clients & integrations';
		default: {
			const never: never = entity;
			return never;
		}
	}
}

export function isReportFolder(value: string): value is ReportFolder {
	return (REPORT_FOLDERS as readonly string[]).includes(value);
}

export function folderOf(folder: string | null | undefined, entity: ReportEntity): ReportFolder {
	if (folder && isReportFolder(folder)) return folder;
	return folderForEntity(entity);
}

export function defaultSpec(entity: ReportEntity): ReportSpec {
	switch (entity) {
		case 'contacts':
			return parseReportSpec({
				entity,
				filters: { match: 'all', rules: [] },
				columns: ['email', 'name', 'sent', 'opens', 'open_rate'],
				sort: { key: 'email', dir: 'asc' },
				limit: 100,
				chart: 'table',
				timeRange: { preset: '90d' }
			});
		case 'companies':
			return parseReportSpec({
				entity,
				filters: { match: 'all', rules: [] },
				columns: ['name', 'contact_count', 'avg_open_rate'],
				sort: { key: 'name', dir: 'asc' },
				limit: 100,
				chart: 'table'
			});
		case 'campaigns':
			return parseReportSpec({
				entity,
				filters: { match: 'all', rules: [] },
				columns: ['subject', 'recipients', 'open_rate', 'click_rate', 'sent_at'],
				sort: { key: 'sent_at', dir: 'desc' },
				limit: 100,
				chart: 'table',
				timeRange: { preset: '90d' }
			});
		case 'segments':
			return parseReportSpec({
				entity,
				filters: { match: 'all', rules: [] },
				columns: ['name', 'member_count', 'subscribed_count', 'avg_open_rate'],
				sort: { key: 'name', dir: 'asc' },
				limit: 100,
				chart: 'table'
			});
		case 'pipeline':
			return parseReportSpec({
				entity,
				filters: { match: 'all', rules: [] },
				columns: ['cards'],
				groupBy: 'pipeline_stage',
				sort: { key: 'cards', dir: 'desc' },
				limit: 100,
				chart: 'bar'
			});
		case 'site_pages':
			return parseReportSpec({
				entity,
				filters: { match: 'all', rules: [] },
				columns: ['views', 'unique_contacts'],
				groupBy: 'path',
				sort: { key: 'views', dir: 'desc' },
				limit: 100,
				chart: 'bar',
				timeRange: { preset: '30d' }
			});
		default: {
			const never: never = entity;
			return never;
		}
	}
}

export function groupChoices(entity: ReportEntity, fieldKeys: string[]): { value: string; label: string }[] {
	const choices = groupByOptions(entity).map((value) => ({ value, label: groupLabel(value) }));
	if (entity === 'contacts') {
		for (const key of fieldKeys) {
			if (!fieldColumnKey(`field:${key}`)) continue;
			choices.push({ value: `field:${key}`, label: key });
		}
	}
	return choices;
}

/**
 * RuleBuilder's operator names are the segment editor's (`has`, `in`).
 * The report parser only accepts the compileRule names (`is`, `within`, `contains`).
 */
export function filtersToBuilder(filters: ReportFilters): SegmentRules {
	return {
		match: filters.match,
		rules: filters.rules.map((rule) => ({
			field: rule.field,
			op: toBuilderOp(rule.field, rule.op),
			...(rule.value != null ? { value: rule.value } : {}),
			...(rule.value2 != null ? { value2: rule.value2 } : {})
		}))
	};
}

export function filtersFromBuilder(rules: SegmentRules): ReportFilters {
	return {
		match: rules.match === 'any' ? 'any' : 'all',
		rules: rules.rules.map((rule) => {
			const next: ReportFilterRule = { field: rule.field, op: fromBuilderOp(rule.field, rule.op) };
			if (rule.value != null && rule.value !== '') next.value = rule.value;
			if (rule.value2 != null && rule.value2 !== '') next.value2 = rule.value2;
			return next;
		})
	};
}

function toBuilderOp(field: string, op: string): string {
	if (field === 'tag' && op === 'is') return 'has';
	if ((field === 'opened' || field === 'clicked') && op === 'within') return 'in';
	if (field === 'visited' && op === 'contains') return 'in';
	if (field === 'event' && op === 'is') return 'in';
	return op;
}

function fromBuilderOp(field: string, op: string): string {
	if (field === 'tag' && op === 'has') return 'is';
	if ((field === 'opened' || field === 'clicked') && op === 'in') return 'within';
	if (field === 'visited' && op === 'in') return 'contains';
	if (field === 'event' && op === 'in') return 'is';
	return op;
}

/** URL-encoded JSON. `decodeSpec` accepts either this or the already-decoded query value. */
export function encodeSpec(spec: ReportSpec): string {
	return encodeURIComponent(JSON.stringify(spec));
}

export function decodeSpec(raw: string): ReportSpec {
	const text = raw.trim();
	if (!text) throw new ReportError('This report link is empty.');
	let parsed: unknown;
	try {
		parsed = text.startsWith('{') ? JSON.parse(text) : JSON.parse(decodeURIComponent(text));
	} catch {
		throw new ReportError('This report link is incomplete.');
	}
	return parseReportSpec(parsed);
}

export function sameSpec(a: ReportSpec, b: ReportSpec): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

const UTC_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * #456: a stored UTC date-time (`YYYY-MM-DD HH:MM:SS` or ISO) as `YYYY-MM-DD HH:MM` in
 * `tz`. A date-only value, an unknown zone or anything unparseable comes back unchanged.
 */
export function formatDateTime(value: string, tz: string): string {
	const m = UTC_DATETIME_RE.exec(value.trim());
	if (!m) return value;
	const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ? (m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : 'Z'}`;
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return value;
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		}).formatToParts(new Date(ms));
	} catch {
		return value;
	}
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** One cell as the results table shows it. With `tz`, date-time cells read in that zone (#456). */
export function formatCell(value: unknown, format: MetricFormat, tz?: string): string {
	if (value == null || value === '') return '—';
	if (format === 'date' && tz) return formatDateTime(String(value), tz);
	if (format === 'pct') {
		const n = Number(value);
		return Number.isFinite(n) ? `${n}%` : '—';
	}
	if (format === 'currency') {
		const n = Number(value);
		return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
	}
	if (format === 'hours' || format === 'count') {
		const n = Number(value);
		return Number.isFinite(n) ? String(n) : '—';
	}
	return String(value);
}

const FORMULA_LEAD = /^[=+\-@]/;

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * RFC-style CSV cell. A leading = + - @ is prefixed so a spreadsheet won't run it — except
 * a plain number (a negative value is data, not a formula).
 */
export function csvCell(value: unknown): string {
	let text = value == null ? '' : String(value);
	if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
	if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
	return text;
}

/** #456: the CSV header; a rate's unit moves here so its cells stay numbers. */
export function csvHeader(column: CsvColumn): string {
	return column.format === 'pct' ? `${column.label} (%)` : column.label;
}

/** #456: one CSV value. Empty stays empty, numbers stay plain numbers, date-times read in `tz`. */
export function csvValue(value: unknown, format: MetricFormat, tz?: string): string {
	if (value == null || value === '') return '';
	if (format === 'text') return String(value);
	if (format === 'date') return tz ? formatDateTime(String(value), tz) : String(value);
	const n = Number(value);
	return Number.isFinite(n) ? String(n) : '';
}

/** UTF-8 byte-order mark, so Excel opens the file as UTF-8. */
export const CSV_BOM = '﻿';

/** CSV of the results, in column order (#456: BOM, numeric cells, times in `tz`). */
export function reportCsv(columns: CsvColumn[], rows: Record<string, unknown>[], opts: { tz?: string } = {}): string {
	const header = columns.map((column) => csvCell(csvHeader(column))).join(',');
	const body = rows.map((row) => columns.map((column) => csvCell(csvValue(row[column.key], column.format, opts.tz))).join(','));
	return CSV_BOM + [header, ...body].join('\r\n') + '\r\n';
}

export function recordHref(entity: ReportEntity, id: number | null | undefined): string | null {
	if (id == null || !Number.isInteger(id) || id <= 0) return null;
	switch (entity) {
		case 'contacts':
			return `/contacts/${id}`;
		case 'companies':
			return `/companies/${id}`;
		case 'campaigns':
			return `/campaign/${id}`;
		case 'segments':
			return `/lists/${id}`;
		case 'pipeline':
			return `/contacts/${id}`;
		case 'site_pages':
			return null;
		default: {
			const never: never = entity;
			return never;
		}
	}
}

export function numericColumns<T extends { format: MetricFormat }>(columns: T[]): T[] {
	return columns.filter((column) => column.format !== 'text' && column.format !== 'date');
}

export function specMentionsSensitive(spec: ReportSpec): boolean {
	return adminOnlyKeys(spec).length > 0;
}

export function previewLimit(spec: ReportSpec): number {
	const chart = spec.chart ?? 'table';
	if (chart === 'stat') return 1;
	if (chart === 'heatmap') return spec.limit;
	if (chart === 'bar' || chart === 'line') return Math.min(spec.limit, 12);
	return Math.min(spec.limit, 5);
}

// --- chart series (#454) -------------------------------------------------------------
// Pure shaping for ReportChart: which columns become series, the x order, where each
// point sits (by time for week / month / day keys) and which values are gaps. A null
// value is never drawn as 0: lines break there, bars leave an empty "no sends" slot.

export const MAX_CHART_SERIES = 4;

/** Count columns whose 0 means "nothing was sent", so that row's rates are gaps, not 0 %. */
const NO_SENDS_KEYS = ['recipients', 'sent'];

/** Sort keys that are time (the chart reads oldest → newest even when the table doesn't). */
const TIME_KEYS = ['week', 'month', 'day', 'period', 'sent_at', 'created_at'];

export type TimeUnit = 'day' | 'week' | 'month';

type ChartColumn = { key: string; label: string; format: MetricFormat };

type ChartInput = {
	columns: ChartColumn[];
	rows: Record<string, unknown>[];
	chartSeries?: { xKey: string; yKey: string; yKeys?: string[] };
};

export type ChartSeriesView = { key: string; label: string; values: (number | null)[] };

export type ChartView = {
	format: MetricFormat;
	/** x labels, in display order (oldest first for a time axis). */
	labels: string[];
	/** Where each point sits, 0 … slotCount − 1 (time buckets leave unused slots empty). */
	slots: number[];
	slotCount: number;
	time: TimeUnit | null;
	series: ChartSeriesView[];
	/** Per point: the row had nothing sent (its rates are gaps). */
	noSends: boolean[];
};

/** The series columns: `yKeys` when given, else `yKey` and the numeric columns of its format (≤ 4). */
export function chartSeriesKeys(columns: ChartColumn[], yKey: string, yKeys?: string[]): string[] {
	const known = (key: string) => columns.some((column) => column.key === key);
	if (yKeys?.length) return yKeys.filter(known).slice(0, MAX_CHART_SERIES);
	const y = columns.find((column) => column.key === yKey);
	if (!y) return [];
	const rest = numericColumns(columns).filter((column) => column.key !== y.key && column.format === y.format);
	return [y.key, ...rest.map((column) => column.key)].slice(0, MAX_CHART_SERIES);
}

function chartNumber(value: unknown): number | null {
	if (value == null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(value: string): number | null {
	const m = DAY_RE.exec(value);
	if (!m) return null;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/**
 * Time slots for week / month / day keys: `YYYY-MM` → months, `YYYY-MM-DD` → weeks when
 * the key is `week` or every step is a whole number of weeks, else days. Null when any
 * label isn't a date key (the chart then places points by index).
 */
export function timeSlots(labels: string[], xKey = ''): { unit: TimeUnit; index: number[] } | null {
	if (labels.length === 0) return null;
	if (labels.every((label) => MONTH_RE.test(label))) {
		return {
			unit: 'month',
			index: labels.map((label) => {
				const m = MONTH_RE.exec(label)!;
				return Number(m[1]) * 12 + Number(m[2]) - 1;
			})
		};
	}
	const days = labels.map(dayNumber);
	if (days.some((day) => day == null)) return null;
	const known = days as number[];
	const sorted = [...known].sort((a, b) => a - b);
	const weekly = xKey === 'week' || (sorted.length > 1 && sorted.every((day, i) => i === 0 || (day - sorted[i - 1]!) % 7 === 0));
	// Day 0 (1970-01-01) is a Thursday; +3 puts week boundaries on Mondays.
	return { unit: weekly ? 'week' : 'day', index: known.map((day) => (weekly ? Math.floor((day + 3) / 7) : day)) };
}

/**
 * Shape a result for ReportChart. Rows sorted newest first by a time key are reversed so
 * the chart reads oldest → newest; a line with a week / month / day axis is placed by time.
 */
export function chartView(
	result: ChartInput,
	opts: { chart: ReportChart; sort?: { key: string; dir: 'asc' | 'desc' } | null }
): ChartView | null {
	const cs = result.chartSeries;
	if (!cs) return null;
	const keys = chartSeriesKeys(result.columns, cs.yKey, cs.yKeys);
	if (keys.length === 0) return null;
	const first = result.columns.find((column) => column.key === keys[0])!;
	let rows = [...result.rows];
	const sort = opts.sort ?? null;
	const sortColumn = sort ? result.columns.find((column) => column.key === sort.key) : null;
	const byTime = sort != null && (TIME_KEYS.includes(sort.key) || sortColumn?.format === 'date');
	if (byTime && sort.dir === 'desc') rows.reverse();

	const labelOf = (row: Record<string, unknown>) => String(row[cs.xKey] ?? '');
	let time: ChartView['time'] = null;
	let slots = rows.map((_, i) => i);
	let slotCount = rows.length;
	if (opts.chart === 'line') {
		const placed = timeSlots(rows.map(labelOf), cs.xKey);
		if (placed) {
			const order = rows.map((row, i) => ({ row, at: placed.index[i]! })).sort((a, b) => a.at - b.at);
			rows = order.map((item) => item.row);
			const start = order[0]!.at;
			slots = order.map((item) => item.at - start);
			slotCount = (slots[slots.length - 1] ?? 0) + 1;
			time = placed.unit;
		}
	}

	const sendsKey = NO_SENDS_KEYS.find((key) => result.columns.some((column) => column.key === key));
	const noSends = rows.map((row) => sendsKey != null && chartNumber(row[sendsKey]) === 0);
	const series = keys.map((key) => {
		const column = result.columns.find((c) => c.key === key)!;
		return {
			key,
			label: column.label,
			values: rows.map((row, i) => (noSends[i] && column.format === 'pct' ? null : chartNumber(row[key])))
		};
	});
	return { format: first.format, labels: rows.map(labelOf), slots, slotCount, time, series, noSends };
}

/** Runs of consecutive drawable points (a null or an empty time bucket ends a run). */
export function lineSegments(values: (number | null)[], slots: number[]): number[][] {
	const out: number[][] = [];
	let run: number[] = [];
	values.forEach((value, i) => {
		const last = run[run.length - 1];
		const broken = value == null || (last != null && slots[i]! - slots[last]! > 1);
		if (broken && run.length) {
			out.push(run);
			run = [];
		}
		if (value != null) run.push(i);
	});
	if (run.length) out.push(run);
	return out;
}

/** Shorten an axis label without dropping it (a date key becomes MM/DD). */
export function shortLabel(value: string, max = 14): string {
	const text = value || '—';
	const day = DAY_RE.exec(text);
	if (day) return `${day[2]}/${day[3]}`;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// --- heatmap (#454) --------------------------------------------------------------------

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** JS dow (0 = Sunday) from 0–6 or a day name ("Mon", "Monday"). */
export function weekdayIndex(value: unknown): number | null {
	if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 6 ? value : null;
	if (typeof value !== 'string') return null;
	const text = value.trim().toLowerCase();
	if (/^\d$/.test(text)) return weekdayIndex(Number(text));
	const i = WEEKDAY_NAMES.indexOf(text.slice(0, 3));
	return i >= 0 ? i : null;
}

/** 0–23 from a number or "9am" / "12pm" / "14". */
export function hourIndex(value: unknown): number | null {
	if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;
	if (typeof value !== 'string') return null;
	const m = /^\s*(\d{1,2})\s*(am|pm)?\s*$/i.exec(value);
	if (!m) return null;
	let h = Number(m[1]);
	const ampm = m[2]?.toLowerCase();
	if (ampm) {
		if (h < 1 || h > 12) return null;
		h = (h % 12) + (ampm === 'pm' ? 12 : 0);
	}
	return h <= 23 ? h : null;
}

/**
 * The 7 × 24 grid (by JS dow) from rows `{ weekday, hour, count, pct }`. Null when no row
 * has that shape — the report then falls back to its bar chart.
 */
export function heatmapGrid(rows: Record<string, unknown>[]): { grid: number[][]; total: number } | null {
	const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
	let total = 0;
	let seen = false;
	for (const row of rows) {
		const dow = weekdayIndex(row.weekday);
		const hour = hourIndex(row.hour);
		const n = chartNumber(row.count);
		if (dow == null || hour == null || n == null) continue;
		seen = true;
		const cells = grid[dow]!;
		cells[hour] = (cells[hour] ?? 0) + n;
		total += n;
	}
	return seen ? { grid, total } : null;
}
