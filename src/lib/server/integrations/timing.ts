// Timing ↔ companies (#168). A company can be attached to one Timing project
// (`companies.timing_project_id` = the project's `self` ref, e.g. "/projects/123"); the
// Timing sync then rolls up tracked hours (7d / 30d / 90d / total) and the latest time entry
// into `company_metrics`.
//
// Per attached company, three sequential calls (never parallel — Timing rate-limits):
//  1. GET /report over the last 90 days grouped by day → rolled up locally into 7/30/90d.
//  2. GET /report from 2000-01-01 → total.
//  3. GET /time-entries from 2000-01-01 (newest first) → the latest entry's title + start.
// A 429 stops the whole run (the rest wait for the next cron) and is logged as an error.
// The project list for the picker is cached in app_state for 10 minutes.

export const TIMING_BASE = 'https://web.timingapp.com/api/v1';
const FETCH_TIMEOUT_MS = 10_000;
export const PROJECTS_CACHE_MS = 10 * 60 * 1000;
const PROJECTS_CACHE_KEY = 'timing_projects_cache';
const TOTAL_FROM = '2000-01-01';

type FetchFn = typeof fetch;
type TimingEnv = { TIMING_API_TOKEN?: string };

export class TimingRateLimited extends Error {
	constructor() {
		super('Timing rate limit (HTTP 429) — stopped, retrying next run');
	}
}

export function timingHeaders(env: TimingEnv) {
	return { Authorization: `Bearer ${env.TIMING_API_TOKEN}`, Accept: 'application/json' };
}

