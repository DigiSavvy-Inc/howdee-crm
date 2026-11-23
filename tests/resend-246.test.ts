import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';

// #246: reschedule a pending resend, original-vs-resend stats, Claude resend subjects.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { actions as campaignPage } from '../src/routes/campaign/[id]/+page.server';
import { POST as suggestPost } from '../src/routes/api/ai/resend-subject/+server';
import { performResend, resendPassBreakdown } from '../src/lib/server/resend';
import { sendCampaignEmail } from '../src/lib/server/send';
import { processScheduledResends } from '../src/lib/server/scheduled';
import { toZonedLocalInput, parseZonedLocal } from '../src/lib/server/businessdays';
import {
	cleanSuggestion,
	suggestResendSubject,
	resetAiSubjectRateLimit,
	AI_SUBJECT_MODEL,
	AI_SUBJECT_RATE_LIMIT
} from '../src/lib/server/ai-subject';

const db = (env as any).DB as D1Database;
const platformEnv = {
	...(env as any),
	POSTMARK_TOKEN: 'test',
	POSTMARK_STREAM: 'broadcast',
	SESSION_SECRET: 'secret',
	PUBLIC_BASE_URL: 'https://app.test'
};
const TZ = 'America/Los_Angeles';
const GONE = 'This resend already went out or was cancelled.';

function actionEvent(id: number, action: string, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = new URL(`https://app.test/campaign/${id}?/${action}`);
	return { platform: { env: platformEnv }, params: { id: String(id) }, url, request: new Request(url, { method: 'POST', body: fd }) } as any;
}

async function run(fn: (e: any) => unknown, e: any): Promise<{ redirect?: string; result?: any }> {
	try {
		return { result: await fn(e) };
	} catch (err) {
		if (!isRedirect(err)) throw err;
		return { redirect: err.location };
	}
}

async function row(id: number) {
	return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<any>();
}

