import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import {
	BUILT_IN_REPORTS,
	builtInByKey,
	builtInsFor,
	resolveParams,
	runBuiltIn,
	type BuiltInDef
} from '../src/lib/server/reports/builtins';
import type { ReportResult } from '../src/lib/server/reports/engine';
import { getReport } from '../src/lib/server/reports/store';
import { load as loadBuiltIn, actions as builtInActions } from '../src/routes/reports/b/[key]/+page.server';
import { load as loadHome } from '../src/routes/reports/+page.server';

const db = (env as { DB: D1Database }).DB;
const admin = { role: 'admin' as const };
const member = { role: 'member' as const };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM reports'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM engagement_tier_daily'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM zoho_invoices'),
		db.prepare('DELETE FROM company_zoho_contacts'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM companies'),
		db.prepare('DELETE FROM lists'),
		db.prepare(`DELETE FROM integration_secrets WHERE provider = 'zoho_books'`),
		db.prepare(`DELETE FROM app_state WHERE key = 'zoho_books_org'`),
		db.prepare(`DELETE FROM users WHERE github_login = 'r357-member'`)
	]);
});

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await db.prepare(sql).bind(...binds).first<{ id: number }>();
	if (!row) throw new Error(sql);
	return row.id;
}

async function run(sql: string, ...binds: unknown[]): Promise<void> {
	await db.prepare(sql).bind(...binds).run();
}

const ago = (days: number) => `-${days} days`;

type Fixture = {
	ann: number;
	bob: number;
	cat: number;
	dan: number;
	eve: number;
	acme: number;
	beta: number;
	newsletter: number;
	c1: number;
	c2: number;
	c3: number;
};

const APPLE = JSON.stringify({ Client: { Name: 'Apple Mail', Family: 'Apple Mail' }, UserAgent: 'Mozilla/5.0 Apple Mail' });
const GMAIL = JSON.stringify({ Client: { Name: 'Gmail' }, UserAgent: 'Mozilla/5.0' });

async function contact(email: string, opts: { source: string; createdDaysAgo: number; meta?: string; company?: number }): Promise<number> {
	return id(
		`INSERT INTO contacts (email, name, source, meta, company_id, subscribed, created_at)
		 VALUES (?, ?, ?, ?, ?, 1, datetime('now', ?)) RETURNING id`,
		email,
		email.split('@')[0],
		opts.source,
		opts.meta ?? null,
		opts.company ?? null,
		ago(opts.createdDaysAgo)
	);
}

