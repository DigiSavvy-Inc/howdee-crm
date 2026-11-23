import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runProviderSync, timingProvider, recentSyncs } from '../src/lib/server/integrations';
import {
	attachTimingProject,
	companyTiming,
	detachTimingProject,
	parseLastEntry,
	parseProjects,
	PROJECTS_CACHE_MS,
	rollupHours,
	sumReportSeconds,
	syncTimingCompanies,
	timingProjects,
	upsertTimingMetrics
} from '../src/lib/server/integrations/timing';
import { listCompanies } from '../src/lib/server/companies';

const db = (env as any).DB as D1Database;
const TOK = { TIMING_API_TOKEN: 'tok' };
const NOW = new Date('2026-10-06T12:00:00Z');

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --- fixtures (shapes from the Timing API docs) ---
const PROJECTS = {
	data: [
		{ self: '/projects/1', title: 'Clients', parent: null },
		{ self: '/projects/2', title: 'Acme', parent: { self: '/projects/1' } },
		{ self: '/projects/3', title: 'Retainer', title_chain: ['Clients', 'Acme', 'Retainer'], parent: { self: '/projects/2' } }
	]
};
const DAY_REPORT = {
	data: [
		{ duration: 3600, timespan: '2026-10-06' }, // today → 7/30/90
		{ duration: 1800, start_date: '2026-09-30T09:00:00-07:00' }, // 6 days back → 7/30/90
		{ duration: 7200, timespan: { start_date: '2026-09-29', end_date: '2026-09-29' } }, // 7 days back → 30/90
		{ duration: 5400, timespan: '2026-09-07' }, // 29 days back → 30/90
		{ duration: 3600, timespan: '2026-09-06' } // 30 days back → 90 only
	]
};
const TOTAL_REPORT = { data: [{ duration: 360000 }, { duration: 1800 }] };
const ENTRIES = {
	data: [
		{ title: 'Older', start_date: '2026-10-01T10:00:00-07:00' },
		{ title: 'Homepage fixes', start_date: '2026-10-06T08:00:00-07:00' }
	]
};

/** Fake Timing API: routes by path, records calls. */
function fakeTiming(over: Partial<Record<'projects' | 'report' | 'total' | 'entries', Response | (() => Response)>> = {}) {
	const calls: string[] = [];
	const f = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		calls.push(url.pathname + url.search);
		const pick = (k: keyof typeof over, d: unknown) => {
			const o = over[k];
			return o ? (typeof o === 'function' ? o() : o) : json(d);
		};
		if (url.pathname.endsWith('/projects')) return pick('projects', PROJECTS);
		if (url.pathname.endsWith('/report')) {
			return url.searchParams.get('timespan_grouping_mode') === 'day' ? pick('report', DAY_REPORT) : pick('total', TOTAL_REPORT);
		}
		if (url.pathname.endsWith('/time-entries')) return pick('entries', ENTRIES);
		return json({}, 404);
	}) as typeof fetch;
	return { f, calls };
}

