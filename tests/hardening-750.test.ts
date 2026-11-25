import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	b64urlEncode,
	hmac,
	resubscribeAllowed,
	signUnsub,
	verifyUnsub,
	verifyUnsubToken,
	RESUB_LINK_EXPIRED,
	RESUB_TOKEN_MAX_AGE_DAYS
} from '../src/lib/server/token';
import { actions as unsubActions, load as unsubLoad } from '../src/routes/unsubscribe/+page.server';
import { POST as oneClick } from '../src/routes/unsubscribe/one-click/+server';
import { POST as luma } from '../src/routes/api/luma/+server';
import { POST as webhook } from '../src/routes/api/webhook/+server';
import { POST as resendHook } from '../src/routes/api/webhook/resend/+server';
import { POST as ingest } from '../src/routes/api/ingest/+server';
import { actions as setupActions } from '../src/routes/settings/setup/+page.server';
import * as webhooksPage from '../src/routes/settings/webhooks/+page.server';
import { actions as accountActions } from '../src/routes/account/+page.server';
import { actions as generalSettingsActions } from '../src/routes/settings/+page.server';
import { setSettings } from '../src/lib/server/settings';
import { lumaSecretFor, lumaSecretInfo, sealStoredLumaSecret, storeLumaSecret } from '../src/lib/server/luma-secret';
import { headerKey, requestKeyMatches } from '../src/lib/server/request-key';
import { readCappedText, BodyTooLargeError, WEBHOOK_BODY_MAX_BYTES } from '../src/lib/server/webhook-body';
import { mailSettingsEvents, resolveMailCredentials, REVEAL_WEBHOOK_EVENT } from '../src/lib/server/mail/config';
import { svixSignature } from '../src/lib/server/mail';
import { saveUnsubPage } from '../src/lib/server/unsubscribe-page';
import { DEFAULT_UNSUB_PAGE } from '../src/lib/unsubscribe-page';
import * as resendFx from './fixtures/resend-702';
import { findWebhookKey, hashPlaintextKeys, plaintextKeyCount } from '../src/lib/server/webhook-keys';
import { checkCurrentPassword, accountPasswordKey } from '../src/lib/server/login-attempts';
import { hashPassword } from '../src/lib/server/password';
import { recordRequest } from '../src/lib/server/account-tokens';

// #750: low-severity hardening. Each refused case, and each "old thing still works" case.
const db = (env as any).DB as D1Database;
const SECRET = 'test-session-secret-750';
const realFetch = globalThis.fetch;
const enc = new TextEncoder();

/** A valid MAIL_TOKEN_KEY made at run time (32 random bytes, base64url). */
function mailKey(): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** An unsubscribe token the way it was signed before #750 (no purpose prefix, no issue time). */
async function legacyToken(payload: { c: number | null; k: number | null; e: string }): Promise<string> {
	const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
	return `${body}.${b64urlEncode(await hmac(SECRET, body))}`;
}

/**
 * Delete the test contacts matching `pattern` (a LIKE pattern on email) and the rows that point at
 * them without ON DELETE CASCADE: events (by contact or by send row), unsubscribes, send rows.
 */
async function clearContacts(pattern: string): Promise<void> {
	const ids = '(SELECT id FROM contacts WHERE email LIKE ?1)';
	await db.batch([
		db.prepare(
			`DELETE FROM events WHERE contact_id IN ${ids}
			 OR recipient_id IN (SELECT id FROM recipients WHERE contact_id IN ${ids} OR email LIKE ?1)`
		).bind(pattern),
		db.prepare(`DELETE FROM unsubscribes WHERE contact_id IN ${ids} OR email LIKE ?1`).bind(pattern),
		db.prepare(`DELETE FROM recipients WHERE contact_id IN ${ids} OR email LIKE ?1`).bind(pattern),
		db.prepare('DELETE FROM contacts WHERE email LIKE ?1').bind(pattern)
	]);
}

/** A request body stream with no Content-Length, `total` bytes long, made lazily in 64 KB pieces. */
function bigStream(total: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= total) {
				controller.close();
				return;
			}
			const n = Math.min(65536, total - sent);
			controller.enqueue(new Uint8Array(n).fill(0x20));
			sent += n;
		}
	});
}

