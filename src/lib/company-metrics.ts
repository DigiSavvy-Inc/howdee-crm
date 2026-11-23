// #170: company metrics (company_metrics, #168/#169) as contact conditions — the shared
// vocabulary for the Contacts filter, segment rules, the automation Condition step and the
// "Company metric crossed" trigger, plus the {{company.*}} merge keys. Universal (no server
// imports) so the rule builder / automation page can use the same labels the server checks.
//
// A condition is `{ metric, op, value }`. Numeric metrics take eq/ne/gt/gte/lt/lte against
// a number; date metrics take `older` ("more than N days ago") / `within` ("in the last N
// days"). A contact with no company — or a company with no value yet — never matches.

import { money } from './money';

export type MetricKind = 'number' | 'date';
/** Where a metric comes from (#445) — pickers group by it; `billing` is Zoho Books (#353). */
export type MetricGroup = 'timing' | 'github' | 'billing';

export type CompanyMetricDef = { key: string; label: string; kind: MetricKind; group: MetricGroup; format?: 'money' };

export const COMPANY_METRICS: CompanyMetricDef[] = [
	{ key: 'hours_7d', label: 'Hours tracked (7 days)', kind: 'number', group: 'timing' },
	{ key: 'hours_30d', label: 'Hours tracked (30 days)', kind: 'number', group: 'timing' },
	{ key: 'hours_90d', label: 'Hours tracked (90 days)', kind: 'number', group: 'timing' },
	{ key: 'hours_total', label: 'Hours tracked (all time)', kind: 'number', group: 'timing' },
	{ key: 'issues_open', label: 'Open issues', kind: 'number', group: 'github' },
	{ key: 'issues_opened_30d', label: 'Issues opened (30 days)', kind: 'number', group: 'github' },
	{ key: 'issues_closed_30d', label: 'Issues closed (30 days)', kind: 'number', group: 'github' },
	{ key: 'issues_closed', label: 'Closed issues (all time)', kind: 'number', group: 'github' },
	{ key: 'last_tracked_at', label: 'Last time tracked', kind: 'date', group: 'timing' },
	{ key: 'last_issue_at', label: 'Last issue activity', kind: 'date', group: 'github' },
	// #445: Zoho Books roll-ups (#353). Hidden in pickers unless the viewer may see billing.
	{ key: 'ar_outstanding', label: 'Outstanding balance', kind: 'number', group: 'billing', format: 'money' },
	{ key: 'ar_overdue', label: 'Overdue balance', kind: 'number', group: 'billing', format: 'money' },
	{ key: 'invoiced_12m', label: 'Invoiced (12 months)', kind: 'number', group: 'billing', format: 'money' },
	{ key: 'paid_12m', label: 'Paid (12 months)', kind: 'number', group: 'billing', format: 'money' },
	{ key: 'last_payment_at', label: 'Last payment', kind: 'date', group: 'billing' },
	{ key: 'last_invoice_at', label: 'Last invoice', kind: 'date', group: 'billing' }
];

export const METRIC_GROUP_LABELS: Record<MetricGroup, string> = { timing: 'Timing', github: 'GitHub', billing: 'Billing' };

/** Shown instead of a billing metric's name to a viewer without billing access (#445). */
export const BILLING_HIDDEN_LABEL = 'Billing metric (admin-only)';

export function isBillingMetric(key: string): boolean {
	return metricDef(key)?.group === 'billing';
}

/** The metrics a picker may offer: without billing access (`canSeeBilling`) the billing group is left out. */
export function visibleMetrics(billing: boolean): CompanyMetricDef[] {
	return billing ? COMPANY_METRICS : COMPANY_METRICS.filter((m) => m.group !== 'billing');
}

/** Options grouped by source, Timing → GitHub → Billing (for `<optgroup>`s). */
export function groupMetrics<T extends { group?: MetricGroup }>(list: T[]): { group: MetricGroup; label: string; metrics: T[] }[] {
	return (Object.keys(METRIC_GROUP_LABELS) as MetricGroup[])
		.map((group) => ({ group, label: METRIC_GROUP_LABELS[group], metrics: list.filter((m) => (m.group ?? 'timing') === group) }))
		.filter((g) => g.metrics.length > 0);
}

export const NUMBER_OPS: { op: string; label: string; sql: string }[] = [
	{ op: 'gt', label: '>', sql: '>' },
	{ op: 'gte', label: '≥', sql: '>=' },
	{ op: 'lt', label: '<', sql: '<' },
	{ op: 'lte', label: '≤', sql: '<=' },
	{ op: 'eq', label: '=', sql: '=' },
	{ op: 'ne', label: '≠', sql: '!=' }
];

export const DATE_OPS: { op: string; label: string }[] = [
	{ op: 'older', label: 'more than N days ago' },
	{ op: 'within', label: 'in the last N days' }
];

export type MetricCondition = { metric: string; op: string; value: number };

export function metricDef(key: string) {
	return COMPANY_METRICS.find((m) => m.key === key);
}

export function opsFor(key: string): { op: string; label: string }[] {
	return metricDef(key)?.kind === 'date' ? DATE_OPS : NUMBER_OPS;
}

/** A whitelisted, well-formed condition — or null (unknown metric/op, non-numeric value). */
export function normalizeCondition(metric: string, op: string, value: unknown): MetricCondition | null {
	const def = metricDef(metric);
	if (!def) return null;
	if (!opsFor(metric).some((o) => o.op === op)) return null;
	const raw = typeof value === 'string' ? value.trim() : value;
	if (raw === '' || raw === null || raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isFinite(n)) return null;
	return { metric, op, value: def.kind === 'date' ? Math.max(0, Math.floor(n)) : n };
}

