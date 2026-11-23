// Reports (#354): the declarative spec shared by the engine and (later) the builder.
// One parser, `parseReportSpec`, is the only way in — unknown entities, columns,
// operators and keys are rejected, and every limit/time value is normalised here.

import { metricDef as anyMetricDef, opsFor, visibleMetrics, type MetricKind } from '$lib/company-metrics';
import { isTier } from '$lib/engagement-view';
import {
	findMetric,
	isFieldColumn,
	isSensitiveKey,
	zohoReportsEnabled,
	type MetricFormat,
	type ReportEntity
} from '$lib/report-metrics';

export type { ReportEntity } from '$lib/report-metrics';

// #445: the billing company metrics stay out of reports (zohoReportsEnabled() is off), so the
// spec only knows the Timing + GitHub ones.
const REPORT_COMPANY_METRICS = visibleMetrics(false);
function metricDef(key: string) {
	const def = anyMetricDef(key);
	return def && def.group !== 'billing' ? def : undefined;
}

export const REPORT_ENTITIES: readonly ReportEntity[] = [
	'contacts',
	'companies',
	'campaigns',
	'segments',
	'pipeline',
	'site_pages'
];

export type ReportFilterRule = {
	field: string;
	op: string;
	value?: string;
	value2?: string;
};

/** Same shape as the dynamic-segment `SegmentRules` (segment-query.ts). */
export type ReportFilters = {
	match: 'all' | 'any';
	rules: ReportFilterRule[];
};

export type EntityFilter = {
	field: string;
	op: string;
	value?: string;
	value2?: string;
};

export type TimePreset = '7d' | '30d' | '90d' | '12m' | 'all';

export type TimeRange = { preset: TimePreset } | { from: string; to: string };

export type ReportSort = { key: string; dir: 'asc' | 'desc' };

/** `heatmap` (#454) is a built-in-only kind (weekday × hour); the builder doesn't offer it. */
export type ReportChart = 'table' | 'bar' | 'line' | 'stat' | 'heatmap';

export type ReportThresholds = { minSent?: number };

export type ReportSpec = {
	entity: ReportEntity;
	filters: ReportFilters;
	entityFilters?: EntityFilter[];
	columns: string[];
	groupBy?: string;
	timeRange?: TimeRange;
	sort?: ReportSort;
	/** Always set. Default 100, never above {@link MAX_REPORT_LIMIT}. */
	limit: number;
	chart?: ReportChart;
	thresholds?: ReportThresholds;
};

export type ReportViewer = { role: 'admin' | 'member' };

export const DEFAULT_REPORT_LIMIT = 100;
export const MAX_REPORT_LIMIT = 5000;

export class ReportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReportError';
	}
}

/**
 * Hours (including `last_tracked_at`, derived from tracked time), billing
 * (including Zoho money fields) and pipeline value.
 * Company-metric filters name the metric in `value2`, so a key is admin-only
 * even when it isn't a column of `entity` (contacts filtered by `hours_30d`).
 */
export function isAdminOnlyField(entity: ReportEntity, key: string): boolean {
	if (isSensitiveKey(entity, key)) return true;
	return (
		key === 'pipeline_value' ||
		key === 'last_tracked_at' ||
		key.startsWith('hours_') ||
		key.startsWith('zoho_')
	);
}

/** Every admin-only key a spec mentions: columns, sort, group, filters and rules. */
export function adminOnlyKeys(spec: ReportSpec): string[] {
	const blocked: string[] = [];
	const note = (key: string | undefined) => {
		if (key && isAdminOnlyField(spec.entity, key)) blocked.push(key);
	};
	for (const key of spec.columns) note(key);
	note(spec.sort?.key);
	note(spec.groupBy);
	for (const filter of spec.entityFilters ?? []) {
		note(filter.field);
		if (filter.field === 'company_metric') note(filter.value2);
	}
	for (const rule of spec.filters.rules) {
		note(rule.field);
		if (rule.field === 'company_metric') note(rule.value2);
	}
	return [...new Set(blocked)];
}

export function adminOnlyMessage(keys: string[]): string {
	return `Admins only: ${keys.join(', ')}. Hours, billing and pipeline value aren't available to members.`;
}

