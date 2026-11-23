import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { HISTORY_KEEP_DAYS, bucketOf, pivotHistory, snapshotReportHistory } from '../src/lib/server/reports/history';
import { builtInByKey, resolveParams, runBuiltIn } from '../src/lib/server/reports/builtins';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, undoAction } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';
import { createReport, getReport } from '../src/lib/server/reports/store';
import { GET as listReportsGET } from '../src/routes/api/v1/reports/+server';
import { GET as runRefGET } from '../src/routes/api/v1/reports/[ref]/run/+server';
import { POST as runSpecPOST } from '../src/routes/api/v1/reports/run/+server';

// #358: daily history snapshots, assistant report tools, /api/v1/reports.

const db = (env as { DB: D1Database }).DB;
const admin = { role: 'admin' as const };
const member = { role: 'member' as const };
const T = `r358${Date.now()}`;
let seq = 0;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await db.prepare(sql).bind(...binds).first<{ id: number }>();
	if (!row) throw new Error(sql);
	return row.id;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM reports'),
		db.prepare('DELETE FROM company_metrics_daily'),
		db.prepare('DELETE FROM list_size_daily'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM companies'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM api_keys'),
		db.prepare(`DELETE FROM app_state WHERE key = 'report_history_day'`)
	]);
});

type Fixture = { acme: number; beta: number; news: number; dyn: number };

async function fixture(): Promise<Fixture> {
	const acme = await id(`INSERT INTO companies (name) VALUES ('Acme') RETURNING id`);
	const beta = await id(`INSERT INTO companies (name) VALUES ('Beta') RETURNING id`);
	await db
		.prepare(`INSERT INTO company_metrics (company_id, hours_7d, hours_30d, issues_open, issues_opened_30d, issues_closed_30d) VALUES (?, 5, 20, 3, 4, 1), (?, 1, 2, NULL, NULL, NULL)`)
		.bind(acme, beta)
		.run();
	const news = await id(`INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id`);
	const dyn = await id(
		`INSERT INTO lists (name, kind, rules) VALUES ('Subscribed', 'segment', ?) RETURNING id`,
		JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] })
	);
	const a = await id(`INSERT INTO contacts (email, subscribed) VALUES ('a-${T}@x.co', 1) RETURNING id`);
	const b = await id(`INSERT INTO contacts (email, subscribed) VALUES ('b-${T}@x.co', 0) RETURNING id`);
	const c = await id(`INSERT INTO contacts (email, subscribed, archived_at) VALUES ('c-${T}@x.co', 1, datetime('now')) RETURNING id`);
	for (const contact of [a, b, c]) await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(news, contact).run();
	return { acme, beta, news, dyn };
}

