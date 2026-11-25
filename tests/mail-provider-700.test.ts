import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { sendCampaignEmail, UNSUB_REFUSED_PREFIX } from '../src/lib/server/send';
import { processScheduledCampaigns } from '../src/lib/server/scheduled';
import {
	asMailProvider,
	fromPostmarkMessage,
	getMailProvider,
	mapPostmarkEvent,
	postmarkProvider,
	streamFields,
	toMailResult,
	toPostmarkMessage,
	WebhookAuthError,
	type MailProvider,
	type OutboundMessage,
	type SendResult
} from '../src/lib/server/mail';
import {
	postmarkTokenInfo,
	resolveMailCredentials,
	setActiveProvider,
	setPostmarkStreams,
	setPostmarkToken,
	mailSettingsEvents,
	UNREADABLE_TOKEN_ERROR
} from '../src/lib/server/mail/config';
import { localRequiredChecks, runSetupChecks } from '../src/lib/server/setup-checks';
import { checkStream, runDomainAuthCheck, switchToCustomUnsubscribe, withSendingCreds } from '../src/lib/server/domain-auth';
import { load as sendingLoad } from '../src/routes/settings/sending/+page.server';
import { actions as composeActions } from '../src/routes/compose/+page.server';

// #700 (1/5 of #699): every send goes through a MailProvider. A fake provider checks the rules
// that hold for every provider — suppressed contacts are never sent to, broadcasts carry the
// unsubscribe link + List-Unsubscribe headers, results map back to recipient rows — and the
// Postmark adapter sends exactly what the send path sent before it existed.

const db = (env as { DB: D1Database }).DB;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeProvider(answer?: (m: OutboundMessage, i: number) => SendResult) {
	const sent: OutboundMessage[] = [];
	let calls = 0;
	const provider: MailProvider = {
		id: 'smtp',
		label: 'Fake',
		maxBatch: 2,
		streams: { broadcast: 'fake-broadcast', transactional: 'fake-tx' },
		capabilities: { tracking: false, suppressions: 'none', webhooks: false, inbound: false, domainApi: false, streams: false },
		async sendBatch(messages) {
			calls++;
			const start = sent.length;
			sent.push(...messages);
			return messages.map((m, i) => (answer ? answer(m, start + i) : { ok: true, messageId: `fake-${start + i}` }));
		},
		async check() {
			return { ok: true, summary: 'Fake is fine.', rows: [] };
		}
	};
	return { provider, sent, calls: () => calls };
}

const UNSUB_HTML = '<p>Hello {{first_name}}</p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>';
const UNSUB_TEXT = 'Hello {{first_name}}\n\nUnsubscribe: %%UNSUB_URL%%';