const TOP_KEYS = new Set([
	'entity',
	'filters',
	'entityFilters',
	'columns',
	'groupBy',
	'timeRange',
	'sort',
	'limit',
	'chart',
	'thresholds'
]);

/** Operators `compileRule` actually honours, made explicit so a typo is an error.
 *  `company_metric` is checked separately (its ops come from the metric, `opsFor`).
 *  Exported for the natural-language builder's catalog (#389). */
export const RULE_OPS: Record<string, readonly string[]> = {
	tag: ['is', 'not'],
	list: ['in', 'not'],
	subscribed: ['yes', 'no'],
	source: ['is', 'contains'],
	company: ['is', 'exists'],
	company_id: ['is', 'exists', 'missing'],
	engagement_tier: ['is', 'not'],
	last_open_within_days: ['within', 'not'],
	opens_last_90d: ['gte', 'gt', 'lte', 'lt', 'eq'],
	never_opened: ['yes', 'no'],
	pipeline_stage: ['is', 'not', 'any', 'none'],
	bounced: ['hard', 'any', 'none'],
	spam_complaint: ['yes', 'no'],
	opened: ['within', 'not'],
	clicked: ['within', 'not'],
	created: ['within', 'before', 'after'],
	visited: ['contains', 'not'],
	event: ['is', 'not'],
	field: ['exists', 'missing', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
	// #448
	field_contains: ['contains', 'not'],
	topic: ['out', 'in']
};

const GROUP_BY_ENTITY: Record<ReportEntity, readonly string[]> = {
	contacts: ['tag', 'list', 'source', 'company', 'engagement_tier', 'pipeline_stage', 'week', 'month'],
	companies: [],
	campaigns: ['campaign', 'week', 'month'],
	segments: [],
	pipeline: ['pipeline_stage', 'week', 'month'],
	site_pages: ['path', 'country', 'referrer_host', 'utm_source', 'utm_campaign', 'week', 'month']
};

/** Group-by keys the parser accepts for an entity (custom `field:` keys are extra, contacts only). */
export function groupByOptions(entity: ReportEntity): readonly string[] {
	return GROUP_BY_ENTITY[entity];
}

export const REPORT_CHARTS: readonly ReportChart[] = ['table', 'bar', 'line', 'stat'];
const CHARTS: readonly ReportChart[] = [...REPORT_CHARTS, 'heatmap'];
export const TIME_PRESETS: readonly TimePreset[] = ['7d', '30d', '90d', '12m', 'all'];
const PRESETS = TIME_PRESETS;

const CAMPAIGN_STATUSES = ['draft', 'sending', 'sent', 'failed', 'scheduled', 'canceled'] as const;
const CAMPAIGN_KINDS = ['campaign', 'automation', 'direct'] as const;
const LIST_KINDS = ['list', 'segment', 'tag', 'company'] as const;
const STAGE_KINDS = ['open', 'won', 'lost'] as const;

/** What an entity filter's `value` holds. `id` names a record of `ref`. */
export type EntityFilterValue = 'none' | 'id' | 'number' | 'text' | 'date' | 'tier' | readonly string[];

export type EntityFilterDef = {
	field: string;
	/** `metric` = the ops of the company metric (`opsFor`): the field itself, or `value2`. */
	ops: readonly string[] | 'metric';
	value: EntityFilterValue;
	ref?: 'stages' | 'lists' | 'sites';
	/** `company_metric` filters name the metric in `value2`. */
	value2?: 'company_metric';
};

/**
 * Every entity filter `parseEntityFilter` accepts (#389). The parser refuses a field / op
 * that isn't listed here before its own checks, so this table is never smaller than what
 * the engine takes; the natural-language catalog is generated from it.
 */
export const ENTITY_FILTERS: Record<ReportEntity, readonly EntityFilterDef[]> = {
	contacts: [
		{ field: 'pipeline', ops: ['any', 'none'], value: 'none' },
		{ field: 'pipeline', ops: ['is', 'not'], value: 'id', ref: 'stages' },
		{ field: 'bounced', ops: ['hard', 'any', 'none'], value: 'none' },
		{ field: 'spam', ops: ['yes', 'no'], value: 'none' },
		{ field: 'tier', ops: ['is', 'not'], value: 'tier' },
		{ field: 'company_metric', ops: 'metric', value: 'number', value2: 'company_metric' }
	],
	companies: [
		{ field: 'name', ops: ['is', 'contains'], value: 'text' },
		...REPORT_COMPANY_METRICS.map((metric): EntityFilterDef => ({ field: metric.key, ops: 'metric', value: 'number' }))
	],
	campaigns: [
		{ field: 'status', ops: ['is'], value: CAMPAIGN_STATUSES },
		{ field: 'kind', ops: ['is'], value: CAMPAIGN_KINDS },
		{ field: 'audience', ops: ['is'], value: 'id', ref: 'lists' },
		{ field: 'sent_at', ops: ['before', 'after'], value: 'date' },
		{ field: 'sent_at', ops: ['within'], value: 'number' }
	],
	segments: [{ field: 'kind', ops: ['is'], value: LIST_KINDS }],
	pipeline: [
		{ field: 'stage', ops: ['is'], value: 'id', ref: 'stages' },
		{ field: 'kind', ops: ['is'], value: STAGE_KINDS }
	],
	site_pages: [
		{ field: 'path', ops: ['contains'], value: 'text' },
		{ field: 'country', ops: ['is'], value: 'text' },
		{ field: 'site', ops: ['is'], value: 'id', ref: 'sites' }
	]
};

function listedEntityFilter(entity: ReportEntity, field: string, op: string): boolean {
	return ENTITY_FILTERS[entity].some((def) => def.field === field && (def.ops === 'metric' || def.ops.includes(op)));
}

/** Custom-field keys that can be a column (`field:<key>`) or a group. No quotes, no `$`. */
export function validFieldKey(key: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(key);
}

export function fieldColumnKey(key: string): string | null {
	if (!key.startsWith('field:')) return null;
	const name = key.slice('field:'.length);
	return validFieldKey(name) ? name : null;
}

export function groupLabel(groupBy: string): string {
	switch (groupBy) {
		case 'tag':
			return 'Tag';
		case 'list':
			return 'List';
		case 'source':
			return 'Source';
		case 'company':
			return 'Company';
		case 'engagement_tier':
			return 'Engagement tier';
		case 'pipeline_stage':
			return 'Pipeline stage';
		case 'campaign':
			return 'Campaign';
		case 'week':
			return 'Week';
		case 'month':
			return 'Month';
		case 'country':
			return 'Country';
		case 'referrer_host':
			return 'Referrer';
		case 'utm_source':
			return 'UTM source';
		case 'utm_campaign':
			return 'UTM campaign';
		case 'path':
			return 'Path';
		default: {
			const field = fieldColumnKey(groupBy);
			if (field) return field;
			return groupBy;
		}
	}
}

/** Monday (UTC) of the week containing `value`, as `YYYY-MM-DD`. */
export function utcWeekStart(value: string): string | null {
	const ms = utcMs(value);
	if (ms == null) return null;
	const d = new Date(ms);
	const sinceMonday = (d.getUTCDay() + 6) % 7;
	d.setUTCDate(d.getUTCDate() - sinceMonday);
	return d.toISOString().slice(0, 10);
}

/** `YYYY-MM` in UTC. */
export function utcMonth(value: string): string | null {
	const ms = utcMs(value);
	if (ms == null) return null;
	const d = new Date(ms);
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	return `${d.getUTCFullYear()}-${month}`;
}

/** SQLite modifier for a preset, or null for `all`. */
export function presetModifier(preset: TimePreset): string | null {
	switch (preset) {
		case '7d':
			return '-7 days';
		case '30d':
			return '-30 days';
		case '90d':
			return '-90 days';
		case '12m':
			return '-12 months';
		case 'all':
			return null;
		default: {
			const never: never = preset;
			return never;
		}
	}
}

export function isReportEntity(v: string): v is ReportEntity {
	return (REPORT_ENTITIES as readonly string[]).includes(v);
}

/**
 * Validate and normalise a report spec. Idempotent: a spec that already came
 * out of here parses to the same value. Throws {@link ReportError} on anything
 * that isn't in the whitelist.
 */
export function parseReportSpec(input: unknown): ReportSpec {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new ReportError('Report spec must be an object.');
	}
	const raw = input as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!TOP_KEYS.has(key)) throw new ReportError(`Unknown key "${key}".`);
	}

	if (typeof raw.entity !== 'string' || !isReportEntity(raw.entity)) {
		throw new ReportError(`Unknown entity "${String(raw.entity ?? '')}".`);
	}
	const entity: ReportEntity = raw.entity;
	const filters = parseFilters(raw.filters);
	const entityFilters = parseEntityFilters(entity, raw.entityFilters);
	const columns = parseColumns(entity, raw.columns);
	const groupBy = parseGroupBy(entity, raw.groupBy);
	const timeRange = parseTimeRange(raw.timeRange);
	const limit = parseLimit(raw.limit);
	const chart = parseChart(raw.chart);
	const thresholds = parseThresholds(raw.thresholds);
	const sort = parseSort(entity, columns, groupBy, raw.sort);

	const spec: ReportSpec = { entity, filters, columns, limit };
	if (entityFilters.length) spec.entityFilters = entityFilters;
	if (groupBy) spec.groupBy = groupBy;
	if (timeRange) spec.timeRange = timeRange;
	if (sort) spec.sort = sort;
	if (chart) spec.chart = chart;
	if (thresholds) spec.thresholds = thresholds;
	return spec;
}

