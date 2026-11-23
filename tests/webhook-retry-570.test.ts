import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { POST as webhook } from '../src/routes/api/webhook/+server';
import { lastSuppressionSync, runSuppressionSyncAfterSend } from '../src/lib/server/suppression-sync';
import { defaultSubscriptionConfig } from '../src/lib/subscription-trigger';

// #570: a webhook event whose processing failed is processed again on Postmark's retry (the
// events row is only "done" once processed_at is set), every step is safe to run twice, and a
// post-send suppression sync closes whatever a failed webhook still left open.
const db = (env as any).DB as D1Database;
const KEY = 'test-key-570';

type Fail = { batch?: boolean; deleteEvents?: boolean; markProcessed?: boolean };

/** The real DB, except the writes named in `fail` throw (once each). */
function failingDb(fail: Fail): D1Database {
	const left = { ...fail };
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'batch') {
				return async (stmts: D1PreparedStatement[]) => {
					if (left.batch) {
						left.batch = false;
						throw new Error('D1_ERROR: simulated batch failure');
					}
					return target.batch(stmts);
				};
			}
			if (prop === 'prepare') {
				return (sql: string) => {
					if (left.deleteEvents && /^DELETE FROM events/.test(sql)) throw new Error('D1_ERROR: simulated delete failure');
					if (left.markProcessed && /SET processed_at/.test(sql)) {
						left.markProcessed = false;
						throw new Error('D1_ERROR: simulated mark failure');
					}
					return target.prepare(sql);
				};
			}
			const v = (target as any)[prop];
			return typeof v === 'function' ? v.bind(target) : v;
		}
	});
}

function hook(payload: object, database: D1Database = db) {
	return webhook({
		platform: { env: { ...env, DB: database, WEBHOOK_KEY: KEY } },
		url: new URL(`https://app.test/api/webhook?key=${KEY}`),
		request: new Request(`https://app.test/api/webhook?key=${KEY}`, { method: 'POST', body: JSON.stringify(payload) })
	} as any);
}

