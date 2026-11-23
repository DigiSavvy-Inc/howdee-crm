// #170: company metrics on the contact side — SQL for metric conditions (Contacts filter,
// segment rules, automation Condition step), {{company.*}} merge values, the Data API read
// and the dashboard "Going quiet" count. Vocabulary lives in $lib/company-metrics; the
// "Company metric crossed" trigger is ./metric-trigger.ts (it needs the engine, which
// imports this file).
//
// Column names are only ever interpolated after matching the COMPANY_METRICS whitelist;
// every value is a bound parameter.

import {
	COMPANY_MERGE_KEYS,
	COMPANY_METRICS,
	NUMBER_OPS,
	formatMergeValue,
	metricDef,
	normalizeCondition,
	type MetricCondition
} from '$lib/company-metrics';

/**
 * A metric condition as a SQL clause over a contact row. `companyCol` is the contact's
 * company id column (`c.company_id`, `contacts.company_id`). EXISTS against company_metrics,
 * so a contact with no company, or a company with no value, never matches.
 */
export function metricClause(
	cond: MetricCondition,
	companyCol: string
): { clause: string; binds: (string | number)[] } | null {
	const c = normalizeCondition(cond.metric, cond.op, cond.value);
	if (!c) return null;
	const col = `cmx.${metricDef(c.metric)!.key}`;
	let test: string;
	let bind: string | number;
	if (metricDef(c.metric)!.kind === 'date') {
		// datetime() normalizes ISO-8601 ('…T…Z') and SQLite text alike before comparing.
		test = c.op === 'older' ? `datetime(${col}) < datetime('now', ?)` : `datetime(${col}) >= datetime('now', ?)`;
		bind = `-${c.value} days`;
	} else {
		test = `${col} ${NUMBER_OPS.find((o) => o.op === c.op)!.sql} ?`;
		bind = c.value;
	}
	return {
		clause: `EXISTS (SELECT 1 FROM company_metrics cmx WHERE cmx.company_id = ${companyCol} AND ${col} IS NOT NULL AND ${test})`,
		binds: [bind]
	};
}

/** Automation Condition step: does this contact's company satisfy the condition? */
export async function contactMatchesMetric(
	db: D1Database,
	contactId: number,
	cond: MetricCondition
): Promise<boolean> {
	const m = metricClause(cond, 'c.company_id');
	if (!m) return false;
	const hit = await db
		.prepare(`SELECT 1 FROM contacts c WHERE c.id = ? AND ${m.clause} LIMIT 1`)
		.bind(contactId, ...m.binds)
		.first();
	return !!hit;
}

const METRIC_COLS = COMPANY_METRICS.map((m) => m.key).concat(['last_tracked_title', 'billing_currency']);

type CompanyMergeRow = Record<string, string | number | null> & { contact_id: number };

/**
 * {{company.*}} values per contact id (name/domain/website + every metric), formatted for
 * display. Contacts without a company are absent from the map (their tags fall back).
 */
export async function companyMergeFields(
	db: D1Database,
	contactIds: (number | null)[]
): Promise<Map<number, Record<string, string>>> {
	const out = new Map<number, Record<string, string>>();
	const ids = [...new Set(contactIds.filter((x): x is number => typeof x === 'number'))];
	for (let i = 0; i < ids.length; i += 90) {
		const part = ids.slice(i, i + 90);
		const rows = await db
			.prepare(
				`SELECT c.id AS contact_id, co.name, co.domain, co.website, ${METRIC_COLS.map((k) => `m.${k}`).join(', ')}
				 FROM contacts c
				 JOIN companies co ON co.id = c.company_id
				 LEFT JOIN company_metrics m ON m.company_id = co.id
				 WHERE c.id IN (${part.map(() => '?').join(',')})`
			)
			.bind(...part)
			.all<CompanyMergeRow>();
		for (const r of rows.results) {
			const vals: Record<string, string> = {};
			for (const k of COMPANY_MERGE_KEYS) vals[k] = formatMergeValue(k, r[k], r.billing_currency as string | null);
			out.set(r.contact_id, vals);
		}
	}
	return out;
}

export type CompanyMetricsRow = {
	company_id: number;
	hours_7d: number | null;
	hours_30d: number | null;
	hours_90d: number | null;
	hours_total: number | null;
	last_tracked_at: string | null;
	last_tracked_title: string | null;
	timing_synced_at: string | null;
	issues_open: number | null;
	issues_closed: number | null;
	issues_opened_30d: number | null;
	issues_closed_30d: number | null;
	last_issue_at: string | null;
	github_synced_at: string | null;
};

/** Data API shape for one company's metrics — every field present, null when never synced. */
export async function companyMetrics(db: D1Database, companyId: number): Promise<CompanyMetricsRow> {
	const row = await db
		.prepare(
			`SELECT company_id, hours_7d, hours_30d, hours_90d, hours_total, last_tracked_at, last_tracked_title,
			        timing_synced_at, issues_open, issues_closed, issues_opened_30d, issues_closed_30d,
			        last_issue_at, github_synced_at
			 FROM company_metrics WHERE company_id = ?`
		)
		.bind(companyId)
		.first<CompanyMetricsRow>();
	return (
		row ?? {
			company_id: companyId,
			hours_7d: null,
			hours_30d: null,
			hours_90d: null,
			hours_total: null,
			last_tracked_at: null,
			last_tracked_title: null,
			timing_synced_at: null,
			issues_open: null,
			issues_closed: null,
			issues_opened_30d: null,
			issues_closed_30d: null,
			last_issue_at: null,
			github_synced_at: null
		}
	);
}

/** Dashboard "Going quiet": companies with hours in the last 90 days but none in 30. */
export const GOING_QUIET_FILTER = 'hours_90d:gt:0,hours_30d:eq:0';

/** null when no company has Timing hours at all (the tile is hidden then). */
export async function goingQuietCount(db: D1Database): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT COUNT(hours_90d) AS tracked, COALESCE(SUM(hours_90d > 0 AND hours_30d = 0), 0) AS quiet
			 FROM company_metrics`
		)
		.first<{ tracked: number; quiet: number }>();
	return row && row.tracked > 0 ? row.quiet : null;
}