/** A column the catalog knows about, or a `field:<key>` custom field on contacts. */
export function columnFormat(entity: ReportEntity, key: string): MetricFormat {
	const metric = findMetric(entity, key);
	if (metric) return metric.format;
	if (entity === 'contacts' && fieldColumnKey(key)) return 'text';
	throw new ReportError(`Unknown column "${key}" for ${entity}.`);
}

function parseFilters(value: unknown): ReportFilters {
	if (value == null) return { match: 'all', rules: [] };
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ReportError('filters must be an object.');
	}
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== 'match' && key !== 'rules') throw new ReportError(`Unknown key "filters.${key}".`);
	}
	if (raw.match != null && raw.match !== 'all' && raw.match !== 'any') {
		throw new ReportError(`Unknown filter match "${String(raw.match)}".`);
	}
	if (!Array.isArray(raw.rules)) throw new ReportError('filters.rules must be a list.');
	return {
		match: raw.match === 'any' ? 'any' : 'all',
		rules: raw.rules.map((rule, i) => parseRule(rule, i))
	};
}

function parseRule(value: unknown, index: number): ReportFilterRule {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ReportError(`filters.rules[${index}] must be an object.`);
	}
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== 'field' && key !== 'op' && key !== 'value' && key !== 'value2') {
			throw new ReportError(`Unknown key "filters.rules[${index}].${key}".`);
		}
	}
	const field = requiredString(raw.field, `filters.rules[${index}].field`);
	const op = requiredString(raw.op, `filters.rules[${index}].op`);
	const ruleValue = optionalScalar(raw.value);
	const value2 = optionalScalar(raw.value2);

	if (field === 'company_metric') {
		const metric = (value2 ?? '').trim();
		const def = metricDef(metric);
		if (!def) throw new ReportError(`Unknown company metric "${metric}".`);
		if (!opsFor(metric).some((item) => item.op === op)) {
			throw new ReportError(`Unknown operator "${op}" for company_metric.`);
		}
		requireNumber(ruleValue, 'company_metric');
		return { field, op, value: ruleValue, value2: metric };
	}

	const allowed = RULE_OPS[field];
	if (!allowed) throw new ReportError(`Unknown field "${field}".`);
	if (!allowed.includes(op)) throw new ReportError(`Unknown operator "${op}" for ${field}.`);

	if (field === 'engagement_tier' && !isTier(ruleValue)) {
		throw new ReportError(`Unknown engagement tier "${ruleValue ?? ''}".`);
	}
	if (field === 'field') {
		const name = (value2 ?? '').trim();
		if (!validFieldKey(name)) throw new ReportError(`Unknown custom field "${name}".`);
	}
	if (field === 'list' || field === 'topic' || (field === 'company_id' && op === 'is') || (field === 'pipeline_stage' && (op === 'is' || op === 'not'))) {
		requirePositiveInt(ruleValue, field);
	}
	if (needsValue(field, op) && !ruleValue?.trim()) {
		throw new ReportError(`Missing value for ${field}.`);
	}
	const rule: ReportFilterRule = { field, op };
	if (ruleValue != null) rule.value = ruleValue;
	if (value2 != null) rule.value2 = value2;
	return rule;
}