async function engagement(
	contactId: number,
	e: {
		sent: number;
		opens: number;
		proxy?: number;
		unique: number;
		clicks?: number;
		replies?: number;
		score: number;
		tier: string;
		prevTier?: string;
		changedDaysAgo?: number;
		lastDaysAgo?: number | null;
	}
) {
	const last = e.lastDaysAgo == null ? null : ago(e.lastDaysAgo);
	await run(
		`INSERT INTO contact_engagement (
		   contact_id, sent_count, open_count, proxy_open_count, unique_open_campaigns, click_count, unique_click_campaigns,
		   reply_count, open_rate, click_rate, score, tier, prev_tier, tier_changed_at, last_open_at, last_click_at, last_reply_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
		   CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END,
		   CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END,
		   CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END,
		   CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
		contactId,
		e.sent,
		e.opens,
		e.proxy ?? 0,
		e.unique,
		e.clicks ?? 0,
		e.clicks ? 1 : 0,
		e.replies ?? 0,
		e.sent ? e.unique / e.sent : null,
		e.sent && e.clicks ? 1 / e.sent : null,
		e.score,
		e.tier,
		e.prevTier ?? null,
		e.changedDaysAgo == null ? null : 1,
		e.changedDaysAgo == null ? null : ago(e.changedDaysAgo),
		last,
		last,
		last,
		last,
		last,
		last
	);
}

async function seed(): Promise<Fixture> {
	const acme = await id(`INSERT INTO companies (name) VALUES ('Acme') RETURNING id`);
	const beta = await id(`INSERT INTO companies (name) VALUES ('Beta') RETURNING id`);
	await id(`INSERT INTO companies (name) VALUES ('Gamma') RETURNING id`);
	await run(
		`INSERT INTO company_metrics (company_id, hours_7d, hours_30d, hours_90d, hours_total, issues_open, issues_closed, issues_opened_30d, issues_closed_30d, last_issue_at)
		 VALUES (?, 2, 10, 40, 100, 5, 9, 3, 1, datetime('now', '-3 days'))`,
		acme
	);
	await run(
		`INSERT INTO company_metrics (company_id, hours_7d, hours_30d, hours_90d, hours_total, issues_open, issues_closed, issues_opened_30d, issues_closed_30d)
		 VALUES (?, 0, 0, 2, 5, 0, 4, 7, 4)`,
		beta
	);

	const ann = await contact('ann@r357.test', { source: 'csv', createdDaysAgo: 30, meta: '{"industry":"saas"}', company: acme });
	const bob = await contact('bob@r357.test', { source: 'csv', createdDaysAgo: 60, meta: '{"industry":"saas"}', company: acme });
	const cat = await contact('cat@r357.test', { source: 'api', createdDaysAgo: 10, meta: '{"industry":"retail"}' });
	const dan = await contact('dan@r357.test', { source: 'webinar', createdDaysAgo: 2 });
	const eve = await contact('eve@r357.test', { source: 'csv', createdDaysAgo: 800 });

	await engagement(ann, { sent: 5, opens: 0, unique: 0, score: 5, tier: 'cold', prevTier: 'warm', changedDaysAgo: 5, lastDaysAgo: null });
	await engagement(bob, { sent: 4, opens: 4, unique: 3, clicks: 2, replies: 1, score: 80, tier: 'hot', lastDaysAgo: 1 });
	await engagement(cat, { sent: 3, opens: 2, proxy: 2, unique: 1, score: 20, tier: 'cool', lastDaysAgo: 100 });
	await engagement(dan, { sent: 1, opens: 0, unique: 0, score: 0, tier: 'new', lastDaysAgo: null });
	await engagement(eve, { sent: 3, opens: 0, unique: 0, score: 2, tier: 'cold', lastDaysAgo: 50 });

	const clientTag = await id(`INSERT INTO lists (name, kind) VALUES ('Client', 'tag') RETURNING id`);
	await run(`INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)`, clientTag, eve);
	const newsletter = await id(`INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id`);
	for (const who of [ann, bob, cat]) await run(`INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)`, newsletter, who);

	const campaign = (subject: string, daysAgo: number, listId: number | null, automation?: { id: number; step: number }) =>
		id(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, automation_id, automation_step_id, sent_at)
			 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, ?, ?, datetime('now', ?)) RETURNING id`,
			subject,
			listId,
			automation?.id ?? null,
			automation?.step ?? null,
			ago(daysAgo)
		);
	const recipient = (campaignId: number, contactId: number, email: string) =>
		id(
			`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted') RETURNING id`,
			campaignId,
			contactId,
			email
		);
	const event = (campaignId: number, recipientId: number, contactId: number, type: string, daysAgo: number, detail: string | null = null) =>
		run(
			`INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
			campaignId,
			recipientId,
			contactId,
			type,
			detail,
			ago(daysAgo)
		);

	const c1 = await campaign('Spring news', 10, newsletter);
	await run(`INSERT INTO campaign_audiences (campaign_id, list_id, mode, position) VALUES (?, ?, 'include', 0)`, c1, newsletter);
	const r1a = await recipient(c1, ann, 'ann@r357.test');
	const r1b = await recipient(c1, bob, 'bob@r357.test');
	await recipient(c1, cat, 'cat@r357.test');
	await event(c1, r1a, ann, 'delivery', 10);
	await event(c1, r1b, bob, 'delivery', 10);
	await event(c1, r1b, bob, 'open', 9, GMAIL);
	await event(c1, r1b, bob, 'click', 9);

	const c2 = await campaign('Old news', 200, newsletter);
	await run(`INSERT INTO campaign_audiences (campaign_id, list_id, mode, position) VALUES (?, ?, 'include', 0)`, c2, newsletter);
	const r2b = await recipient(c2, bob, 'bob@r357.test');
	const r2c = await recipient(c2, cat, 'cat@r357.test');
	await event(c2, r2b, bob, 'open', 199, GMAIL);
	await event(c2, r2c, cat, 'open', 100, APPLE);

	const automation = await id(`INSERT INTO automations (name, status) VALUES ('Welcome drip', 'active') RETURNING id`);
	const step = await id(
		`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
		 VALUES (?, 1, 0, 'Welcome!', 'x', 'f@x.example.net', 'email') RETURNING id`,
		automation
	);
	const c3 = await campaign('Welcome!', 5, null, { id: automation, step });
	await recipient(c3, ann, 'ann@r357.test');
	const r3b = await recipient(c3, bob, 'bob@r357.test');
	await event(c3, r3b, bob, 'open', 2, GMAIL);

	const site = await id(`INSERT INTO tracking_sites (name, domain, site_key) VALUES ('DS', 'r357.test', 'sk_r357') RETURNING id`);
	const view = (contactId: number, path: string, daysAgo: number, referrer: string | null, utm: string | null) =>
		run(
			`INSERT INTO site_events (site_id, contact_id, kind, name, path, referrer_host, utm, occurred_at)
			 VALUES (?, ?, 'pageview', 'pageview', ?, ?, ?, datetime('now', ?))`,
			site,
			contactId,
			path,
			referrer,
			utm,
			ago(daysAgo)
		);
	await view(cat, '/pricing', 3, 'google.com', '{"source":"newsletter","campaign":"spring"}');
	await view(bob, '/blog/post', 5, null, null);
	await view(bob, '/pricing', 40, 'twitter.com', null);

	const stage = async (name: string) => (await db.prepare(`SELECT id FROM pipeline_stages WHERE name = ?`).bind(name).first<{ id: number }>())!.id;
	const lead = await stage('Lead');
	const won = await stage('Won');
	await run(`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 1000, datetime('now', '-30 days'))`, ann, lead);
	await run(`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 5000, datetime('now', '-2 days'))`, bob, won);
	const move = (contactId: number, from: number | null, to: number, daysAgo: number) =>
		run(
			`INSERT INTO pipeline_history (contact_id, from_stage_id, to_stage_id, actor_kind, created_at) VALUES (?, ?, ?, 'user', datetime('now', ?))`,
			contactId,
			from,
			to,
			ago(daysAgo)
		);
	await move(ann, null, lead, 10);
	await move(bob, null, lead, 20);
	await move(bob, lead, won, 2);
	await move(ann, lead, lead, 1); // a stage-deletion system row (from = to) isn't a move

	for (const [day, hot, cold] of [
		[2, 3, 1],
		[1, 2, 2]
	] as const) {
		await run(`INSERT INTO engagement_tier_daily (day, tier, n) VALUES (date('now', ?), 'hot', ?)`, ago(day), hot);
		await run(`INSERT INTO engagement_tier_daily (day, tier, n) VALUES (date('now', ?), 'cold', ?)`, ago(day), cold);
	}

	return { ann, bob, cat, dan, eve, acme, beta, newsletter, c1, c2, c3 };
}

async function connectZoho(acme: number) {
	await run(`INSERT INTO integration_secrets (provider, blob, last4, set_at) VALUES ('zoho_books', 'v1.SEALED', 'abcd', datetime('now'))`);
	await run(`INSERT INTO app_state (key, value) VALUES ('zoho_books_org', ?)`, JSON.stringify({ id: '1', name: 'Org', currency_code: 'USD' }));
	await run(`INSERT INTO company_zoho_contacts (company_id, zoho_contact_id, contact_name) VALUES (?, 'z1', 'Acme Ltd')`, acme);
	await run(`UPDATE company_metrics SET invoiced_12m = 12000 WHERE company_id = ?`, acme);
	await run(
		`INSERT INTO zoho_invoices (invoice_id, zoho_contact_id, status, date, total, balance, currency_code)
		 VALUES ('i1', 'z1', 'paid', date('now', '-10 days'), 4000, 0, 'USD'),
		        ('i2', 'z1', 'draft', date('now', '-10 days'), 9999, 9999, 'USD'),
		        ('i3', 'z1', 'paid', date('now', '-200 days'), 7000, 0, 'USD')`
	);
}

function def(key: string): BuiltInDef {
	const found = builtInByKey(key);
	if (!found) throw new Error(`missing built-in ${key}`);
	return found;
}

async function report(key: string, params: Record<string, string> = {}, viewer: { role: 'admin' | 'member' } = admin): Promise<ReportResult> {
	const d = def(key);
	const source = new URLSearchParams(Object.entries(params).map(([k, v]) => [`p_${k}`, v]));
	return await runBuiltIn(db, d, resolveParams(d, source), viewer);
}

const keys = (result: ReportResult) => result.columns.map((column) => column.key);
const col = (result: ReportResult, key: string) => result.rows.map((row) => row[key]);

async function adminId(): Promise<number> {
	return id(`SELECT id FROM users WHERE github_login = 'ourco-admin'`);
}

function pageEvent(path: string, role: 'admin' | 'member', params: Record<string, string>, userId = 1) {
	const url = new URL(`https://crm.test${path}`);
	return { request: new Request(url), url, params, locals: { user: { id: userId, role } }, platform: { env } } as any;
}

