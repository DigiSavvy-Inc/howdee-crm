// #453: reports engine foundation — time-group sort crash, per-card error isolation,
// rate sorting, the opener rule, deleted-step sends, recent buckets, decimal rates,
// the sent_at tie-break and the new campaign metrics.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { FINE_RATE_KEYS, reportPct } from '../src/lib/report-metrics';
import { parseReportSpec, utcWeekStart } from '../src/lib/report-spec';
import { formatCell, reportCsv } from '../src/lib/report-view';
import { builtInByKey, resolveParams, runBuiltIn } from '../src/lib/server/reports/builtins';
import { compileReportQuery, runReport } from '../src/lib/server/reports/engine';
import { createReport } from '../src/lib/server/reports/store';
import { SENDLOG_TYPE_SQL, sendLogWhere } from '../src/lib/server/sendlog-query';
import { load as loadHome } from '../src/routes/reports/+page.server';

const db = (env as { DB: D1Database }).DB;
const admin = { role: 'admin' as const };

const GMAIL = JSON.stringify({ Client: { Name: 'Gmail' }, UserAgent: 'Mozilla/5.0' });
const APPLE = JSON.stringify({ Client: { Name: 'Apple Mail', Family: 'Apple Mail' }, UserAgent: 'Mozilla/5.0 Apple Mail' });

let listId: number;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM reports'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare(`DELETE FROM lists WHERE name = 'r453 list'`)
	]);
	listId = await id(`INSERT INTO lists (name, kind) VALUES ('r453 list', 'list') RETURNING id`);
});

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await db.prepare(sql).bind(...binds).first<{ id: number }>();
	if (!row) throw new Error(sql);
	return row.id;
}

async function run(sql: string, ...binds: unknown[]): Promise<void> {
	await db.prepare(sql).bind(...binds).run();
}

type CampaignOpts = { daysAgo?: number; sentAt?: string; list?: number | null; automation?: number | null; step?: number | null };

