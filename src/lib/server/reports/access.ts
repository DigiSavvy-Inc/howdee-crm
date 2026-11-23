// Reports 5/5 (#358): one read path for reports outside the /reports pages — the
// assistant's report tools and GET/POST /api/v1/reports. Lists built-in + saved reports,
// runs one by reference (`builtin:<key>` or a saved id) or an ad-hoc spec, and describes
// the metric catalog. Every run goes through the engine / built-in runner with the
// caller's viewer, so hours, billing and pipeline value stay admin-only here too.

import { folderOf, metricOffered, specMentionsSensitive } from '$lib/report-view';
import { metricsFor } from '$lib/report-metrics';
import {
	adminOnlyMessage,
	DEFAULT_REPORT_LIMIT,
	groupByOptions,
	isAdminOnlyField,
	MAX_REPORT_LIMIT,
	parseReportSpec,
	REPORT_ENTITIES,
	ReportError,
	RULE_OPS,
	type ReportChart,
	type ReportEntity,
	type ReportViewer
} from '$lib/report-spec';
import {
	BUILT_IN_REPORTS,
	builtInByKey,
	builtInVisible,
	resolveParams,
	runBuiltIn,
	type BuiltInParam
} from '$lib/server/reports/builtins';
import { runReport, type ReportResult } from '$lib/server/reports/engine';
import { getReport, listReports } from '$lib/server/reports/store';

export type ReportRef = { kind: 'builtin'; key: string } | { kind: 'saved'; id: number };

/** `builtin:<key>` (or `b:<key>`) or a saved report's numeric id. */
export function parseReportRef(raw: unknown): ReportRef | null {
	const s = String(raw ?? '').trim();
	const builtin = /^(?:builtin|b):([a-z0-9][a-z0-9_-]{0,63})$/.exec(s);
	if (builtin) return { kind: 'builtin', key: builtin[1] };
	if (/^\d{1,12}$/.test(s) && Number(s) > 0) return { kind: 'saved', id: Number(s) };
	return null;
}

export type CatalogParam = Pick<BuiltInParam, 'key' | 'label' | 'kind' | 'default' | 'min' | 'max' | 'options'>;

export type CatalogEntry = {
	id: string;
	kind: 'builtin' | 'saved';
	name: string;
	description: string | null;
	folder: string;
	chart: ReportChart;
	/** Built-ins only: inline inputs, passed as `p_<key>` (or plain `<key>`). */
	params?: CatalogParam[];
	pinned?: boolean;
	updated_at?: string;
	/** A saved report that mentions hours, billing or pipeline value (admins only). */
	admin_only?: boolean;
};

/** Built-ins this viewer may see, then every saved report (newest first). */
export async function reportCatalog(db: D1Database, viewer: ReportViewer): Promise<CatalogEntry[]> {
	const out: CatalogEntry[] = [];
	for (const def of BUILT_IN_REPORTS) {
		if (!(await builtInVisible(db, def, viewer))) continue;
		out.push({
			id: `builtin:${def.key}`,
			kind: 'builtin',
			name: def.name,
			description: def.description,
			folder: def.folder,
			chart: def.chart,
			params: (def.params ?? []).map(catalogParam)
		});
	}
	for (const report of await listReports(db)) {
		out.push({
			id: String(report.id),
			kind: 'saved',
			name: report.name,
			description: report.description,
			folder: folderOf(report.folder, report.spec.entity),
			chart: report.spec.chart ?? 'table',
			pinned: report.pinned === 1,
			updated_at: report.updated_at,
			admin_only: specMentionsSensitive(report.spec)
		});
	}
	return out;
}

function catalogParam(param: BuiltInParam): CatalogParam {
	const out: CatalogParam = { key: param.key, label: param.label, kind: param.kind, default: param.default };
	if (param.min != null) out.min = param.min;
	if (param.max != null && param.max < Number.MAX_SAFE_INTEGER) out.max = param.max;
	if (param.options) out.options = param.options;
	return out;
}

type ParamSource = { get(name: string): unknown };

/** Built-in params as `p_<key>`, falling back to a plain `<key>`. */
export function paramSource(get: (name: string) => unknown): ParamSource {
	return {
		get: (name: string) => {
			const value = get(name);
			if (value != null) return value;
			return name.startsWith('p_') ? get(name.slice(2)) : null;
		}
	};
}

export type RanReport = { id: string; name: string; result: ReportResult };