async function campaign(listId: number | null = null, status = 'sending'): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, body_text, list_id, from_email, status, scheduled_at)
			 VALUES ('Hi', 'x', ?, ?, ?, 'news@ourco.example', ?, datetime('now', '-1 minute')) RETURNING id`
		)
		.bind(UNSUB_HTML, UNSUB_TEXT, listId, status)
		.first<{ id: number }>())!.id;
}

const person = (email: string) => ({ id: null, email, name: null, first_name: 'Pat', last_name: null });

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM integration_secrets'),
		db.prepare(`DELETE FROM app_state WHERE key IN ('mail_settings', 'mail_settings_events')`)
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the shared send path through a provider', () => {
	it('broadcast: every message carries the unsubscribe link and both List-Unsubscribe headers, in provider-sized batches', async () => {
		const fake = fakeProvider();
		const cid = await campaign();
		const res = await sendCampaignEmail(db, {
			provider: fake.provider,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [person('a@ourco.example'), person('b@ourco.example'), person('c@ourco.example')],
			subject: 'Hi {{first_name}}',
			htmlTemplate: UNSUB_HTML,
			textTemplate: UNSUB_TEXT,
			from: 'news@ourco.example',
			stream: 'ignored',
			streamKind: 'broadcast'
		});
		expect(res.accepted).toBe(3);
		expect(fake.calls()).toBe(2); // maxBatch 2 → 2 + 1
		for (const m of fake.sent) {
			expect(m.stream).toBe('broadcast');
			expect(m.subject).toBe('Hi Pat');
			const names = (m.headers ?? []).map((h) => h.name);
			expect(names).toContain('List-Unsubscribe');
			expect(names).toContain('List-Unsubscribe-Post');
			const lu = m.headers!.find((h) => h.name === 'List-Unsubscribe')!.value;
			expect(lu).toMatch(/^<https:\/\/crm\.myapp\.example\/unsubscribe\/one-click\?t=/);
			expect(m.html).toContain('https://crm.myapp.example/unsubscribe?t=');
			expect(m.text).toContain('https://crm.myapp.example/unsubscribe?t=');
			expect(m.tracking).toEqual({ opens: true, links: 'html_and_text' });
		}
		const rows = await db.prepare('SELECT message_id, status, provider FROM recipients WHERE campaign_id = ? ORDER BY id').bind(cid).all();
		expect(rows.results).toEqual([
			{ message_id: 'fake-0', status: 'accepted', provider: 'smtp' },
			{ message_id: 'fake-1', status: 'accepted', provider: 'smtp' },
			{ message_id: 'fake-2', status: 'accepted', provider: 'smtp' }
		]);
	});

	it('a broadcast missing its unsubscribe link never reaches the provider', async () => {
		const fake = fakeProvider();
		const cid = await campaign();
		const res = await sendCampaignEmail(db, {
			provider: fake.provider,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [person('a@ourco.example')],
			subject: 'Hi',
			htmlTemplate: '<p>No link</p>',
			textTemplate: 'No link',
			from: 'news@ourco.example',
			stream: 'x',
			streamKind: 'broadcast'
		});
		expect(fake.sent).toEqual([]);
		expect(res.accepted).toBe(0);
		expect(res.firstError).toContain(UNSUB_REFUSED_PREFIX);
	});

	it('1:1 / transactional mail gets no unsubscribe headers', async () => {
		const fake = fakeProvider();
		const cid = await campaign();
		await sendCampaignEmail(db, {
			provider: fake.provider,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [person('a@ourco.example')],
			subject: 'Hi',
			htmlTemplate: '<p>Hi</p>',
			textTemplate: 'Hi',
			from: 'me@ourco.example',
			stream: 'fake-tx',
			unsubscribe: false,
			trackOpens: false,
			trackLinks: 'None'
		});
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].stream).toBe('transactional'); // the name mapped to the provider's own stream
		expect(fake.sent[0].streamName).toBeUndefined();
		expect(fake.sent[0].headers).toBeUndefined();
		expect(fake.sent[0].tracking).toEqual({ opens: false, links: 'none' });
	});

	it('a permanent refusal comes back permanent (the engine fails fast), a transport failure as Transport', async () => {
		const fake = fakeProvider((_m, i) =>
			i === 0 ? { ok: false, error: '550 5.1.1 user unknown', permanent: true } : { ok: false, error: 'timed out', permanent: false, transport: true }
		);
		const cid = await campaign();
		const res = await sendCampaignEmail(db, {
			provider: fake.provider,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [person('a@ourco.example'), person('b@ourco.example')],
			subject: 'Hi',
			htmlTemplate: UNSUB_HTML,
			textTemplate: UNSUB_TEXT,
			from: 'news@ourco.example',
			stream: 'x',
			streamKind: 'broadcast'
		});
		expect(res.accepted).toBe(0);
		expect(res.results[0]).toMatchObject({ ErrorCode: -1, Message: '550 5.1.1 user unknown', Permanent: true });
		expect(res.results[1]).toMatchObject({ ErrorCode: -1, Transport: true });
		const rows = await db.prepare(`SELECT status, error FROM recipients WHERE campaign_id = ? ORDER BY id`).bind(cid).all<{ status: string; error: string }>();
		expect(rows.results.map((r) => r.status)).toEqual(['error', 'error']);
	});

	it('a throwing provider marks its chunk failed instead of throwing', async () => {
		const provider: MailProvider = { ...fakeProvider().provider, sendBatch: async () => { throw new Error('boom'); } };
		const cid = await campaign();
		const res = await sendCampaignEmail(db, {
			provider,
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [person('a@ourco.example')],
			subject: 'Hi',
			htmlTemplate: UNSUB_HTML,
			textTemplate: UNSUB_TEXT,
			from: 'news@ourco.example',
			stream: 'x',
			streamKind: 'broadcast'
		});
		expect(res.firstError).toBe('Fake request failed: boom');
		expect(res.results[0]).toMatchObject({ Transport: true });
	});
});

describe('suppression is enforced before the provider', () => {
	it('a scheduled broadcast never hands an unsubscribed, pending or archived contact to the provider', async () => {
		const list = (await db.prepare(`INSERT INTO lists (name, kind) VALUES ('News 700', 'list') RETURNING id`).first<{ id: number }>())!.id;
		const add = async (email: string, subscribed: number, pending: number, archived: boolean) => {
			const id = (await db
				.prepare(
					`INSERT INTO contacts (email, subscribed, confirm_pending, archived_at)
					 VALUES (?, ?, ?, CASE WHEN ? THEN datetime('now') END) RETURNING id`
				)
				.bind(email, subscribed, pending, archived ? 1 : 0)
				.first<{ id: number }>())!.id;
			await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, id).run();
		};
		await add('keep@ourco.example', 1, 0, false);
		await add('unsub@ourco.example', 0, 0, false);
		await add('pending@ourco.example', 0, 1, false);
		await add('archived@ourco.example', 1, 0, true);
		await campaign(list, 'scheduled');

		const fake = fakeProvider();
		const out = await processScheduledCampaigns(db, { token: 'unused', provider: fake.provider, secret: 's', baseUrl: 'https://crm.myapp.example', stream: 'fake-broadcast' });
		expect(out).toEqual({ fired: 1, failed: 0 });
		expect(fake.sent.map((m) => m.to)).toEqual(['keep@ourco.example']);
		expect(fake.sent[0].stream).toBe('broadcast');
		expect(fake.sent[0].headers!.some((h) => h.name === 'List-Unsubscribe-Post' && h.value === 'List-Unsubscribe=One-Click')).toBe(true);
	});
});

describe('the Postmark adapter', () => {
	type Captured = { url: string; body: unknown; token: string | null };
	function stubPostmark() {
		const seen: Captured[] = [];
		vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? 'null'));
			seen.push({ url: String(input), body, token: new Headers(init?.headers).get('X-Postmark-Server-Token') });
			return new Response(JSON.stringify((body as unknown[]).map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `pm-${seen.length}-${i}` }))), { status: 200 });
		}) as typeof fetch);
		return seen;
	}

	it('sends exactly the request the token path always sent', async () => {
		const seen = stubPostmark();
		const cid = await campaign();
		const common = {
			secret: 's',
			baseUrl: 'https://crm.myapp.example',
			campaignId: cid,
			recipients: [person('a@ourco.example')],
			subject: 'Hi',
			htmlTemplate: UNSUB_HTML,
			textTemplate: UNSUB_TEXT,
			from: 'Ann <news@ourco.example>',
			stream: 'broadcast',
			replyToInbound: 'abc@inbound.postmarkapp.com'
		};
		await sendCampaignEmail(db, { ...common, token: 'pm-token' });
		await sendCampaignEmail(db, { ...common, provider: postmarkProvider({ token: 'pm-token', broadcast: 'broadcast', transactional: 'outbound' }) });
		expect(seen).toHaveLength(2);
		expect(seen[0].url).toBe('https://api.postmarkapp.com/email/batch');
		expect(seen[1].body).toEqual(seen[0].body);
		expect(seen.map((s) => s.token)).toEqual(['pm-token', 'pm-token']);
		const [m] = seen[0].body as Record<string, unknown>[];
		expect(Object.keys(m)).toEqual(['From', 'To', 'ReplyTo', 'Headers', 'Subject', 'HtmlBody', 'TextBody', 'MessageStream', 'TrackOpens', 'TrackLinks']);
		expect(m.MessageStream).toBe('broadcast');
		const rows = await db.prepare('SELECT message_id, provider FROM recipients WHERE campaign_id = ? ORDER BY id').bind(cid).all();
		expect(rows.results).toEqual([
			{ message_id: 'pm-1-0', provider: 'postmark' },
			{ message_id: 'pm-2-0', provider: 'postmark' }
		]);
	});

	it('maps messages both ways without changing them', () => {
		const streams = { broadcast: 'broadcast', transactional: 'outbound' };
		const pm = {
			From: 'a@ourco.example',
			To: 'b@ourco.example',
			ReplyTo: 'c@ourco.example',
			Headers: [{ Name: 'In-Reply-To', Value: '<x@y>' }],
			Subject: 's',
			HtmlBody: '<p>h</p>',
			TextBody: 't',
			MessageStream: 'outbound',
			TrackOpens: false,
			TrackLinks: 'None' as const
		};
		const neutral = fromPostmarkMessage(pm, streams);
		expect(neutral.stream).toBe('transactional');
		expect(neutral.streamName).toBeUndefined();
		expect(toPostmarkMessage(neutral, streams)).toEqual(pm);
		// An explicit stream the provider doesn't know is kept, never silently changed.
		expect(toPostmarkMessage(fromPostmarkMessage({ ...pm, MessageStream: 'other' }, streams), streams).MessageStream).toBe('other');
		expect(streamFields({ streams }, 'broadcast')).toEqual({ stream: 'broadcast' });
		expect(streamFields({ streams }, 'weird')).toEqual({ stream: 'broadcast', streamName: 'weird' });
	});

	it('results: accepted, permanent (300 / 406) and transport', () => {
		const p = postmarkProvider({ token: 't', broadcast: 'broadcast' });
		expect(p.id).toBe('postmark');
		expect(toMailResult({ ok: true, messageId: 'm' })).toEqual({ ErrorCode: 0, Message: 'OK', MessageID: 'm' });
		const raw = { ErrorCode: 406, Message: 'Inactive recipient' };
		expect(toMailResult({ ok: false, error: 'Inactive recipient', permanent: true, code: 406, raw })).toBe(raw);
	});

	it('maps webhook events to the normalised type', async () => {
		const hard = await mapPostmarkEvent({ RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'm1', Email: 'a@ourco.example', BouncedAt: '2026-11-20T10:00:00Z', ID: 5 });
		expect(hard).toMatchObject({ type: 'bounce', hard: true, messageId: 'm1', email: 'a@ourco.example', at: '2026-11-20T10:00:00Z' });
		expect(hard!.dedupeKey).toMatch(/^pm:/);
		expect((await mapPostmarkEvent({ RecordType: 'Bounce', Type: 'SoftBounce', MessageID: 'm1' }))!.hard).toBe(false);
		expect((await mapPostmarkEvent({ RecordType: 'Bounce', Type: 'Transient', Inactive: true }))!.hard).toBe(true);
		expect(await mapPostmarkEvent({ RecordType: 'Click', OriginalLink: 'https://ourco.example/x', Recipient: 'a@ourco.example' })).toMatchObject({ type: 'click', link: 'https://ourco.example/x', email: 'a@ourco.example' });
		expect((await mapPostmarkEvent({ RecordType: 'Delivery' }))!.type).toBe('delivery');
		expect((await mapPostmarkEvent({ RecordType: 'Open' }))!.type).toBe('open');
		expect((await mapPostmarkEvent({ RecordType: 'SpamComplaint' }))!.type).toBe('spam');
		expect((await mapPostmarkEvent({ RecordType: 'SubscriptionChange' }))!.type).toBe('unsubscribe');
		expect(await mapPostmarkEvent({ RecordType: 'InboundMessage' })).toBeNull();
	});

	it('parseWebhook checks the key before reading anything', async () => {
		const p = postmarkProvider({ token: 't', broadcast: 'broadcast', webhookKey: 'right-key' });
		const req = (key: string) => new Request(`https://crm.myapp.example/api/webhook?key=${key}`, { method: 'POST', body: JSON.stringify({ RecordType: 'Delivery', MessageID: 'm' }) });
		await expect(p.parseWebhook!(req('wrong'))).rejects.toBeInstanceOf(WebhookAuthError);
		await expect(postmarkProvider({ token: 't', broadcast: 'b' }).parseWebhook!(req(''))).rejects.toBeInstanceOf(WebhookAuthError);
		const events = await p.parseWebhook!(req('right-key'));
		expect(events.map((e) => e.type)).toEqual(['delivery']);
	});

	it('a credential bundle becomes a Postmark adapter; no token → none', () => {
		expect(asMailProvider({ token: 't', stream: 'broadcast' })?.streams).toEqual({ broadcast: 'broadcast', transactional: 'outbound' });
		expect(asMailProvider({ token: '', stream: 'broadcast' })).toBeNull();
		expect(asMailProvider(null)).toBeNull();
	});
});

