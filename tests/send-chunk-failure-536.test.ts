import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { sendCampaignEmail, SEND_CHUNK, ALREADY_SENT, type SendableRecipient } from '../src/lib/server/send';
import { sendBatch } from '../src/lib/server/postmark';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import { stuckSends } from '../src/lib/server/dashboard';

// #536: a campaign send writes its `recipients` rows per Postmark chunk, right after that chunk
// returns; a failed chunk (thrown fetch, timeout, bad body) marks only itself failed; a retry
// skips contacts that already have an accepted row for the campaign and pass. No real mail:
// fetch is stubbed for every test.

const db = (env as any).DB as D1Database;
const BATCH_URL = 'https://api.postmarkapp.com/email/batch';

type Mode = 'ok' | 'throw' | 'badjson' | 'short';
/** Stub fetch: `modes[n]` decides the n-th Postmark batch call (default 'ok'). */
function stubPostmark(modes: Mode[] = []) {
	const batches: { To: string }[][] = [];
	const signals: (AbortSignal | null | undefined)[] = [];
	vi.stubGlobal('fetch', async (u: string | URL | Request, init?: RequestInit) => {
		const url = String(u);
		if (url !== BATCH_URL) return new Response('ok', { status: 200 });
		const msgs = JSON.parse(String(init?.body)) as { To: string }[];
		const mode = modes[batches.length] ?? 'ok';
		batches.push(msgs);
		signals.push(init?.signal);
		if (mode === 'throw') throw new TypeError('network connection lost');
		if (mode === 'badjson') return new Response('<html>oops</html>', { status: 200 });
		if (mode === 'short') return Response.json([{ ErrorCode: 0, Message: 'OK', MessageID: 'x' }]);
		return Response.json(msgs.map((m, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `mid-${batches.length}-${i}-${m.To}`, To: m.To })));
	});
	return { batches, signals };
}

async function makeCampaign(status = 'sending'): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status)
			 VALUES ('Hello', 'x', '<p>x %%UNSUB_URL%%</p>', 'x %%UNSUB_URL%%', 'alan@ourco.example', ?) RETURNING id`
		)
		.bind(status)
		.first<{ id: number }>();
	return row!.id;
}

/** n subscribed contacts on a fresh list; returns the list id and the recipients. */
async function makeAudience(n: number): Promise<{ listId: number; recipients: SendableRecipient[] }> {
	const list = await db.prepare(`INSERT INTO lists (name, kind) VALUES ('Big list 536', 'list') RETURNING id`).first<{ id: number }>();
	const ins = db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1)');
	for (let i = 0; i < n; i += 100) {
		await db.batch(Array.from({ length: Math.min(100, n - i) }, (_, k) => ins.bind(`p${i + k}@example.com`)));
	}
	await db.prepare(`INSERT INTO list_members (list_id, contact_id) SELECT ?, id FROM contacts`).bind(list!.id).run();
	const rows = await db.prepare('SELECT id, email FROM contacts ORDER BY id').all<{ id: number; email: string }>();
	return {
		listId: list!.id,
		recipients: rows.results.map((r) => ({ id: r.id, email: r.email, name: null, first_name: null, last_name: null }))
	};
}

function send(campaignId: number, recipients: SendableRecipient[]) {
	return sendCampaignEmail(db, {
		token: 'POSTMARK_API_TEST',
		secret: 's',
		baseUrl: 'https://app.test',
		campaignId,
		recipients,
		subject: 'Hello',
		htmlTemplate: '<p>x %%UNSUB_URL%%</p>',
		textTemplate: 'x %%UNSUB_URL%%',
		from: 'alan@ourco.example',
		stream: 'broadcast',
		skipAlreadySent: true
	});
}

async function rowCounts(campaignId: number) {
	return (await db
		.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
			        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
			 FROM recipients WHERE campaign_id = ?`
		)
		.bind(campaignId)
		.first<{ total: number; accepted: number; error: number }>())!;
}

beforeEach(async () => {
	vi.unstubAllGlobals();
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});
afterEach(() => vi.unstubAllGlobals());