beforeEach(() => {
	globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('unsubscribe tokens', () => {
	const TOPIC = 'U750 topic list';
	beforeEach(async () => {
		await db.prepare('DELETE FROM lists WHERE name = ?').bind(TOPIC).run();
		await clearContacts('%@u750.test');
		await saveUnsubPage(db, { ...DEFAULT_UNSUB_PAGE, resubscribe: true });
	});
	afterEach(async () => {
		await saveUnsubPage(db, DEFAULT_UNSUB_PAGE);
	});

	const unsubEnv = { DB: db, SESSION_SECRET: SECRET };
	function actionEvent(action: string, fields: Record<string, string | string[]>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
		return {
			request: new Request(`https://app.test/unsubscribe?/${action}`, { method: 'POST', body: fd }),
			platform: { env: unsubEnv }
		} as any;
	}
	async function loadWith(token: string): Promise<any> {
		return await unsubLoad({
			url: new URL(`https://app.test/unsubscribe?t=${encodeURIComponent(token)}`),
			platform: { env: unsubEnv },
			setHeaders: () => undefined
		} as any);
	}
	const subscribedOf = async (email: string) =>
		(await db.prepare('SELECT subscribed FROM contacts WHERE email = ?').bind(email).first<{ subscribed: number }>())!.subscribed;

	it('a new token verifies, carries its issue time, and the old payload shape is returned', async () => {
		const now = Date.UTC(2026, 10, 25);
		const t = await signUnsub(SECRET, { c: 3, k: 4, e: 'new@u750.test' }, now);
		expect(await verifyUnsub(SECRET, t)).toEqual({ c: 3, k: 4, e: 'new@u750.test' });
		const v = await verifyUnsubToken(SECRET, t);
		expect(v?.issuedAt).toBe(Math.floor(now / 1000));
	});

	it('a token signed before the change still verifies (no issue time)', async () => {
		const t = await legacyToken({ c: 3, k: 4, e: 'old@u750.test' });
		expect(await verifyUnsub(SECRET, t)).toEqual({ c: 3, k: 4, e: 'old@u750.test' });
		expect((await verifyUnsubToken(SECRET, t))?.issuedAt).toBeNull();
	});

	it('a token from another secret, or with a changed body, does not verify', async () => {
		const t = await signUnsub('another-secret', { c: 1, k: 1, e: 'x@u750.test' });
		expect(await verifyUnsub(SECRET, t)).toBeNull();
		const good = await signUnsub(SECRET, { c: 1, k: 1, e: 'x@u750.test' });
		const forged = b64urlEncode(enc.encode(JSON.stringify({ c: 1, k: 1, e: 'y@u750.test' }))) + good.slice(good.lastIndexOf('.'));
		expect(await verifyUnsub(SECRET, forged)).toBeNull();
	});

	it('resubscribe is allowed only within the max age, never for an old-format token', async () => {
		const now = Date.UTC(2026, 10, 25);
		const fresh = (await verifyUnsubToken(SECRET, await signUnsub(SECRET, { c: 1, k: 1, e: 'a@u750.test' }, now)))!;
		expect(resubscribeAllowed(fresh, now)).toBe(true);
		const tooOld = now + (RESUB_TOKEN_MAX_AGE_DAYS + 1) * 86400_000;
		expect(resubscribeAllowed(fresh, tooOld)).toBe(false);
		const legacy = (await verifyUnsubToken(SECRET, await legacyToken({ c: 1, k: 1, e: 'a@u750.test' })))!;
		expect(resubscribeAllowed(legacy, now)).toBe(false);
	});

	it('an old-format token still unsubscribes (page action and one-click)', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('p@u750.test', 1), ('o@u750.test', 1)").run();
		const fd = new FormData();
		fd.set('token', await legacyToken({ c: null, k: null, e: 'p@u750.test' }));
		const res: any = await unsubActions.unsubscribeAll({
			request: new Request('https://app.test/unsubscribe?/unsubscribeAll', { method: 'POST', body: fd }),
			platform: { env: { DB: db, SESSION_SECRET: SECRET } }
		} as any);
		expect(res).toEqual({ success: true, email: 'p@u750.test' });

		const t = await legacyToken({ c: null, k: null, e: 'o@u750.test' });
		const url = `https://app.test/unsubscribe/one-click?t=${encodeURIComponent(t)}`;
		const r = await oneClick({
			request: new Request(url, { method: 'POST' }),
			url: new URL(url),
			platform: { env: { DB: db, SESSION_SECRET: SECRET } }
		} as any);
		expect(r.status).toBe(200);
		const rows = await db
			.prepare("SELECT email, subscribed FROM contacts WHERE email IN ('p@u750.test', 'o@u750.test') ORDER BY email")
			.all<{ email: string; subscribed: number }>();
		expect(rows.results.map((x) => x.subscribed)).toEqual([0, 0]);
	});

	it('the resubscribe action refuses an old-format token with a clear message', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('r@u750.test', 0)").run();
		const fd = new FormData();
		fd.set('token', await legacyToken({ c: null, k: null, e: 'r@u750.test' }));
		const res: any = await unsubActions.resubscribe({
			request: new Request('https://app.test/unsubscribe?/resubscribe', { method: 'POST', body: fd }),
			platform: { env: { DB: db, SESSION_SECRET: SECRET } }
		} as any);
		expect(res.status).toBe(400);
		expect(res.data.resubError).toBe(RESUB_LINK_EXPIRED);
		const c = await db.prepare("SELECT subscribed FROM contacts WHERE email = 'r@u750.test'").first<{ subscribed: number }>();
		expect(c!.subscribed).toBe(0);
	});

	it('a fresh token resubscribes through the resubscribe action, and the page offers it', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('fresh@u750.test', 0)").run();
		const t = await signUnsub(SECRET, { c: null, k: null, e: 'fresh@u750.test' });
		const data = await loadWith(t);
		expect(data.invalid).toBe(false);
		expect(data.canResubscribe).toBe(true);
		const res: any = await unsubActions.resubscribe(actionEvent('resubscribe', { token: t }));
		expect(res).toEqual({ resubscribed: true, email: 'fresh@u750.test' });
		expect(await subscribedOf('fresh@u750.test')).toBe(1);
	});

	it('the page does not offer resubscribe for an old-format or an expired token', async () => {
		await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('noresub@u750.test', 0)").run();
		const legacy = await loadWith(await legacyToken({ c: null, k: null, e: 'noresub@u750.test' }));
		expect(legacy.invalid).toBe(false);
		expect(legacy.canResubscribe).toBe(false);
		const issued = Date.now() - (RESUB_TOKEN_MAX_AGE_DAYS + 1) * 86400_000;
		const expired = await loadWith(await signUnsub(SECRET, { c: null, k: null, e: 'noresub@u750.test' }, issued));
		expect(expired.invalid).toBe(false);
		expect(expired.canResubscribe).toBe(false);
		const res: any = await unsubActions.resubscribe(
			actionEvent('resubscribe', { token: await signUnsub(SECRET, { c: null, k: null, e: 'noresub@u750.test' }, issued) })
		);
		expect(res.status).toBe(400);
		expect(res.data.resubError).toBe(RESUB_LINK_EXPIRED);
		expect(await subscribedOf('noresub@u750.test')).toBe(0);
	});

	it('preferences with "Resubscribe me" and an old-format token is refused and saves no topic choice', async () => {
		const cid = (await db
			.prepare("INSERT INTO contacts (email, subscribed) VALUES ('prefs@u750.test', 0) RETURNING id")
			.first<{ id: number }>())!.id;
		const lid = (await db
			.prepare("INSERT INTO lists (name, kind, public_topic, topic_label) VALUES (?, 'list', 1, 'U750 news') RETURNING id")
			.bind(TOPIC)
			.first<{ id: number }>())!.id;
		const token = await legacyToken({ c: null, k: null, e: 'prefs@u750.test' });
		const res: any = await unsubActions.preferences(actionEvent('preferences', { token, topic: String(lid), resubscribe: '1' }));
		expect(res.status).toBe(400);
		expect(res.data.error).toBe(RESUB_LINK_EXPIRED);
		expect(await subscribedOf('prefs@u750.test')).toBe(0);
		const member = await db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE contact_id = ? AND list_id = ?').bind(cid, lid).first<{ n: number }>();
		expect(member!.n).toBe(0);
		const optouts = await db.prepare('SELECT COUNT(*) AS n FROM topic_optouts WHERE contact_id = ?').bind(cid).first<{ n: number }>();
		expect(optouts!.n).toBe(0);

		// Without "Resubscribe me" the same old token still saves topic choices.
		const saved: any = await unsubActions.preferences(actionEvent('preferences', { token, topic: String(lid) }));
		expect(saved).toMatchObject({ prefsSaved: true, stillUnsubscribed: true });
		const after = await db.prepare('SELECT COUNT(*) AS n FROM list_members WHERE contact_id = ? AND list_id = ?').bind(cid, lid).first<{ n: number }>();
		expect(after!.n).toBe(1);
	});
});

