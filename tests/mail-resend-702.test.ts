import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { sendCampaignEmail } from '../src/lib/server/send';
import {
	fromResendBatch,
	getMailProvider,
	mapResendEvent,
	providerFor,
	resendCheckRows,
	resendProvider,
	svixSignature,
	toResendEmail,
	verifySvix,
	WebhookAuthError,
	type OutboundMessage
} from '../src/lib/server/mail';
import {
	removeResendSecret,
	resendSecretInfo,
	resolveMailCredentials,
	setActiveProvider,
	setResendSecret,
	UNREADABLE_RESEND_KEY_ERROR
} from '../src/lib/server/mail/config';
import { RESEND_STILL_PROCESSING_ERROR, RESEND_UNMATCHED_ERROR } from '../src/lib/server/mail/resend';
import { mailToken, sendingUnconfigured } from '../src/lib/server/db';
import { localRequiredChecks } from '../src/lib/server/setup-checks';
import { POST as resendWebhook } from '../src/routes/api/webhook/resend/+server';
import { load as sendingLoad } from '../src/routes/settings/sending/+page.server';
import * as fx from './fixtures/resend-702';

// #702 (3/5 of #699): Resend behind MailProvider. Fixtures in tests/fixtures/resend-702.ts follow
// Resend's documented shapes; nothing here touches the network (fetch is injected or stubbed).

const db = (env as { DB: D1Database }).DB;
const admin = { id: 1, github_login: 'ourco-admin', role: 'admin' };

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Call = { url: string; init: RequestInit; headers: Record<string, string>; body: any };

/** A fetch that answers from a queue and records every request. */
function fakeFetch(answers: (Response | Error | ((c: Call) => Response))[]) {
	const calls: Call[] = [];
	const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((v, k) => (headers[k] = v));
		const call: Call = { url: String(input), init, headers, body: init.body ? JSON.parse(String(init.body)) : null };
		calls.push(call);
		const a = answers.length > 1 ? answers.shift()! : answers[0];
		if (a instanceof Error) throw a;
		return typeof a === 'function' ? a(call) : a.clone();
	}) as typeof fetch;
	return { fn, calls };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const msg = (to: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
	from: 'News <news@ourco.example>',
	to,
	subject: 'Hi',
	html: '<p>Hi</p>',
	text: 'Hi',
	stream: 'broadcast',
	...extra
});