describe('Settings → Sending', () => {
	const KEY = newKey();
	const admin = { id: 1, github_login: 'ourco-admin', role: 'admin' };

	it('Settings win over the env: stream names and the sealed token', async () => {
		const base = { MAIL_TOKEN_KEY: KEY, POSTMARK_TOKEN: 'env-token', POSTMARK_STREAM: 'broadcast', POSTMARK_STREAM_TX: 'outbound' };
		let c = await resolveMailCredentials(db, base);
		expect(c.postmark).toMatchObject({ token: 'env-token', tokenFrom: 'env', stream: 'broadcast', txStream: 'outbound' });
		expect(c.provider).toBe('postmark');

		expect(await setPostmarkStreams(db, { stream: 'news', txStream: 'system' }, admin)).toEqual({ ok: true, changed: true });
		await setPostmarkToken(db, base, 'app-token-value-700', admin);
		c = await resolveMailCredentials(db, base);
		expect(c.postmark).toMatchObject({ token: 'app-token-value-700', tokenFrom: 'app', stream: 'news', txStream: 'system' });
		const p = await getMailProvider(db, base);
		expect(p?.streams).toEqual({ broadcast: 'news', transactional: 'system' });

		// The stored row and the audit never carry the token.
		const stored = await db.prepare(`SELECT blob, last4 FROM integration_secrets WHERE provider = 'mail_postmark'`).first<{ blob: string; last4: string }>();
		expect(stored!.blob).not.toContain('app-token');
		expect(stored!.last4).toBe('');
		expect(JSON.stringify(await mailSettingsEvents(db))).not.toContain('app-token');

		// Without MAIL_TOKEN_KEY the sealed token can't be opened → unreadable, never the Worker secret.
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await resolveMailCredentials(db, { ...base, MAIL_TOKEN_KEY: '' })).postmark).toMatchObject({ token: '', tokenFrom: 'unreadable' });
		errSpy.mockRestore();
	});

	it('only an available provider can be made active', async () => {
		expect(await setActiveProvider(db, 'ses', admin)).toMatchObject({ ok: false });
		expect(await setActiveProvider(db, 'postmark', admin)).toEqual({ ok: true, changed: true });
		expect((await resolveMailCredentials(db, { MAIL_PROVIDER: 'ses' })).provider).toBe('postmark');
		expect(await setPostmarkStreams(db, { stream: 'same', txStream: 'same' }, admin)).toMatchObject({ ok: false });
	});

	it('Setup counts a token set in Settings → Sending', async () => {
		const e = { DB: db, MAIL_TOKEN_KEY: KEY, SESSION_SECRET: 's', CRON_KEY: 'c', MEDIA: {} };
		const before = (await localRequiredChecks(db, e)).find((r) => r.id === 'postmark_token')!;
		expect(before.state).toBe('attention');
		await setPostmarkToken(db, e, 'app-token-value-700', admin);
		const after = (await localRequiredChecks(db, e)).find((r) => r.id === 'postmark_token')!;
		expect(after).toMatchObject({ state: 'ready', detail: 'Set in Settings → Sending.' });
	});

	it('the page is admin only and never shows a secret', async () => {
		const pageEnv = { DB: db, MAIL_TOKEN_KEY: KEY, POSTMARK_TOKEN: 'env-token-700', WEBHOOK_KEY: 'webhook-key-700', POSTMARK_STREAM: 'broadcast', PUBLIC_BASE_URL: 'https://crm.myapp.example' };
		const ev = (role: string) =>
			({ url: new URL('https://crm.myapp.example/settings/sending'), params: {}, platform: { env: pageEnv }, locals: { user: { ...admin, role } }, request: new Request('https://crm.myapp.example/settings/sending') }) as any;
		try {
			await sendingLoad(ev('member'));
			throw new Error('expected 403');
		} catch (e) {
			expect(isHttpError(e) && e.status).toBe(403);
		}
		await setPostmarkToken(db, pageEnv, 'app-token-value-700', admin);
		const data = (await sendingLoad(ev('admin'))) as any;
		expect(data.active).toBe('postmark');
		expect(data.configured).toBe(true);
		expect(data.capabilities.length).toBeGreaterThan(0);
		expect(data.postmark.token.source).toBe('app');
		expect(data.webhookUrl).toBe('https://crm.myapp.example/api/webhook?key=<WEBHOOK_KEY>');
		const json = JSON.stringify(data);
		for (const secret of ['app-token-value-700', 'env-token-700', 'webhook-key-700', KEY]) expect(json).not.toContain(secret);
	});
});