describe('Luma webhook', () => {
	const LUMA = 'whsec_test750';

	async function signed(body: string, secret = LUMA, t = String(Math.floor(Date.now() / 1000))): Promise<string> {
		const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
		return `t=${t},v1=${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
	}
	function post(body: string, signature: string, extraEnv: Record<string, string> = {}) {
		return luma({
			request: new Request('https://app.test/api/luma', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'webhook-signature': signature, 'webhook-id': `evt750-${Math.random()}` },
				body
			}),
			platform: { env: { ...(env as object), ...extraEnv } },
			url: new URL('https://app.test/api/luma')
		} as any);
	}

	beforeEach(async () => {
		await db.prepare('DELETE FROM luma_events').run();
		await clearContacts('%@l750.test');
		await db.prepare("DELETE FROM app_state WHERE key LIKE 'luma%'").run();
	});

	it('a bad signature is refused, not stored, and the answer does not say why', async () => {
		await setSettings(db, { luma_webhook_secret: LUMA, luma_list: 'L750' });
		const body = JSON.stringify({ type: 'guest.registered', data: { email: 'bad@l750.test' } });
		const res = await post(body, `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid signature' });
		const n = await db.prepare('SELECT COUNT(*) AS n FROM luma_events').first<{ n: number }>();
		expect(n!.n).toBe(0);
	});

	it('a secret saved before the change (plain) still verifies', async () => {
		await setSettings(db, { luma_webhook_secret: LUMA, luma_list: 'L750' });
		const body = JSON.stringify({ type: 'guest.registered', data: { email: 'plain@l750.test', name: 'P' } });
		const res = await post(body, await signed(body));
		expect(res.status).toBe(200);
	});

	it('with MAIL_TOKEN_KEY the secret is stored sealed and still verifies', async () => {
		const MAIL_TOKEN_KEY = mailKey();
		await setSettings(db, { luma_list: 'L750' });
		await storeLumaSecret(db, { MAIL_TOKEN_KEY }, LUMA);
		const row = await db.prepare("SELECT value FROM app_state WHERE key = 'luma_webhook_secret'").first<{ value: string }>();
		expect(row!.value.startsWith('v1.')).toBe(true);
		expect(row!.value).not.toContain(LUMA);
		expect(await lumaSecretFor(db, { MAIL_TOKEN_KEY })).toBe(LUMA);
		expect(await lumaSecretInfo(db, { MAIL_TOKEN_KEY })).toEqual({ from: 'app', sealed: true });
		const body = JSON.stringify({ type: 'guest.registered', data: { email: 'sealed@l750.test', name: 'S' } });
		expect((await post(body, await signed(body), { MAIL_TOKEN_KEY })).status).toBe(200);
	});

	it('without MAIL_TOKEN_KEY the secret is stored as before; a plain one is sealed later', async () => {
		await storeLumaSecret(db, {}, LUMA);
		const plain = await db.prepare("SELECT value FROM app_state WHERE key = 'luma_webhook_secret'").first<{ value: string }>();
		expect(plain!.value).toBe(LUMA);
		const MAIL_TOKEN_KEY = mailKey();
		expect(await sealStoredLumaSecret(db, { MAIL_TOKEN_KEY })).toBe(true);
		expect(await lumaSecretFor(db, { MAIL_TOKEN_KEY })).toBe(LUMA);
	});

	it('a General Settings save with the Luma field blank leaves a sealed secret as it is', async () => {
		const MAIL_TOKEN_KEY = mailKey();
		await setSettings(db, { luma_list: 'L750' });
		await storeLumaSecret(db, { MAIL_TOKEN_KEY }, LUMA);
		const read = async () =>
			(await db.prepare("SELECT value FROM app_state WHERE key = 'luma_webhook_secret'").first<{ value: string }>())!.value;
		const before = await read();
		expect(before.startsWith('v1.')).toBe(true);

		const fd = new FormData();
		fd.set('luma_list', 'L750');
		fd.set('luma_webhook_secret', '');
		const url = new URL('https://app.test/settings?/save');
		const res: any = await (generalSettingsActions as any).save({
			request: new Request(url, { method: 'POST', body: fd }),
			url,
			platform: { env: { ...(env as object), MAIL_TOKEN_KEY } },
			locals: { user: { id: 990770, github_login: 'admin-770', role: 'admin' } }
		} as any);
		expect(res).toEqual({ saved: true });
		expect(await read()).toBe(before);

		const body = JSON.stringify({ type: 'guest.registered', data: { email: 'kept@l750.test', name: 'K' } });
		expect((await post(body, await signed(body), { MAIL_TOKEN_KEY })).status).toBe(200);
	});

	it('a General Settings save with the Luma field blank leaves a plain secret plain', async () => {
		const MAIL_TOKEN_KEY = mailKey();
		await setSettings(db, { luma_webhook_secret: LUMA, luma_list: 'L750' });
		const fd = new FormData();
		fd.set('luma_list', 'L750');
		const url = new URL('https://app.test/settings?/save');
		await (generalSettingsActions as any).save({
			request: new Request(url, { method: 'POST', body: fd }),
			url,
			platform: { env: { ...(env as object), MAIL_TOKEN_KEY } },
			locals: { user: { id: 990771, github_login: 'admin-771', role: 'admin' } }
		} as any);
		const row = await db.prepare("SELECT value FROM app_state WHERE key = 'luma_webhook_secret'").first<{ value: string }>();
		expect(row!.value).toBe(LUMA);
	});

	it('a General Settings save with the Luma field set to a single space clears the stored secret', async () => {
		const MAIL_TOKEN_KEY = mailKey();
		await setSettings(db, { luma_list: 'L750' });
		await storeLumaSecret(db, { MAIL_TOKEN_KEY }, LUMA);
		const fd = new FormData();
		fd.set('luma_list', 'L750');
		fd.set('luma_webhook_secret', ' ');
		const url = new URL('https://app.test/settings?/save');
		const res: any = await (generalSettingsActions as any).save({
			request: new Request(url, { method: 'POST', body: fd }),
			url,
			platform: { env: { ...(env as object), MAIL_TOKEN_KEY } },
			locals: { user: { id: 990772, github_login: 'admin-772', role: 'admin' } }
		} as any);
		expect(res).toEqual({ saved: true });
		const row = await db.prepare("SELECT value FROM app_state WHERE key = 'luma_webhook_secret'").first<{ value: string | null }>();
		expect(row?.value ?? null).toBeNull();
		const noEnv = { MAIL_TOKEN_KEY, LUMA_WEBHOOK_SECRET: '' };
		expect(await lumaSecretFor(db, noEnv)).toBe('');
		expect((await lumaSecretInfo(db, noEnv)).from).toBe('none');
	});

	it('a General Settings save without a valid MAIL_TOKEN_KEY stores a new secret plain, and it verifies', async () => {
		await setSettings(db, { luma_list: 'L750' });
		const fd = new FormData();
		fd.set('luma_list', 'L750');
		fd.set('luma_webhook_secret', LUMA);
		const url = new URL('https://app.test/settings?/save');
		const res: any = await (generalSettingsActions as any).save({
			request: new Request(url, { method: 'POST', body: fd }),
			url,
			platform: { env: { ...(env as object), MAIL_TOKEN_KEY: '' } },
			locals: { user: { id: 990773, github_login: 'admin-773', role: 'admin' } }
		} as any);
		expect(res).toEqual({ saved: true });
		const row = await db.prepare("SELECT value FROM app_state WHERE key = 'luma_webhook_secret'").first<{ value: string }>();
		expect(row!.value).toBe(LUMA);
		const body = JSON.stringify({ type: 'guest.registered', data: { email: 'nokey@l750.test', name: 'N' } });
		expect((await post(body, await signed(body), { MAIL_TOKEN_KEY: '' })).status).toBe(200);
	});

	it('a sealed secret that cannot be opened counts as not set (no env fallback)', async () => {
		await storeLumaSecret(db, { MAIL_TOKEN_KEY: mailKey() }, LUMA);
		const other = { MAIL_TOKEN_KEY: mailKey(), LUMA_WEBHOOK_SECRET: 'whsec_envfallback' };
		expect(await lumaSecretFor(db, other)).toBe('');
		expect((await lumaSecretInfo(db, other)).from).toBe('unreadable');
	});
});