describe('built-in library', () => {
	it('every built-in has a name, description, folder and chart, and a unique key', () => {
		const seen = new Set<string>();
		for (const report of BUILT_IN_REPORTS) {
			expect(report.name).toBeTruthy();
			expect(report.description).toBeTruthy();
			expect(report.folder).toBeTruthy();
			expect(['table', 'bar', 'line', 'stat', 'heatmap']).toContain(report.chart);
			expect(report.spec(resolveParams(report), admin).chart ?? 'table').toBe(report.chart);
			expect(seen.has(report.key)).toBe(false);
			seen.add(report.key);
		}
		expect(BUILT_IN_REPORTS.length).toBeGreaterThanOrEqual(26);
	});

	it('renders every built-in against an empty DB', async () => {
		await connectZohoEmpty();
		for (const report of BUILT_IN_REPORTS) {
			const result = await runBuiltIn(db, report, resolveParams(report), admin);
			expect(result.columns.length, report.key).toBeGreaterThan(0);
			expectEmptyRows(report.key, result.rows);
			const page = await loadBuiltIn(pageEvent(`/reports/b/${report.key}`, 'admin', { key: report.key }));
			expect(page.error, report.key).toBeNull();
			expectEmptyRows(report.key, page.result?.rows);
		}
	});

	// #457: best-send-times always returns the full zero-filled 7 x 24 grid, even on an empty DB.
	function expectEmptyRows(key: string, rows: Record<string, unknown>[] | undefined) {
		// #468: one row per rule of the seeded Lead score, nothing awarded.
		if (key === 'score-rule-activity') {
			expect(rows!.length, key).toBeGreaterThan(0);
			return expect(rows!.every((r) => r.awarded === 0 && r.contacts === 0 && r.share === null), key).toBe(true);
		}
		if (key !== 'best-send-times') return expect(rows, key).toEqual([]);
		expect(rows, key).toHaveLength(168);
		expect(rows!.every((r) => r.count === 0 && r.pct === null), key).toBe(true);
		expect(rows![0], key).toMatchObject({ weekday: 'Mon', hour: 0 });
		expect(rows![167], key).toMatchObject({ weekday: 'Sun', hour: 23 });
	}

	async function connectZohoEmpty() {
		await run(`INSERT INTO integration_secrets (provider, blob, last4, set_at) VALUES ('zoho_books', 'v1.SEALED', 'abcd', datetime('now'))`);
		await run(`INSERT INTO app_state (key, value) VALUES ('zoho_books_org', '{"id":"1","name":"Org","currency_code":"USD"}')`);
	}
});

