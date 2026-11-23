// #457: automation report order + range + A/B + links, per-contact resend counting with the
// Resend pair, the full Best send times grid counted by people, the resend-pass proxy check,
// the sampling note and the comparison's count line.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { builtInByKey, resolveParams, runBuiltIn } from '../src/lib/server/reports/builtins';
import type { ReportResult } from '../src/lib/server/reports/engine';
import { engagementHeatmap } from '../src/lib/server/engagement-insights';
import { readback } from '../src/lib/report-nl';

const db = (env as { DB: D1Database }).DB;
const admin = { role: 'admin' as const };
const GMAIL = JSON.stringify({ Client: { Name: 'Gmail' }, UserAgent: 'Mozilla/5.0' });

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM lists'),
		db.prepare(`DELETE FROM app_state WHERE key = 'timezone'`)
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

const contact = (email: string) => id(`INSERT INTO contacts (email, subscribed, source) VALUES (?, 1, 'test') RETURNING id`, email);
const list = (name: string) => id(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, name);

function campaign(subject: string, opts: { list?: number | null; automation?: number; step?: number | null; sentAt?: string }) {
	return id(
		`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, automation_id, automation_step_id, sent_at)
		 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, ?, ?, ?) RETURNING id`,
		subject,
		opts.list ?? null,
		opts.automation ?? null,
		opts.step ?? null,
		opts.sentAt ?? '2026-10-01 09:00:00'
	);
}

function recipient(campaignId: number, contactId: number, opts: { pass?: 'resend'; variant?: string } = {}) {
	return id(
		`INSERT INTO recipients (campaign_id, contact_id, email, status, send_pass, ab_variant) VALUES (?, ?, ?, 'accepted', ?, ?) RETURNING id`,
		campaignId,
		contactId,
		`c${contactId}@t457.test`,
		opts.pass ?? null,
		opts.variant ?? null
	);
}