async function makeCampaign(resendStatus: string | null, resendAtOffset = '+1 day', resendSubject: string | null = 'Old resend'): Promise<number> {
	const c = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status, sent_at, recipient_count,
			                        resend_at, resend_status, resend_subject)
			 VALUES ('Hello {{first_name}}', 'md', '<p>hi %%UNSUB_URL%%</p>', 'hi %%UNSUB_URL%%', 'alan@ourco.example', 'sent', datetime('now'), 1,
			         datetime('now', ?), ?, ?)
			 RETURNING id`
		)
		.bind(resendAtOffset, resendStatus, resendSubject)
		.first<{ id: number }>();
	return c!.id;
}

async function makeContact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
}

async function makeRecipient(campaignId: number, contactId: number, email: string, pass: string | null = null): Promise<number> {
	const r = await db
		.prepare('INSERT INTO recipients (campaign_id, contact_id, email, status, message_id, send_pass) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(campaignId, contactId, email, 'accepted', `msg-${email}-${Math.random()}`, pass)
		.first<{ id: number }>();
	return r!.id;
}

async function addEvent(campaignId: number, recipientId: number, contactId: number, type: string): Promise<void> {
	await db
		.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, ?)')
		.bind(campaignId, recipientId, contactId, type)
		.run();
}

const utc = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `mid-${Date.now()}-${i}-${Math.random()}` }))
	);
	resetAiSubjectRateLimit();
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key IN ('timezone', 'approved_senders', 'ai_resend_subject', 'site_tracking_links')")
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reschedule a pending resend (#246)', () => {
	it('Edit overwrites resend_at (operator timezone) and resend_subject', async () => {
		const id = await makeCampaign('pending');
		const target = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
		target.setUTCSeconds(0, 0);
		const local = toZonedLocalInput(target, TZ);

		const r = await run(
			campaignPage.resend!,
			actionEvent(id, 'resend', { edit: '1', subject: 'Second chance, {{first_name}}', resend_when: 'custom', resend_at: local })
		);
		expect(r.redirect).toBe(`/campaign/${id}`);
		const after = await row(id);
		expect(after.resend_status).toBe('pending');
		expect(after.resend_subject).toBe('Second chance, {{first_name}}');
		expect(after.resend_at).toBe(utc(parseZonedLocal(local, TZ)!));
		expect(after.resend_at).toBe(utc(target));
	});

	it('keeps the same validation (custom time at least 15 minutes out)', async () => {
		const id = await makeCampaign('pending');
		const soon = toZonedLocalInput(new Date(Date.now() + 5 * 60 * 1000), TZ);
		const before = await row(id);
		const r = await run(campaignPage.resend!, actionEvent(id, 'resend', { edit: '1', subject: 'x', resend_when: 'custom', resend_at: soon }));
		expect(r.result?.status).toBe(400);
		expect(await row(id)).toMatchObject({ resend_at: before.resend_at, resend_subject: 'Old resend' });
	});

	it('fails when the resend already went out or was cancelled', async () => {
		for (const status of ['sent', 'canceled', 'sending']) {
			const id = await makeCampaign(status);
			const before = await row(id);
			const r = await run(campaignPage.resend!, actionEvent(id, 'resend', { edit: '1', subject: 'New', resend_when: '24h' }));
			expect(r.result?.status).toBe(400);
			expect(r.result?.data?.error).toBe(GONE);
			const after = await row(id);
			expect(after.resend_status).toBe(status);
			expect(after.resend_at).toBe(before.resend_at);
			expect(after.resend_subject).toBe('Old resend');
		}
	});

	it('Edit → Now claims the pending resend, sends it once, and marks it sent', async () => {
		const id = await makeCampaign('pending');
		const ann = await makeContact('ann@x.example.net');
		await makeRecipient(id, ann, 'ann@x.example.net');

		const r = await run(campaignPage.resend!, actionEvent(id, 'resend', { edit: '1', subject: 'Now please', resend_when: 'now' }));
		expect(r.redirect).toBe(`/campaign/${id}`);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		expect((await row(id)).resend_status).toBe('sent');

		// A second edit of the same (no longer pending) resend fails and sends nothing.
		const again = await run(campaignPage.resend!, actionEvent(id, 'resend', { edit: '1', subject: 'Again', resend_when: 'now' }));
		expect(again.result?.data?.error).toBe(GONE);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
	});

	it('a resend can be scheduled again after a cancel', async () => {
		const id = await makeCampaign('pending');
		const cancel = await run(campaignPage.cancelResend!, actionEvent(id, 'cancelResend', {}));
		expect(cancel.result).toEqual({ ok: true });
		expect((await row(id)).resend_status).toBe('canceled');

		const r = await run(campaignPage.resend!, actionEvent(id, 'resend', { subject: 'Try again', resend_when: '3d' }));
		expect(r.redirect).toBe(`/campaign/${id}`);
		expect(await row(id)).toMatchObject({ resend_status: 'pending', resend_subject: 'Try again' });
	});
});

describe('send_pass + original vs resend breakdown (#246)', () => {
	it('performResend stamps resend; a normal send leaves send_pass NULL', async () => {
		const id = await makeCampaign(null, '+1 day', null);
		const cfg = { token: 't', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };
		const recipient = { id: await makeContact('bo@x.example.net'), email: 'bo@x.example.net', name: null, first_name: 'Bo', last_name: null };

		await sendCampaignEmail(db, {
			...cfg,
			campaignId: id,
			recipients: [recipient],
			subject: 'Hello',
			htmlTemplate: '<p>hi %%UNSUB_URL%%</p>',
			textTemplate: 'hi %%UNSUB_URL%%',
			from: 'alan@ourco.example'
		});
		await performResend(
			db,
			{ id, subject: 'Hello {{first_name}}', body_html: '<p>hi %%UNSUB_URL%%</p>', body_text: 'hi %%UNSUB_URL%%', from_email: 'alan@ourco.example' },
			'Again',
			[recipient],
			cfg
		);

		const rows = await db
			.prepare('SELECT send_pass FROM recipients WHERE campaign_id = ? ORDER BY id')
			.bind(id)
			.all<{ send_pass: string | null }>();
		expect(rows.results.map((r) => r.send_pass)).toEqual([null, 'resend']);
	});

	it('splits sent / unique opens / unique clicks by pass; the passes add up to the combined tiles', async () => {
		const id = await makeCampaign('sent', '-1 day', 'Again');
		const a = await makeContact('a@x.example.net');
		const b = await makeContact('b@x.example.net');
		const c = await makeContact('c@x.example.net');
		const d = await makeContact('d@x.example.net');
		const rA = await makeRecipient(id, a, 'a@x.example.net'); // NULL = original (pre-0070 rows)
		const rB = await makeRecipient(id, b, 'b@x.example.net', 'original');
		const rC = await makeRecipient(id, c, 'c@x.example.net');
		await makeRecipient(id, d, 'd@x.example.net');
		const rC2 = await makeRecipient(id, c, 'c@x.example.net', 'resend');
		const rD2 = await makeRecipient(id, d, 'd@x.example.net', 'resend');

		await addEvent(id, rA, a, 'open');
		await addEvent(id, rA, a, 'open'); // repeat open: still one unique
		await addEvent(id, rB, b, 'click');
		await addEvent(id, rC2, c, 'open');
		await addEvent(id, rC2, c, 'click');
		await addEvent(id, rD2, d, 'bounce');
		void rC;

		const p = await resendPassBreakdown(db, id);
		expect(p.original).toEqual({ sent: 4, opens: 1, clicks: 1 });
		expect(p.resend).toEqual({ sent: 2, opens: 1, clicks: 1 });

		// The combined tiles (same SQL as the campaign page) are unchanged and equal the sum.
		const combined = await db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM recipients WHERE campaign_id = ?1 AND status = 'accepted') AS sent,
				   (SELECT COUNT(DISTINCT recipient_id) FROM events WHERE campaign_id = ?1 AND type = 'open') AS unique_opens,
				   (SELECT COUNT(DISTINCT recipient_id) FROM events WHERE campaign_id = ?1 AND type = 'click') AS unique_clicks`
			)
			.bind(id)
			.first<{ sent: number; unique_opens: number; unique_clicks: number }>();
		expect(combined).toEqual({ sent: 6, unique_opens: 2, unique_clicks: 2 });
		expect(p.original.sent + p.resend.sent).toBe(combined!.sent);
		expect(p.original.opens + p.resend.opens).toBe(combined!.unique_opens);
		expect(p.original.clicks + p.resend.clicks).toBe(combined!.unique_clicks);
	});

	it('a campaign with no resend has everything under original', async () => {
		const id = await makeCampaign(null, '+1 day', null);
		const a = await makeContact('a@x.example.net');
		const rA = await makeRecipient(id, a, 'a@x.example.net');
		await addEvent(id, rA, a, 'open');
		expect(await resendPassBreakdown(db, id)).toEqual({
			original: { sent: 1, opens: 1, clicks: 0 },
			resend: { sent: 0, opens: 0, clicks: 0 }
		});
	});
});

