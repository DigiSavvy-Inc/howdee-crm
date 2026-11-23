// Reports 5/5 (#358): daily history for values that are otherwise only current
// snapshots — company_metrics (Timing hours, GitHub counts) and list/segment sizes.
// Migration 0093. Written once per UTC day by the heartbeat (same pattern as
// `snapshotTierCounts` / engagement_tier_daily), kept 3 years. Derived data: the
// tables are safe to drop; a missed day is a gap, never a wrong value.
//
// The trend helpers bucket the daily rows: a period's value is the value on the
// **last snapshot inside that period** (day / UTC week from Monday / UTC month).
// Hours charts read hours_7d for weeks and hours_30d for months, so a week is the
// 7 days up to its last snapshot (exact when that is the Sunday).

import { utcMonth, utcWeekStart } from '$lib/report-spec';
import { compileSegment, parseRules } from '$lib/server/segment-query';

export const HISTORY_KEEP_DAYS = 1096; // 3 years
const STAMP_KEY = 'report_history_day';

export type HistoryBucket = 'day' | 'week' | 'month';

export type HistorySnapshot = { written: boolean; day: string; companies: number; lists: number; pruned: number };

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Write today's rows (UTC) unless today's stamp is already there, then prune rows
 * older than {@link HISTORY_KEEP_DAYS}. `INSERT OR REPLACE` keeps a re-run on the same
 * day idempotent even without the stamp.
 */
export async function snapshotReportHistory(db: D1Database, now: Date = new Date()): Promise<HistorySnapshot> {
	const day = utcDay(now);
	const stamp = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(STAMP_KEY).first<{ value: string }>();
	if (stamp?.value === day) return { written: false, day, companies: 0, lists: 0, pruned: 0 };

	const companies = await db
		.prepare(
			`INSERT OR REPLACE INTO company_metrics_daily
			   (day, company_id, hours_7d, hours_30d, open_issues, issues_opened_30d, issues_closed_30d)
			 SELECT ?, cm.company_id, cm.hours_7d, cm.hours_30d, cm.issues_open, cm.issues_opened_30d, cm.issues_closed_30d
			 FROM company_metrics cm JOIN companies co ON co.id = cm.company_id
			 WHERE cm.hours_7d IS NOT NULL OR cm.hours_30d IS NOT NULL OR cm.issues_open IS NOT NULL
			    OR cm.issues_opened_30d IS NOT NULL OR cm.issues_closed_30d IS NOT NULL`
		)
		.bind(day)
		.run();

	// Dynamic segments are counted through their rules; every other list, segment and tag
	// through list_members. Archived contacts are never members (#280).
	const groups = await db
		.prepare(`SELECT id, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL`)
		.all<{ id: number; rules: string | null }>();
	const dynamic: { id: number; sql: string; binds: unknown[] }[] = [];
	for (const row of groups.results ?? []) {
		const rules = parseRules(row.rules);
		if (!rules) continue;
		const compiled = compileSegment(rules);
		dynamic.push({ id: row.id, sql: compiled.sql, binds: compiled.binds });
	}
	const handPicked = await db
		.prepare(
			`INSERT OR REPLACE INTO list_size_daily (day, list_id, members, subscribed)
			 SELECT ?, l.id, COUNT(c.id), COALESCE(SUM(c.subscribed = 1), 0)
			 FROM lists l
			 LEFT JOIN list_members lm ON lm.list_id = l.id
			 LEFT JOIN contacts c ON c.id = lm.contact_id AND c.archived_at IS NULL
			 WHERE l.kind IN ('list', 'segment', 'tag')
			   AND l.id NOT IN (SELECT value FROM json_each(?))
			 GROUP BY l.id`
		)
		.bind(day, JSON.stringify(dynamic.map((d) => d.id)))
		.run();
	let lists = handPicked.meta?.changes ?? 0;
	for (const seg of dynamic) {
		await db
			.prepare(
				`INSERT OR REPLACE INTO list_size_daily (day, list_id, members, subscribed)
				 SELECT ?, ?, COUNT(*), COALESCE(SUM(c.subscribed = 1), 0) FROM contacts c WHERE c.id IN (${seg.sql})`
			)
			.bind(day, seg.id, ...seg.binds)
			.run();
		lists++;
	}

	const cutoff = utcDay(new Date(now.getTime() - HISTORY_KEEP_DAYS * 86_400_000));
	const [a, b] = await db.batch([
		db.prepare(`DELETE FROM company_metrics_daily WHERE day < ?`).bind(cutoff),
		db.prepare(`DELETE FROM list_size_daily WHERE day < ?`).bind(cutoff),
		db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(STAMP_KEY, day)
	]);
	return {
		written: true,
		day,
		companies: companies.meta?.changes ?? 0,
		lists,
		pruned: (a.meta?.changes ?? 0) + (b.meta?.changes ?? 0)
	};
}