async function company(name: string, project?: string): Promise<number> {
	const row = await db.prepare('INSERT INTO companies (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>();
	if (project) await attachTimingProject(db, row!.id, project, `Path ${name}`);
	return row!.id;
}

beforeEach(async () => {
	await db.prepare('DELETE FROM company_metrics').run();
	await db.prepare('UPDATE contacts SET company_id = NULL').run();
	await db.prepare('DELETE FROM companies').run();
	await db.prepare('DELETE FROM integration_syncs').run();
	await db.prepare(`DELETE FROM app_state WHERE key LIKE 'integration_%' OR key = 'timing_projects_cache'`).run();
});

describe('parsing', () => {
	it('projects: builds paths from title_chain or the parent chain', () => {
		expect(parseProjects(PROJECTS)).toEqual([
			{ id: '/projects/1', title: 'Clients', path: 'Clients' },
			{ id: '/projects/2', title: 'Acme', path: 'Clients › Acme' },
			{ id: '/projects/3', title: 'Retainer', path: 'Clients › Acme › Retainer' }
		]);
		expect(parseProjects(null)).toEqual([]);
	});

	it('report: rolls a per-day report up into 7/30/90d hours (1 decimal)', () => {
		expect(rollupHours(DAY_REPORT, NOW)).toEqual({ hours_7d: 1.5, hours_30d: 5, hours_90d: 6 });
		expect(rollupHours({ data: [] }, NOW)).toEqual({ hours_7d: 0, hours_30d: 0, hours_90d: 0 });
	});

	it('report: sums duration seconds, ignoring junk', () => {
		expect(sumReportSeconds(TOTAL_REPORT)).toBe(361800);
		expect(sumReportSeconds({ data: [{ duration: 'x' }, { duration: -5 }, null] })).toBe(0);
	});

	it('last entry: newest by start_date regardless of order', () => {
		expect(parseLastEntry(ENTRIES)).toEqual({ title: 'Homepage fixes', start_date: '2026-10-06T08:00:00-07:00' });
		expect(parseLastEntry({ data: [] })).toBeNull();
		expect(parseLastEntry({ data: [{ title: '  ', start_date: '2026-10-01T00:00:00Z' }] })).toEqual({
			title: null,
			start_date: '2026-10-01T00:00:00Z'
		});
	});
});

describe('picker cache', () => {
	it('serves the project list from cache for 10 minutes', async () => {
		const t = fakeTiming();
		await timingProjects(db, TOK, { fetch: t.f, now: NOW });
		await timingProjects(db, TOK, { fetch: t.f, now: new Date(NOW.getTime() + PROJECTS_CACHE_MS - 1) });
		expect(t.calls).toHaveLength(1);
		const again = await timingProjects(db, TOK, { fetch: t.f, now: new Date(NOW.getTime() + PROJECTS_CACHE_MS) });
		expect(t.calls).toHaveLength(2);
		expect(again.map((p) => p.path)).toContain('Clients › Acme');
	});
});

describe('syncTimingCompanies', () => {
	it('syncs attached companies, skips ones with no project, upserts metrics', async () => {
		const acme = await company('Acme', '/projects/2');
		const none = await company('No Project');
		const t = fakeTiming();
		const res = await syncTimingCompanies(db, TOK, { fetch: t.f, now: NOW });
		expect(res.counts).toMatchObject({ companies: 1, synced: 1, failed: 0, rate_limited: 0 });
		expect(t.calls).toHaveLength(3);
		expect(t.calls.every((c) => c.includes(encodeURIComponent('/projects/2')))).toBe(true);
		expect(t.calls.every((c) => c.includes('include_child_projects=1'))).toBe(true);

		const m = await companyTiming(db, acme);
		expect(m).toMatchObject({
			project_id: '/projects/2',
			hours_7d: 1.5,
			hours_30d: 5,
			hours_90d: 6,
			hours_total: 100.5,
			last_tracked_title: 'Homepage fixes',
			last_tracked_at: '2026-10-06T08:00:00-07:00'
		});
		expect(m!.timing_synced_at).not.toBeNull();
		expect((await companyTiming(db, none))!.timing_synced_at).toBeNull();

		// Re-sync updates in place (one row per company).
		await syncTimingCompanies(db, TOK, { fetch: fakeTiming({ total: json({ data: [{ duration: 7200 }] }) }).f, now: NOW });
		expect((await companyTiming(db, acme))!.hours_total).toBe(2);
		const n = await db.prepare('SELECT COUNT(*) AS n FROM company_metrics').first<{ n: number }>();
		expect(n!.n).toBe(1);
	});

	it('a 429 stops the run and is reported; later companies wait', async () => {
		await company('A', '/projects/1');
		await company('B', '/projects/2');
		const t = fakeTiming({ report: () => new Response('', { status: 429 }) });
		const res = await syncTimingCompanies(db, TOK, { fetch: t.f, now: NOW });
		expect(res.counts).toMatchObject({ companies: 2, synced: 0, rate_limited: 1 });
		expect(res.errors[0]).toContain('429');
		expect(t.calls).toHaveLength(1);
	});

	it('other per-company errors are reported and the run continues', async () => {
		await company('A', '/projects/1');
		await company('B', '/projects/2');
		let n = 0;
		const t = fakeTiming({ entries: () => (n++ === 0 ? json({}, 500) : json(ENTRIES)) });
		const res = await syncTimingCompanies(db, TOK, { fetch: t.f, now: NOW });
		expect(res.counts).toMatchObject({ synced: 1, failed: 1 });
		expect(res.errors[0]).toMatch(/^A: HTTP 500/);
	});

	it('companyId narrows the sync to one company', async () => {
		await company('A', '/projects/1');
		const b = await company('B', '/projects/2');
		const t = fakeTiming();
		const res = await syncTimingCompanies(db, TOK, { fetch: t.f, now: NOW, companyId: b });
		expect(res.counts.synced).toBe(1);
		expect(t.calls).toHaveLength(3);
	});
});

describe('provider + attach/detach', () => {
	it('the Timing provider sync refreshes projects and syncs companies via the runner', async () => {
		const acme = await company('Acme', '/projects/2');
		const t = fakeTiming();
		const r = await runProviderSync(db, TOK, timingProvider, 'manual', { fetch: t.f, companyId: acme });
		expect(r).toMatchObject({ ok: true });
		const [row] = await recentSyncs(db);
		expect(JSON.parse(row.detail!).counts).toMatchObject({ projects: 3, synced: 1 });
		expect((await companyTiming(db, acme))!.hours_total).toBeGreaterThan(0);
	});

	it('detach clears the project and the Timing numbers; list sorts by hours_30d', async () => {
		const a = await company('Alpha', '/projects/1');
		const b = await company('Beta', '/projects/2');
		await company('Gamma');
		const base = { hours_7d: 0, hours_90d: 0, hours_total: 0, last_tracked_at: null, last_tracked_title: null };
		await upsertTimingMetrics(db, a, { ...base, hours_30d: 2 });
		await upsertTimingMetrics(db, b, { ...base, hours_30d: 9 });

		const desc = await listCompanies(db, { sort: 'hours_30d', dir: 'desc' });
		expect(desc.rows.map((r) => [r.name, r.hours_30d])).toEqual([['Beta', 9], ['Alpha', 2], ['Gamma', null]]);
		const asc = await listCompanies(db, { sort: 'hours_30d', dir: 'asc' });
		expect(asc.rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);

		await detachTimingProject(db, b);
		const m = await companyTiming(db, b);
		expect(m).toMatchObject({ project_id: null, project_name: null, hours_30d: null, timing_synced_at: null });
	});
});