async function campaign(subject: string, opts: CampaignOpts = {}): Promise<number> {
	const list = opts.list === undefined ? listId : opts.list;
	if (opts.sentAt) {
		return id(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, automation_id, automation_step_id, sent_at)
			 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, ?, ?, ?) RETURNING id`,
			subject,
			list,
			opts.automation ?? null,
			opts.step ?? null,
			opts.sentAt
		);
	}
	return id(
		`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, automation_id, automation_step_id, sent_at)
		 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, ?, ?, datetime('now', ?)) RETURNING id`,
		subject,
		list,
		opts.automation ?? null,
		opts.step ?? null,
		`-${opts.daysAgo ?? 1} days`
	);
}

/** `n` recipients of one status; returns their ids in insert order. */
async function recipients(campaignId: number, n: number, status: 'accepted' | 'error' = 'accepted'): Promise<number[]> {
	await run(
		`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
		 INSERT INTO recipients (campaign_id, email, status) SELECT ?, 'r453-' || ? || '-' || ? || '-' || i || '@x.example.net', ? FROM seq`,
		n,
		campaignId,
		campaignId,
		status,
		status
	);
	const rows = await db
		.prepare(`SELECT id FROM recipients WHERE campaign_id = ? AND status = ? ORDER BY id`)
		.bind(campaignId, status)
		.all<{ id: number }>();
	return (rows.results ?? []).map((row) => row.id);
}

async function event(campaignId: number, recipientId: number, type: string, detail: string | null = null): Promise<void> {
	await run(`INSERT INTO events (campaign_id, recipient_id, type, detail) VALUES (?, ?, ?, ?)`, campaignId, recipientId, type, detail);
}

/** A campaign of `sent` accepted recipients, the first `opens` of whom opened (human). */
async function withOpens(subject: string, sent: number, opens: number, opts: CampaignOpts = {}): Promise<number> {
	const camp = await campaign(subject, opts);
	const ids = sent ? await recipients(camp, sent) : [];
	for (const who of ids.slice(0, opens)) await event(camp, who, 'open', GMAIL);
	return camp;
}

function campaignSpec(extra: Record<string, unknown>) {
	return parseReportSpec({ entity: 'campaigns', filters: { match: 'all', rules: [] }, ...extra });
}

function homeEvent(platformEnv: unknown) {
	const url = new URL('https://crm.test/reports');
	return { request: new Request(url), url, params: {}, locals: { user: { id: 1, role: 'admin' } }, platform: { env: platformEnv } } as any;
}

describe('B1: time-grouped campaigns sorted by the group', () => {
	it('runs, sorts the buckets, and never emits ORDER BY g', async () => {
		await withOpens('This week', 4, 2, { daysAgo: 1 });
		await withOpens('Weeks ago', 4, 1, { daysAgo: 22 });
		for (const groupBy of ['week', 'month'] as const) {
			const spec = campaignSpec({ columns: ['open_rate', 'click_rate'], groupBy, sort: { key: groupBy, dir: 'desc' } });
			expect(compileReportQuery(spec, admin).sql).not.toMatch(/ORDER BY g\b/);
			const result = await runReport(db, spec, admin);
			const keys = result.rows.map((row) => String(row[groupBy]));
			expect(keys).toEqual([...keys].sort().reverse());
		}
		const weekly = await runReport(db, campaignSpec({ columns: ['open_rate'], groupBy: 'week', sort: { key: 'week', dir: 'desc' } }), admin);
		expect(weekly.rows.map((row) => row.open_rate)).toEqual([50, 25]);
	});

	it('a pinned week-grouped report sorted by week renders on the home page', async () => {
		await withOpens('This week', 4, 2, { daysAgo: 1 });
		const saved = await createReport(
			db,
			{
				name: 'r453 trend',
				pinned: true,
				spec: campaignSpec({ columns: ['open_rate'], groupBy: 'week', sort: { key: 'week', dir: 'desc' }, chart: 'line', limit: 52 })
			},
			admin
		);
		const home = await loadHome(homeEvent(env));
		const card = home.pinned.find((item) => item.id === saved.id);
		expect(card?.error).toBeNull();
		expect(card?.result?.rows).toEqual([expect.objectContaining({ open_rate: 50 })]);
	});

	it('one report failing in D1 shows an error on its card and the rest of the home page loads', async () => {
		await withOpens('Fine', 2, 1);
		const broken = await createReport(db, { name: 'r453 broken', pinned: true, spec: campaignSpec({ columns: ['subject', 'recipients'] }) }, admin);
		const fine = await createReport(
			db,
			{ name: 'r453 fine', pinned: true, spec: parseReportSpec({ entity: 'contacts', filters: { match: 'all', rules: [] }, columns: ['contacts'], chart: 'stat' }) },
			admin
		);
		const failing = new Proxy(db, {
			get(target, prop) {
				if (prop === 'prepare') {
					return (sql: string) => {
						if (sql.includes('FROM campaigns cp')) throw new Error('D1_ERROR: no such column: g');
						return target.prepare(sql);
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const home = await loadHome(homeEvent({ ...env, DB: failing }));
		const bad = home.pinned.find((item) => item.id === broken.id);
		const good = home.pinned.find((item) => item.id === fine.id);
		expect(bad?.result).toBeNull();
		expect(bad?.error).toBe("This report can't run: no such column: g");
		expect(good?.error).toBeNull();
		expect(good?.result).not.toBeNull();
		expect(home.library.length).toBeGreaterThan(0);
	});
});

describe('B4: sorting campaigns by a post-computed column', () => {
	beforeEach(async () => {
		await withOpens('Ten', 10, 1, { daysAgo: 1 });
		await withOpens('Sixty', 10, 6, { daysAgo: 2 });
		await withOpens('Thirty', 10, 3, { daysAgo: 3 });
		await withOpens('Hundred', 10, 10, { daysAgo: 4 });
		await withOpens('Nothing sent', 0, 0, { daysAgo: 5 });
	});

	it('orders by open rate, with no-value rows last in either direction', async () => {
		const desc = await runReport(db, campaignSpec({ columns: ['subject', 'open_rate'], sort: { key: 'open_rate', dir: 'desc' } }), admin);
		expect(desc.rows.map((row) => row.open_rate)).toEqual([100, 60, 30, 10, null]);
		const asc = await runReport(db, campaignSpec({ columns: ['subject', 'open_rate'], sort: { key: 'open_rate', dir: 'asc' } }), admin);
		expect(asc.rows.map((row) => row.open_rate)).toEqual([10, 30, 60, 100, null]);
	});

	it('a row limit keeps the real top N, and the total still counts every match', async () => {
		const top = await runReport(db, campaignSpec({ columns: ['subject', 'open_rate'], sort: { key: 'open_rate', dir: 'desc' }, limit: 3 }), admin);
		expect(top.rows.map((row) => row.subject)).toEqual(['Hundred', 'Sixty', 'Thirty']);
		expect(top.total).toBe(5);
		expect(top.truncated).toBe(true);
	});

	it('sorts by a rate or opens column that is not shown', async () => {
		const byOpens = await runReport(db, campaignSpec({ columns: ['subject'], sort: { key: 'opens', dir: 'desc' }, limit: 2 }), admin);
		expect(byOpens.rows.map((row) => row.subject)).toEqual(['Hundred', 'Sixty']);
	});
});

describe('B5: a clicker counts as an opener', () => {
	it('open rate counts clickers without a human open, and CTOR stays at or under 100 %', async () => {
		const camp = await campaign('Blocked images');
		const [human, clickOnly, proxyClick, proxyOnly] = await recipients(camp, 10);
		await event(camp, human!, 'open', GMAIL);
		await event(camp, human!, 'click');
		await event(camp, human!, 'click');
		await event(camp, clickOnly!, 'click');
		await event(camp, proxyClick!, 'open', APPLE);
		await event(camp, proxyClick!, 'click');
		await event(camp, proxyOnly!, 'open', APPLE);

		const result = await runReport(
			db,
			campaignSpec({ columns: ['subject', 'opens', 'clicks', 'total_opens', 'total_clicks', 'open_rate', 'click_rate', 'ctor'] }),
			admin
		);
		expect(result.rows[0]).toEqual({
			subject: 'Blocked images',
			opens: 3,
			clicks: 3,
			total_opens: 3,
			total_clicks: 4,
			open_rate: 30,
			click_rate: 30,
			ctor: 100
		});

		const weekly = await runReport(db, campaignSpec({ columns: ['opens', 'ctor'], groupBy: 'week' }), admin);
		expect(weekly.rows[0]).toMatchObject({ opens: 3, ctor: 100 });
	});
});

describe('B8: sends from a deleted automation step', () => {
	it('stay automation sends in reports and the send log, labelled (deleted step)', async () => {
		const automation = await id(`INSERT INTO automations (name, status) VALUES ('r453 drip', 'active') RETURNING id`);
		const gone = await withOpens('Gone step', 4, 2, { list: null, automation, step: null });
		const direct = await withOpens('Direct note', 1, 0, { list: null });

		const auto = await runReport(
			db,
			campaignSpec({ columns: ['subject', 'kind'], entityFilters: [{ field: 'kind', op: 'is', value: 'automation' }] }),
			admin
		);
		expect(auto.rows).toEqual([{ subject: 'Gone step', kind: 'automation' }]);
		const direct1 = await runReport(
			db,
			campaignSpec({ columns: ['subject', 'kind'], entityFilters: [{ field: 'kind', op: 'is', value: 'direct' }] }),
			admin
		);
		expect(direct1.rows).toEqual([{ subject: 'Direct note', kind: 'direct' }]);

		const def = builtInByKey('automation-email-performance')!;
		const builtIn = await runBuiltIn(db, def, resolveParams(def), admin);
		expect(builtIn.rows).toEqual([expect.objectContaining({ subject: 'Gone step (deleted step)', automation: 'r453 drip', open_rate: 50 })]);

		const kind = await db.prepare(`SELECT ${SENDLOG_TYPE_SQL} AS kind FROM campaigns c WHERE c.id = ?`).bind(gone).first<{ kind: string }>();
		expect(kind?.kind).toBe('automation');
		const base = { status: 'any', q: '', from: '', to: '' } as const;
		for (const [type, expected] of [
			['automation', [gone]],
			['direct', [direct]]
		] as const) {
			const { where, params } = sendLogWhere({ ...base, type });
			const rows = await db.prepare(`SELECT c.id AS id FROM campaigns c ${where} ORDER BY c.id`).bind(...params).all<{ id: number }>();
			expect((rows.results ?? []).map((row) => row.id)).toEqual(expected);
		}
	});
});

describe('B9: time-grouped specs with a row limit', () => {
	it('keep the most recent buckets, oldest first', async () => {
		for (let k = 0; k < 14; k++) await withOpens(`Week -${k}`, 2, 1, { daysAgo: 7 * k });
		const sentAt = async (subject: string) =>
			(await db.prepare(`SELECT sent_at FROM campaigns WHERE subject = ?`).bind(subject).first<{ sent_at: string }>())!.sent_at;
		const newest = utcWeekStart(await sentAt('Week -0'));
		const oldestKept = utcWeekStart(await sentAt('Week -11'));
		const dropped = utcWeekStart(await sentAt('Week -12'));

		const result = await runReport(db, campaignSpec({ columns: ['open_rate'], groupBy: 'week', limit: 12, chart: 'line' }), admin);
		const weeks = result.rows.map((row) => String(row.week));
		expect(weeks).toHaveLength(12);
		expect(weeks).toEqual([...weeks].sort());
		expect(weeks[0]).toBe(oldestKept);
		expect(weeks[11]).toBe(newest);
		expect(weeks).not.toContain(dropped);
		expect(result.total).toBe(14);
		expect(result.truncated).toBe(true);
	});
});

describe('B11: rates carry decimals', () => {
	it('reportPct: one decimal; unsubscribe / bounce / complaint keep two below 1 %', () => {
		expect(reportPct(1, 3)).toBe(33.3);
		expect(reportPct(1, 300)).toBe(0.3);
		expect(reportPct(1, 300, true)).toBe(0.33);
		expect(reportPct(1, 250, true)).toBe(0.4);
		expect(reportPct(4, 300, true)).toBe(1.3);
		expect(reportPct(0, 0)).toBeNull();
		expect([...FINE_RATE_KEYS].sort()).toEqual(['bounce_rate', 'complaint_rate', 'unsub_rate']);
	});

	it('small signals show instead of rounding to 0 %, in cells and CSV', async () => {
		const camp = await campaign('Big send');
		const ids = await recipients(camp, 300);
		await recipients(camp, 5, 'error');
		for (const who of ids.slice(0, 4)) await event(camp, who, 'open', GMAIL);
		await event(camp, ids[0]!, 'click');
		await event(camp, ids[10]!, 'unsubscribe');
		await event(camp, ids[11]!, 'bounce');
		await event(camp, ids[12]!, 'bounce');
		await event(camp, ids[13]!, 'spam');

		const result = await runReport(
			db,
			campaignSpec({
				columns: ['subject', 'recipients', 'rejected', 'open_rate', 'click_rate', 'unsub_rate', 'bounce_rate', 'spam', 'complaint_rate']
			}),
			admin
		);
		expect(result.rows[0]).toEqual({
			subject: 'Big send',
			recipients: 300,
			rejected: 5,
			open_rate: 1.3,
			click_rate: 0.3,
			unsub_rate: 0.33,
			bounce_rate: 0.67,
			spam: 1,
			complaint_rate: 0.33
		});
		expect(result.columns.find((column) => column.key === 'recipients')?.label).toBe('Sent');
		expect(result.columns.find((column) => column.key === 'rejected')?.label).toBe('Rejected');
		expect(result.columns.find((column) => column.key === 'complaint_rate')?.format).toBe('pct');
		expect(formatCell(0.33, 'pct')).toBe('0.33%');
		const csv = reportCsv(result.columns, result.rows);
		// #456: rates are plain numbers in the CSV; the unit is in the header.
		expect(csv).toContain('Big send,300,5,1.3,0.3,0.33,0.67,1,0.33');
	});
});

describe('P9: equal sent_at', () => {
	it('breaks the tie by id, newest first', async () => {
		const first = await campaign('Same time A', { sentAt: '2026-10-01 09:00:00' });
		const second = await campaign('Same time B', { sentAt: '2026-10-01 09:00:00' });
		for (const sort of [undefined, { key: 'sent_at', dir: 'desc' }]) {
			const spec = campaignSpec({ columns: ['subject', 'sent_at'], ...(sort ? { sort } : {}), limit: 1 });
			expect(compileReportQuery(spec, admin).sql).toContain('cp.id DESC');
			const result = await runReport(db, spec, admin);
			expect(result.recordIds).toEqual([second]);
		}
		const all = await runReport(db, campaignSpec({ columns: ['subject'], sort: { key: 'sent_at', dir: 'desc' } }), admin);
		expect(all.recordIds).toEqual([second, first]);
	});
});