/**
 * Run a built-in or saved report as `viewer`. Null when there's no such report (or a
 * built-in this viewer can't see for a reason other than permissions). Throws
 * ReportError for an admin-only report run by a member.
 */
export async function runReportRef(
	db: D1Database,
	ref: ReportRef,
	viewer: ReportViewer,
	params?: ParamSource | null,
	now: Date = new Date(),
	/** #456: a built-in's row limit for this run (raised up to the engine cap). */
	opts: { limit?: number | null } = {}
): Promise<RanReport | null> {
	if (ref.kind === 'builtin') {
		const def = builtInByKey(ref.key);
		if (!def) return null;
		if (!(await builtInVisible(db, def, viewer))) {
			if (viewer.role !== 'admin' && (def.adminOnly || specMentionsSensitive(def.spec(resolveParams(def), viewer)))) {
				throw new ReportError(adminOnlyMessage([def.name]));
			}
			return null;
		}
		const result = await runBuiltIn(db, def, resolveParams(def, params, now), viewer, now, opts);
		return { id: `builtin:${def.key}`, name: def.name, result };
	}
	const report = await getReport(db, ref.id);
	if (!report) return null;
	return { id: String(report.id), name: report.name, result: await runReport(db, report.spec, viewer) };
}

/** Run an ad-hoc spec (validated by `parseReportSpec`; refused for admin-only keys). */
export async function runAdHoc(db: D1Database, spec: unknown, viewer: ReportViewer): Promise<ReportResult> {
	return await runReport(db, parseReportSpec(spec), viewer);
}

/** The first `max` rows (record ids cut alongside), with `truncated` set when rows were dropped. */
export function capRows(result: ReportResult, max: number): ReportResult {
	if (result.rows.length <= max) return result;
	const out: ReportResult = { ...result, rows: result.rows.slice(0, max), truncated: true };
	if (result.recordIds) out.recordIds = result.recordIds.slice(0, max);
	return out;
}

export type MetricCatalog = {
	entities: {
		entity: ReportEntity;
		columns: { key: string; label: string; format: string; definition: string }[];
		group_by: readonly string[];
	}[];
	filter_rules: Record<string, readonly string[]>;
	time_presets: string[];
	charts: ReportChart[];
	limit: { default: number; max: number };
	notes: string[];
	example: unknown;
};

/** The spec vocabulary for `viewer`: admin-only columns are left out for members. */
export function metricCatalog(viewer: ReportViewer, entity?: ReportEntity): MetricCatalog {
	const entities = (entity ? [entity] : [...REPORT_ENTITIES]).map((e) => ({
		entity: e,
		columns: metricsFor(e)
			.filter((metric) => metricOffered(e, metric.key, viewer.role) && (viewer.role === 'admin' || !isAdminOnlyField(e, metric.key)))
			.map((metric) => ({ key: metric.key, label: metric.label, format: metric.format, definition: metric.definition })),
		group_by: groupByOptions(e)
	}));
	const notes = [
		'A spec is { entity, columns, filters?, entityFilters?, groupBy?, timeRange?, sort?, limit?, chart?, thresholds? }. Unknown keys are rejected.',
		'filters = { match: "all"|"any", rules: [{ field, op, value?, value2? }] }: contact rules, the same shape as dynamic segments. company_metric rules name the metric in value2; numeric metrics take gt|gte|lt|lte|eq|ne, dates older|within (days).',
		'Contacts also take custom-field columns and groups as "field:<key>".',
		'timeRange = { preset } or { from, to } (UTC dates). groupBy "week" buckets by UTC Monday, "month" by UTC month.',
		'Built-in reports with history (hours per client, GitHub activity, list growth) read the daily snapshots and only have data from the first snapshot on.'
	];
	if (viewer.role !== 'admin') notes.push('Hours, billing and pipeline value are admin-only and are not listed.');
	return {
		entities,
		filter_rules: { ...RULE_OPS },
		time_presets: ['7d', '30d', '90d', '12m', 'all'],
		charts: ['table', 'bar', 'line', 'stat'],
		limit: { default: DEFAULT_REPORT_LIMIT, max: MAX_REPORT_LIMIT },
		notes,
		example: {
			entity: 'contacts',
			filters: { match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] },
			columns: ['contacts'],
			groupBy: 'month',
			timeRange: { preset: '12m' },
			sort: { key: 'month', dir: 'asc' },
			chart: 'line'
		}
	};
}