function needsValue(field: string, op: string): boolean {
	if (op === 'exists' || op === 'missing' || op === 'any' || op === 'none' || op === 'yes' || op === 'no') {
		return false;
	}
	if (field === 'bounced' || field === 'subscribed' || field === 'never_opened' || field === 'spam_complaint') {
		return false;
	}
	return true;
}

function parseEntityFilters(entity: ReportEntity, value: unknown): EntityFilter[] {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new ReportError('entityFilters must be a list.');
	return value.map((item, i) => parseEntityFilter(entity, item, i));
}

function parseEntityFilter(entity: ReportEntity, value: unknown, index: number): EntityFilter {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ReportError(`entityFilters[${index}] must be an object.`);
	}
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== 'field' && key !== 'op' && key !== 'value' && key !== 'value2') {
			throw new ReportError(`Unknown key "entityFilters[${index}].${key}".`);
		}
	}
	const field = requiredString(raw.field, `entityFilters[${index}].field`);
	const op = requiredString(raw.op, `entityFilters[${index}].op`);
	const ruleValue = optionalScalar(raw.value);
	const value2 = optionalScalar(raw.value2);
	assertEntityFilter(entity, field, op, ruleValue, value2);
	const filter: EntityFilter = { field, op };
	if (ruleValue != null) filter.value = ruleValue;
	if (value2 != null) filter.value2 = value2;
	return filter;
}