describe('email & campaigns', () => {
	it('campaign performance: campaigns in range, newest first, with rates', async () => {
		const f = await seed();
		const result = await report('campaign-performance');
		expect(keys(result)).toEqual(['subject', 'recipients', 'rejected', 'delivered', 'open_rate', 'click_rate', 'ctor', 'unsub_rate', 'bounce_rate', 'spam', 'replies', 'sent_at']);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({ subject: 'Spring news', recipients: 3, rejected: 0, delivered: 2, open_rate: 33.3, click_rate: 33.3, ctor: 100 });
		expect(result.recordIds).toEqual([f.c1]);
		const year = await report('campaign-performance', { range: '12m' });
		expect(col(year, 'subject')).toEqual(['Spring news', 'Old news']);
	});

	it('campaign comparison: last campaigns as a bar chart of open rate', async () => {
		await seed();
		const result = await report('campaign-comparison');
		expect(keys(result)).toEqual(['subject', 'open_rate', 'click_rate', 'recipients', 'sent_at']);
		expect(col(result, 'subject')).toEqual(['Spring news', 'Old news']);
		expect(result.chartSeries?.yKey).toBe('open_rate');
		expect(result.chartSeries?.points.map((point) => point.y)).toEqual([33.3, 50]);
	});

	it('open & click rate trend: weekly, with automations as their own series', async () => {
		const f = await seed();
		// #455: automation recipients count from their first delivery / bounce event.
		await run(
			`INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at)
			 SELECT campaign_id, id, contact_id, 'delivery', '{}', datetime('now', '-3 days') FROM recipients WHERE campaign_id = ?`,
			f.c3
		);
		const result = await report('rate-trend');
		expect(keys(result)).toEqual(['week', 'open_rate', 'click_rate', 'automation_open_rate', 'automation_click_rate', 'sent', 'automation_sent']);
		const weeks = col(result, 'week') as string[];
		expect([...weeks].sort()).toEqual(weeks);
		expect(result.rows.some((row) => row.open_rate === 33.3 && row.click_rate === 33.3)).toBe(true);
		expect(result.rows.some((row) => row.open_rate === 50)).toBe(true);
		expect(result.rows.some((row) => row.automation_open_rate === 50)).toBe(true);
		expect(result.chartSeries?.xKey).toBe('week');
		// #454: all four rates are chart series.
		expect(result.chartSeries?.yKeys).toEqual(['open_rate', 'click_rate', 'automation_open_rate', 'automation_click_rate']);
	});

	it('automation email performance: one row per step with the automation name', async () => {
		const f = await seed();
		const result = await report('automation-email-performance');
		expect(keys(result)).toEqual(['subject', 'automation', 'recipients', 'rejected', 'delivered', 'open_rate', 'click_rate', 'ctor', 'unsub_rate', 'bounce_rate', 'spam', 'replies']);
		expect(result.rows).toEqual([
			expect.objectContaining({ subject: 'Welcome!', automation: 'Welcome drip', recipients: 2, open_rate: 50, click_rate: 0 })
		]);
		expect(result.recordIds).toEqual([f.c3]);
	});

	it('best send times: people who open and click, by weekday and hour (#457: full grid)', async () => {
		await seed();
		const result = await report('best-send-times');
		expect(keys(result)).toEqual(['weekday', 'hour', 'count', 'pct']);
		expect(result.rows).toHaveLength(168);
		// Only bob: his c1 open + click (9 days ago) and c3 open (2 days ago) — one person per
		// slot (normally one slot; a DST change in between can split it in two). cat's proxy
		// open and the 199-day open aren't in the window.
		const counts = (col(result, 'count') as number[]).filter((n) => n > 0);
		expect(counts.length).toBeGreaterThanOrEqual(1);
		expect(counts.every((n) => n === 1)).toBe(true);
		expect(result.heatmap?.total).toBe(1);
		expect(result.secondary?.rows.every((row) => row.count === 1 && row.pct === 100)).toBe(true);
		const short = await report('best-send-times', { days: '30' });
		expect(short.heatmap?.total).toBe(1);
	});
});

