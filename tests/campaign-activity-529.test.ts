import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	activityBadge,
	activityLabel,
	activityQuery,
	nextActivitySize,
	parseActivityFilter,
	parseActivityRows
} from '../src/lib/campaign-activity';
import { campaignActivity } from '../src/lib/server/campaign-activity';
import { load as campaignPageLoad } from '../src/routes/campaign/[id]/+page.server';

// #529: campaign page Activity panel — URL helpers + the filtered query.
const db = (env as any).DB as D1Database;

describe('parse / clamp helpers', () => {
	it('parseActivityFilter keeps known filters, else all', () => {
		expect(parseActivityFilter('clicks')).toBe('clicks');
		expect(parseActivityFilter('Bounces')).toBe('bounces');
		expect(parseActivityFilter('unsubscribes')).toBe('unsubscribes');
		expect(parseActivityFilter('spam')).toBe('all');
		expect(parseActivityFilter('')).toBe('all');
		expect(parseActivityFilter(null)).toBe('all');
	});

	it('parseActivityRows accepts 10 / 25 / 50, else 10', () => {
		expect(parseActivityRows('25')).toBe(25);
		expect(parseActivityRows('50')).toBe(50);
		expect(parseActivityRows('10')).toBe(10);
		expect(parseActivityRows('500')).toBe(10);
		expect(parseActivityRows('-1')).toBe(10);
		expect(parseActivityRows('abc')).toBe(10);
		expect(parseActivityRows(null)).toBe(10);
	});

	it('nextActivitySize steps 10 → 25 → 50 → none', () => {
		expect(nextActivitySize(10)).toBe(25);
		expect(nextActivitySize(25)).toBe(50);
		expect(nextActivitySize(50)).toBeNull();
	});

	it('activityQuery keeps other params and drops defaults', () => {
		const p = new URLSearchParams('who=opens&as=4&rows=25');
		expect(activityQuery(p, { activity: 'clicks' })).toBe('?who=opens&as=4&rows=25&activity=clicks');
		expect(activityQuery(new URLSearchParams('activity=clicks&who=sent'), { activity: 'all' })).toBe('?who=sent');
		expect(activityQuery(new URLSearchParams('activity=bounces'), { rows: 25 })).toBe('?activity=bounces&rows=25');
		expect(activityQuery(new URLSearchParams('rows=25'), { rows: 10 })).toBe('?');
	});

	it('labels and badges match the old table', () => {
		expect(activityLabel('unsubscribe_click')).toBe('unsubscribe page');
		expect(activityLabel('open')).toBe('open');
		expect(activityBadge('click')).toBe('sent');
		expect(activityBadge('spam')).toBe('failed');
		expect(activityBadge('delivery')).toBe('draft');
	});
});

beforeEach(async () => {
	await db.batch([db.prepare('DELETE FROM events'), db.prepare('DELETE FROM recipients'), db.prepare('DELETE FROM campaigns')]);
});

async function makeCampaign(): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES ('Hello', 'md', '<p>hi</p>', 'alan@ourco.example', 'sent', datetime('now')) RETURNING id`
		)
		.first<{ id: number }>();
	return c!.id;
}

async function makeRecipient(campaignId: number, email: string): Promise<number> {
	const r = await db
		.prepare(`INSERT INTO recipients (campaign_id, email, status, message_id) VALUES (?, ?, 'accepted', ?) RETURNING id`)
		.bind(campaignId, email, `msg-${email}-${Math.random()}`)
		.first<{ id: number }>();
	return r!.id;
}

async function addEvents(campaignId: number, recipientId: number, type: string, n: number, base = 0) {
	for (let i = 0; i < n; i++) {
		const at = `2026-11-01 ${String(10 + Math.floor((base + i) / 60)).padStart(2, '0')}:${String((base + i) % 60).padStart(2, '0')}:00`;
		await db
			.prepare('INSERT INTO events (campaign_id, recipient_id, type, recorded_at) VALUES (?, ?, ?, ?)')
			.bind(campaignId, recipientId, type, at)
			.run();
	}
}

describe('campaignActivity (#529)', () => {
	it('filters in SQL, limits rows, counts per chip and leaves out scanner clicks', async () => {
		const cid = await makeCampaign();
		const r = await makeRecipient(cid, 'a@x.example.net');
		// Clicks are the oldest — a browser-side filter over the latest 50 would miss them.
		await addEvents(cid, r, 'click', 12, 0);
		await addEvents(cid, r, 'open', 60, 20);
		await addEvents(cid, r, 'unsubscribe', 1, 90);
		await addEvents(cid, r, 'unsubscribe_click', 2, 91);
		await addEvents(cid, r, 'bounce', 1, 95);
		await addEvents(cid, r, 'spam', 1, 96);
		await addEvents(cid, r, 'scanner_click', 5, 100);

		const clicks = await campaignActivity(db, cid, 'clicks', 10);
		expect(clicks.rows).toHaveLength(10);
		expect(clicks.rows.every((e) => e.type === 'click')).toBe(true);
		expect(clicks.hasMore).toBe(true);

		const clicks25 = await campaignActivity(db, cid, 'clicks', 25);
		expect(clicks25.rows).toHaveLength(12);
		expect(clicks25.hasMore).toBe(false);

		const all = await campaignActivity(db, cid, 'all', 50);
		expect(all.rows).toHaveLength(50);
		expect(all.rows.some((e) => e.type === 'scanner_click')).toBe(false);
		expect(all.rows[0].type).toBe('spam');

		// Never more than 50, whatever is asked for.
		expect((await campaignActivity(db, cid, 'all', 500)).rows).toHaveLength(50);

		const unsubs = await campaignActivity(db, cid, 'unsubscribes', 10);
		expect(unsubs.rows.map((e) => e.label).sort()).toEqual(['unsubscribe', 'unsubscribe page', 'unsubscribe page']);
		const bounces = await campaignActivity(db, cid, 'bounces', 10);
		expect(bounces.rows.map((e) => e.type)).toEqual(['spam', 'bounce']);

		expect(all.counts).toEqual({ all: 77, opens: 60, clicks: 12, unsubscribes: 3, bounces: 2 });
		expect(all.rows[0].who).toBe('a@x.example.net');
	});

	it('page load reads ?activity= / ?rows= and falls back to all / 10', async () => {
		const cid = await makeCampaign();
		const r = await makeRecipient(cid, 'b@x.example.net');
		await addEvents(cid, r, 'open', 30, 0);
		await addEvents(cid, r, 'click', 3, 40);
		const load = async (q: string) => {
			const url = new URL(`https://app.test/campaign/${cid}${q}`);
			return (await campaignPageLoad({
				platform: { env: { ...(env as any), SESSION_SECRET: 'test-secret' } },
				params: { id: String(cid) },
				url,
				request: new Request(url),
				locals: {}
			} as any)) as any;
		};
		const d1 = await load('?activity=clicks&rows=25');
		expect(d1.activity.filter).toBe('clicks');
		expect(d1.activity.size).toBe(25);
		expect(d1.activity.rows).toHaveLength(3);
		const d2 = await load('?activity=nope&rows=999');
		expect(d2.activity.filter).toBe('all');
		expect(d2.activity.size).toBe(10);
		expect(d2.activity.rows).toHaveLength(10);
		expect(d2.activity.hasMore).toBe(true);
		const d3 = await load('?activity=bounces');
		expect(d3.activity.rows).toHaveLength(0);
		expect(d3.activity.counts.all).toBe(33);
	});
});