describe('Postmark and Resend webhooks', () => {
	const KEY = 'test-key-750';
	let seq = 0;

	/** `key` = the `?key=` value (default: the right key; null = no query). */
	function hook(payload: object, opts: { key?: string | null; headers?: Record<string, string>; body?: BodyInit } = {}) {
		const k = opts.key === undefined ? KEY : opts.key;
		const qs = k === null ? '' : `?key=${encodeURIComponent(k)}`;
		const url = `https://app.test/api/webhook${qs}`;
		return webhook({
			platform: { env: { ...(env as object), WEBHOOK_KEY: KEY } },
			url: new URL(url),
			request: new Request(url, { method: 'POST', headers: opts.headers ?? {}, body: opts.body ?? JSON.stringify(payload) })
		} as any);
	}
	async function sentVia(email: string, provider: string): Promise<{ id: number; mid: string }> {
		const id = (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
		const cid = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'news@ourco.example', 'sent') RETURNING id`)
			.first<{ id: number }>())!.id;
		const mid = `msg-750-${++seq}`;
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status, provider) VALUES (?, ?, ?, ?, 'accepted', ?)")
			.bind(cid, id, email, mid, provider)
			.run();
		return { id, mid };
	}
	const subscribed = async (id: number) =>
		(await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed;

	beforeEach(async () => {
		await clearContacts('%@w750.test');
	});

	it('a Postmark bounce for a message another provider sent changes nobody', async () => {
		const s = await sentVia('rs@w750.test', 'resend');
		await hook({ RecordType: 'Bounce', ID: 75001, Type: 'HardBounce', Email: 'rs@w750.test', MessageID: s.mid, BouncedAt: '2026-11-25T10:00:00Z' });
		expect(await subscribed(s.id)).toBe(1);
	});

	it('a Postmark bounce for a message Postmark sent still unsubscribes', async () => {
		const s = await sentVia('pm@w750.test', 'postmark');
		await hook({ RecordType: 'Bounce', ID: 75002, Type: 'HardBounce', Email: 'pm@w750.test', MessageID: s.mid, BouncedAt: '2026-11-25T10:00:00Z' });
		expect(await subscribed(s.id)).toBe(0);
	});

	it('an oversized body is refused with 413', async () => {
		const big = 'x'.repeat(WEBHOOK_BODY_MAX_BYTES + 10);
		expect((await hook({}, { body: big })).status).toBe(413);
		await expect(readCappedText(new Request('https://app.test/', { method: 'POST', body: big }))).rejects.toBeInstanceOf(BodyTooLargeError);
		// A body at the cap is read in full.
		const atCap = await readCappedText(new Request('https://app.test/', { method: 'POST', body: bigStream(WEBHOOK_BODY_MAX_BYTES) }));
		expect(atCap.length).toBe(WEBHOOK_BODY_MAX_BYTES);
	});

	it('an oversized streamed body with no Content-Length is refused with 413', async () => {
		const req = new Request('https://app.test/', { method: 'POST', body: bigStream(WEBHOOK_BODY_MAX_BYTES + 1) });
		expect(req.headers.get('content-length')).toBeNull();
		await expect(readCappedText(req)).rejects.toBeInstanceOf(BodyTooLargeError);
		expect((await hook({}, { body: bigStream(WEBHOOK_BODY_MAX_BYTES + 65536) })).status).toBe(413);
	});

	it('the key works from an Authorization header and from ?key=; a wrong one is refused', async () => {
		const open = { RecordType: 'Open', MessageID: 'none' };
		const bearer = await hook(open, { key: null, headers: { authorization: `Bearer ${KEY}` } });
		expect(bearer.status).toBe(200);
		const basic = await hook(open, { key: null, headers: { authorization: `Basic ${btoa(`pm:${KEY}`)}` } });
		expect(basic.status).toBe(200);
		expect((await hook(open)).status).toBe(200);
		const wrong = await hook(open, { key: null, headers: { authorization: 'Bearer nope' } });
		expect(wrong.status).toBe(401);
		expect((await hook(open, { key: null })).status).toBe(401);
	});

	it('either location is enough: an unrelated Basic header next to the right ?key= passes', async () => {
		const open = { RecordType: 'Open', MessageID: 'none' };
		const unrelated = { authorization: `Basic ${btoa('provider:something-else')}` };
		expect((await hook(open, { headers: unrelated })).status).toBe(200);
		expect((await hook(open, { key: null, headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
		expect((await hook(open, { key: 'wrong-750', headers: unrelated })).status).toBe(401);
	});

	it('requestKeyMatches checks the header and the query', () => {
		const url = new URL('https://app.test/x?key=fromquery');
		expect(requestKeyMatches(new Request(url, { headers: { authorization: 'Bearer fromheader' } }), url, 'fromheader')).toBe(true);
		expect(requestKeyMatches(new Request(url, { headers: { authorization: 'Bearer fromheader' } }), url, 'fromquery')).toBe(true);
		expect(requestKeyMatches(new Request(url), url, 'other')).toBe(false);
		expect(requestKeyMatches(new Request(url), url, '')).toBe(false);
		const bare = new URL('https://app.test/x');
		expect(requestKeyMatches(new Request(bare), bare, 'fromquery')).toBe(false);
		expect(headerKey(new Request(url, { headers: { authorization: 'Token abc' } }))).toBeNull();
	});

	it('requestKeyMatches: an empty Bearer value or an empty Basic password never matches on its own', () => {
		const bare = new URL('https://app.test/x');
		const emptyBearer = new Request(bare, { headers: { authorization: 'Bearer ' } });
		expect(headerKey(emptyBearer)).toBeNull();
		expect(requestKeyMatches(emptyBearer, bare, 'some-key-750')).toBe(false);
		const emptyBasic = new Request(bare, { headers: { authorization: `Basic ${btoa('pm:')}` } });
		expect(headerKey(emptyBasic)).toBeNull();
		expect(requestKeyMatches(emptyBasic, bare, 'some-key-750')).toBe(false);
	});

	it('a Basic header with malformed base64 next to the right ?key= is accepted', async () => {
		const open = { RecordType: 'Open', MessageID: 'none' };
		const res = await hook(open, { headers: { authorization: 'Basic %%%not-base64%%%' } });
		expect(res.status).toBe(200);
	});

	const resendEnv = () => ({ ...(env as object), RESEND_WEBHOOK_SECRET: resendFx.FAKE_WEBHOOK_SECRET });
	async function resendPost(payload: unknown | null, body?: BodyInit) {
		const url = 'https://app.test/api/webhook/resend';
		const headers: Record<string, string> = {};
		if (payload !== null) {
			const text = JSON.stringify(payload);
			const id = `msg_${crypto.randomUUID()}`;
			const ts = String(Math.floor(Date.now() / 1000));
			headers['content-type'] = 'application/json';
			headers['svix-id'] = id;
			headers['svix-timestamp'] = ts;
			headers['svix-signature'] = (await svixSignature(resendFx.FAKE_WEBHOOK_SECRET, id, ts, text))!;
			body = text;
		}
		return await resendHook({
			platform: { env: resendEnv() },
			url: new URL(url),
			request: new Request(url, { method: 'POST', headers, body })
		} as any);
	}

	it('the Resend webhook refuses an oversized body before checking the signature', async () => {
		// The secret is really resolved, so a 401 for a missing secret can't stand in for the 413.
		expect((await resolveMailCredentials(db, resendEnv())).resend.webhookSecret).toBe(resendFx.FAKE_WEBHOOK_SECRET);
		expect((await resendPost(null, 'x'.repeat(WEBHOOK_BODY_MAX_BYTES + 10))).status).toBe(413);
		expect((await resendPost(null, bigStream(WEBHOOK_BODY_MAX_BYTES + 65536))).status).toBe(413);
		// A small unsigned body gets past the cap and is refused by the signature check.
		expect((await resendPost(null, '{}')).status).toBe(401);
	});

	it('a Resend event matches the send Resend made, never a Postmark send with the same message id', async () => {
		const mid = `msg-750-shared-${++seq}`;
		const pm = await sentVia('pmshared@w750.test', 'postmark');
		const rs = await sentVia('rsshared@w750.test', 'resend');
		await db.prepare('UPDATE recipients SET message_id = ? WHERE message_id IN (?, ?)').bind(mid, pm.mid, rs.mid).run();
		const res = await resendPost(resendFx.evBounced(mid, 'rsshared@w750.test'));
		expect(res.status).toBe(200);
		expect(await subscribed(rs.id)).toBe(0);
		expect(await subscribed(pm.id)).toBe(1);
		const ev = await db.prepare('SELECT contact_id FROM events WHERE message_id = ?').bind(mid).all<{ contact_id: number | null }>();
		expect(ev.results.map((r) => r.contact_id)).toEqual([rs.id]);
	});

	it('a Resend event for a message id only Postmark used changes nobody', async () => {
		const pm = await sentVia('pmonly@w750.test', 'postmark');
		const res = await resendPost(resendFx.evBounced(pm.mid, 'pmonly@w750.test'));
		expect(res.status).toBe(200);
		expect(await subscribed(pm.id)).toBe(1);
		const ev = await db.prepare('SELECT contact_id FROM events WHERE message_id = ?').bind(pm.mid).all<{ contact_id: number | null }>();
		expect(ev.results.map((r) => r.contact_id)).toEqual([null]);
	});
});

describe('Settings → Setup reveal webhook URL', () => {
	it('writes an audit row (never the key) and still shows the URL', async () => {
		const res: any = await setupActions.revealWebhook({
			request: new Request('https://app.test/settings/setup?/revealWebhook', { method: 'POST', body: new FormData() }),
			url: new URL('https://app.test/settings/setup'),
			platform: { env: { ...(env as object), WEBHOOK_KEY: 'reveal-key-750' } },
			locals: { user: { id: 990750, github_login: 'admin-750', role: 'admin' } }
		} as any);
		expect(res.revealed).toContain('reveal-key-750');
		const events = await mailSettingsEvents(db, 5);
		expect(events[0].change).toBe(REVEAL_WEBHOOK_EVENT);
		expect(events[0].user_id).toBe(990750);
		expect(JSON.stringify(events)).not.toContain('reveal-key-750');
	});
});

describe('webhook keys stored in plaintext', () => {
	const admin = { id: 990751, github_login: 'admin-751', role: 'admin' };
	const member = { id: 990752, github_login: 'member-752', role: 'member' };
	const ev = (user: object, fields: Record<string, string>) => {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		return {
			request: new Request('https://app.test/settings/webhooks?/hashPlaintext', { method: 'POST', body: fd }),
			url: new URL('https://app.test/settings/webhooks'),
			platform: { env },
			locals: { user }
		} as any;
	};

	beforeEach(async () => {
		await db.prepare("DELETE FROM webhook_keys WHERE label LIKE 'k750-%'").run();
	});

	it('the admin action hashes them; they keep working', async () => {
		const token = 'plain750token';
		await db.prepare("INSERT INTO webhook_keys (label, token) VALUES ('k750-plain', ?)").bind(token).run();
		expect(await plaintextKeyCount(db)).toBeGreaterThanOrEqual(1);

		expect((await (webhooksPage.actions as any).hashPlaintext(ev(member, { confirm: '1' }))).status).toBe(403);
		expect((await (webhooksPage.actions as any).hashPlaintext(ev(admin, {}))).status).toBe(400);

		const res = await (webhooksPage.actions as any).hashPlaintext(ev(admin, { confirm: '1' }));
		expect(res.hashedKeys).toBeGreaterThanOrEqual(1);
		const row = await db
			.prepare("SELECT token, token_hash, token_last4 FROM webhook_keys WHERE label = 'k750-plain'")
			.first<{ token: string; token_hash: string | null; token_last4: string }>();
		expect(row!.token.startsWith('hashed:')).toBe(true);
		expect(row!.token_hash).not.toBeNull();
		expect(row!.token_last4).toBe('oken');
		expect(await findWebhookKey(db, token)).not.toBeNull();
		expect((await hashPlaintextKeys(db)).hashed).toBe(0);
	});
});

describe('account: current-password checks', () => {
	const IP = 'ip-750';
	beforeEach(async () => {
		await db.prepare("DELETE FROM login_attempts WHERE username LIKE 'account:%' OR username LIKE 'verify:%' OR ip = ?").bind(IP).run();
	});

	it('five wrong answers lock it; a right one before that resets the count', async () => {
		const stored = await hashPassword('correct horse battery', 1000);
		const userId = 990760;
		for (let i = 0; i < 4; i++) {
			expect(await checkCurrentPassword(db, { userId, password: 'wrong', storedHash: stored, ip: IP })).toEqual({ ok: false, status: 400 });
		}
		expect(await checkCurrentPassword(db, { userId, password: 'correct horse battery', storedHash: stored, ip: IP })).toEqual({ ok: true });
		for (let i = 0; i < 5; i++) await checkCurrentPassword(db, { userId, password: 'wrong', storedHash: stored, ip: IP });
		const locked = await checkCurrentPassword(db, { userId, password: 'correct horse battery', storedHash: stored, ip: IP });
		expect(locked.ok).toBe(false);
		expect((locked as { status: number }).status).toBe(429);
		const rows = await db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE username = ?').bind(accountPasswordKey(userId)).first<{ n: number }>();
		expect(rows!.n).toBe(10);
	});

	it('an email change is refused once the verification mail limit is reached, and nothing is saved', async () => {
		const login = 'acct750';
		await db.prepare('DELETE FROM users WHERE github_login = ?').bind(login).run();
		const id = (await db.prepare("INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id").bind(login).first<{ id: number }>())!.id;
		for (let i = 0; i < 3; i++) await recordRequest(db, 'verify', 'next@a750.test', 'other-ip');
		const fd = new FormData();
		fd.set('email', 'next@a750.test');
		const res: any = await accountActions.email({
			request: new Request('https://app.test/account?/email', { method: 'POST', body: fd, headers: { 'cf-connecting-ip': IP } }),
			url: new URL('https://app.test/account'),
			platform: { env: { DB: db, SESSION_SECRET: SECRET } },
			locals: { user: { id, github_login: login, role: 'member' } }
		} as any);
		expect(res.status).toBe(429);
		const u = await db.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string | null }>();
		expect(u!.email).toBeNull();
		await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
	});
});

describe('ingest: the deferred confirmation email', () => {
	const INGEST_KEY = ['ingest', 'test', '750'].join('-');
	function post(email: string, ctx?: { waitUntil: (p: Promise<unknown>) => void }) {
		const url = 'https://crm.test/api/ingest';
		return ingest({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_KEY}` },
				body: JSON.stringify({ email, list: 'I750 list', confirm: true })
			}),
			url: new URL(url),
			platform: {
				env: {
					...(env as object),
					SESSION_SECRET: SECRET,
					INGEST_KEY,
					POSTMARK_TOKEN: 'pm-test-750',
					POSTMARK_FROM: 'news@ourco.example',
					POSTMARK_STREAM_TX: 'outbound'
				},
				...(ctx ? { ctx } : {})
			}
		} as any);
	}
	const logRows = (email: string) =>
		db.prepare('SELECT status, detail FROM webhook_events WHERE email = ? ORDER BY id').bind(email).all<{ status: string; detail: string }>();

	beforeEach(async () => {
		await db.prepare("DELETE FROM rate_limits WHERE key LIKE 'ingest:%'").run();
		await db.prepare("DELETE FROM webhook_events WHERE email LIKE '%@i750.test'").run();
		await db.prepare("DELETE FROM subscription_confirmations WHERE email LIKE '%@i750.test'").run();
		await clearContacts('%@i750.test');
	});

	it('with a platform context: the row is written before the response, then updated when the send ends', async () => {
		// Hold the provider request until the test has looked at the log; everything else fails fast.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let providerCalled = false;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input instanceof Request ? input.url : input).includes('postmarkapp')) {
				providerCalled = true;
				await gate;
			}
			return new Response('', { status: 503 });
		}) as typeof fetch;
		const pending: Promise<unknown>[] = [];
		const res = await post('ctx@i750.test', { waitUntil: (p) => pending.push(p) });
		expect(await res.json()).toEqual({ ok: true, status: 'pending_confirmation' });
		expect(pending.length).toBe(1);
		// Before the background send finishes, the request is already in the log.
		expect((await logRows('ctx@i750.test')).results).toEqual([{ status: 'pending', detail: 'confirmation sending' }]);
		release();
		await Promise.all(pending);
		expect(providerCalled).toBe(true);
		const after = (await logRows('ctx@i750.test')).results;
		expect(after.length).toBe(1);
		expect(after[0].status).toBe('pending');
		expect(after[0].detail.startsWith('confirmation not sent: send_failed')).toBe(true);
	});

	it('without a platform context a failed send leaves one send_failed row', async () => {
		const res = await post('noctx@i750.test');
		expect(res.status).toBe(200);
		const rows = (await logRows('noctx@i750.test')).results;
		expect(rows.length).toBe(1);
		expect(rows[0].detail.startsWith('confirmation not sent: send_failed')).toBe(true);
	});
});