let seq = 0;
async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
}
async function sentTo(email: string): Promise<{ mid: string; campaignId: number }> {
	const campaignId = (await db
		.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'alan@ourco.example', 'sent') RETURNING id`)
		.first<{ id: number }>())!.id;
	const mid = `msg-570-${++seq}`;
	await db
		.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, (SELECT id FROM contacts WHERE email = ?), ?, ?, 'accepted')")
		.bind(campaignId, email, email, mid)
		.run();
	return { mid, campaignId };
}
const subscribed = async (id: number) =>
	(await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed;
const unsubRows = async (email: string) =>
	(await db.prepare('SELECT COUNT(*) AS n FROM unsubscribes WHERE email = ?').bind(email).first<{ n: number }>())!.n;
const eventRow = async (mid: string) =>
	db.prepare('SELECT COUNT(*) AS n, MAX(processed_at) AS processed FROM events WHERE message_id = ?').bind(mid).first<{ n: number; processed: string | null }>();

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('retry of an unprocessed event', () => {
	it('processEvent throws and the cleanup delete fails: the retry unsubscribes and writes one row', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = await contact('retry1@570.test');
		const { mid } = await sentTo('retry1@570.test');
		const bounce = { RecordType: 'Bounce', ID: 5701, Type: 'HardBounce', Email: 'retry1@570.test', MessageID: mid, BouncedAt: '2026-11-16T16:37:50Z' };

		await expect(hook(bounce, failingDb({ batch: true, deleteEvents: true }))).rejects.toThrow(/simulated/);
		expect(await subscribed(id)).toBe(1);
		expect(await eventRow(mid)).toEqual({ n: 1, processed: null });

		const retry = await hook(bounce);
		expect(await retry.json()).toEqual({ ok: true });
		expect(await subscribed(id)).toBe(0);
		expect(await unsubRows('retry1@570.test')).toBe(1);
		const row = await eventRow(mid);
		expect(row?.n).toBe(1);
		expect(row?.processed).toBeTruthy();

		// A later retry of the now-processed record is a true duplicate.
		expect(await (await hook(bounce)).json()).toEqual({ ok: true, duplicate: true });
		expect(await unsubRows('retry1@570.test')).toBe(1);
	});

	it('logs the failing step with RecordType and MessageID, never the address', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await contact('logged@570.test');
		const { mid } = await sentTo('logged@570.test');
		const bounce = { RecordType: 'Bounce', ID: 5702, Type: 'HardBounce', Email: 'logged@570.test', MessageID: mid, BouncedAt: '2026-11-16T16:37:51Z' };
		await expect(hook(bounce, failingDb({ batch: true }))).rejects.toThrow();
		const line = spy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('webhook processing failed'));
		expect(line).toContain('"unsubscribe contact"');
		expect(line).toContain('RecordType Bounce');
		expect(line).toContain(`MessageID ${mid}`);
		expect(line).not.toContain('logged@570.test');
	});
});

describe('every step is safe to run twice', () => {
	it('processing that ran fully but failed to mark processed: the retry adds no row and fires no trigger again', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = await contact('twice@570.test');
		const { mid } = await sentTo('twice@570.test');
		const aid = (await db
			.prepare(`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry) VALUES ('Bounced', 'active', 'subscription_changed', ?, 'multiple') RETURNING id`)
			.bind(JSON.stringify({ ...defaultSubscriptionConfig(), events: ['bounced'] }))
			.first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
				 VALUES (?, 0, 'tag', 'add', 'bounced-570', '', '', 'alan@ourco.example', 0)`
			)
			.bind(aid)
			.run();
		const passes = async () =>
			(await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?').bind(aid).first<{ n: number }>())!.n;

		const bounce = { RecordType: 'Bounce', ID: 5703, Type: 'HardBounce', Email: 'twice@570.test', MessageID: mid, BouncedAt: '2026-11-16T16:37:52Z' };
		await expect(hook(bounce, failingDb({ markProcessed: true }))).rejects.toThrow();
		expect(await subscribed(id)).toBe(0);
		expect(await unsubRows('twice@570.test')).toBe(1);
		expect(await passes()).toBe(1);
		// End the pass, so a second fire (re-entry multiple) would be visible as a new pass.
		await db.prepare("UPDATE automation_enrollments SET status = 'completed', ended_at = datetime('now') WHERE automation_id = ?").bind(aid).run();

		expect(await (await hook(bounce)).json()).toEqual({ ok: true });
		expect(await unsubRows('twice@570.test')).toBe(1);
		expect(await passes()).toBe(1);
		expect((await eventRow(mid))?.processed).toBeTruthy();
	});

	it("a SubscriptionChange after the bounce of the same send doesn't add a second row with the same reason", async () => {
		await contact('pair@570.test');
		const { mid } = await sentTo('pair@570.test');
		await hook({ RecordType: 'Bounce', ID: 5704, Type: 'HardBounce', Email: 'pair@570.test', MessageID: mid, BouncedAt: '2026-11-16T16:37:53Z' });
		await hook({ RecordType: 'SubscriptionChange', Recipient: 'pair@570.test', MessageID: mid, SuppressSending: true, SuppressionReason: 'HardBounce', ChangedAt: '2026-11-16T16:37:53Z' });
		expect(await unsubRows('pair@570.test')).toBe(1);
	});

	it('a reprocessed open tags the contact once', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = await contact('open@570.test');
		const { mid, campaignId } = await sentTo('open@570.test');
		await db.prepare("UPDATE campaigns SET tag_on_open = 'opened-570' WHERE id = ?").bind(campaignId).run();
		const open = { RecordType: 'Open', MessageID: mid, Recipient: 'open@570.test', ReceivedAt: '2026-11-16T16:38:00Z' };
		await expect(hook(open, failingDb({ markProcessed: true }))).rejects.toThrow();
		expect(await (await hook(open)).json()).toEqual({ ok: true });
		const tags = await db
			.prepare(`SELECT COUNT(*) AS n FROM list_members m JOIN lists l ON l.id = m.list_id WHERE l.kind = 'tag' AND l.name = 'opened-570' AND m.contact_id = ?`)
			.bind(id)
			.first<{ n: number }>();
		expect(tags?.n).toBe(1);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM events WHERE message_id = ?').bind(mid).first<{ n: number }>())?.n).toBe(1);
	});
});

