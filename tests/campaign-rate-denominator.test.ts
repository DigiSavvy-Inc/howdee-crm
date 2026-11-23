import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { recentCampaigns } from '../src/lib/server/dashboard';
import { load } from '../src/routes/campaigns/+page.server';

// #196: dashboard Recent campaigns and each /campaigns row use accepted recipients
// as the open/click denominator. `recipient_count` can be a different number.

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns')
	]);
});

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

async function campaign(subject: string, recipientCount: number): Promise<number> {
	return id(
		`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, recipient_count, sent_at)
		 VALUES (?, 'm', 'h', 'f@x.example.net', 'sent', ?, '2026-06-01 12:00:00') RETURNING id`,
		subject,
		recipientCount
	);
}

async function recipient(campaignId: number, email: string, status: string): Promise<number> {
	return id(
		`INSERT INTO recipients (campaign_id, email, status) VALUES (?, ?, ?) RETURNING id`,
		campaignId,
		email,
		status
	);
}

async function event(campaignId: number, recipientId: number, type: string) {
	await db
		.prepare(`INSERT INTO events (campaign_id, recipient_id, type) VALUES (?, ?, ?)`)
		.bind(campaignId, recipientId, type)
		.run();
}

async function campaignsRow(subject: string) {
	const page = (await load({
		platform: { env },
		url: new URL('https://app.test/campaigns')
	} as never)) as {
		campaigns: {
			subject: string;
			recipient_count: number;
			accepted: number;
			opens: number;
			clicks: number;
			open_pct: number | null;
			click_pct: number | null;
		}[];
	};
	const row = page.campaigns.find((c) => c.subject === subject);
	expect(row).toBeTruthy();
	return row!;
}

describe('open/click denominator (#196)', () => {
	it('dashboard and /campaigns both divide by accepted recipients', async () => {
		const camp = await campaign('Hello', 10);
		const a = await recipient(camp, 'a@x.example.net', 'accepted');
		const b = await recipient(camp, 'b@x.example.net', 'accepted');
		await recipient(camp, 'c@x.example.net', 'accepted');
		await recipient(camp, 'd@x.example.net', 'accepted');
		await recipient(camp, 'e@x.example.net', 'error');
		await recipient(camp, 'f@x.example.net', 'error');
		await event(camp, a, 'open');
		await event(camp, a, 'open');
		await event(camp, b, 'open');
		await event(camp, a, 'click');

		const recent = await recentCampaigns(db);
		expect(recent.map((c) => c.subject)).toEqual(['Hello']);
		const row = await campaignsRow('Hello');

		// 2 unique opens and 1 click out of 4 accepted → 50% and 25%.
		// recipient_count is 10, which would have been 20% and 10%.
		expect(row.recipient_count).toBe(10);
		expect(row.accepted).toBe(4);
		expect(row.opens).toBe(2);
		expect(row.clicks).toBe(1);
		expect(recent[0].open_pct).toBe(50);
		expect(recent[0].click_pct).toBe(25);
		expect(row.open_pct).toBe(recent[0].open_pct);
		expect(row.click_pct).toBe(recent[0].click_pct);
	});

	it('is null on both pages when nothing was accepted', async () => {
		const camp = await campaign('Empty', 5);
		const bad = await recipient(camp, 'bad@x.example.net', 'error');
		await event(camp, bad, 'open');

		const recent = await recentCampaigns(db);
		const row = await campaignsRow('Empty');
		expect(row.accepted).toBe(0);
		expect(row.recipient_count).toBe(5);
		expect(recent[0].open_pct).toBeNull();
		expect(recent[0].click_pct).toBeNull();
		expect(row.open_pct).toBeNull();
		expect(row.click_pct).toBeNull();
	});
});