describe('sendBatch never throws (#536)', () => {
	const msg = { From: 'a@x.example.net', To: 'b@x.example.net', Subject: 's', HtmlBody: 'h', TextBody: 't', MessageStream: 'broadcast' };

	it('a thrown fetch, an unreadable 200 body and a short result list mark the chunk failed', async () => {
		stubPostmark(['throw', 'badjson', 'short']);
		for (const expected of [/network connection lost/, /Unreadable Postmark response/, /Unreadable Postmark response/]) {
			const out = await sendBatch('t', [msg, { ...msg, To: 'c@x.example.net' }]);
			expect(out).toHaveLength(2);
			for (const r of out) {
				expect(r.ErrorCode).toBe(-1);
				expect(r.Message).toMatch(expected);
				expect(r.Transport).toBe(true);
			}
		}
	});

	it('every batch request carries a timeout signal', async () => {
		const pm = stubPostmark();
		await sendBatch('t', [msg]);
		expect(pm.signals[0]).toBeInstanceOf(AbortSignal);
	});

	it('a timeout comes back as a failed result', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
		});
		const [r] = await sendBatch('t', [msg]);
		expect(r).toMatchObject({ ErrorCode: -1, Transport: true });
		expect(r.Message).toMatch(/timed out/);
	});
});

describe('sendCampaignEmail: per-chunk rows and retry (#536)', () => {
	it('chunk 1 accepted, chunk 2 throws → chunk 1 rows written; the retry sends only chunk 2', async () => {
		const { recipients } = await makeAudience(SEND_CHUNK + 3);
		const campaignId = await makeCampaign();

		let pm = stubPostmark(['ok', 'throw']);
		const first = await send(campaignId, recipients);
		expect(pm.batches.map((b) => b.length)).toEqual([SEND_CHUNK, 3]);
		expect(first.accepted).toBe(SEND_CHUNK);
		expect(first.failed).toBe(3);
		expect(first.skipped).toBe(0);
		expect(first.firstError).toMatch(/network connection lost/);
		expect(await rowCounts(campaignId)).toEqual({ total: SEND_CHUNK + 3, accepted: SEND_CHUNK, error: 3 });
		// Every accepted row has its MessageID (the webhook join key).
		const missing = await db
			.prepare(`SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND status = 'accepted' AND message_id IS NULL`)
			.bind(campaignId)
			.first<{ n: number }>();
		expect(missing!.n).toBe(0);

		vi.unstubAllGlobals();
		pm = stubPostmark();
		const retry = await send(campaignId, recipients);
		expect(pm.batches).toHaveLength(1);
		expect(pm.batches[0].map((m) => m.To)).toEqual(recipients.slice(SEND_CHUNK).map((r) => r.email));
		expect(retry.accepted).toBe(3);
		expect(retry.skipped).toBe(SEND_CHUNK);
		expect(retry.failed).toBe(0);
		expect(retry.results[0]).toMatchObject({ ErrorCode: 0, Message: ALREADY_SENT });
		// The error rows were reused, not duplicated: one row per recipient, all accepted.
		expect(await rowCounts(campaignId)).toEqual({ total: SEND_CHUNK + 3, accepted: SEND_CHUNK + 3, error: 0 });

		// Without the opt-in, a caller that re-sends on purpose still re-sends.
		vi.unstubAllGlobals();
		pm = stubPostmark();
		const plain = await sendCampaignEmail(db, {
			token: 't', secret: 's', baseUrl: 'https://app.test', campaignId, recipients: recipients.slice(0, 1), subject: 'Hi',
			htmlTemplate: '<p>x</p>', textTemplate: 'x', from: 'alan@ourco.example', stream: 'outbound', unsubscribe: false
		});
		expect(plain).toMatchObject({ accepted: 1, skipped: 0 });

		// A third opt-in call sends nothing at all.
		vi.unstubAllGlobals();
		pm = stubPostmark();
		const again = await send(campaignId, recipients);
		expect(pm.batches).toHaveLength(0);
		expect(again).toMatchObject({ accepted: 0, skipped: SEND_CHUNK + 3, failed: 0 });
	});

	it('a resend is not de-duplicated against earlier resend rows (#83 allows more than one)', async () => {
		const { recipients } = await makeAudience(2);
		const campaignId = await makeCampaign('sent');
		stubPostmark();
		const opts = {
			token: 't', secret: 's', baseUrl: 'https://app.test', campaignId, recipients, subject: 'Hi',
			htmlTemplate: '<p>%%UNSUB_URL%%</p>', textTemplate: '%%UNSUB_URL%%', from: 'alan@ourco.example', stream: 'broadcast',
			sendPass: 'resend' as const,
			skipAlreadySent: true
		};
		await sendCampaignEmail(db, opts);
		const second = await sendCampaignEmail(db, opts);
		expect(second).toMatchObject({ accepted: 2, skipped: 0 });
	});
});