function event(campaignId: number, recipientId: number | null, contactId: number, type: string, at: string, detail: string | null = null) {
	return run(
		`INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
		campaignId,
		recipientId,
		contactId,
		type,
		detail,
		at
	);
}

function step(automation: number, position: number, opts: { type?: string; parent?: number; label?: string; subject?: string } = {}) {
	return id(
		`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, parent_step_id, branch_label)
		 VALUES (?, ?, 0, ?, 'x', 'f@x.example.net', ?, ?, ?) RETURNING id`,
		automation,
		position,
		opts.subject ?? 's',
		opts.type ?? 'email',
		opts.parent ?? null,
		opts.label ?? null
	);
}

async function report(key: string, params: Record<string, string> = {}, now?: Date): Promise<ReportResult> {
	const def = builtInByKey(key)!;
	const source = new URLSearchParams(Object.entries(params).map(([k, v]) => [`p_${k}`, v]));
	return runBuiltIn(db, def, resolveParams(def, source), admin, now);
}

const col = (result: ReportResult, key: string) => result.rows.map((row) => row[key]);

/** SQLite datetime `days` before now. */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

describe('#457 automation email performance', () => {
	it('orders steps by flow position (branch lanes in canvas order), a deleted step last; automations by name', async () => {
		const flow = await id(`INSERT INTO automations (name, status) VALUES ('Flow', 'active') RETURNING id`);
		const alpha = await id(`INSERT INTO automations (name, status) VALUES ('Alpha', 'active') RETURNING id`);
		// Ids deliberately out of flow order.
		const s3 = await step(flow, 3, { subject: 'Third' });
		const s1 = await step(flow, 1, { subject: 'First' });
		const branch = await step(flow, 2, { type: 'branch' });
		const yes = await step(flow, 1, { parent: branch, label: 'yes', subject: 'Yes lane' });
		const a1 = await step(alpha, 1, { subject: 'Alpha one' });

		const gone = await campaign('Gone', { automation: flow, step: null });
		const c3 = await campaign('Third', { automation: flow, step: s3 });
		const cy = await campaign('Yes lane', { automation: flow, step: yes });
		const c1 = await campaign('First', { automation: flow, step: s1 });
		const ca = await campaign('Alpha one', { automation: alpha, step: a1 });

		const result = await report('automation-email-performance');
		expect(col(result, 'subject')).toEqual(['Alpha one', 'First', 'Yes lane', 'Third', 'Gone (deleted step)']);
		expect(result.recordIds).toEqual([ca, c1, cy, c3, gone]);
		// Links: the automation, and the step on the canvas (a deleted step falls back to the campaign).
		expect(result.links?.automation).toEqual([`/automations/${alpha}`, `/automations/${flow}`, `/automations/${flow}`, `/automations/${flow}`, `/automations/${flow}`]);
		expect(result.links?.subject).toEqual([
			`/automations/${alpha}#step-node-${a1}`,
			`/automations/${flow}#step-node-${s1}`,
			`/automations/${flow}#step-node-${yes}`,
			`/automations/${flow}#step-node-${s3}`,
			null
		]);
		expect(builtInByKey('automation-email-performance')!.description).toContain('sorted by automation, then step position');
	});

	it('the range counts the emails sent in it (first delivery), not the step campaign row', async () => {
		const flow = await id(`INSERT INTO automations (name, status) VALUES ('Drip', 'active') RETURNING id`);
		const s1 = await step(flow, 1, { subject: 'Hello' });
		const s2 = await step(flow, 2, { subject: 'Old only' });
		// First sent a year ago, still sending.
		const c1 = await campaign('Hello', { automation: flow, step: s1, sentAt: daysAgo(400) });
		const c2 = await campaign('Old only', { automation: flow, step: s2, sentAt: daysAgo(300) });
		const [ann, bob, cat] = [await contact('ann@t457.test'), await contact('bob@t457.test'), await contact('cat@t457.test')];
		const oldR = await recipient(c1, ann);
		await event(c1, oldR, ann, 'delivery', daysAgo(400));
		await event(c1, oldR, ann, 'open', daysAgo(5), GMAIL); // an old send opened lately is still an old send
		const newR = await recipient(c1, bob);
		await event(c1, newR, bob, 'delivery', daysAgo(3));
		await event(c1, newR, bob, 'click', daysAgo(2));
		const r2 = await recipient(c2, cat);
		await event(c2, r2, cat, 'delivery', daysAgo(300));

		const all = await report('automation-email-performance');
		expect(all.rows).toEqual([
			expect.objectContaining({ subject: 'Hello', recipients: 2, open_rate: 100, click_rate: 50 }),
			expect.objectContaining({ subject: 'Old only', recipients: 1 })
		]);
		const recent = await report('automation-email-performance', { range: '30d' });
		expect(recent.rows).toEqual([expect.objectContaining({ subject: 'Hello', recipients: 1, delivered: 1, open_rate: 100, click_rate: 100 })]);
		const def = builtInByKey('automation-email-performance')!;
		expect(def.params?.find((param) => param.key === 'range')?.default).toBe('all');
	});

	it('adds a row per A/B variant under the step', async () => {
		const flow = await id(`INSERT INTO automations (name, status) VALUES ('AB', 'active') RETURNING id`);
		const s1 = await step(flow, 1, { subject: 'Test me' });
		const c1 = await campaign('Test me', { automation: flow, step: s1 });
		for (let k = 0; k < 4; k++) {
			const who = await contact(`ab${k}@t457.test`);
			const r = await recipient(c1, who, { variant: k < 2 ? 'A' : 'B' });
			if (k === 0 || k === 2 || k === 3) await event(c1, r, who, 'open', '2026-10-02 10:00:00', GMAIL);
		}
		const result = await report('automation-email-performance');
		expect(result.columns.map((column) => column.key)).toContain('variant');
		expect(result.rows).toEqual([
			expect.objectContaining({ subject: 'Test me', variant: null, recipients: 4, open_rate: 75 }),
			expect.objectContaining({ subject: 'Test me (variant A)', variant: 'A', recipients: 2, open_rate: 50 }),
			expect.objectContaining({ subject: 'Test me (variant B)', variant: 'B', recipients: 2, open_rate: 100 })
		]);
		expect(result.total).toBe(3);
	});
});