function assertEntityFilter(
	entity: ReportEntity,
	field: string,
	op: string,
	value: string | undefined,
	value2: string | undefined
): void {
	if (!listedEntityFilter(entity, field, op)) {
		if (entity === 'contacts' || entity === 'companies' || entity === 'campaigns') {
			throw new ReportError(`Unknown filter "${field}" for ${entity}.`);
		}
		throw new ReportError(`Unknown filter "${field}" ${op} for ${entity}.`);
	}
	switch (entity) {
		case 'contacts':
			assertContactEntityFilter(field, op, value, value2);
			return;
		case 'companies':
			assertCompanyEntityFilter(field, op, value);
			return;
		case 'campaigns':
			assertCampaignEntityFilter(field, op, value);
			return;
		case 'pipeline':
			if (field === 'stage' && op === 'is') return requirePositiveInt(value, 'stage');
			if (field === 'kind' && op === 'is' && value && (STAGE_KINDS as readonly string[]).includes(value)) return;
			break;
		case 'site_pages':
			if (field === 'path' && op === 'contains' && value?.trim()) return;
			if (field === 'country' && op === 'is' && value?.trim()) return;
			if (field === 'site' && op === 'is') return requirePositiveInt(value, 'site');
			break;
		case 'segments':
			if (field === 'kind' && op === 'is' && value && (LIST_KINDS as readonly string[]).includes(value)) return;
			break;
		default: {
			const never: never = entity;
			throw new ReportError(`Unknown entity "${String(never)}".`);
		}
	}
	throw new ReportError(`Unknown filter "${field}" ${op} for ${entity}.`);
}

function assertContactEntityFilter(field: string, op: string, value: string | undefined, value2: string | undefined): void {
	if (field === 'pipeline' && (op === 'any' || op === 'none')) return;
	if (field === 'pipeline' && (op === 'is' || op === 'not')) return requirePositiveInt(value, 'pipeline');
	if (field === 'bounced' && (op === 'hard' || op === 'any' || op === 'none')) return;
	if (field === 'spam' && (op === 'yes' || op === 'no')) return;
	if (field === 'tier' && (op === 'is' || op === 'not')) {
		if (!isTier(value)) throw new ReportError(`Unknown engagement tier "${value ?? ''}".`);
		return;
	}
	if (field === 'company_metric') {
		const metric = (value2 ?? '').trim();
		if (!metricDef(metric)) throw new ReportError(`Unknown company metric "${metric}".`);
		if (!opsFor(metric).some((item) => item.op === op)) {
			throw new ReportError(`Unknown operator "${op}" for company_metric.`);
		}
		requireNumber(value, 'company_metric');
		return;
	}
	throw new ReportError(`Unknown filter "${field}" for contacts.`);
}