describe('a stored token that can’t be read fails closed', () => {
	const KEY = newKey();
	const admin = { id: 1, github_login: 'ourco-admin', role: 'admin' };
	const ENV_TOKEN = 'env-token-unreadable-700';
	const APP_TOKEN = 'app-token-unreadable-700';
	const base = { DB: db, POSTMARK_TOKEN: ENV_TOKEN, POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 's', CRON_KEY: 'c', MEDIA: {}, PUBLIC_BASE_URL: 'https://crm.myapp.example' };
	// Saved with KEY, read with another key (rotated) or none at all.
	const rotated = { ...base, MAIL_TOKEN_KEY: newKey() };
	const missing = { ...base, MAIL_TOKEN_KEY: '' };

	function stubFetch() {
		const tokens: (string | null)[] = [];
		vi.stubGlobal('fetch', (async (_input: string | URL | Request, init?: RequestInit) => {
			tokens.push(new Headers(init?.headers).get('X-Postmark-Server-Token'));
			const body = JSON.parse(String(init?.body ?? 'null'));
			const answer = Array.isArray(body) ? body.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `pm-${i}` })) : { ErrorCode: 0, Message: 'OK' };
			return new Response(JSON.stringify(answer), { status: 200 });
		}) as typeof fetch);
		return tokens;
	}

	function composeTest(platformEnv: Record<string, unknown>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries({ subject: 'Hi', from: 'news@ourco.example', body_md: 'Hello', test_to: 'me@ourco.example', direct: '1' })) fd.append(k, v);
		const url = new URL('https://crm.myapp.example/compose?/test');
		return { platform: { env: platformEnv }, params: {}, url, request: new Request(url, { method: 'POST', body: fd }), locals: { user: admin } } as any;
	}

	beforeEach(async () => {
		await db.prepare(`DELETE FROM app_state WHERE key = 'approved_senders'`).run();
	});

	it('resolves to no token with a clear error, logs one line without a secret', async () => {
		await setPostmarkToken(db, { MAIL_TOKEN_KEY: KEY }, APP_TOKEN, admin);
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const e of [rotated, missing]) {
			errSpy.mockClear();
			const c = await resolveMailCredentials(db, e);
			expect(c.postmark).toMatchObject({ token: '', tokenFrom: 'unreadable', tokenError: UNREADABLE_TOKEN_ERROR });
			expect(await getMailProvider(db, e)).toBeNull();
			expect(errSpy).toHaveBeenCalled();
			const logged = JSON.stringify(errSpy.mock.calls);
			for (const secret of [APP_TOKEN, ENV_TOKEN, e.MAIL_TOKEN_KEY, KEY].filter(Boolean)) expect(logged).not.toContain(secret);
		}
		errSpy.mockRestore();
	});

	it('a send fails with that error and never reaches Postmark with the env token', async () => {
		await setPostmarkToken(db, { MAIL_TOKEN_KEY: KEY }, APP_TOKEN, admin);
		const tokens = stubFetch();
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await composeActions.test(composeTest(rotated));
			throw new Error('expected a 500');
		} catch (e) {
			expect(isHttpError(e) && e.status).toBe(500);
			expect(isHttpError(e) && e.body.message).toBe(UNREADABLE_TOKEN_ERROR);
		}
		errSpy.mockRestore();
		expect(tokens).toEqual([]);
	});

	it('nothing stored → the env token is used, as before', async () => {
		const tokens = stubFetch();
		const c = await resolveMailCredentials(db, rotated);
		expect(c.postmark).toMatchObject({ token: ENV_TOKEN, tokenFrom: 'env', tokenError: null });
		const out = await composeActions.test(composeTest(rotated));
		expect(out).toMatchObject({ testSuccess: true });
		expect(tokens).toEqual([ENV_TOKEN]);
	});

	it('token info, the setup checks and Settings → Sending report the unreadable state as a problem', async () => {
		await setPostmarkToken(db, { MAIL_TOKEN_KEY: KEY }, APP_TOKEN, admin);
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const info = await postmarkTokenInfo(db, rotated);
		expect(info).toMatchObject({ source: 'unreadable', error: UNREADABLE_TOKEN_ERROR });

		const local = (await localRequiredChecks(db, rotated)).find((r) => r.id === 'postmark_token')!;
		expect(local).toMatchObject({ state: 'attention', detail: UNREADABLE_TOKEN_ERROR });

		// One postmark_token row on Settings → Setup, saying the same, and no Postmark call.
		const report = await runSetupChecks(db, rotated);
		const rows = report.checks.filter((r) => r.id === 'postmark_token');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ state: 'attention', detail: UNREADABLE_TOKEN_ERROR });
		expect(fetchMock).not.toHaveBeenCalled();

		const ev = { url: new URL('https://crm.myapp.example/settings/sending'), params: {}, platform: { env: rotated }, locals: { user: admin }, request: new Request('https://crm.myapp.example/settings/sending') } as any;
		const data = (await sendingLoad(ev)) as any;
		expect(data.configured).toBe(false);
		expect(data.postmark.token).toMatchObject({ source: 'unreadable', error: UNREADABLE_TOKEN_ERROR });
		const json = JSON.stringify(data);
		for (const secret of [APP_TOKEN, ENV_TOKEN, KEY]) expect(json).not.toContain(secret);
		errSpy.mockRestore();
	});
});