/** The period a `YYYY-MM-DD` snapshot day falls in. */
export function bucketOf(day: string, bucket: HistoryBucket): string {
	if (bucket === 'week') return utcWeekStart(day) ?? day;
	if (bucket === 'month') return utcMonth(day) ?? day.slice(0, 7);
	return day;
}

export type HistoryPoint = { day: string; id: number; value: number | null };

export type Pivot = {
	periods: string[];
	/** Series ids, largest total first. */
	ids: number[];
	/** period → id → value on the last snapshot of the period. */
	values: Map<string, Map<number, number | null>>;
};

/** Bucket daily points: per period and series, keep the value of the newest day. */
export function pivotHistory(points: HistoryPoint[], bucket: HistoryBucket): Pivot {
	const latest = new Map<string, Map<number, { day: string; value: number | null }>>();
	for (const point of points) {
		const period = bucketOf(point.day, bucket);
		let row = latest.get(period);
		if (!row) latest.set(period, (row = new Map()));
		const have = row.get(point.id);
		if (!have || point.day > have.day) row.set(point.id, { day: point.day, value: point.value });
	}
	const periods = [...latest.keys()].sort();
	const totals = new Map<number, number>();
	const values = new Map<string, Map<number, number | null>>();
	for (const period of periods) {
		const out = new Map<number, number | null>();
		for (const [id, { value }] of latest.get(period)!) {
			out.set(id, value);
			totals.set(id, (totals.get(id) ?? 0) + (value ?? 0));
		}
		values.set(period, out);
	}
	const ids = [...totals.keys()].sort((x, y) => (totals.get(y) ?? 0) - (totals.get(x) ?? 0) || x - y);
	return { periods, ids, values };
}

export type CompanyHistoryMetric = 'hours_7d' | 'hours_30d' | 'open_issues' | 'issues_opened_30d' | 'issues_closed_30d';
const COMPANY_COLUMNS: readonly CompanyHistoryMetric[] = ['hours_7d', 'hours_30d', 'open_issues', 'issues_opened_30d', 'issues_closed_30d'];

/** Daily company points since `days` ago. `metric` is whitelisted before it reaches SQL. */
export async function companyHistory(
	db: D1Database,
	metric: CompanyHistoryMetric,
	opts: { days: number; now: Date; companyId?: number | null }
): Promise<HistoryPoint[]> {
	if (!COMPANY_COLUMNS.includes(metric)) throw new Error(`Unknown history metric "${metric}".`);
	const since = utcDay(new Date(opts.now.getTime() - opts.days * 86_400_000));
	const byCompany = opts.companyId ? ' AND company_id = ?' : '';
	const binds: (string | number)[] = [since];
	if (opts.companyId) binds.push(opts.companyId);
	const rows = await db
		.prepare(
			`SELECT day, company_id AS id, ${metric} AS value FROM company_metrics_daily
			 WHERE day >= ?${byCompany} AND ${metric} IS NOT NULL ORDER BY day`
		)
		.bind(...binds)
		.all<HistoryPoint>();
	return rows.results ?? [];
}

/** Daily list-size points since `days` ago. */
export async function listHistory(
	db: D1Database,
	measure: 'members' | 'subscribed',
	opts: { days: number; now: Date; listId?: number | null }
): Promise<HistoryPoint[]> {
	const column = measure === 'subscribed' ? 'subscribed' : 'members';
	const since = utcDay(new Date(opts.now.getTime() - opts.days * 86_400_000));
	const byList = opts.listId ? ' AND list_id = ?' : '';
	const binds: (string | number)[] = [since];
	if (opts.listId) binds.push(opts.listId);
	const rows = await db
		.prepare(`SELECT day, list_id AS id, ${column} AS value FROM list_size_daily WHERE day >= ?${byList} ORDER BY day`)
		.bind(...binds)
		.all<HistoryPoint>();
	return rows.results ?? [];
}