/** `metric:op:value` — the URL / gate_value encoding of one condition. */
export function encodeCondition(c: MetricCondition): string {
	return `${c.metric}:${c.op}:${c.value}`;
}

export function decodeCondition(s: string): MetricCondition | null {
	const [metric, op, value] = s.trim().split(':');
	return normalizeCondition(metric ?? '', op ?? '', value ?? '');
}

export const MAX_METRIC_CONDITIONS = 5;

/**
 * Filter params → conditions. `cm` is a comma list of `metric:op:value`; `cm_keep` (repeated)
 * and the `cm_metric`/`cm_op`/`cm_value` triple are the Filters popover's kept + new rows.
 * Malformed entries are dropped; duplicates collapse; at most MAX_METRIC_CONDITIONS.
 */
export function parseMetricConditions(src: {
	get(key: string): string | File | null;
	getAll?(key: string): (string | File)[];
}): MetricCondition[] {
	const raw: string[] = [];
	const cm = src.get('cm');
	if (typeof cm === 'string') raw.push(...cm.split(','));
	for (const v of src.getAll?.('cm_keep') ?? []) if (typeof v === 'string') raw.push(v);
	const metric = src.get('cm_metric');
	const op = src.get('cm_op');
	const value = src.get('cm_value');
	if (typeof metric === 'string' && metric && typeof op === 'string' && typeof value === 'string') {
		raw.push(`${metric}:${op}:${value}`);
	}
	const out: MetricCondition[] = [];
	const seen = new Set<string>();
	for (const s of raw.slice(0, 20)) {
		const c = decodeCondition(s);
		if (!c || seen.has(encodeCondition(c))) continue;
		seen.add(encodeCondition(c));
		out.push(c);
		if (out.length >= MAX_METRIC_CONDITIONS) break;
	}
	return out;
}

export function serializeMetricConditions(conds: MetricCondition[]): string {
	return conds.map(encodeCondition).join(',');
}

/** "Open issues > 10", "Last time tracked more than 30 days ago". `billing: false` (#445) hides a
 *  billing metric's name and value behind BILLING_HIDDEN_LABEL. */
export function conditionLabel(c: MetricCondition, opts: { billing?: boolean } = {}): string {
	const def = metricDef(c.metric);
	if (opts.billing === false && def?.group === 'billing') return BILLING_HIDDEN_LABEL;
	const name = def?.label ?? c.metric;
	if (def?.kind === 'date') {
		return c.op === 'older' ? `${name} more than ${c.value} days ago` : `${name} in the last ${c.value} days`;
	}
	const sym = NUMBER_OPS.find((o) => o.op === c.op)?.label ?? c.op;
	return `${name} ${sym} ${c.value}`;
}

// ---- "Company metric crossed" trigger ------------------------------------------------

export type CrossDirection = 'above' | 'below';

/** Numeric metrics only — a date can't "cross" a threshold. */
export const TRIGGER_METRICS = COMPANY_METRICS.filter((m) => m.kind === 'number');

/** "Open issues crosses above 10". */
export function triggerLabel(
	metric: string | null,
	direction: string | null,
	threshold: number | null,
	opts: { billing?: boolean } = {}
): string {
	if (opts.billing === false && isBillingMetric(metric ?? '')) return `${BILLING_HIDDEN_LABEL} crosses a threshold`;
	const name = metricDef(metric ?? '')?.label ?? 'a company metric';
	const dir = direction === 'below' ? 'below' : 'above';
	return `${name} crosses ${dir} ${threshold ?? '?'}`;
}

/** Did the value cross the threshold between two syncs? A missing value on either side is
 *  never a crossing (the first sync after attaching is a baseline). */
export function crossed(
	prev: number | null | undefined,
	cur: number | null | undefined,
	direction: CrossDirection,
	threshold: number
): boolean {
	if (prev === null || prev === undefined || cur === null || cur === undefined) return false;
	return direction === 'above' ? prev <= threshold && cur > threshold : prev >= threshold && cur < threshold;
}

// ---- {{company.*}} merge tags -----------------------------------------------------------

export const COMPANY_MERGE_KEYS = [
	'name',
	'domain',
	'website',
	'hours_7d',
	'hours_30d',
	'hours_90d',
	'hours_total',
	'last_tracked_at',
	'last_tracked_title',
	'issues_open',
	'issues_closed',
	'issues_opened_30d',
	'issues_closed_30d',
	'last_issue_at',
	// #445: Zoho Books roll-ups — money in the company's billing currency, blank when unset.
	'ar_outstanding',
	'ar_overdue',
	'invoiced_12m',
	'paid_12m',
	'last_payment_at',
	'last_invoice_at'
] as const;

/** Display form of a stored value: hours to ≤1 decimal, timestamps to YYYY-MM-DD, money (#445)
 *  in `currency` (the company's `billing_currency`). */
export function formatMergeValue(key: string, v: unknown, currency?: string | null): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'number' && metricDef(key)?.format === 'money') return money(v, currency);
	if (typeof v === 'number') return String(Math.round(v * 10) / 10);
	const s = String(v).trim();
	if (key.endsWith('_at')) return s.slice(0, 10);
	return s;
}
