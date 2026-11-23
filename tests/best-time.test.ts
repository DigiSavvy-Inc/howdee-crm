import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { bestSendAt, queueBestTimeRecipients, processBestTimeQueue } from '../src/lib/server/best-time';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import { bestTimeLift } from '../src/lib/server/engagement-query';
import { conversationsFor } from '../src/lib/server/conversations';
import { cohortRate, liftPoints, liftText } from '../src/lib/engagement-view';
import type { EngineConfig } from '../src/lib/server/automations';
import type { SendableRow } from '../src/lib/server/segments';

const db = (env as any).DB as D1Database;
const cfg: EngineConfig = { token: 't', secret: 'test-secret', baseUrl: 'https://app.test', stream: 'broadcast' };

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

function row(contactId: number, email: string): SendableRow {
	return { id: contactId, email, name: null, first_name: null, last_name: null, company: null, meta: null, tags: null };
}

describe('bestSendAt (#115)', () => {
	const start = new Date('2026-10-06T15:30:00Z');
	it('no hour guess → null (default cohort)', () => {
		expect(bestSendAt(start, null)).toBeNull();
		expect(bestSendAt(start, undefined)).toBeNull();
		expect(bestSendAt(start, 24)).toBeNull();
	});
	it('the start hour itself → the start', () => {
		expect(bestSendAt(start, 15)?.toISOString()).toBe('2026-10-06T15:30:00.000Z');
	});
	it('a later hour today, or that hour tomorrow — always inside 24 h', () => {
		expect(bestSendAt(start, 18)?.toISOString()).toBe('2026-10-06T18:00:00.000Z');
		expect(bestSendAt(start, 9)?.toISOString()).toBe('2026-10-07T09:00:00.000Z');
		for (let h = 0; h < 24; h++) {
			const t = bestSendAt(start, h)!.getTime();
			expect(t).toBeGreaterThanOrEqual(start.getTime());
			expect(t).toBeLessThan(start.getTime() + 24 * 3600_000);
		}
	});
});

describe('lift math (#115)', () => {
	it('percentage points, one decimal; null without both cohorts', () => {
		expect(liftPoints(cohortRate(3, 10), cohortRate(1, 10))).toBe(20);
		expect(liftPoints(cohortRate(1, 3), cohortRate(1, 4))).toBe(8.3);
		expect(liftPoints(cohortRate(1, 0), cohortRate(1, 4))).toBeNull();
		expect(liftText(20)).toBe('+20.0 pts');
		expect(liftText(-1)).toBe('−1.0 pts');
		expect(liftText(0)).toBe('±0 pts');
		expect(liftText(null)).toBe('—');
	});
});