describe('daily history snapshots', () => {
	it('writes once per UTC day, is idempotent, and counts lists without archived contacts', async () => {
		const f = await fixture();
		const now = new Date('2026-10-20T12:00:00Z');
		const first = await snapshotReportHistory(db, now);
		expect(first).toMatchObject({ written: true, day: '2026-10-20', companies: 2 });
		const again = await snapshotReportHistory(db, new Date('2026-10-20T23:00:00Z'));
		expect(again.written).toBe(false);
		expect(await count('SELECT COUNT(*) AS n FROM company_metrics_daily')).toBe(2);

		const acme = await db.prepare('SELECT * FROM company_metrics_daily WHERE company_id = ?').bind(f.acme).first<any>();
		expect(acme).toMatchObject({ day: '2026-10-20', hours_7d: 5, hours_30d: 20, open_issues: 3, issues_opened_30d: 4, issues_closed_30d: 1 });
		const news = await db.prepare('SELECT members, subscribed FROM list_size_daily WHERE list_id = ?').bind(f.news).first<any>();
		expect(news).toEqual({ members: 2, subscribed: 1 }); // the archived contact isn't a member
		const dyn = await db.prepare('SELECT members, subscribed FROM list_size_daily WHERE list_id = ?').bind(f.dyn).first<any>();
		expect(dyn).toEqual({ members: 1, subscribed: 1 }); // dynamic: subscribed and not archived

		// Re-running a day whose stamp is gone replaces, never duplicates.
		await db.prepare(`DELETE FROM app_state WHERE key = 'report_history_day'`).run();
		await db.prepare('UPDATE company_metrics SET hours_7d = 9 WHERE company_id = ?').bind(f.acme).run();
		expect((await snapshotReportHistory(db, now)).written).toBe(true);
		expect(await count('SELECT COUNT(*) AS n FROM company_metrics_daily')).toBe(2);
		expect(await count('SELECT hours_7d AS n FROM company_metrics_daily WHERE company_id = ?', f.acme)).toBe(9);

		const next = await snapshotReportHistory(db, new Date('2026-10-21T00:05:00Z'));
		expect(next.written).toBe(true);
		expect(await count('SELECT COUNT(DISTINCT day) AS n FROM list_size_daily')).toBe(2);
	});

	it('prunes rows older than 3 years', async () => {
		const f = await fixture();
		const now = new Date('2026-10-20T12:00:00Z');
		const old = new Date(now.getTime() - (HISTORY_KEEP_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
		const kept = new Date(now.getTime() - (HISTORY_KEEP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
		await db.batch([
			db.prepare('INSERT INTO company_metrics_daily (day, company_id, hours_7d) VALUES (?, ?, 1), (?, ?, 1)').bind(old, f.acme, kept, f.acme),
			db.prepare('INSERT INTO list_size_daily (day, list_id, members, subscribed) VALUES (?, ?, 1, 1), (?, ?, 1, 1)').bind(old, f.news, kept, f.news)
		]);
		const res = await snapshotReportHistory(db, now);
		expect(res.pruned).toBe(2);
		expect(await count('SELECT COUNT(*) AS n FROM company_metrics_daily WHERE day = ?', old)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM company_metrics_daily WHERE day = ?', kept)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM list_size_daily WHERE day = ?', old)).toBe(0);
	});
});

describe('time-series bucketing', () => {
	it('buckets by UTC day, Monday week and month, keeping the last snapshot of each period', () => {
		expect(bucketOf('2026-10-18', 'week')).toBe('2026-10-12'); // a Sunday → its Monday
		expect(bucketOf('2026-10-19', 'week')).toBe('2026-10-19');
		expect(bucketOf('2026-10-19', 'month')).toBe('2026-10');
		expect(bucketOf('2026-10-19', 'day')).toBe('2026-10-19');
		const pivot = pivotHistory(
			[
				{ day: '2026-10-12', id: 1, value: 2 },
				{ day: '2026-10-18', id: 1, value: 7 }, // last of the week of the 12th
				{ day: '2026-10-14', id: 2, value: 1 },
				{ day: '2026-10-19', id: 1, value: 3 },
				{ day: '2026-10-31', id: 2, value: 4 }
			],
			'week'
		);
		expect(pivot.periods).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
		expect(pivot.values.get('2026-10-12')).toEqual(new Map([[1, 7], [2, 1]]));
		expect(pivot.values.get('2026-10-19')).toEqual(new Map([[1, 3]]));
		expect(pivot.ids).toEqual([1, 2]); // 10 vs 5 in total
		const months = pivotHistory([{ day: '2026-09-30', id: 1, value: 1 }, { day: '2026-10-01', id: 1, value: 5 }, { day: '2026-10-20', id: 1, value: 6 }], 'month');
		expect(months.periods).toEqual(['2026-09', '2026-10']);
		expect(months.values.get('2026-10')!.get(1)).toBe(6);
	});

	it('hours per client: weeks read hours_7d, months hours_30d; admins only', async () => {
		const f = await fixture();
		await db.batch([
			db.prepare('INSERT INTO company_metrics_daily (day, company_id, hours_7d, hours_30d) VALUES (?, ?, 4, 10), (?, ?, 6, 12), (?, ?, 1, 3)').bind('2026-10-13', f.acme, '2026-10-18', f.acme, '2026-10-18', f.beta)
		]);
		const def = builtInByKey('client-hours-trend')!;
		const now = new Date('2026-10-20T12:00:00Z');
		const weekly = await runBuiltIn(db, def, resolveParams(def, new URLSearchParams('p_by=week&p_days=90')), admin, now);
		expect(weekly.columns.map((c) => c.label)).toEqual(['Week (UTC Monday)', 'All clients', 'Acme', 'Beta']);
		expect(weekly.rows).toEqual([{ period: '2026-10-12', total: 7, [`id_${f.acme}`]: 6, [`id_${f.beta}`]: 1 }]);
		expect(weekly.chartSeries).toMatchObject({ xKey: 'period', yKey: 'total' });
		const monthly = await runBuiltIn(db, def, resolveParams(def, new URLSearchParams('p_by=month&p_days=90')), admin, now);
		expect(monthly.rows[0]).toMatchObject({ period: '2026-10', total: 15 });
		await expect(runBuiltIn(db, def, resolveParams(def), member, now)).rejects.toThrow(/Admins only/);
	});

	it('list growth reads list_size_daily for members', async () => {
		const f = await fixture();
		await db
			.prepare('INSERT INTO list_size_daily (day, list_id, members, subscribed) VALUES (?, ?, 10, 8), (?, ?, 12, 9)')
			.bind('2026-09-10', f.news, '2026-10-10', f.news)
			.run();
		const def = builtInByKey('list-growth')!;
		const res = await runBuiltIn(db, def, resolveParams(def, new URLSearchParams('p_by=month&p_measure=subscribed')), member, new Date('2026-10-20T00:00:00Z'));
		expect(res.rows).toEqual([
			{ period: '2026-09', total: 8, [`id_${f.news}`]: 8 },
			{ period: '2026-10', total: 9, [`id_${f.news}`]: 9 }
		]);
	});
});

// --- assistant tools ---------------------------------------------------------------------

async function toolCtx(role: 'admin' | 'member'): Promise<ToolContext> {
	const login = `${T}-${role}-${++seq}`;
	const userId = await id(`INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id`, login, role);
	const threadId = await createThread(db, userId, modelInfo('claude-sonnet-5-5')!.id, 'medium', 'test');
	return {
		db,
		user: { id: userId, github_login: login, name: null, avatar_url: null, role, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any,
		baseUrl: 'https://app.test',
		now: new Date(),
		threadId
	};
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	const r = await runTool(ctx, name, input, TOOLS, `tu_${++seq}`);
	return { ...r, data: r.ok && r.content ? JSON.parse(r.content) : null };
}

describe('assistant report tools', () => {
	it('are registered with read-tier names, and nothing saves results as a group or tags from a report', () => {
		for (const name of ['list_reports', 'get_report_results', 'get_report_metrics', 'suggest_report', 'get_report_preview']) expect(toolByName(name)?.tier).toBe('read');
		expect(toolByName('create_report_draft')?.tier).toBe('write');
		const reportish = TOOLS.filter((t) => /report/.test(t.name)).map((t) => t.name);
		// suggest_report / get_report_preview come from #389 (read-only, never save).
		expect(reportish.sort()).toEqual(['create_report_draft', 'get_report_metrics', 'get_report_preview', 'get_report_results', 'list_reports', 'suggest_report']);
		for (const t of TOOLS) expect(t.name).not.toMatch(/report.*(segment|list|tag)|(segment|tag).*report/);
		const create = toolByName('create_report_draft')!;
		expect(Object.keys((create.input_schema as any).properties)).toEqual(['name', 'description', 'spec']);
	});

	it('lists, runs, describes and saves reports as the signed-in user', async () => {
		const f = await fixture();
		const ctx = await toolCtx('member');
		const listed = await call(ctx, 'list_reports', {});
		expect(listed.ok).toBe(true);
		const ids = listed.data.reports.map((r: any) => r.id);
		expect(ids).toContain('builtin:list-growth');
		expect(ids).not.toContain('builtin:client-hours-trend'); // admin-only

		const ran = await call(ctx, 'get_report_results', { spec: { entity: 'segments', columns: ['name', 'member_count'] } });
		expect(ran.ok).toBe(true);
		// #705: only a counts; b is unsubscribed (subscribed = 0, not pending) and c is archived.
		expect(ran.data.rows).toContainEqual({ name: 'Newsletter', member_count: 1 });

		const bad = await call(ctx, 'get_report_results', { spec: { entity: 'contacts', columns: ['nope'] } });
		expect(bad).toMatchObject({ ok: false, content: 'Unknown column "nope" for contacts.' });
		const hours = await call(ctx, 'get_report_results', { spec: { entity: 'companies', columns: ['name', 'hours_30d'] } });
		expect(hours.ok).toBe(false);
		expect(hours.content).toMatch(/Admins only: hours_30d/);
		expect((await call(ctx, 'get_report_results', { report: 'builtin:client-hours-trend' })).content).toMatch(/Admins only/);

		const metrics = await call(ctx, 'get_report_metrics', { entity: 'companies' });
		const keys = metrics.data.entities[0].columns.map((c: any) => c.key);
		expect(keys).toContain('name');
		expect(keys).not.toContain('hours_30d');
		const adminCtx = await toolCtx('admin');
		const adminMetrics = await call(adminCtx, 'get_report_metrics', { entity: 'companies' });
		expect(adminMetrics.data.entities[0].columns.map((c: any) => c.key)).toContain('hours_30d');
		const adminRun = await call(adminCtx, 'get_report_results', { report: 'builtin:client-hours-trend', params: { by: 'month' } });
		expect(adminRun.ok).toBe(true);

		// Saved, not pinned; Undo removes it while untouched.
		const lists = await count('SELECT COUNT(*) AS n FROM lists');
		const saved = await call(ctx, 'create_report_draft', { name: 'Segment sizes', spec: { entity: 'segments', columns: ['name', 'member_count'] } });
		expect(saved.ok).toBe(true);
		expect(saved.action?.status).toBe('applied');
		const reportId = Number(saved.action!.url!.split('/').pop());
		expect(await getReport(db, reportId)).toMatchObject({ name: 'Segment sizes', pinned: 0, created_by: ctx.user.id });
		expect(await count('SELECT COUNT(*) AS n FROM lists')).toBe(lists); // no group made
		const row = await actionForUser(db, saved.action!.id, ctx.user.id);
		await undoAction(ctx, row!, toolByName('create_report_draft') as WriteTool);
		expect(await getReport(db, reportId)).toBeNull();

		const refused = await call(ctx, 'create_report_draft', { name: 'Hours', spec: { entity: 'companies', columns: ['name', 'hours_30d'] } });
		expect(refused.ok).toBe(false);
		expect(await count('SELECT COUNT(*) AS n FROM reports')).toBe(0);
		expect(f.news).toBeGreaterThan(0);
	});
});

// --- API ---------------------------------------------------------------------------------

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('test', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, token?: string, opts: { params?: Record<string, string>; body?: unknown } = {}) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	const init: RequestInit = { headers };
	if (opts.body !== undefined) {
		init.method = 'POST';
		init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
	}
	return { request: new Request(url, init), platform: { env }, url, params: opts.params ?? {} } as any;
}

describe('/api/v1/reports', () => {
	it('needs a read key; draft-only keys are refused', async () => {
		expect((await listReportsGET(ev('/api/v1/reports'))).status).toBe(401);
		const draft = await makeKey('campaigns:draft');
		expect((await listReportsGET(ev('/api/v1/reports', draft))).status).toBe(403);
		expect((await runSpecPOST(ev('/api/v1/reports/run', draft, { body: { entity: 'segments', columns: ['name'] } }))).status).toBe(403);
	});

	it('lists and runs built-in and saved reports as a member', async () => {
		const f = await fixture();
		const key = await makeKey('read');
		const saved = await createReport(db, { name: 'Sizes', spec: { entity: 'segments', columns: ['name', 'member_count'] } }, admin);
		const hoursReport = await createReport(db, { name: 'Hours', spec: { entity: 'companies', columns: ['name', 'hours_30d'] } }, admin);

		const list = await (await listReportsGET(ev('/api/v1/reports', key))).json<any>();
		const ids = list.data.map((r: any) => r.id);
		expect(ids).toContain('builtin:campaign-performance');
		expect(ids).toContain(String(saved.id));
		expect(ids).not.toContain('builtin:client-hours-trend');
		expect(list.data.find((r: any) => r.id === String(hoursReport.id)).admin_only).toBe(true);

		const run = await runRefGET(ev(`/api/v1/reports/${saved.id}/run?limit=1`, key, { params: { ref: String(saved.id) } }));
		expect(run.status).toBe(200);
		const body = await run.json<any>();
		expect(body.data).toMatchObject({ report: String(saved.id), name: 'Sizes', truncated: true });
		expect(body.data.rows).toHaveLength(1);

		await db.prepare('INSERT INTO list_size_daily (day, list_id, members, subscribed) VALUES (?, ?, 3, 2)').bind(new Date().toISOString().slice(0, 10), f.news).run();
		const growth = await runRefGET(ev('/api/v1/reports/builtin:list-growth/run?by=day&p_measure=subscribed', key, { params: { ref: 'builtin:list-growth' } }));
		expect((await growth.json<any>()).data.rows[0]).toMatchObject({ total: 2 });

		const blocked = await runRefGET(ev(`/api/v1/reports/${hoursReport.id}/run`, key, { params: { ref: String(hoursReport.id) } }));
		expect(blocked.status).toBe(403);
		const adminBuiltIn = await runRefGET(ev('/api/v1/reports/builtin:client-hours-trend/run', key, { params: { ref: 'builtin:client-hours-trend' } }));
		expect(adminBuiltIn.status).toBe(403);
		expect((await runRefGET(ev('/api/v1/reports/999999/run', key, { params: { ref: '999999' } }))).status).toBe(404);
		expect((await runRefGET(ev('/api/v1/reports/builtin:nope/run', key, { params: { ref: 'builtin:nope' } }))).status).toBe(404);
		expect((await runRefGET(ev('/api/v1/reports/x/run', key, { params: { ref: 'x' } }))).status).toBe(400);
	});

	it('POST /run takes a spec; an invalid one is 400 with the validation message', async () => {
		await fixture();
		const key = await makeKey('read');
		const ok = await runSpecPOST(ev('/api/v1/reports/run', key, { body: { entity: 'segments', columns: ['name', 'member_count'] } }));
		expect(ok.status).toBe(200);
		// #705: only a counts; b is unsubscribed (subscribed = 0, not pending) and c is archived.
		expect((await ok.json<any>()).data.rows).toContainEqual({ name: 'Newsletter', member_count: 1 });

		const wrapped = await runSpecPOST(ev('/api/v1/reports/run', key, { body: { spec: { entity: 'segments', columns: ['name'] } } }));
		expect(wrapped.status).toBe(200);

		const bad = await runSpecPOST(ev('/api/v1/reports/run', key, { body: { entity: 'contacts', columns: ['nope'] } }));
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: 'Unknown column "nope" for contacts.' });
		expect((await runSpecPOST(ev('/api/v1/reports/run', key, { body: 'not json' }))).status).toBe(400);

		const sensitive = await runSpecPOST(ev('/api/v1/reports/run', key, { body: { entity: 'companies', columns: ['name', 'hours_30d'] } }));
		expect(sensitive.status).toBe(403);
		expect(await count('SELECT COUNT(*) AS n FROM reports')).toBe(0); // running saves nothing
	});
});