describe('contacts & engagement', () => {
	it('most active contacts: top by engagement score', async () => {
		const f = await seed();
		const result = await report('most-active-contacts');
		expect(keys(result)).toEqual(['email', 'name', 'engagement_score', 'opens', 'clicks', 'replies', 'site_visits', 'days_since_engagement', 'last_site_visit']);
		expect(result.rows[0]).toMatchObject({ email: 'bob@r357.test', engagement_score: 80, opens: 4, clicks: 2, replies: 1, site_visits: 2 });
		expect(result.recordIds?.[0]).toBe(f.bob);
		expect(col(result, 'engagement_score')).toEqual([80, 20, 5, 2, 0]);
	});

	it('least active contacts: lowest open rate, then the oldest last engagement', async () => {
		await seed();
		const result = await report('least-active-contacts');
		expect(keys(result)).toEqual(['email', 'name', 'sent', 'open_rate', 'click_rate', 'days_since_engagement', 'last_open']);
		// ann and eve are both 0%: ann never engaged, so she comes first. dan has 1 send and is left out.
		expect(col(result, 'email')).toEqual(['ann@r357.test', 'eve@r357.test', 'cat@r357.test', 'bob@r357.test']);
	});

	it('below an open-rate threshold: X% and N sends are editable', async () => {
		await seed();
		const result = await report('below-open-rate');
		expect(keys(result)).toEqual(['email', 'name', 'sent', 'unique_opens', 'open_rate', 'last_open']);
		expect(col(result, 'email').sort()).toEqual(['ann@r357.test', 'eve@r357.test']);
		const wider = await report('below-open-rate', { rate: '50' });
		expect(col(wider, 'email').sort()).toEqual(['ann@r357.test', 'cat@r357.test', 'eve@r357.test']);
		const stricter = await report('below-open-rate', { sends: '5' });
		expect(col(stricter, 'email')).toEqual(['ann@r357.test']);
		// Junk falls back to the default, out-of-range is clamped: rate 20%, sends 1 (dan has one send).
		const junk = await report('below-open-rate', { rate: 'abc', sends: '-4' });
		expect(col(junk, 'email').sort()).toEqual(['ann@r357.test', 'dan@r357.test', 'eve@r357.test']);
	});

	it('clients not opening: company or Client tag, low open rate or no recent open', async () => {
		await seed();
		const result = await report('clients-not-opening');
		expect(keys(result)).toEqual(['email', 'name', 'company', 'sent', 'unique_opens', 'open_rate', 'last_open']);
		expect(col(result, 'email').sort()).toEqual(['ann@r357.test', 'eve@r357.test']);
		expect(result.rows.find((row) => row.email === 'ann@r357.test')?.company).toBe('Acme');
		// bob opened a day ago at 75%: under an 80% threshold he matches too.
		const lax = await report('clients-not-opening', { rate: '80' });
		expect(col(lax, 'email')).toContain('bob@r357.test');
	});

	it('never opened: 3+ sends and no real opens (proxy opens excluded)', async () => {
		await seed();
		const result = await report('never-opened');
		expect(keys(result)).toEqual(['email', 'name', 'sent', 'opens', 'clicks', 'created']);
		expect(col(result, 'email').sort()).toEqual(['ann@r357.test', 'cat@r357.test', 'eve@r357.test']);
		expect(col(result, 'opens')).toEqual([0, 0, 0]);
	});

	it('going cold: moved down a tier in 30 days', async () => {
		const f = await seed();
		const result = await report('going-cold');
		expect(keys(result)).toEqual(['email', 'name', 'prev_tier', 'tier', 'tier_changed_at', 'score']);
		expect(result.rows).toEqual([expect.objectContaining({ email: 'ann@r357.test', prev_tier: 'Warm', tier: 'Cold' })]);
		expect(result.recordIds).toEqual([f.ann]);
	});

	it('engagement tier mix over time: one row per snapshot day, charted tier is a param', async () => {
		await seed();
		const result = await report('tier-mix');
		expect(keys(result)).toEqual(['day', 'hot', 'warm', 'cool', 'cold', 'never', 'new']);
		expect(col(result, 'hot')).toEqual([3, 2]);
		expect(col(result, 'warm')).toEqual([0, 0]);
		expect(result.chartSeries?.yKey).toBe('hot');
		const cold = await report('tier-mix', { tier: 'cold' });
		expect(cold.chartSeries?.yKey).toBe('cold');
		expect(cold.chartSeries?.points.map((point) => point.y)).toEqual([1, 2]);
	});

	it('new contacts by week: contacts created in 12 months, by UTC week', async () => {
		await seed();
		const result = await report('new-contacts-by-week');
		expect(keys(result)).toEqual(['week', 'contacts']);
		expect((col(result, 'contacts') as number[]).reduce((a, b) => a + b, 0)).toBe(4);
	});

	it('new contacts by source: counted per source in the range', async () => {
		await seed();
		const result = await report('new-contacts-by-source');
		expect(keys(result)).toEqual(['source', 'contacts']);
		expect(result.rows[0]).toEqual({ source: 'csv', contacts: 2 });
		const week = await report('new-contacts-by-source', { range: '7d' });
		expect(week.rows).toEqual([{ source: 'webinar', contacts: 1 }]);
	});

	it('breakdown by custom field: asks for a field, then counts each value', async () => {
		await seed();
		const empty = await report('custom-field-breakdown');
		expect(keys(empty)).toEqual(['value', 'contacts', 'open_rate']);
		expect(empty.rows).toEqual([]);
		const result = await report('custom-field-breakdown', { field: 'industry' });
		expect(keys(result)).toEqual(['field:industry', 'contacts', 'open_rate']);
		expect(result.rows[0]).toMatchObject({ 'field:industry': 'saas', contacts: 2 });
		expect(result.rows[0].open_rate).toBe(33.3);
		const bad = await report('custom-field-breakdown', { field: "x'); DROP" });
		expect(bad.rows).toEqual([]);
	});
});