describe('#457 campaigns: per-contact counting with resend passes', () => {
	async function resentCampaign(): Promise<number> {
		// C06 from the audit: 10 contacts, 4 open the original, the resend goes to the other 6
		// and 2 of them open it. Per recipient row that was 6/16 = 38 %.
		const news = await list('News');
		const cp = await campaign('C06', { list: news, sentAt: daysAgo(5) });
		const people: number[] = [];
		for (let k = 0; k < 10; k++) people.push(await contact(`p${k}@t457.test`));
		for (const [k, who] of people.entries()) {
			const r = await recipient(cp, who);
			await event(cp, r, who, 'delivery', daysAgo(5));
			if (k < 4) await event(cp, r, who, 'open', daysAgo(4), GMAIL);
		}
		for (const [k, who] of people.slice(4).entries()) {
			const r = await recipient(cp, who, { pass: 'resend' });
			await event(cp, r, who, 'delivery', daysAgo(3));
			if (k < 2) await event(cp, r, who, 'open', daysAgo(2), GMAIL);
		}
		return cp;
	}

	it('campaign performance: one recipient and one opener per contact, plus the Resend pair', async () => {
		const cp = await resentCampaign();
		const result = await report('campaign-performance');
		expect(result.columns.map((column) => column.key).slice(-2)).toEqual(['resend_sent', 'resend_open_rate']);
		expect(result.rows).toEqual([expect.objectContaining({ subject: 'C06', recipients: 10, delivered: 10, open_rate: 60, resend_sent: 6, resend_open_rate: 33.3 })]);
		expect(result.recordIds).toEqual([cp]);
		expect(result.rowLabel).toEqual({ one: 'campaign', many: 'campaigns' });
	});

	it('campaign comparison: same per-contact rate; no Resend columns without a resend', async () => {
		await resentCampaign();
		const result = await report('campaign-comparison');
		expect(result.rows[0]).toMatchObject({ subject: 'C06', recipients: 10, open_rate: 60, resend_open_rate: 33.3 });
		expect(result.chartSeries?.yKeys).toEqual(['open_rate', 'click_rate']);

		await db.batch([db.prepare('DELETE FROM events'), db.prepare('DELETE FROM recipients'), db.prepare('DELETE FROM campaigns')]);
		await campaign('Plain', { list: await list('Other') });
		const plain = await report('campaign-comparison');
		expect(plain.columns.map((column) => column.key)).toEqual(['subject', 'open_rate', 'click_rate', 'recipients', 'sent_at']);
	});

	it('campaign comparison is the last 10: the count line says 10 campaigns, not "15 rows · showing first 10"', async () => {
		const news = await list('News');
		for (let k = 0; k < 15; k++) await campaign(`N${k}`, { list: news, sentAt: daysAgo(15 - k) });
		const result = await report('campaign-comparison');
		expect(result.rows).toHaveLength(10);
		expect(result.total).toBe(10);
		expect(result.truncated).toBe(false);
		expect(col(result, 'subject')[0]).toBe('N14');
		const def = builtInByKey('campaign-comparison')!;
		expect(readback(def.spec(resolveParams(def), admin))).toContain('last 10');
		expect(def.description).toContain('last 10');
	});
});

