import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { load } from '../src/routes/campaigns/+page.server';

// #132: the Campaigns tab — 30-day rate tiles + Upcoming card (send log itself is covered
// by sendlog-query.test.ts).
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('UPDATE automation_steps SET target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists')
	]);
});

function ev(qs = '') {
	return { platform: { env }, url: new URL(`https://app.test/campaigns${qs}`) } as any;
}
const run = async (qs = '') => (await load(ev(qs))) as any;

async function makeList(): Promise<number> {
	const r = await db.prepare(`INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list')`).run();
	return r.meta.last_row_id as number;
}

async function makeCampaign(opts: {
	listId: number | null;
	sentAt?: string;
	status?: string;
	scheduledAt?: string | null;
	resendStatus?: string | null;
	resendAt?: string | null;
	weekdayOnly?: number;
}): Promise<number> {
	const r = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at,
			   scheduled_at, resend_status, resend_at, weekday_only)
			 VALUES ('S', '', '', ?, 'a@x.test', ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			opts.listId,
			opts.status ?? 'sent',
			opts.sentAt ?? null,
			opts.scheduledAt ?? null,
			opts.resendStatus ?? null,
			opts.resendAt ?? null,
			opts.weekdayOnly ?? 0
		)
		.run();
	return r.meta.last_row_id as number;
}

/** n accepted recipients; returns their ids. */
async function addRecipients(campaignId: number, n: number): Promise<number[]> {
	const ids: number[] = [];
	for (let i = 0; i < n; i++) {
		const r = await db
			.prepare(`INSERT INTO recipients (campaign_id, email, status) VALUES (?, ?, 'accepted')`)
			.bind(campaignId, `r${campaignId}-${i}@x.test`)
			.run();
		ids.push(r.meta.last_row_id as number);
	}
	return ids;
}

async function addEvent(campaignId: number, recipientId: number, type: string) {
	await db
		.prepare(`INSERT INTO events (campaign_id, recipient_id, type) VALUES (?, ?, ?)`)
		.bind(campaignId, recipientId, type)
		.run();
}

describe('/campaigns load — 30-day rates', () => {
	it('empty → null rates (not 0%)', async () => {
		const data = await run();
		expect(data.rates).toEqual({ delivered: 0, openRate: null, clickRate: null });
		expect(data.totals).toEqual({ campaigns: 0, emails_sent: 0, scheduled: 0 });
		expect(data.upcoming).toEqual([]);
	});

	it('unique opens/clicks ÷ delivered across recent broadcast sends only', async () => {
		const listId = await makeList();
		const recent = await makeCampaign({ listId });
		// sent_at in the window: set relative to now so the test doesn't age out.
		await db.prepare(`UPDATE campaigns SET sent_at = datetime('now', '-2 days') WHERE id = ?`).bind(recent).run();
		const r = await addRecipients(recent, 8);
		// 3 unique openers (one opens twice), 1 clicker.
		await addEvent(recent, r[0], 'open');
		await addEvent(recent, r[0], 'open');
		await addEvent(recent, r[1], 'open');
		await addEvent(recent, r[2], 'open');
		await addEvent(recent, r[0], 'click');

		// Excluded: an old broadcast, a direct 1:1 send (no list) — both fully engaged.
		const old = await makeCampaign({ listId });
		await db.prepare(`UPDATE campaigns SET sent_at = datetime('now', '-45 days') WHERE id = ?`).bind(old).run();
		const direct = await makeCampaign({ listId: null });
		await db.prepare(`UPDATE campaigns SET sent_at = datetime('now', '-1 days') WHERE id = ?`).bind(direct).run();
		for (const c of [old, direct]) {
			const [rid] = await addRecipients(c, 1);
			await addEvent(c, rid, 'open');
			await addEvent(c, rid, 'click');
		}

		const data = await run();
		expect(data.rates.delivered).toBe(8);
		expect(data.rates.openRate).toBe(37.5);
		expect(data.rates.clickRate).toBe(12.5);
		// All-time tiles still count everything sent.
		expect(data.totals.campaigns).toBe(3);
		expect(data.totals.emails_sent).toBe(10);
	});
});

describe('/campaigns load — Upcoming', () => {
	it('merges scheduled sends and pending resends, soonest first, with weekday flag', async () => {
		const listId = await makeList();
		const later = await makeCampaign({ listId, status: 'scheduled', scheduledAt: '2099-03-02 10:00:00' });
		const resend = await makeCampaign({
			listId,
			resendStatus: 'pending',
			resendAt: '2099-03-01 09:00:00',
			weekdayOnly: 1
		});
		await makeCampaign({ listId, resendStatus: 'sent', resendAt: '2099-01-01 00:00:00' });

		const data = await run();
		expect(data.totals.scheduled).toBe(1);
		expect(data.upcoming.map((u: any) => [u.id, u.kind, u.weekday_only])).toEqual([
			[resend, 'resend', 1],
			[later, 'send', 0]
		]);
		expect(data.upcoming[0].list_name).toBe('Newsletter');
	});

	it('keeps the send log + pager on /campaigns', async () => {
		const listId = await makeList();
		for (let i = 0; i < 3; i++) await makeCampaign({ listId });
		const data = await run('?per=25&status=sent');
		expect(data.matched).toBe(3);
		expect(data.campaigns).toHaveLength(3);
		expect(data.filter.status).toBe('sent');
	});
});