function assertCompanyEntityFilter(field: string, op: string, value: string | undefined): void {
	if (field === 'name' && (op === 'is' || op === 'contains') && value?.trim()) return;
	const def = metricDef(field);
	if (def && opsFor(field).some((item) => item.op === op)) {
		requireMetricValue(def.kind, value);
		return;
	}
	throw new ReportError(`Unknown filter "${field}" for companies.`);
}

function assertCampaignEntityFilter(field: string, op: string, value: string | undefined): void {
	if (field === 'status' && op === 'is' && value && (CAMPAIGN_STATUSES as readonly string[]).includes(value)) return;
	if (field === 'kind' && op === 'is' && value && (CAMPAIGN_KINDS as readonly string[]).includes(value)) return;
	if (field === 'audience' && op === 'is') return requirePositiveInt(value, 'audience');
	if (field === 'sent_at' && (op === 'before' || op === 'after') && value?.trim()) return;
	if (field === 'sent_at' && op === 'within') return requireNumber(value, 'sent_at');
	throw new ReportError(`Unknown filter "${field}" for campaigns.`);
}

function parseColumns(entity: ReportEntity, value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new ReportError('columns must list at least one metric.');
	const seen = new Set<string>();
	const columns: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !item.trim()) throw new ReportError('Unknown column "".');
		const key = item.trim();
		if (seen.has(key)) throw new ReportError(`Duplicate column "${key}".`);
		seen.add(key);
		const metric = findMetric(entity, key);
		if (metric) {
			if (metric.feature === 'zoho' && !zohoReportsEnabled()) {
				throw new ReportError(`Zoho Books metrics aren't available yet (${key}).`);
			}
		} else if (!(entity === 'contacts' && isFieldColumn(key) && fieldColumnKey(key))) {
			throw new ReportError(`Unknown column "${key}" for ${entity}.`);
		}
		columns.push(key);
	}
	return columns;
}

function parseGroupBy(entity: ReportEntity, value: unknown): string | undefined {
	if (value == null || value === '') return undefined;
	if (typeof value !== 'string') throw new ReportError(`Unknown group "${String(value)}" for ${entity}.`);
	const group = value.trim();
	if (GROUP_BY_ENTITY[entity].includes(group)) return group;
	if (entity === 'contacts' && fieldColumnKey(group)) return group;
	throw new ReportError(`Unknown group "${group}" for ${entity}.`);
}

function parseTimeRange(value: unknown): TimeRange | undefined {
	if (value == null) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReportError('Unknown time range.');
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== 'preset' && key !== 'from' && key !== 'to') throw new ReportError(`Unknown key "timeRange.${key}".`);
	}
	if ('preset' in raw) {
		if (raw.from != null || raw.to != null) throw new ReportError('Time range preset cannot also set from/to.');
		if (typeof raw.preset !== 'string' || !(PRESETS as readonly string[]).includes(raw.preset)) {
			throw new ReportError(`Unknown time range preset "${String(raw.preset ?? '')}".`);
		}
		return { preset: raw.preset as TimePreset };
	}
	if (typeof raw.from !== 'string' || typeof raw.to !== 'string') {
		throw new ReportError('Time range from/to must be UTC dates.');
	}
	const from = normalizeTimestamp(raw.from, 'start');
	const to = normalizeTimestamp(raw.to, 'end');
	if (from > to) throw new ReportError('Time range from is after to.');
	return { from, to };
}

function parseLimit(value: unknown): number {
	if (value == null) return DEFAULT_REPORT_LIMIT;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new ReportError('limit must be a positive integer.');
	}
	return Math.min(value, MAX_REPORT_LIMIT);
}