describe('site activity', () => {
	it('top pages: views and unique contacts', async () => {
		await seed();
		const result = await report('top-pages');
		expect(keys(result)).toEqual(['path', 'views', 'unique_contacts']);
		expect(result.rows).toHaveLength(2);
		expect(result.rows.find((row) => row.path === '/pricing')).toEqual({ path: '/pricing', views: 1, unique_contacts: 1 });
		const quarter = await report('top-pages', { range: '90d' });
		expect(quarter.rows[0]).toEqual({ path: '/pricing', views: 2, unique_contacts: 2 });
	});

	it('high-intent visitors: path patterns and window are params', async () => {
		await seed();
		const result = await report('high-intent-visitors');
		expect(keys(result)).toEqual(['email', 'name', 'site_visits', 'last_site_visit', 'engagement_score', 'pipeline_stage']);
		expect(col(result, 'email')).toEqual(['cat@r357.test']);
		const blog = await report('high-intent-visitors', { paths: '/blog' });
		expect(col(blog, 'email')).toEqual(['bob@r357.test']);
		const wider = await report('high-intent-visitors', { days: '60' });
		expect(col(wider, 'email').sort()).toEqual(['bob@r357.test', 'cat@r357.test']);
	});

	it('visiting but not opening: visits in 30 days, no open in 60', async () => {
		await seed();
		const result = await report('visiting-not-opening');
		expect(keys(result)).toEqual(['email', 'name', 'site_visits', 'last_site_visit', 'last_open', 'engagement_tier']);
		expect(col(result, 'email')).toEqual(['cat@r357.test']);
		const lenient = await report('visiting-not-opening', { open_days: '1' });
		expect(col(lenient, 'email').sort()).toEqual(['bob@r357.test', 'cat@r357.test']);
	});

	it('traffic sources: by referrer or UTM', async () => {
		await seed();
		const result = await report('traffic-sources');
		expect(keys(result)).toEqual(['referrer_host', 'views', 'unique_contacts']);
		expect(result.rows.find((row) => row.referrer_host === 'google.com')).toMatchObject({ views: 1 });
		const utm = await report('traffic-sources', { by: 'utm_source' });
		expect(keys(utm)).toEqual(['utm_source', 'views', 'unique_contacts']);
		expect(utm.rows.find((row) => row.utm_source === 'newsletter')).toMatchObject({ views: 1 });
		const campaign = await report('traffic-sources', { by: 'utm_campaign', range: '90d' });
		expect(campaign.rows.find((row) => row.utm_campaign === 'spring')).toMatchObject({ views: 1 });
	});
});