describe('best-time queue + drain (#115)', () => {
	const original = globalThis.fetch;
	let sent: { To: string }[][] = [];
	let ann: number, bob: number, cat: number;

	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM events'),
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare('DELETE FROM contact_engagement'),
			db.prepare('DELETE FROM list_members'),
			db.prepare('DELETE FROM lists'),
			db.prepare('DELETE FROM contacts')
		]);
		sent = [];
		let n = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/email/batch')) {
				const batch = JSON.parse(String(init?.body));
				sent.push(batch);
				return new Response(
					JSON.stringify(batch.map(() => ({ ErrorCode: 0, Message: 'OK', MessageID: `pm-${++n}` }))),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		}) as typeof fetch;

		ann = await id("INSERT INTO contacts (email, subscribed) VALUES ('ann@x.example.net', 1) RETURNING id");
		bob = await id("INSERT INTO contacts (email, subscribed) VALUES ('bob@x.example.net', 1) RETURNING id");
		cat = await id("INSERT INTO contacts (email, subscribed) VALUES ('cat@x.example.net', 1) RETURNING id");
	});

	afterEach(() => {
		globalThis.fetch = original;
	});

	async function sendingCampaign(): Promise<number> {
		return id(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status, best_time, sent_at)
			 VALUES ('Hi', 'b', '<p>b %%UNSUB_URL%%</p>', 'b %%UNSUB_URL%%', 'me@x.example.net', 'sending', 1, datetime('now')) RETURNING id`
		);
	}

	it('queues best-hour contacts at their hour and the rest at the start', async () => {
		const start = new Date();
		const later = (start.getUTCHours() + 3) % 24;
		await db.prepare('INSERT INTO contact_engagement (contact_id, best_hour_utc) VALUES (?, ?)').bind(ann, later).run();
		await db.prepare('INSERT INTO contact_engagement (contact_id, best_hour_utc) VALUES (?, NULL)').bind(bob).run();
		const camp = await sendingCampaign();

		const counts = await queueBestTimeRecipients(db, camp, [row(ann, 'ann@x.example.net'), row(bob, 'bob@x.example.net'), row(cat, 'cat@x.example.net')], start);
		expect(counts).toEqual({ best: 1, default: 2 });

		const rows = await db
			.prepare('SELECT contact_id, status, send_cohort, send_after FROM recipients WHERE campaign_id = ? ORDER BY contact_id')
			.bind(camp)
			.all<{ contact_id: number; status: string; send_cohort: string; send_after: string }>();
		expect(rows.results.map((r) => [r.status, r.send_cohort])).toEqual([
			['queued', 'best'],
			['queued', 'default'],
			['queued', 'default']
		]);
		expect(rows.results[0].send_after.slice(11, 13)).toBe(String(later).padStart(2, '0'));

		// Only the default cohort is due now; rows are filled in place, never duplicated.
		const first = await processBestTimeQueue(db, cfg);
		expect(first.sent).toBe(2);
		expect(sent.flat().map((m) => m.To).sort()).toEqual(['bob@x.example.net', 'cat@x.example.net']);
		const after = await db
			.prepare('SELECT status, message_id FROM recipients WHERE campaign_id = ? ORDER BY contact_id')
			.bind(camp)
			.all<{ status: string; message_id: string | null }>();
		expect(after.results.map((r) => r.status)).toEqual(['queued', 'accepted', 'accepted']);
		expect(after.results[1].message_id).toMatch(/^pm-/);

		// Still waiting on Ann → campaign stays 'sending'; a second pass sends nothing new.
		expect((await processBestTimeQueue(db, cfg)).sent).toBe(0);
		expect(sent.length).toBe(1);
		const mid = await db.prepare('SELECT status FROM campaigns WHERE id = ?').bind(camp).first<{ status: string }>();
		expect(mid?.status).toBe('sending');

		// Queued rows don't show up as sent mail in conversations yet.
		expect(await conversationsFor(db, ann)).toEqual([]);

		// Ann's hour arrives → sent, and the campaign closes out.
		await db.prepare("UPDATE recipients SET send_after = datetime('now') WHERE contact_id = ?").bind(ann).run();
		const last = await processBestTimeQueue(db, cfg);
		expect(last.sent).toBe(1);
		expect(last.finished).toBe(1);
		const done = await db
			.prepare('SELECT status, recipient_count, error FROM campaigns WHERE id = ?')
			.bind(camp)
			.first<{ status: string; recipient_count: number; error: string | null }>();
		expect(done).toEqual({ status: 'sent', recipient_count: 3, error: null });
	});

	it('drops a contact who unsubscribed while queued', async () => {
		const camp = await sendingCampaign();
		await queueBestTimeRecipients(db, camp, [row(ann, 'ann@x.example.net'), row(bob, 'bob@x.example.net')]);
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(bob).run();
		const res = await processBestTimeQueue(db, cfg);
		expect(res).toMatchObject({ sent: 1, dropped: 1, finished: 1 });
		const n = await db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?').bind(camp).first<{ n: number }>();
		expect(n?.n).toBe(1);
	});

	it('a claim that never resolved is closed out, not resent', async () => {
		const camp = await sendingCampaign();
		await db
			.prepare(
				`INSERT INTO recipients (campaign_id, contact_id, email, status, send_after, send_cohort)
				 VALUES (?, ?, 'ann@x.example.net', 'sending', datetime('now', '-20 minutes'), 'default')`
			)
			.bind(camp, ann)
			.run();
		const res = await processBestTimeQueue(db, cfg);
		expect(sent.length).toBe(0);
		expect(res.finished).toBe(1);
		const c = await db.prepare('SELECT status, error FROM campaigns WHERE id = ?').bind(camp).first<{ status: string; error: string }>();
		expect(c?.status).toBe('failed');
		expect(c?.error).toContain('Send interrupted');
	});

	it('a scheduled best-time campaign queues instead of sending, then drains', async () => {
		const list = await id("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id");
		for (const c of [ann, bob]) {
			await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, c).run();
		}
		const later = (new Date().getUTCHours() + 5) % 24;
		await db.prepare('INSERT INTO contact_engagement (contact_id, best_hour_utc) VALUES (?, ?)').bind(ann, later).run();
		const camp = await id(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, scheduled_at, best_time)
			 VALUES ('Hi', 'b', '<p>b %%UNSUB_URL%%</p>', 'b %%UNSUB_URL%%', ?, 'me@x.example.net', 'scheduled', datetime('now', '-1 minute'), 1) RETURNING id`,
			list
		);
		expect(await processScheduledCampaigns(db, cfg)).toEqual({ fired: 1, failed: 0 });
		expect(sent.length).toBe(0);
		const c = await db.prepare('SELECT status, recipient_count FROM campaigns WHERE id = ?').bind(camp).first();
		expect(c).toEqual({ status: 'sending', recipient_count: 2 });

		await processBestTimeQueue(db, cfg);
		expect(sent.flat().map((m) => m.To)).toEqual(['bob@x.example.net']);

		// Lift report: Bob (default) opened; Ann still waiting.
		const bobRow = await db
			.prepare('SELECT id, message_id FROM recipients WHERE campaign_id = ? AND contact_id = ?')
			.bind(camp, bob)
			.first<{ id: number; message_id: string }>();
		await db
			.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type, message_id) VALUES (?, ?, ?, 'open', ?)")
			.bind(camp, bobRow!.id, bob, bobRow!.message_id)
			.run();
		expect(await bestTimeLift(db, camp)).toEqual({
			best: { sent: 0, opened: 0, clicked: 0, queued: 1 },
			default: { sent: 1, opened: 1, clicked: 0, queued: 0 }
		});
	});

	it('an ordinary campaign has no lift report', async () => {
		const camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', 'h', 'me@x.example.net', 'sent') RETURNING id"
		);
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'ann@x.example.net', 'accepted')").bind(camp, ann).run();
		expect(await bestTimeLift(db, camp)).toBeNull();
	});
});