describe('#457 best send times', () => {
	it('returns the full 7 × 24 grid counted by people, plus the top 5 slots', async () => {
		await run(`INSERT INTO app_state (key, value) VALUES ('timezone', 'UTC')`);
		const news = await list('News');
		const cp = await campaign('Grid', { list: news, sentAt: daysAgo(10) });
		const ann = await contact('ann@t457.test');
		const bob = await contact('bob@t457.test');
		const ra = await recipient(cp, ann);
		const rb = await recipient(cp, bob);
		// Monday 2026-10-19 15:xx UTC: ann opens twice and clicks, bob opens once → 2 people.
		await event(cp, ra, ann, 'open', '2026-10-19 15:01:00', GMAIL);
		await event(cp, ra, ann, 'open', '2026-10-19 15:20:00', GMAIL);
		await event(cp, ra, ann, 'click', '2026-10-19 15:21:00');
		await event(cp, rb, bob, 'open', '2026-10-19 15:40:00', GMAIL);
		// Tuesday 09:00: ann alone.
		await event(cp, ra, ann, 'open', '2026-10-20 09:05:00', GMAIL);
		// A review / 1:1 send (no list, no automation) is left out.
		const review = await campaign('Review', { list: null });
		const rr = await recipient(review, bob);
		await event(review, rr, bob, 'open', '2026-10-20 09:10:00', GMAIL);

		const now = new Date('2026-10-24T12:00:00Z');
		const result = await report('best-send-times', {}, now);
		expect(result.columns.map((column) => column.key)).toEqual(['weekday', 'hour', 'count', 'pct']);
		expect(result.rows).toHaveLength(168);
		expect(result.truncated).toBe(false);
		expect(result.rows[0]).toEqual({ weekday: 'Mon', hour: 0, count: 0, pct: 0 });
		expect(result.rows.find((row) => row.weekday === 'Mon' && row.hour === 15)).toEqual({ weekday: 'Mon', hour: 15, count: 2, pct: 100 });
		expect(result.rows.find((row) => row.weekday === 'Tue' && row.hour === 9)).toEqual({ weekday: 'Tue', hour: 9, count: 1, pct: 50 });
		expect(result.heatmap).toMatchObject({ tz: 'UTC', total: 2, truncated: false });
		expect(result.secondary?.rows).toEqual([
			{ slot: 'Mon 3pm', count: 2, pct: 100 },
			{ slot: 'Tue 9am', count: 1, pct: 50 }
		]);
		expect(result.note).toBeUndefined();
		expect(builtInByKey('best-send-times')!.description).toContain(
			"Best-time sending uses each contact's own best hour; this is the audience-wide picture."
		);
	});

	it("flags a fast first open against the delivery of the same pass (the resend's)", async () => {
		const news = await list('News');
		const cp = await campaign('Pass', { list: news, sentAt: '2026-10-10 09:00:00' });
		const ann = await contact('ann@t457.test');
		const original = await recipient(cp, ann);
		await event(cp, original, ann, 'delivery', '2026-10-10 09:00:00');
		const resend = await recipient(cp, ann, { pass: 'resend' });
		await event(cp, resend, ann, 'delivery', '2026-10-12 09:00:00');
		// 5 s after the resend's delivery: a prefetch, not a person.
		await event(cp, resend, ann, 'open', '2026-10-12 09:00:05', JSON.stringify({ FirstOpen: true, Client: { Name: 'Gmail' } }));
		const heat = await engagementHeatmap(db, 'UTC', new Date('2026-10-24T12:00:00Z'));
		expect(heat.proxySkipped).toBe(1);
		expect(heat.total).toBe(0);
	});

	it('says "sampled: first 20,000 events" when the cap is hit', async () => {
		const news = await list('News');
		const cp = await campaign('Busy', { list: news, sentAt: daysAgo(5) });
		const ann = await contact('ann@t457.test');
		await run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20001)
			 INSERT INTO events (campaign_id, contact_id, type, recorded_at)
			 SELECT ?, ?, 'click', datetime('now', '-' || (i % 1000) || ' minutes') FROM n`,
			cp,
			ann
		);
		const result = await report('best-send-times');
		expect(result.heatmap?.truncated).toBe(true);
		expect(result.note).toBe('sampled: first 20,000 events');
		expect(result.truncated).toBe(false);
		expect(result.rows).toHaveLength(168);
	});
});