describe('segments & lists', () => {
	it('segment health: members, rates and campaigns in the last 90 days', async () => {
		const f = await seed();
		const result = await report('segment-health');
		expect(keys(result)).toEqual(['name', 'member_count', 'subscribed_count', 'avg_open_rate', 'avg_click_rate', 'campaigns_sent', 'campaign_open_rate']);
		const row = result.rows.find((item) => item.name === 'Newsletter');
		// Old news (200 days) is left out: one campaign, 1 human open of 3 accepted.
		expect(row).toMatchObject({ member_count: 3, subscribed_count: 3, campaigns_sent: 1, campaign_open_rate: 33.3 });
		expect(result.columns.find((column) => column.key === 'campaigns_sent')?.label).toBe('Campaigns (90 days)');
		expect(result.recordIds).toContain(f.newsletter);
	});
});

describe('pipeline', () => {
	it('pipeline by stage: cards per stage, value only for admins', async () => {
		await seed();
		const result = await report('pipeline-by-stage');
		expect(keys(result)).toEqual(['pipeline_stage', 'cards', 'pipeline_value']);
		expect(result.rows.find((row) => row.pipeline_stage === 'Won')).toEqual({ pipeline_stage: 'Won', cards: 1, pipeline_value: 5000 });
		const asMember = await report('pipeline-by-stage', {}, member);
		expect(keys(asMember)).toEqual(['pipeline_stage', 'cards']);
	});

	it('stage aging: open cards, longest in stage first, with the contact', async () => {
		const f = await seed();
		const result = await report('stage-aging');
		expect(keys(result)).toEqual(['contact', 'email', 'pipeline_stage', 'avg_days_in_stage', 'pipeline_value']);
		expect(result.rows).toEqual([expect.objectContaining({ email: 'ann@r357.test', pipeline_stage: 'Lead', avg_days_in_stage: 30 })]);
		expect(result.recordIds).toEqual([f.ann]);
		const asMember = await report('stage-aging', {}, member);
		expect(keys(asMember)).not.toContain('pipeline_value');
	});

	it('pipeline movement: moves per destination stage in the range', async () => {
		await seed();
		const result = await report('pipeline-movement');
		expect(keys(result)).toEqual(['stage', 'kind', 'moves', 'contacts', 'value']);
		expect(result.rows).toEqual([
			{ stage: 'Lead', kind: 'open', moves: 2, contacts: 2, value: 6000 },
			{ stage: 'Won', kind: 'won', moves: 1, contacts: 1, value: 5000 }
		]);
		const week = await report('pipeline-movement', { range: '7d' });
		expect(week.rows).toEqual([{ stage: 'Won', kind: 'won', moves: 1, contacts: 1, value: 5000 }]);
		const asMember = await report('pipeline-movement', {}, member);
		expect(keys(asMember)).toEqual(['stage', 'kind', 'moves', 'contacts']);
	});
});

