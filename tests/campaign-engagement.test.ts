import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { engagementBreakdown, segmentWhere } from '../src/lib/server/campaign-engagement';
import { barSegments, engagementHeadline, engagementNote, pctOf } from '../src/lib/engagement-bar';

// #161: campaign Engagement bar — breakdown (D1) + pure view math.
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns')
	]);
});

async function makeCampaign(): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES ('Hello', 'md', '<p>hi</p>', 'alan@ourco.example', 'sent', datetime('now'))
			 RETURNING id`
		)
		.first<{ id: number }>();
	return c!.id;
}

async function makeRecipient(campaignId: number, email: string, status = 'accepted'): Promise<number> {
	const r = await db
		.prepare('INSERT INTO recipients (campaign_id, email, status, message_id) VALUES (?, ?, ?, ?) RETURNING id')
		.bind(campaignId, email, status, `msg-${email}-${Math.random()}`)
		.first<{ id: number }>();
	return r!.id;
}

async function addEvent(campaignId: number, recipientId: number, type: string, detail: object | null = null, at = '2026-10-01 12:00:00') {
	await db
		.prepare('INSERT INTO events (campaign_id, recipient_id, type, detail, recorded_at) VALUES (?, ?, ?, ?, ?)')
		.bind(campaignId, recipientId, type, detail ? JSON.stringify(detail) : null, at)
		.run();
}

describe('engagementBreakdown (#161)', () => {
	it('splits accepted recipients into clicked / opened-only / none, unique per recipient', async () => {
		const cid = await makeCampaign();
		const clicker = await makeRecipient(cid, 'a@x.example.net');
		await addEvent(cid, clicker, 'open');
		await addEvent(cid, clicker, 'open');
		await addEvent(cid, clicker, 'click');
		await addEvent(cid, clicker, 'click');
		// Click with no recorded open still counts as Clicked.
		const clickOnly = await makeRecipient(cid, 'b@x.example.net');
		await addEvent(cid, clickOnly, 'click');
		const opener = await makeRecipient(cid, 'c@x.example.net');
		await addEvent(cid, opener, 'open');
		await addEvent(cid, opener, 'open');
		await makeRecipient(cid, 'd@x.example.net');
		await makeRecipient(cid, 'e@x.example.net');
		const bouncer = await makeRecipient(cid, 'f@x.example.net');
		await addEvent(cid, bouncer, 'bounce');
		const unsub = await makeRecipient(cid, 'g@x.example.net');
		await addEvent(cid, unsub, 'open');
		await addEvent(cid, unsub, 'unsubscribe');
		// Errored rows are not "sent".
		await makeRecipient(cid, 'h@x.example.net', 'error');

		const b = await engagementBreakdown(db, cid);
		expect(b).toMatchObject({ sent: 7, clicked: 2, openedOnly: 2, none: 2, bounced: 1, unsubscribed: 1, proxyOpens: 0 });
		// Segments + bounced-without-engagement cover everyone sent.
		expect(b.clicked + b.openedOnly + b.none + b.bounced).toBe(b.sent);
	});

	it('ignores other campaigns’ events', async () => {
		const a = await makeCampaign();
		const other = await makeCampaign();
		const r = await makeRecipient(a, 'a@x.example.net');
		const r2 = await makeRecipient(other, 'a@x.example.net');
		await addEvent(other, r2, 'click');
		const b = await engagementBreakdown(db, a);
		expect(b).toMatchObject({ sent: 1, clicked: 0, none: 1 });
		void r;
	});

	it('counts opened-only recipients whose every open is a proxy (Apple MPP) open', async () => {
		const cid = await makeCampaign();
		const apple = await makeRecipient(cid, 'a@x.example.net');
		await addEvent(cid, apple, 'open', { Client: { Name: 'Apple Mail' } });
		// One proxy open + one human open → a real opener.
		const mixed = await makeRecipient(cid, 'b@x.example.net');
		await addEvent(cid, mixed, 'open', { Client: { Name: 'Apple Mail' } });
		await addEvent(cid, mixed, 'open', { Client: { Name: 'Gmail' } });
		// FirstOpen within 60s of delivery → proxy.
		const fast = await makeRecipient(cid, 'c@x.example.net');
		await addEvent(cid, fast, 'delivery', null, '2026-10-01 12:00:00');
		await addEvent(cid, fast, 'open', { FirstOpen: true }, '2026-10-01 12:00:20');
		// A clicker with a proxy open isn't in openedOnly, so not counted.
		const clicker = await makeRecipient(cid, 'd@x.example.net');
		await addEvent(cid, clicker, 'open', { Client: { Name: 'Apple Mail' } });
		await addEvent(cid, clicker, 'click');

		const b = await engagementBreakdown(db, cid);
		expect(b.openedOnly).toBe(3);
		expect(b.proxyOpens).toBe(2);
		expect(b.clicked).toBe(1);
	});

	it('segmentWhere selects the same recipients the counts do', async () => {
		const cid = await makeCampaign();
		const c1 = await makeRecipient(cid, 'a@x.example.net');
		await addEvent(cid, c1, 'click');
		const o1 = await makeRecipient(cid, 'b@x.example.net');
		await addEvent(cid, o1, 'open');
		const n1 = await makeRecipient(cid, 'c@x.example.net');
		const bounced = await makeRecipient(cid, 'd@x.example.net');
		await addEvent(cid, bounced, 'bounce');
		const ids = async (seg: 'clicked' | 'opened' | 'none') =>
			(
				await db
					.prepare(`SELECT r.id FROM recipients r WHERE r.campaign_id = ? AND r.status = 'accepted' AND ${segmentWhere(seg)}`)
					.bind(cid)
					.all<{ id: number }>()
			).results.map((r) => r.id);
		expect(await ids('clicked')).toEqual([c1]);
		expect(await ids('opened')).toEqual([o1]);
		expect(await ids('none')).toEqual([n1]);
	});

	it('returns zeros for a campaign with nothing sent', async () => {
		const cid = await makeCampaign();
		expect(await engagementBreakdown(db, cid)).toEqual({
			sent: 0, clicked: 0, openedOnly: 0, none: 0, bounced: 0, unsubscribed: 0, proxyOpens: 0
		});
	});
});

describe('engagement bar view math (#161)', () => {
	const b = { sent: 40, clicked: 4, openedOnly: 10, none: 22, bounced: 4, unsubscribed: 1, proxyOpens: 6 };

	it('keeps the fixed Clicked → Opened → None order with shares of sent', () => {
		const segs = barSegments(b);
		expect(segs.map((s) => s.key)).toEqual(['clicked', 'opened', 'none']);
		expect(segs.map((s) => s.pct)).toEqual([10, 25, 55]);
		expect(segs.map((s) => s.color)).toEqual(['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)']);
	});

	it('headline is clicked + opened over sent', () => {
		expect(engagementHeadline(b)).toEqual({ interacted: 14, rate: 35 });
		expect(engagementHeadline({ ...b, sent: 0, clicked: 0, openedOnly: 0 })).toEqual({ interacted: 0, rate: 0 });
	});

	it('note lists bounced / unsubscribed only when non-zero', () => {
		expect(engagementNote(b)).toBe('4 bounced · 1 unsubscribed');
		expect(engagementNote({ ...b, bounced: 0 })).toBe('1 unsubscribed');
		expect(engagementNote({ ...b, bounced: 0, unsubscribed: 0 })).toBe('');
	});

	it('pctOf guards a zero denominator', () => {
		expect(pctOf(3, 0)).toBe(0);
		expect(pctOf(1, 3)).toBe(33);
	});
});