describe('scheduled send with a failed chunk (#536)', () => {
	it('lands as sent with the accepted count, the failure in error, and only chunk 2 as error rows', async () => {
		const { listId } = await makeAudience(SEND_CHUNK + 2);
		const id = await makeCampaign('scheduled');
		await db.prepare(`UPDATE campaigns SET list_id = ?, scheduled_at = datetime('now', '-1 minute') WHERE id = ?`).bind(listId, id).run();

		stubPostmark(['ok', 'throw']);
		const out = await processScheduledCampaigns(db, { token: 't', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' });
		expect(out).toEqual({ fired: 1, failed: 0 });
		const row = await db.prepare('SELECT status, recipient_count, error FROM campaigns WHERE id = ?').bind(id).first<any>();
		expect(row.status).toBe('sent');
		expect(row.recipient_count).toBe(SEND_CHUNK);
		expect(row.error).toMatch(/^2 failed\. First error: Postmark request failed/);
		expect(await rowCounts(id)).toEqual({ total: SEND_CHUNK + 2, accepted: SEND_CHUNK, error: 2 });
	});
});

describe('stuckSends (#536)', () => {
	it('lists a broadcast stuck in sending and an overdue scheduled one; skips automation, held, fresh and draining', async () => {
		const stuck = await makeCampaign('sending');
		await db.prepare(`UPDATE campaigns SET created_at = datetime('now', '-2 hours') WHERE id = ?`).bind(stuck).run();
		await db.prepare(`INSERT INTO recipients (campaign_id, email, status, message_id) VALUES (?, 'a@x.example.net', 'accepted', 'm1')`).bind(stuck).run();

		const fresh = await makeCampaign('sending'); // just started

		const automationRow = await makeCampaign('sending');
		const auto = await db.prepare(`INSERT INTO automations (name, status) VALUES ('A', 'active') RETURNING id`).first<{ id: number }>();
		await db
			.prepare(`UPDATE campaigns SET created_at = datetime('now', '-2 hours'), automation_id = ? WHERE id = ?`)
			.bind(auto!.id, automationRow)
			.run();

		const draining = await makeCampaign('sending');
		await db.prepare(`UPDATE campaigns SET created_at = datetime('now', '-2 hours'), best_time = 1 WHERE id = ?`).bind(draining).run();
		await db.prepare(`INSERT INTO recipients (campaign_id, email, status) VALUES (?, 'q@x.example.net', 'queued')`).bind(draining).run();

		const overdue = await makeCampaign('scheduled');
		await db.prepare(`UPDATE campaigns SET scheduled_at = datetime('now', '-1 hour') WHERE id = ?`).bind(overdue).run();
		const held = await makeCampaign('scheduled');
		await db.prepare(`UPDATE campaigns SET scheduled_at = datetime('now', '-1 hour'), held_at = datetime('now') WHERE id = ?`).bind(held).run();
		const soon = await makeCampaign('scheduled');
		await db.prepare(`UPDATE campaigns SET scheduled_at = datetime('now', '-2 minutes') WHERE id = ?`).bind(soon).run();

		const rows = await stuckSends(db);
		expect(rows.map((r) => [r.id, r.kind])).toEqual([
			[stuck, 'sending'],
			[overdue, 'overdue']
		]);
		expect(rows[0].accepted).toBe(1);
		for (const id of [fresh, automationRow, draining, held, soon]) expect(rows.some((r) => r.id === id)).toBe(false);
	});
});