function parseChart(value: unknown): ReportChart | undefined {
	if (value == null) return undefined;
	if (typeof value !== 'string' || !(CHARTS as readonly string[]).includes(value)) {
		throw new ReportError(`Unknown chart "${String(value)}".`);
	}
	return value as ReportChart;
}

function parseThresholds(value: unknown): ReportThresholds | undefined {
	if (value == null) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReportError('thresholds must be an object.');
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== 'minSent') throw new ReportError(`Unknown threshold "${key}".`);
	}
	if (raw.minSent == null) return undefined;
	if (typeof raw.minSent !== 'number' || !Number.isInteger(raw.minSent) || raw.minSent < 0) {
		throw new ReportError('minSent must be a whole number of zero or more.');
	}
	return { minSent: raw.minSent };
}

function parseSort(entity: ReportEntity, columns: string[], groupBy: string | undefined, value: unknown): ReportSort | undefined {
	if (value == null) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReportError('sort must be an object.');
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== 'key' && key !== 'dir') throw new ReportError(`Unknown key "sort.${key}".`);
	}
	const key = requiredString(raw.key, 'sort.key');
	if (raw.dir !== 'asc' && raw.dir !== 'desc') throw new ReportError(`Unknown sort direction "${String(raw.dir ?? '')}".`);
	const known = key === groupBy || columns.includes(key) || !!findMetric(entity, key) || !!fieldColumnKey(key);
	if (!known) throw new ReportError(`Unknown sort key "${key}".`);
	return { key, dir: raw.dir };
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new ReportError(`${label} is required.`);
	return value.trim();
}

function optionalScalar(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value !== 'string') throw new ReportError('Filter values must be text or numbers.');
	return value;
}

function requirePositiveInt(value: string | undefined, label: string): void {
	const n = Number(value);
	if (!value || !Number.isInteger(n) || n <= 0) throw new ReportError(`${label} must be a positive id.`);
}

function requireNumber(value: string | undefined, label: string): void {
	if (value == null || value.trim() === '' || !Number.isFinite(Number(value))) {
		throw new ReportError(`${label} needs a number.`);
	}
}

function requireMetricValue(kind: MetricKind, value: string | undefined): void {
	requireNumber(value, kind === 'date' ? 'days' : 'value');
}

function normalizeTimestamp(raw: string, bound: 'start' | 'end'): string {
	const s = raw.trim();
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (day) {
		assertRealUtcDate(+day[1], +day[2], +day[3]);
		return bound === 'start' ? `${day[1]}-${day[2]}-${day[3]} 00:00:00` : `${day[1]}-${day[2]}-${day[3]} 23:59:59`;
	}
	const dt = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
	if (!dt) throw new ReportError('Time range from/to must be UTC dates.');
	assertRealUtcDate(+dt[1], +dt[2], +dt[3]);
	const hour = +dt[4];
	const minute = +dt[5];
	const second = +dt[6];
	if (hour > 23 || minute > 59 || second > 59) throw new ReportError('Time range from/to must be UTC dates.');
	if (dt[7]) {
		const ms = Date.parse(s.includes(' ') ? s.replace(' ', 'T') : s);
		if (Number.isNaN(ms)) throw new ReportError('Time range from/to must be UTC dates.');
		return sqliteUtc(ms);
	}
	return `${dt[1]}-${dt[2]}-${dt[3]} ${dt[4]}:${dt[5]}:${dt[6]}`;
}

function assertRealUtcDate(year: number, month: number, date: number): void {
	const ms = Date.UTC(year, month - 1, date);
	const d = new Date(ms);
	if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== date) {
		throw new ReportError('Time range from/to must be UTC dates.');
	}
}

function sqliteUtc(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Parse a stored UTC timestamp (`YYYY-MM-DD HH:MM:SS` or ISO) to epoch ms. */
function utcMs(value: string): number | null {
	const s = value.trim();
	if (!s) return null;
	const normalized = s.includes('T') ? s : s.replace(' ', 'T');
	const withZone = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
	const ms = Date.parse(withZone);
	return Number.isNaN(ms) ? null : ms;
}