async function timingGet(env: TimingEnv, path: string, f: FetchFn): Promise<unknown> {
	const res = await f(`${TIMING_BASE}${path}`, {
		headers: timingHeaders(env),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (res.status === 429) throw new TimingRateLimited();
	if (!res.ok) {
		throw new Error(res.status === 401 || res.status === 403 ? `HTTP ${res.status} — token rejected` : `HTTP ${res.status}`);
	}
	return res.json().catch(() => null);
}

function dataArray(body: unknown): Record<string, unknown>[] {
	const d = (body as { data?: unknown } | null)?.data;
	return Array.isArray(d) ? (d.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

// ---------------------------------------------------------------------------
// Projects (picker)
// ---------------------------------------------------------------------------

export type TimingProject = { id: string; title: string; path: string };

/**
 * Flatten /projects into `{ id, title, path }` sorted by path. The path is built from
 * `title_chain` when present, else by walking `parent.self` through the list.
 */
export function parseProjects(body: unknown): TimingProject[] {
	const rows = dataArray(body);
	const byId = new Map<string, { title: string; parent: string | null }>();
	for (const r of rows) {
		const id = typeof r.self === 'string' ? r.self : null;
		if (!id) continue;
		const parent = (r.parent as { self?: unknown } | null)?.self;
		byId.set(id, { title: String(r.title ?? ''), parent: typeof parent === 'string' ? parent : null });
	}
	const out: TimingProject[] = [];
	for (const r of rows) {
		const id = typeof r.self === 'string' ? r.self : null;
		if (!id) continue;
		const title = String(r.title ?? '');
		let chain: string[];
		if (Array.isArray(r.title_chain) && r.title_chain.length) {
			chain = r.title_chain.map(String);
		} else {
			chain = [];
			let cur: string | null = id;
			const seen = new Set<string>();
			while (cur && byId.has(cur) && !seen.has(cur) && chain.length < 20) {
				seen.add(cur);
				chain.unshift(byId.get(cur)!.title);
				cur = byId.get(cur)!.parent;
			}
		}
		out.push({ id, title, path: chain.join(' › ') || title });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The project list for the picker — from the 10-minute app_state cache, else the API. */
export async function timingProjects(
	db: D1Database,
	env: TimingEnv,
	opts: { fetch?: FetchFn; now?: Date; refresh?: boolean } = {}
): Promise<TimingProject[]> {
	const now = (opts.now ?? new Date()).getTime();
	if (!opts.refresh) {
		const row = await db
			.prepare(`SELECT value FROM app_state WHERE key = ?`)
			.bind(PROJECTS_CACHE_KEY)
			.first<{ value: string | null }>();
		try {
			const cached = JSON.parse(row?.value ?? 'null') as { at: number; projects: TimingProject[] } | null;
			if (cached && now - cached.at < PROJECTS_CACHE_MS && Array.isArray(cached.projects)) return cached.projects;
		} catch {
			// unreadable cache → refetch
		}
	}
	const projects = parseProjects(await timingGet(env, '/projects', opts.fetch ?? fetch));
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(PROJECTS_CACHE_KEY, JSON.stringify({ at: now, projects }))
		.run();
	return projects;
}

// ---------------------------------------------------------------------------
// Hours + last entry
// ---------------------------------------------------------------------------

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (d: Date, n: number) => new Date(d.getTime() - n * 86_400_000);
const round1 = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;

/** The day a report row belongs to (YYYY-MM-DD), across the shapes Timing may return. */
function rowDay(r: Record<string, unknown>): string | null {
	const ts = r.timespan as unknown;
	const candidates = [
		r.start_date,
		r.date,
		typeof ts === 'object' && ts ? (ts as { start_date?: unknown }).start_date : ts
	];
	for (const c of candidates) {
		if (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c)) return c.slice(0, 10);
	}
	return null;
}

/** Sum of `duration` seconds over a report's rows. */
export function sumReportSeconds(body: unknown): number {
	let s = 0;
	for (const r of dataArray(body)) {
		const d = Number(r.duration);
		if (Number.isFinite(d) && d > 0) s += d;
	}
	return s;
}

/**
 * Roll a 90-day per-day report up into 7/30/90-day hours (1 decimal). Day N counts toward the
 * window when it is within the last N calendar days including `today`. A row with no
 * readable date still counts toward 90d (the report itself was limited to 90 days).
 */
export function rollupHours(body: unknown, today: Date): { hours_7d: number; hours_30d: number; hours_90d: number } {
	const c7 = ymd(daysBefore(today, 6));
	const c30 = ymd(daysBefore(today, 29));
	let s7 = 0;
	let s30 = 0;
	let s90 = 0;
	for (const r of dataArray(body)) {
		const d = Number(r.duration);
		if (!Number.isFinite(d) || d <= 0) continue;
		s90 += d;
		const day = rowDay(r);
		if (day && day >= c30) s30 += d;
		if (day && day >= c7) s7 += d;
	}
	return { hours_7d: round1(s7), hours_30d: round1(s30), hours_90d: round1(s90) };
}

/** The newest entry in a /time-entries response (by start_date, whatever the order). */
export function parseLastEntry(body: unknown): { title: string | null; start_date: string } | null {
	let best: { title: string | null; start_date: string; t: number } | null = null;
	for (const r of dataArray(body)) {
		if (typeof r.start_date !== 'string') continue;
		const t = Date.parse(r.start_date);
		if (!Number.isFinite(t)) continue;
		if (!best || t > best.t) {
			const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 300) : null;
			best = { title, start_date: r.start_date, t };
		}
	}
	return best ? { title: best.title, start_date: best.start_date } : null;
}

function projectQuery(projectId: string): string {
	return `projects[]=${encodeURIComponent(projectId)}&include_child_projects=1`;
}

export type TimingMetrics = {
	hours_7d: number;
	hours_30d: number;
	hours_90d: number;
	hours_total: number;
	last_tracked_at: string | null;
	last_tracked_title: string | null;
};

/** Fetch one project's numbers — three sequential calls. Throws TimingRateLimited on 429. */
export async function fetchProjectMetrics(
	env: TimingEnv,
	projectId: string,
	opts: { fetch?: FetchFn; now?: Date } = {}
): Promise<TimingMetrics> {
	const f = opts.fetch ?? fetch;
	const now = opts.now ?? new Date();
	// Upper bound is tomorrow (UTC): Timing reads date-only params in the account's timezone,
	// so "today" in UTC could cut off entries from late in the local day.
	const until = ymd(daysBefore(now, -1));
	const pq = projectQuery(projectId);

	const recent = await timingGet(
		env,
		`/report?start_date_min=${ymd(daysBefore(now, 89))}&start_date_max=${until}&${pq}` +
			`&columns[]=timespan&timespan_grouping_mode=day`,
		f
	);
	const total = await timingGet(env, `/report?start_date_min=${TOTAL_FROM}&start_date_max=${until}&${pq}`, f);
	const entries = await timingGet(
		env,
		`/time-entries?start_date_min=${TOTAL_FROM}&start_date_max=${until}&${pq}&sort=-start_date&limit=1`,
		f
	);
	const last = parseLastEntry(entries);
	return {
		...rollupHours(recent, now),
		hours_total: round1(sumReportSeconds(total)),
		last_tracked_at: last?.start_date ?? null,
		last_tracked_title: last?.title ?? null
	};
}

/** Upsert the Timing columns of a company's metrics row (GitHub columns untouched). */
export async function upsertTimingMetrics(db: D1Database, companyId: number, m: TimingMetrics): Promise<void> {
	await db
		.prepare(
			`INSERT INTO company_metrics (company_id, hours_7d, hours_30d, hours_90d, hours_total,
			   last_tracked_at, last_tracked_title, timing_synced_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(company_id) DO UPDATE SET
			   hours_7d = excluded.hours_7d, hours_30d = excluded.hours_30d, hours_90d = excluded.hours_90d,
			   hours_total = excluded.hours_total, last_tracked_at = excluded.last_tracked_at,
			   last_tracked_title = excluded.last_tracked_title, timing_synced_at = excluded.timing_synced_at`
		)
		.bind(companyId, m.hours_7d, m.hours_30d, m.hours_90d, m.hours_total, m.last_tracked_at, m.last_tracked_title)
		.run();
}

/** Clear a company's Timing numbers (on detach / project change). */
export async function clearTimingMetrics(db: D1Database, companyId: number): Promise<void> {
	await db
		.prepare(
			`UPDATE company_metrics SET hours_7d = NULL, hours_30d = NULL, hours_90d = NULL, hours_total = NULL,
			   last_tracked_at = NULL, last_tracked_title = NULL, timing_synced_at = NULL
			 WHERE company_id = ?`
		)
		.bind(companyId)
		.run();
}

/**
 * Sync every company with an attached project (or just `companyId`). Companies without a
 * project are skipped. Sequential; a 429 stops the run and is reported in `errors`; any other
 * per-company failure is reported and the run moves on.
 */
export async function syncTimingCompanies(
	db: D1Database,
	env: TimingEnv,
	opts: { fetch?: FetchFn; now?: Date; companyId?: number } = {}
): Promise<{ counts: Record<string, number>; errors: string[] }> {
	const where = opts.companyId ? 'AND id = ?' : '';
	const stmt = db.prepare(
		`SELECT id, name, timing_project_id FROM companies
		 WHERE timing_project_id IS NOT NULL AND timing_project_id != '' ${where} ORDER BY id`
	);
	const rows = await (opts.companyId ? stmt.bind(opts.companyId) : stmt).all<{
		id: number;
		name: string;
		timing_project_id: string;
	}>();
	const counts = { companies: rows.results.length, synced: 0, failed: 0, rate_limited: 0 };
	const errors: string[] = [];
	for (const co of rows.results) {
		try {
			const m = await fetchProjectMetrics(env, co.timing_project_id, opts);
			await upsertTimingMetrics(db, co.id, m);
			counts.synced++;
		} catch (e) {
			if (e instanceof TimingRateLimited) {
				counts.rate_limited = 1;
				errors.push(e.message);
				break;
			}
			counts.failed++;
			errors.push(`${co.name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
		}
	}
	return { counts, errors };
}

// ---------------------------------------------------------------------------
// Read side (company page, contact page)
// ---------------------------------------------------------------------------

export type CompanyTiming = {
	project_id: string | null;
	project_name: string | null;
	hours_7d: number | null;
	hours_30d: number | null;
	hours_90d: number | null;
	hours_total: number | null;
	last_tracked_at: string | null;
	last_tracked_title: string | null;
	timing_synced_at: string | null;
};

export async function companyTiming(db: D1Database, companyId: number): Promise<CompanyTiming | null> {
	return db
		.prepare(
			`SELECT co.timing_project_id AS project_id, co.timing_project_name AS project_name,
			   m.hours_7d, m.hours_30d, m.hours_90d, m.hours_total, m.last_tracked_at, m.last_tracked_title,
			   m.timing_synced_at
			 FROM companies co LEFT JOIN company_metrics m ON m.company_id = co.id WHERE co.id = ?`
		)
		.bind(companyId)
		.first<CompanyTiming>();
}

/** Attach (or replace) a company's Timing project; the old numbers are cleared. */
export async function attachTimingProject(
	db: D1Database,
	companyId: number,
	projectId: string,
	projectName: string
): Promise<void> {
	await db
		.prepare(`UPDATE companies SET timing_project_id = ?, timing_project_name = ?, updated_at = datetime('now') WHERE id = ?`)
		.bind(projectId.slice(0, 200), projectName.slice(0, 300) || projectId.slice(0, 200), companyId)
		.run();
	await clearTimingMetrics(db, companyId);
}

export async function detachTimingProject(db: D1Database, companyId: number): Promise<void> {
	await db
		.prepare(`UPDATE companies SET timing_project_id = NULL, timing_project_name = NULL, updated_at = datetime('now') WHERE id = ?`)
		.bind(companyId)
		.run();
	await clearTimingMetrics(db, companyId);
}