function claudeReply(text: string, status = 200) {
	return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('suggestResendSubject (#246)', () => {
	it('calls the Messages API and cleans quotes/newlines, keeping merge tags', async () => {
		const fetchMock = vi.fn(async () => claudeReply('"Still time, {{first_name}}: the launch"\n'));
		const out = await suggestResendSubject('Hello {{first_name}}, the launch', { apiKey: 'k', fetch: fetchMock as any });
		expect(out).toBe('Still time, {{first_name}}: the launch');

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
		const body = JSON.parse(String(init.body));
		expect(body.model).toBe(AI_SUBJECT_MODEL);
		expect(body.model).toBe('claude-haiku-5-5');
		expect(body.system).toContain("Lightly rewrite this email subject for a resend to people who didn't open it.");
		expect(body.messages).toEqual([{ role: 'user', content: 'Hello {{first_name}}, the launch' }]);
	});

	it('rejects a reply that drops, changes or adds a merge tag', async () => {
		for (const reply of ['Still time: the launch', 'Still time, {{ first_name }}', 'Hi {{name}}', 'Hi {{first_name}} {{company}}']) {
			const out = await suggestResendSubject('Hello {{first_name}}', { apiKey: 'k', fetch: (async () => claudeReply(reply)) as any });
			expect(out).toBeNull();
		}
	});

	it('rejects empty and over-long replies, and errors', async () => {
		expect(await suggestResendSubject('Hello', { apiKey: 'k', fetch: (async () => claudeReply('  ""  ')) as any })).toBeNull();
		expect(await suggestResendSubject('Hello', { apiKey: 'k', fetch: (async () => claudeReply('x'.repeat(121))) as any })).toBeNull();
		expect(await suggestResendSubject('Hello', { apiKey: 'k', fetch: (async () => claudeReply('Hi', 500)) as any })).toBeNull();
		expect(await suggestResendSubject('Hello', { apiKey: 'k', fetch: (async () => { throw new Error('net'); }) as any })).toBeNull();
		expect(await suggestResendSubject('Hello', { apiKey: '', fetch: (async () => claudeReply('Hi')) as any })).toBeNull();
	});

	it('a timeout returns null', async () => {
		const hang = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		expect(await suggestResendSubject('Hello', { apiKey: 'k', fetch: hang as any, timeoutMs: 20 })).toBeNull();
	});

	it('cleanSuggestion keeps conditionals exactly', () => {
		const orig = '{{#if tag:vip}}VIP: {{/if}}News';
		expect(cleanSuggestion('{{#if tag:vip}}VIP: {{/if}}Fresh news', orig)).toBe('{{#if tag:vip}}VIP: {{/if}}Fresh news');
		expect(cleanSuggestion('VIP: Fresh news', orig)).toBeNull();
	});
});

function suggestEvent(body: unknown, envOver: Record<string, unknown> = {}, user: unknown = { id: 7 }) {
	return {
		locals: { user },
		platform: { env: { ...platformEnv, ...envOver } },
		request: new Request('https://app.test/api/ai/resend-subject', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as any;
}

async function toggle(value: 'on' | 'off') {
	await db
		.prepare(`INSERT INTO app_state (key, value) VALUES ('ai_resend_subject', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(value)
		.run();
}

describe('POST /api/ai/resend-subject (#246)', () => {
	it('403 when the toggle is off (default and explicit)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect((await suggestPost(suggestEvent({ subject: 'Hi' }, { ANTHROPIC_API_KEY: 'k' }))).status).toBe(403);
		await toggle('off');
		expect((await suggestPost(suggestEvent({ subject: 'Hi' }, { ANTHROPIC_API_KEY: 'k' }))).status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('503 when ANTHROPIC_API_KEY is missing', async () => {
		await toggle('on');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect((await suggestPost(suggestEvent({ subject: 'Hi' }, { ANTHROPIC_API_KEY: '' }))).status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('401 without a session; 400 without a subject', async () => {
		await toggle('on');
		expect((await suggestPost(suggestEvent({ subject: 'Hi' }, { ANTHROPIC_API_KEY: 'k' }, null))).status).toBe(401);
		expect((await suggestPost(suggestEvent({ subject: '  ' }, { ANTHROPIC_API_KEY: 'k' }))).status).toBe(400);
	});

	it('returns the suggestion, a 502 when none, and rate-limits 20 per user per hour', async () => {
		await toggle('on');
		vi.stubGlobal('fetch', vi.fn(async () => claudeReply('Hello again')));
		const ok = await suggestPost(suggestEvent({ subject: 'Hello' }, { ANTHROPIC_API_KEY: 'k' }));
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ subject: 'Hello again' });

		vi.stubGlobal('fetch', vi.fn(async () => claudeReply('Hi there')));
		const bad = await suggestPost(suggestEvent({ subject: 'Hello {{first_name}}' }, { ANTHROPIC_API_KEY: 'k' }));
		expect(bad.status).toBe(502);

		for (let i = 2; i < AI_SUBJECT_RATE_LIMIT; i++) {
			expect((await suggestPost(suggestEvent({ subject: 'Hello' }, { ANTHROPIC_API_KEY: 'k' }))).status).not.toBe(429);
		}
		expect((await suggestPost(suggestEvent({ subject: 'Hello' }, { ANTHROPIC_API_KEY: 'k' }))).status).toBe(429);
		// Another user has their own budget.
		expect((await suggestPost(suggestEvent({ subject: 'Hello' }, { ANTHROPIC_API_KEY: 'k' }, { id: 8 }))).status).not.toBe(429);
	});
});

describe('no AI call at send time (#246)', () => {
	it('processScheduledResends sends the stored subject and never calls Anthropic, even with the toggle on', async () => {
		await toggle('on');
		const fetchMock = vi.fn(async () => claudeReply('Rewritten'));
		vi.stubGlobal('fetch', fetchMock);

		const id = await makeCampaign('pending', '-1 minute', 'Stored resend subject');
		const ann = await makeContact('ann@x.example.net');
		await makeRecipient(id, ann, 'ann@x.example.net');

		const out = await processScheduledResends(db, { token: 't', secret: 's', baseUrl: 'https://x', stream: 'broadcast' });
		expect(out.sent).toBe(1);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		const msgs = spies.sendBatch.mock.calls[0][1] as { Subject: string }[];
		expect(msgs.map((m) => m.Subject)).toEqual(['Stored resend subject']);
		expect(fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('anthropic'))).toBe(false);
	});
});