describe('domain authentication reads the sending credentials', () => {
	const KEY = newKey();
	const admin = { id: 1, github_login: 'ourco-admin', role: 'admin' };

	function stubStreams() {
		const seen: { url: string; method: string; token: string | null }[] = [];
		vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), method: init?.method ?? 'GET', token: new Headers(init?.headers).get('X-Postmark-Server-Token') });
			return new Response(JSON.stringify({ ID: 'news', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } }), { status: 200 });
		}) as typeof fetch);
		return seen;
	}

	it('a token and stream saved only in Settings → Sending are used for the stream check and Switch to custom', async () => {
		const settingsOnly = { MAIL_TOKEN_KEY: KEY };
		await setPostmarkToken(db, settingsOnly, 'app-token-domain-700', admin);
		await setPostmarkStreams(db, { stream: 'news', txStream: '' }, admin);
		const seen = stubStreams();

		const resolved = await withSendingCreds(db, settingsOnly);
		expect((await checkStream(resolved)).check.status).toBe('pass');
		expect(await switchToCustomUnsubscribe(resolved)).toEqual({ ok: true, stream: 'news' });
		const { result } = await runDomainAuthCheck(db, settingsOnly, 'manual');
		expect(result.stream).toMatchObject({ stream: 'news', check: { status: 'pass' } });

		const streamCalls = seen.filter((s) => s.url.includes('/message-streams/'));
		expect(streamCalls.length).toBe(3);
		for (const c of streamCalls) {
			expect(c.url).toBe('https://api.postmarkapp.com/message-streams/news');
			expect(c.token).toBe('app-token-domain-700');
		}
	});

	it('an env-only install gets its own values back', async () => {
		const envOnly = { POSTMARK_TOKEN: 'env-token-domain-700', POSTMARK_STREAM: 'broadcast', POSTMARK_STREAM_TX: 'outbound' };
		expect(await withSendingCreds(db, envOnly)).toMatchObject(envOnly);
		const seen = stubStreams();
		expect((await checkStream(await withSendingCreds(db, envOnly))).check.status).toBe('pass');
		expect(seen.map((s) => s.token)).toEqual(['env-token-domain-700']);
	});

	it('an unreadable stored token is reported, and the env token is not used', async () => {
		await setPostmarkToken(db, { MAIL_TOKEN_KEY: KEY }, 'app-token-domain-700', admin);
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const seen = stubStreams();
		const resolved = await withSendingCreds(db, { MAIL_TOKEN_KEY: newKey(), POSTMARK_TOKEN: 'env-token-domain-700', POSTMARK_STREAM: 'broadcast' });
		const r = await checkStream(resolved);
		expect(r.check.status).toBe('unknown');
		expect(r.check.summary).toContain(UNREADABLE_TOKEN_ERROR);
		expect(await switchToCustomUnsubscribe(resolved)).toEqual({ ok: false, error: UNREADABLE_TOKEN_ERROR });
		expect(seen).toEqual([]);
		errSpy.mockRestore();
	});
});