describe('post-send suppression sync', () => {
	const creds = { token: 't', stream: 'broadcast', txStream: 'outbound' };
	const now = Date.parse('2026-11-16T17:00:00Z');

	beforeEach(async () => {
		await db.prepare("DELETE FROM app_state WHERE key = 'last_suppression_sync'").run();
		await db.prepare('UPDATE campaigns SET post_send_sync_at = COALESCE(post_send_sync_at, ?)').bind('2000-01-01 00:00:00').run();
	});

	async function broadcast(sentAt: string, extra = ''): Promise<number> {
		const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id").bind(`L570-${++seq}`).first<{ id: number }>())!.id;
		return (await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, sent_at${extra ? ', automation_id' : ''})
				 VALUES ('s', 'b', '<p>b</p>', 'alan@ourco.example', 'sent', ?, ?${extra ? ', ' + extra : ''}) RETURNING id`
			)
			.bind(list, sentAt)
			.first<{ id: number }>())!.id;
	}

	it('runs once per broadcast ~15 minutes after sent_at and records trigger post_send', async () => {
		const id = await contact('late@570.test');
		const fetchMock = vi.fn(async (url: string) => {
			const stream = /message-streams\/([^/]+)\//.exec(url)?.[1];
			const list = stream === 'broadcast' ? [{ EmailAddress: 'late@570.test', SuppressionReason: 'HardBounce' }] : [];
			return new Response(JSON.stringify({ Suppressions: list }), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const recent = await broadcast('2026-11-16 16:50:00'); // 10 min ago: not yet
		const due = await broadcast('2026-11-16 16:37:57'); // 22 min ago: due
		const old = await broadcast('2026-11-14 16:00:00'); // older than 24 h: the daily run's

		const first = await runSuppressionSyncAfterSend(db, creds, now);
		expect(first).toMatchObject({ ok: true, unsubscribed: 1, campaignIds: [due] });
		expect(await subscribed(id)).toBe(0);
		const last = await lastSuppressionSync(db);
		expect(last).toMatchObject({ trigger: 'post_send', campaignIds: [due], unsubscribed: 1 });

		const stamp = async (cid: number) =>
			(await db.prepare('SELECT post_send_sync_at AS s FROM campaigns WHERE id = ?').bind(cid).first<{ s: string | null }>())?.s;
		expect(await stamp(due)).toBe('2026-11-16 17:00:00');
		expect(await stamp(recent)).toBeNull();
		expect(await stamp(old)).toBeNull();

		// Same tick again: nothing due, Postmark not called.
		const calls = fetchMock.mock.calls.length;
		expect(await runSuppressionSyncAfterSend(db, creds, now + 60_000)).toEqual({ skipped: 'no send due' });
		expect(fetchMock.mock.calls.length).toBe(calls);

		// The recent one becomes due later, once.
		expect(await runSuppressionSyncAfterSend(db, creds, now + 10 * 60_000)).toMatchObject({ ok: true, campaignIds: [recent] });
		expect(await runSuppressionSyncAfterSend(db, creds, now + 11 * 60_000)).toEqual({ skipped: 'no send due' });
	});

	it('skips automation step campaigns and runs nothing without a token', async () => {
		const aid = (await db.prepare("INSERT INTO automations (name, status) VALUES ('A570', 'active') RETURNING id").first<{ id: number }>())!.id;
		await broadcast('2026-11-16 16:37:57', String(aid));
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Suppressions: [] }), { status: 200 })));
		expect(await runSuppressionSyncAfterSend(db, creds, now)).toEqual({ skipped: 'no send due' });
		expect(await runSuppressionSyncAfterSend(db, {}, now)).toEqual({ skipped: 'not configured' });
	});
});