const noSleep = async () => {};

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM integration_secrets'),
		db.prepare(`DELETE FROM app_state WHERE key IN ('mail_settings', 'mail_settings_events')`)
	]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the Resend adapter: sending', () => {
	it('maps a message to Resend’s JSON: headers, reply-to, stream + id tags', () => {
		const e = toResendEmail(
			msg('pat@ourco.example', {
				replyTo: 'reply+c1r2@ourco.example',
				headers: [
					{ name: 'List-Unsubscribe', value: '<https://crm.myapp.example/unsubscribe/one-click?t=x>' },
					{ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
				],
				metadata: { campaignId: 12, contactId: 34 },
				tracking: { opens: false, links: 'none' }
			})
		);
		expect(e).toEqual({
			from: 'News <news@ourco.example>',
			to: ['pat@ourco.example'],
			subject: 'Hi',
			html: '<p>Hi</p>',
			text: 'Hi',
			reply_to: ['reply+c1r2@ourco.example'],
			headers: {
				'List-Unsubscribe': '<https://crm.myapp.example/unsubscribe/one-click?t=x>',
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
			},
			tags: [
				{ name: 'stream', value: 'broadcast' },
				{ name: 'campaign_id', value: '12' },
				{ name: 'contact_id', value: '34' }
			]
		});
	});

	it('one batch call: key, User-Agent, idempotency key, no permissive header; ids back in order', async () => {
		const f = fakeFetch([jsonRes(fx.batchOk(3))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const res = await p.sendBatch([msg('a@ourco.example'), msg('b@ourco.example'), msg('c@ourco.example')]);
		expect(res.map((r) => r.ok && r.messageId)).toEqual(['rs-msg-0', 'rs-msg-1', 'rs-msg-2']);
		expect(f.calls).toHaveLength(1);
		const c = f.calls[0];
		expect(c.url).toBe('https://api.resend.com/emails/batch');
		expect(c.init.method).toBe('POST');
		expect(c.headers.authorization).toBe(`Bearer ${fx.FAKE_RESEND_KEY}`);
		expect(c.headers['x-batch-validation']).toBeUndefined();
		expect(typeof c.headers['user-agent']).toBe('string');
		expect(c.headers['user-agent'].trim()).not.toBe('');
		expect(c.headers['idempotency-key']).toMatch(/^crm-batch-/);
		expect(c.body.map((e: { to: string[] }) => e.to[0])).toEqual(['a@ourco.example', 'b@ourco.example', 'c@ourco.example']);
	});

	it('more than 100 messages go out in batches of 100', async () => {
		const f = fakeFetch([(c) => jsonRes(fx.batchOk(c.body.length, `b${Math.random()}`))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const res = await p.sendBatch(Array.from({ length: 150 }, (_, i) => msg(`r${i}@ourco.example`)));
		expect(res).toHaveLength(150);
		expect(res.every((r) => r.ok)).toBe(true);
		expect(f.calls.map((c) => c.body.length)).toEqual([100, 50]);
	});

	it('a success whose data length differs from the messages sent matches nothing: no id is guessed', async () => {
		const res = fromResendBatch(3, { data: [{ id: 'rs-a' }, { id: 'rs-b' }] });
		expect(res).toHaveLength(3);
		for (const r of res) expect(r).toEqual({ ok: false, error: RESEND_UNMATCHED_ERROR, permanent: false, raw: undefined });

		const f = fakeFetch([jsonRes({ data: [{ id: 'rs-a' }, { id: 'rs-b' }, { id: 'rs-c' }, { id: 'rs-d' }] })]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const sent = await p.sendBatch([msg('a@ourco.example'), msg('b@ourco.example'), msg('c@ourco.example')]);
		expect(sent.some((r) => r.ok)).toBe(false);
		for (const r of sent) expect(r).toMatchObject({ ok: false, error: RESEND_UNMATCHED_ERROR, permanent: false });
		expect(f.calls).toHaveLength(1); // a success is never retried
	});

	it('a validation failure that every part repeats (400 validation_error) marks every row with Resend’s message, permanently', async () => {
		// #745: the refused batch is split down to single messages; here every part is refused too.
		const f = fakeFetch([jsonRes(fx.errorBatchValidation, 400)]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const res = await p.sendBatch([msg('a@ourco.example'), msg('not-an-address'), msg('c@ourco.example')]);
		expect(res).toHaveLength(3);
		for (const r of res) {
			expect(r).toMatchObject({ ok: false, permanent: true, code: 400 });
			expect(!r.ok && r.error).toContain('Invalid `to` field');
		}
		expect(f.calls.map((c) => c.body.length)).toEqual([3, 2, 1, 1, 1]);
	});

	it('a 429 is retried with the same idempotency key; a refused key fails the batch, not permanently', async () => {
		const f = fakeFetch([jsonRes(fx.errorRateLimit, 429, { 'retry-after': '1' }), jsonRes(fx.batchOk(1))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const [ok] = await p.sendBatch([msg('a@ourco.example')]);
		expect(ok).toMatchObject({ ok: true, messageId: 'rs-msg-0' });
		expect(f.calls).toHaveLength(2);
		expect(f.calls[0].headers['idempotency-key']).toBe(f.calls[1].headers['idempotency-key']);

		const g = fakeFetch([jsonRes(fx.errorInvalidKey, 403)]);
		const q = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: g.fn, sleep: noSleep });
		const res = await q.sendBatch([msg('a@ourco.example'), msg('b@ourco.example')]);
		expect(res).toHaveLength(2);
		for (const r of res) expect(r).toMatchObject({ ok: false, permanent: false, code: 403 });

		const v = fakeFetch([jsonRes(fx.errorInvalidParameter, 422)]);
		const w = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: v.fn, sleep: noSleep });
		expect((await w.sendBatch([msg('a@ourco.example')]))[0]).toMatchObject({ ok: false, permanent: true, code: 422 });
	});

	it('a 429 quota error is not retried and names the quota; it is not permanent', async () => {
		const f = fakeFetch([jsonRes(fx.errorDailyQuota, 429, { 'retry-after': '1' }), jsonRes(fx.batchOk(1))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const [r] = await p.sendBatch([msg('a@ourco.example')]);
		expect(r).toMatchObject({ ok: false, permanent: false, code: 429 });
		expect(!r.ok && r.error).toContain('daily sending quota');
		expect(f.calls).toHaveLength(1);
	});

	it('409 concurrent_idempotent_requests is waited out and retried with the same key; the ids are stored', async () => {
		const f = fakeFetch([new Error('The operation was aborted'), jsonRes(fx.errorConcurrentIdempotent, 409), (c) => jsonRes(fx.batchOk(c.body.length, 'idem'))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const cid = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Hi', 'x', 'x', 'news@ourco.example', 'sending') RETURNING id`)
			.first<{ id: number }>())!.id;
		const res = await sendCampaignEmail(db, {
			provider: p,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [
				{ id: null, email: 'a@ourco.example', name: null, first_name: 'A', last_name: null },
				{ id: null, email: 'b@ourco.example', name: null, first_name: 'B', last_name: null }
			],
			subject: 'Hi',
			htmlTemplate: '<p>Hello</p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>',
			textTemplate: 'Hello\n\nUnsubscribe: %%UNSUB_URL%%',
			from: 'news@ourco.example',
			stream: 'broadcast'
		});
		expect(res.accepted).toBe(2);
		expect(f.calls).toHaveLength(3);
		const keys = f.calls.map((c) => c.headers['idempotency-key']);
		expect(new Set(keys).size).toBe(1);
		const rows = await db.prepare('SELECT message_id, status FROM recipients WHERE campaign_id = ? ORDER BY id').bind(cid).all();
		expect(rows.results).toEqual([
			{ message_id: 'idem-0', status: 'accepted' },
			{ message_id: 'idem-1', status: 'accepted' }
		]);
	});

	it('attempts that run out on the 409 say the batch may have been sent, not a plain failure', async () => {
		const f = fakeFetch([jsonRes(fx.errorConcurrentIdempotent, 409)]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const res = await p.sendBatch([msg('a@ourco.example'), msg('b@ourco.example')]);
		expect(f.calls).toHaveLength(3);
		for (const r of res) {
			expect(r).toMatchObject({ ok: false, error: RESEND_STILL_PROCESSING_ERROR, permanent: false, code: 409 });
			expect(r.ok === false && r.transport).toBeFalsy();
		}
	});

	it('a dropped connection is a transport failure, and the key never shows in an error', async () => {
		const f = fakeFetch([new Error(`connect failed (Bearer ${fx.FAKE_RESEND_KEY})`)]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const [r] = await p.sendBatch([msg('a@ourco.example')]);
		expect(r).toMatchObject({ ok: false, transport: true, permanent: false });
		expect(JSON.stringify(r)).not.toContain(fx.FAKE_RESEND_KEY);
		expect(f.calls).toHaveLength(3); // retried with the same key, then given up
	});

	it('the shared send path: broadcast carries List-Unsubscribe; rows record provider resend and Resend’s ids', async () => {
		const f = fakeFetch([(c) => jsonRes(fx.batchOk(c.body.length, 'send'))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const cid = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Hi', 'x', 'x', 'news@ourco.example', 'sending') RETURNING id`)
			.first<{ id: number }>())!.id;
		const html = '<p>Hello</p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>';
		const res = await sendCampaignEmail(db, {
			provider: p,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [
				{ id: null, email: 'a@ourco.example', name: null, first_name: 'A', last_name: null },
				{ id: null, email: 'b@ourco.example', name: null, first_name: 'B', last_name: null }
			],
			subject: 'Hi',
			htmlTemplate: html,
			textTemplate: 'Hello\n\nUnsubscribe: %%UNSUB_URL%%',
			from: 'news@ourco.example',
			stream: 'broadcast'
		});
		expect(res.accepted).toBe(2);
		const sent = f.calls[0].body as { headers: Record<string, string>; tags: { name: string; value: string }[] }[];
		for (const e of sent) {
			expect(e.headers['List-Unsubscribe']).toMatch(/^<https:\/\/crm\.myapp\.example\/unsubscribe\/one-click\?t=/);
			expect(e.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
			expect(e.tags).toContainEqual({ name: 'stream', value: 'broadcast' });
			expect(e.tags).toContainEqual({ name: 'campaign_id', value: String(cid) });
		}
		const rows = await db.prepare('SELECT message_id, status, provider FROM recipients WHERE campaign_id = ? ORDER BY id').bind(cid).all();
		expect(rows.results).toEqual([
			{ message_id: 'send-0', status: 'accepted', provider: 'resend' },
			{ message_id: 'send-1', status: 'accepted', provider: 'resend' }
		]);
	});

	it('a caller naming the transactional stream gets the transactional tag', async () => {
		const f = fakeFetch([jsonRes(fx.batchOk(1))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn, sleep: noSleep });
		const cid = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('Re', 'x', 'x', 'me@ourco.example', 'sending') RETURNING id`)
			.first<{ id: number }>())!.id;
		await sendCampaignEmail(db, {
			provider: p,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [{ id: null, email: 'a@ourco.example', name: null, first_name: null, last_name: null }],
			subject: 'Re: hi',
			htmlTemplate: '<p>x</p>',
			textTemplate: 'x',
			from: 'me@ourco.example',
			stream: 'outbound',
			unsubscribe: false
		});
		expect(f.calls[0].body[0].tags).toContainEqual({ name: 'stream', value: 'transactional' });
		expect(f.calls[0].body[0].headers?.['List-Unsubscribe']).toBeUndefined();
	});
});

describe('the Resend webhook signature (Svix)', () => {
	const body = JSON.stringify(fx.evDelivered('rs-1', 'a@ourco.example'));
	const now = 1_800_000_000_000;
	const ts = String(now / 1000);

	it('passes for the right secret, id, timestamp and body', async () => {
		const sig = (await svixSignature(fx.FAKE_WEBHOOK_SECRET, 'msg_1', ts, body))!;
		expect(sig).toMatch(/^v1,/);
		expect(await verifySvix(fx.FAKE_WEBHOOK_SECRET, { id: 'msg_1', timestamp: ts, signature: sig }, body, now)).toBe(true);
		// Several signatures (secret rotation): any one is enough.
		expect(await verifySvix(fx.FAKE_WEBHOOK_SECRET, { id: 'msg_1', timestamp: ts, signature: `v1,AAAA ${sig}` }, body, now)).toBe(true);
	});

	it('fails for a changed body, another id, another secret, a stale timestamp or missing headers', async () => {
		const sig = (await svixSignature(fx.FAKE_WEBHOOK_SECRET, 'msg_1', ts, body))!;
		expect(await verifySvix(fx.FAKE_WEBHOOK_SECRET, { id: 'msg_1', timestamp: ts, signature: sig }, body + ' ', now)).toBe(false);
		expect(await verifySvix(fx.FAKE_WEBHOOK_SECRET, { id: 'msg_2', timestamp: ts, signature: sig }, body, now)).toBe(false);
		expect(await verifySvix('whsec_' + btoa('another-secret-entirely'), { id: 'msg_1', timestamp: ts, signature: sig }, body, now)).toBe(false); // gitleaks:allow
		expect(await verifySvix(fx.FAKE_WEBHOOK_SECRET, { id: 'msg_1', timestamp: ts, signature: sig }, body, now + 6 * 60 * 1000)).toBe(false);
		expect(await verifySvix(fx.FAKE_WEBHOOK_SECRET, { id: null, timestamp: ts, signature: sig }, body, now)).toBe(false);
		expect(await verifySvix('', { id: 'msg_1', timestamp: ts, signature: sig }, body, now)).toBe(false);
	});

	it('Svix’s published test vector verifies (known answer, not our own signer)', async () => {
		// Svix's public documentation vector, not a secret of ours.
		const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'; // gitleaks:allow
		// Split so the public-export scanner does not read this public test vector as a token.
		const headers = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: 'v1,g0hM9SsE+OTPJTGt/tmIK' + 'tSyZlE3uFJELVlNIOLJ1OE=' };
		const raw = '{"test": 2432232314}';
		const at = 1614265330 * 1000;
		expect(await verifySvix(secret, headers, raw, at)).toBe(true);
		expect(await verifySvix(secret, headers, '{"test": 2432232315}', at)).toBe(false); // one byte changed
		expect(await verifySvix(secret, headers, raw, at + 6 * 60 * 1000)).toBe(false); // 6 minutes later
	});

	it('parseWebhook throws WebhookAuthError on a bad signature before reading the body as data', async () => {
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', webhookSecret: fx.FAKE_WEBHOOK_SECRET });
		const req = new Request('https://crm.myapp.example/api/webhook/resend', {
			method: 'POST',
			body: 'not json at all',
			headers: { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,bad' }
		});
		await expect(p.parseWebhook!(req)).rejects.toBeInstanceOf(WebhookAuthError);
	});
});

describe('Resend events map to the shared event types', () => {
	it('delivery, open, click, hard and soft bounce, suppressed, complaint, failed; others ignored', () => {
		const to = 'a@ourco.example';
		expect(mapResendEvent(fx.evDelivered('m1', to), 'd1')).toMatchObject({ kind: 'event', type: 'delivery', messageId: 'm1', email: to, payload: { RecordType: 'Delivery', ID: 'd1', Source: 'resend' } });
		// email.opened carries no `open` object: an open with an empty user agent, at the event time.
		expect(mapResendEvent(fx.evOpened('m1', to), 'd2')).toMatchObject({ type: 'open', payload: { RecordType: 'Open', UserAgent: '', ReceivedAt: '2026-11-25T10:00:05.000Z' } });
		const click = mapResendEvent(fx.evClicked('m1', to), 'd3');
		expect(click).toMatchObject({ type: 'click', payload: { RecordType: 'Click', OriginalLink: 'https://ourco.example/pricing' } });
		expect(JSON.stringify(click)).not.toContain('192.0.2.10'); // never the IP
		expect(mapResendEvent(fx.evBounced('m1', to), 'd4')).toMatchObject({ type: 'bounce', hard: true, payload: { Type: 'HardBounce' } });
		expect(mapResendEvent(fx.evBounced('m1', to, 'Transient', 'MailboxFull'), 'd5')).toMatchObject({ type: 'bounce', hard: false, payload: { Type: 'SoftBounce' } });
		expect(mapResendEvent(fx.evSuppressed('m1', to), 'd6')).toMatchObject({ type: 'bounce', hard: true, payload: { Type: 'HardBounce' } });
		expect(mapResendEvent(fx.evComplained('m1', to), 'd7')).toMatchObject({ type: 'spam', payload: { RecordType: 'SpamComplaint' } });
		expect(mapResendEvent(fx.evFailed('m1', to), 'd8')).toMatchObject({ kind: 'failed', reason: 'reached_daily_quota' });
		expect(mapResendEvent(fx.evSent('m1', to), 'd9')).toBeNull();
	});
});

describe('/api/webhook/resend', () => {
	async function sentTo(email: string, messageId: string, trackId: string | null = null): Promise<number> {
		const contactId = (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
		const cid = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'news@ourco.example', 'sent') RETURNING id`)
			.first<{ id: number }>())!.id;
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status, provider, track_id) VALUES (?, ?, ?, ?, 'accepted', 'resend', ?)")
			.bind(cid, contactId, email, messageId, trackId)
			.run();
		return contactId;
	}

	async function post(payload: unknown, opts: { id?: string; secret?: string | null; signWith?: string; tamper?: boolean } = {}) {
		const body = JSON.stringify(payload);
		const id = opts.id ?? `msg_${crypto.randomUUID()}`;
		const ts = String(Math.floor(Date.now() / 1000));
		const sig = (await svixSignature(opts.signWith ?? fx.FAKE_WEBHOOK_SECRET, id, ts, body))!;
		const envSecret = opts.secret === null ? '' : (opts.secret ?? fx.FAKE_WEBHOOK_SECRET);
		return resendWebhook({
			platform: { env: { ...env, RESEND_WEBHOOK_SECRET: envSecret } },
			url: new URL('https://crm.myapp.example/api/webhook/resend'),
			request: new Request('https://crm.myapp.example/api/webhook/resend', {
				method: 'POST',
				body: opts.tamper ? body.replace('ourco', 'other') : body,
				headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }
			})
		} as any);
	}

	const subscribed = async (id: number) => (await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed;
	const events = async (mid: string) => (await db.prepare('SELECT type FROM events WHERE message_id = ? ORDER BY id').bind(mid).all<{ type: string }>()).results.map((r) => r.type);

	it('refuses a bad signature, another secret or no secret configured — nothing stored', async () => {
		const id = await sentTo('hard@ourco.example', 'rs-hard');
		const payload = fx.evBounced('rs-hard', 'hard@ourco.example');
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await post(payload, { tamper: true })).status).toBe(401);
		expect((await post(payload, { signWith: 'whsec_' + btoa('not-the-configured-one') })).status).toBe(401); // gitleaks:allow
		expect((await post(payload, { secret: null })).status).toBe(401);
		expect(await events('rs-hard')).toEqual([]);
		expect(await subscribed(id)).toBe(1);
		errSpy.mockRestore();
	});

	it('a hard bounce suppresses the contact (via Resend); a retry of the same delivery is a no-op', async () => {
		const id = await sentTo('hard@ourco.example', 'rs-hard');
		const payload = fx.evBounced('rs-hard', 'hard@ourco.example');
		const first = await post(payload, { id: 'msg_retry_1' });
		expect(first.status).toBe(200);
		expect(await subscribed(id)).toBe(0);
		const again = await post(payload, { id: 'msg_retry_1' });
		expect(await again.json()).toMatchObject({ ok: true, duplicate: true });
		expect(await events('rs-hard')).toEqual(['bounce']);
		const unsub = await db.prepare('SELECT reason, detail FROM unsubscribes WHERE email = ?').bind('hard@ourco.example').all();
		expect(unsub.results).toEqual([{ reason: 'HardBounce', detail: 'via Resend' }]);
	});

	it('a soft bounce is recorded and suppresses nobody; a complaint suppresses', async () => {
		const soft = await sentTo('soft@ourco.example', 'rs-soft');
		await post(fx.evBounced('rs-soft', 'soft@ourco.example', 'Transient', 'MailboxFull'));
		expect(await events('rs-soft')).toEqual(['bounce']);
		expect(await subscribed(soft)).toBe(1);

		const spam = await sentTo('spam@ourco.example', 'rs-spam');
		await post(fx.evComplained('rs-spam', 'spam@ourco.example'));
		expect(await events('rs-spam')).toEqual(['spam']);
		expect(await subscribed(spam)).toBe(0);
	});

	it('delivery, open and click land as events; opens and clicks of CRM-tracked mail are ignored', async () => {
		await sentTo('eng@ourco.example', 'rs-eng');
		await post(fx.evDelivered('rs-eng', 'eng@ourco.example'));
		await post(fx.evOpened('rs-eng', 'eng@ourco.example'));
		await post(fx.evClicked('rs-eng', 'eng@ourco.example'));
		expect(await events('rs-eng')).toEqual(['delivery', 'open', 'click']);
		const detail = await db.prepare("SELECT detail FROM events WHERE message_id = 'rs-eng' AND type = 'open'").first<{ detail: string }>();
		expect(JSON.parse(detail!.detail)).toMatchObject({ RecordType: 'Open', FirstOpen: true, Source: 'resend', UserAgent: '' });

		await sentTo('crm@ourco.example', 'rs-crm', 'track-702');
		await post(fx.evOpened('rs-crm', 'crm@ourco.example'));
		expect(await events('rs-crm')).toEqual([]);
	});

	it('email.failed marks the send failed with Resend’s reason; a suppression by an address we never sent it to changes nobody', async () => {
		await sentTo('fail@ourco.example', 'rs-fail');
		await post(fx.evFailed('rs-fail', 'fail@ourco.example'));
		const row = await db.prepare("SELECT status, error FROM recipients WHERE message_id = 'rs-fail'").first<{ status: string; error: string }>();
		expect(row).toEqual({ status: 'error', error: 'Resend: reached_daily_quota' });

		const id = await sentTo('real@ourco.example', 'rs-real');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await post(fx.evSuppressed('rs-real', 'someone-else@ourco.example'));
		expect(await subscribed(id)).toBe(1);
		warn.mockRestore();
	});
});

describe('Resend credentials and Settings → Sending', () => {
	const KEY = newKey();

	it('env fallback, then the sealed key wins; the stored row and audit never carry it', async () => {
		let c = await resolveMailCredentials(db, { RESEND_API_KEY: 're_env_FakeKey000000', RESEND_WEBHOOK_SECRET: fx.FAKE_WEBHOOK_SECRET }); // gitleaks:allow
		expect(c.resend).toMatchObject({ apiKey: 're_env_FakeKey000000', apiKeyFrom: 'env', webhookSecretFrom: 'env' }); // gitleaks:allow
		const e = { MAIL_TOKEN_KEY: KEY, RESEND_API_KEY: 're_env_FakeKey000000' }; // gitleaks:allow
		await setResendSecret(db, e, 'api_key', fx.FAKE_RESEND_KEY, admin);
		c = await resolveMailCredentials(db, e);
		expect(c.resend).toMatchObject({ apiKey: fx.FAKE_RESEND_KEY, apiKeyFrom: 'app' });
		const row = await db.prepare(`SELECT blob, last4 FROM integration_secrets WHERE provider = 'mail_resend'`).first<{ blob: string; last4: string }>();
		expect(row!.blob).not.toContain('FakeKey');
		expect(row!.last4).toBe('');
		const audit = await db.prepare(`SELECT value FROM app_state WHERE key = 'mail_settings_events'`).first<{ value: string }>();
		expect(audit!.value).not.toContain('FakeKey');
		expect(await resendSecretInfo(db, e, 'api_key')).toMatchObject({ source: 'app', error: null });
		expect(await removeResendSecret(db, 'api_key', admin)).toBe(true);
		expect((await resolveMailCredentials(db, e)).resend.apiKeyFrom).toBe('env');
	});

	it('an unreadable saved key fails closed: no env fallback, sending refused with the message', async () => {
		const e = { MAIL_TOKEN_KEY: KEY, RESEND_API_KEY: 're_env_FakeKey000000' }; // gitleaks:allow
		await setResendSecret(db, e, 'api_key', fx.FAKE_RESEND_KEY, admin);
		expect(await setActiveProvider(db, 'resend', admin)).toEqual({ ok: true, changed: true });
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const rotated = { ...e, MAIL_TOKEN_KEY: newKey() };
		const c = await resolveMailCredentials(db, rotated);
		expect(c.provider).toBe('resend');
		expect(c.resend).toMatchObject({ apiKey: '', apiKeyFrom: 'unreadable', apiKeyError: UNREADABLE_RESEND_KEY_ERROR });
		expect(await getMailProvider(db, rotated)).toBeNull();
		expect(sendingUnconfigured(null, c)).toBe(false); // a problem, not "not set up yet"
		try {
			mailToken({} as any, c);
			throw new Error('expected a 500');
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(500);
		}
		expect(JSON.stringify(errSpy.mock.calls)).not.toContain('FakeKey');
		errSpy.mockRestore();
	});

	it('Resend active: providerFor builds it with the stream names; Setup asks for the Resend key', async () => {
		const e = { DB: db, MAIL_PROVIDER: 'resend', RESEND_API_KEY: fx.FAKE_RESEND_KEY, POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 's', CRON_KEY: 'c', MEDIA: {} };
		const c = await resolveMailCredentials(db, e);
		const p = providerFor(e, c)!;
		expect(p.id).toBe('resend');
		expect(p.streams).toEqual({ broadcast: 'broadcast', transactional: 'outbound' });
		expect(p.trackingBy).toBe('provider');
		expect(mailToken({} as any, c)).toBe(''); // no Postmark token needed; the provider sends
		const rows = await localRequiredChecks(db, e);
		expect(rows.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'ready' });
		expect(rows.find((r) => r.id === 'postmark_token')).toBeUndefined();
		const none = await localRequiredChecks(db, { ...e, RESEND_API_KEY: '' });
		expect(none.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'attention' });
	});

	it('Test connection rows: full key, sending-only key, rejected key, tracking mismatch', async () => {
		const full = fakeFetch([jsonRes(fx.domainsList), jsonRes(fx.domainDetail({ open: true, click: true }))]);
		const rows = await resendCheckRows({ apiKey: fx.FAKE_RESEND_KEY, webhookSecret: fx.FAKE_WEBHOOK_SECRET, trackingBy: 'crm' }, full.fn);
		expect(rows.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'ready' });
		expect(rows.find((r) => r.id === 'resend_domains')).toMatchObject({ state: 'ready', detail: 'Verified: ourco.example.' });
		expect(rows.find((r) => r.id === 'resend_webhook')).toMatchObject({ state: 'ready' });
		expect(rows.find((r) => r.id === 'resend_tracking')).toMatchObject({ state: 'attention' });

		const restricted = fakeFetch([jsonRes(fx.errorRestricted, 401)]);
		const r2 = await resendCheckRows({ apiKey: fx.FAKE_RESEND_KEY, webhookSecret: '' }, restricted.fn);
		expect(r2.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'ready', detail: expect.stringContaining('sending access only') });
		expect(r2.find((r) => r.id === 'resend_webhook')).toMatchObject({ state: 'attention' });

		const bad = fakeFetch([jsonRes(fx.errorInvalidKey, 403)]);
		const r3 = await resendCheckRows({ apiKey: fx.FAKE_RESEND_KEY, webhookSecret: '' }, bad.fn);
		expect(r3.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'attention', detail: 'Resend rejected the key.' });

		// An inactive key: 403 restricted_api_key is a rejected key, not "sending access only".
		const inactive = fakeFetch([jsonRes(fx.errorInactiveKey, 403)]);
		const r4 = await resendCheckRows({ apiKey: fx.FAKE_RESEND_KEY, webhookSecret: '' }, inactive.fn);
		expect(r4.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'attention', detail: 'Resend rejected the key.' });

		// A bad key on /domains: 400 validation_error "API key is invalid" is a rejected key, not "Couldn't reach Resend".
		const invalid = fakeFetch([jsonRes(fx.errorInvalidKeyValidation, 400)]);
		const r5 = await resendCheckRows({ apiKey: fx.FAKE_RESEND_KEY, webhookSecret: '' }, invalid.fn);
		expect(r5.find((r) => r.id === 'resend_api_key')).toMatchObject({ state: 'attention', detail: 'Resend rejected the key.' });

		for (const c of [...full.calls, ...restricted.calls, ...bad.calls]) expect(c.headers['user-agent']?.trim()).toBeTruthy();
		for (const r of [...rows, ...r2, ...r3, ...r4, ...r5]) expect(JSON.stringify(r)).not.toContain(fx.FAKE_RESEND_KEY);
	});

	it('domain status reads DKIM and the return path records (MX and TXT only, not the Forge CNAME); every call sends a User-Agent', async () => {
		const f = fakeFetch([jsonRes(fx.domainsList), jsonRes(fx.domainDetail(null))]);
		const p = resendProvider({ apiKey: fx.FAKE_RESEND_KEY, broadcast: 'broadcast', transactional: 'outbound', fetch: f.fn });
		expect(await p.domainStatus!('OurCo.example')).toEqual({ domain: 'ourco.example', found: true, verified: true, dkim: true, returnPath: true });
		expect(f.calls).toHaveLength(2);
		for (const c of f.calls) {
			expect(typeof c.headers['user-agent']).toBe('string');
			expect(c.headers['user-agent'].trim()).not.toBe('');
		}
	});

	it('the page shows Resend secrets as set / not set, never their values', async () => {
		const pageEnv = { DB: db, MAIL_TOKEN_KEY: KEY, RESEND_WEBHOOK_SECRET: fx.FAKE_WEBHOOK_SECRET, PUBLIC_BASE_URL: 'https://crm.myapp.example' };
		await setResendSecret(db, pageEnv, 'api_key', fx.FAKE_RESEND_KEY, admin);
		const ev = {
			url: new URL('https://crm.myapp.example/settings/sending'),
			params: {},
			platform: { env: pageEnv },
			locals: { user: admin },
			request: new Request('https://crm.myapp.example/settings/sending')
		} as any;
		const data = (await sendingLoad(ev)) as any;
		expect(data.resend.apiKey.source).toBe('app');
		expect(data.resend.webhookSecret.source).toBe('env');
		expect(data.resendWebhookUrl).toBe('https://crm.myapp.example/api/webhook/resend');
		expect(data.providers.find((p: { id: string }) => p.id === 'resend').available).toBe(true);
		const json = JSON.stringify(data);
		for (const secret of [fx.FAKE_RESEND_KEY, fx.FAKE_WEBHOOK_SECRET, KEY]) expect(json).not.toContain(secret);
	});
});