describe('clients & integrations', () => {
	it('clients by time spent: Timing hours, admins only', async () => {
		await seed();
		const result = await report('clients-by-time');
		expect(keys(result)).toEqual(['name', 'hours_30d', 'hours_90d', 'hours_total']);
		expect(col(result, 'name')).toEqual(['Acme', 'Beta']);
		await expect(report('clients-by-time', {}, member)).rejects.toThrow(/admins only/i);
	});

	it('clients by GitHub activity: issues opened first', async () => {
		await seed();
		const result = await report('clients-by-github');
		expect(keys(result)).toEqual(['name', 'issues_opened_30d', 'issues_closed_30d', 'issues_open', 'last_issue_at']);
		expect(col(result, 'name')).toEqual(['Beta', 'Acme']);
		expect(result.rows[0]).toMatchObject({ issues_opened_30d: 7, issues_open: 0 });
	});

	it('effort vs engagement: hours next to open rate and last reply', async () => {
		await seed();
		const result = await report('effort-vs-engagement');
		expect(keys(result)).toEqual(['name', 'hours_90d', 'contact_count', 'avg_open_rate', 'last_reply']);
		const acme = result.rows[0]!;
		expect(acme).toMatchObject({ name: 'Acme', hours_90d: 40, contact_count: 2 });
		expect(acme.avg_open_rate).toBe(37.5);
		expect(acme.last_reply).toBeTruthy();
		expect(result.rows[1]).toMatchObject({ name: 'Beta', last_reply: null });
	});

	it('revenue per hour: hidden until Zoho is connected, then invoiced 90 days ÷ hours 90 days', async () => {
		const f = await seed();
		expect((await builtInsFor(db, admin)).map((report) => report.key)).not.toContain('revenue-per-hour');
		await connectZoho(f.acme);
		expect((await builtInsFor(db, admin)).map((report) => report.key)).toContain('revenue-per-hour');
		expect((await builtInsFor(db, member)).map((report) => report.key)).not.toContain('revenue-per-hour');
		const result = await report('revenue-per-hour');
		expect(keys(result)).toEqual(['name', 'revenue_per_hour', 'invoiced_90d', 'hours_90d', 'invoiced_12m']);
		// Draft and older invoices are left out: 4000 ÷ 40 hours.
		expect(result.rows).toEqual([{ name: 'Acme', revenue_per_hour: 100, invoiced_90d: 4000, hours_90d: 40, invoiced_12m: 12000 }]);
		await expect(report('revenue-per-hour', {}, member)).rejects.toThrow(/admins only/i);
	});
});

describe('routes', () => {
	it('members get no library row or route for admin-only reports', async () => {
		const memberId = await id(`INSERT INTO users (github_login, role) VALUES ('r357-member', 'member') RETURNING id`);
		const home = await loadHome(pageEvent('/reports', 'member', {}, memberId));
		const keysSeen = home.library.filter((item) => item.builtIn).map((item) => item.href.split('/').pop());
		expect(keysSeen).toContain('pipeline-by-stage');
		expect(keysSeen).not.toContain('clients-by-time');
		expect(keysSeen).not.toContain('effort-vs-engagement');
		await expect(loadBuiltIn(pageEvent('/reports/b/clients-by-time', 'member', { key: 'clients-by-time' }, memberId))).rejects.toMatchObject({ status: 404 });
	});

	it('params come from the URL and are shown on the page', async () => {
		await seed();
		const page = await loadBuiltIn(pageEvent('/reports/b/below-open-rate?p_rate=50&p_sends=3', 'admin', { key: 'below-open-rate' }));
		expect(page.builtIn?.params.find((param) => param.key === 'rate')?.value).toBe('50');
		expect(page.spec.thresholds?.minSent).toBe(3);
		expect(page.result?.rows.map((row) => row.email).sort()).toEqual(['ann@r357.test', 'cat@r357.test', 'eve@r357.test']);
	});

	it('duplicate to customize copies the spec with the chosen params', async () => {
		const body = new FormData();
		body.set('p_rate', '30');
		body.set('p_sends', '5');
		const event = {
			request: new Request('https://crm.test/reports/b/below-open-rate', { method: 'POST', body }),
			url: new URL('https://crm.test/reports/b/below-open-rate'),
			params: { key: 'below-open-rate' },
			locals: { user: { id: await adminId(), role: 'admin' } },
			platform: { env }
		} as any;
		let location = '';
		try {
			await builtInActions.duplicate(event);
		} catch (err) {
			if (!isRedirect(err)) throw err;
			location = err.location;
		}
		// #456: the unsaved builder opens with the copy; nothing is saved yet.
		const url = new URL(location, 'https://crm.test');
		expect(url.pathname).toBe('/reports/new');
		expect(url.searchParams.get('name')).toBe('Copy of Below an open-rate threshold');
		expect(JSON.parse(url.searchParams.get('spec') ?? '{}').thresholds?.minSent).toBe(5);
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM reports`).first<{ n: number }>())?.n).toBe(0);
	});

	it("refuses to duplicate a report the builder can't express", async () => {
		const event = {
			request: new Request('https://crm.test/reports/b/going-cold', { method: 'POST', body: new FormData() }),
			url: new URL('https://crm.test/reports/b/going-cold'),
			params: { key: 'going-cold' },
			locals: { user: { id: 1, role: 'admin' } },
			platform: { env }
		} as any;
		const res = (await builtInActions.duplicate(event)) as { status: number };
		expect(res.status).toBe(400);
		expect((await db.prepare(`SELECT COUNT(*) AS n FROM reports`).first<{ n: number }>())?.n).toBe(0);
	});
});
