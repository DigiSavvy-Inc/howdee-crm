// #297: the Anthropic API key set in Settings → Assistant (sealed with MAIL_TOKEN_KEY in
// integration_secrets, provider 'anthropic'), with the ANTHROPIC_API_KEY secret as fallback.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	ANTHROPIC_PROVIDER,
	KEY_STORE_MISSING,
	anthropicKeyInfo,
	clearAnthropicKeyCache,
	cleanAnthropicKey,
	removeAnthropicKey,
	resolveAnthropicKey,
	scrubKey,
	setAnthropicKey,
	testAnthropicKey
} from '../src/lib/server/ai/key';
import { ASSISTANT_DEFAULTS, availability, normalizeConfig, saveAssistantConfig } from '../src/lib/server/ai/config';
import { handleChat } from '../src/lib/server/ai/chat';
import { load, actions } from '../src/routes/settings/assistant/+page.server';

const db = (env as any).DB as D1Database;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const MAIL_KEY = newKey();
const APP_KEY = 'sk-ant-api03-inAppFakeValue-9xYz';
const ENV_KEY = 'sk-ant-api03-fromWorkerFake-ab12';

let admin: any;
let member: any;

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function makeUser(login: string, role: 'admin' | 'member') {
	const r = await db.prepare('INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id').bind(login, role).first<{ id: number }>();
	return sessionUser({ id: r!.id, github_login: login, role });
}

beforeAll(async () => {
	admin = await makeUser(`key-admin-${Date.now()}`, 'admin');
	member = await makeUser(`key-member-${Date.now()}`, 'member');
});

beforeEach(async () => {
	await db.prepare(`DELETE FROM integration_secrets WHERE provider = ?`).bind(ANTHROPIC_PROVIDER).run();
	clearAnthropicKeyCache(db);
});

function pageEvent(action: string | null, opts: { user: any; envOver?: Record<string, unknown>; form?: Record<string, string>; fetch?: typeof fetch }) {
	const url = new URL(`https://app.test/settings/assistant${action ? `?/${action}` : ''}`);
	const fd = new FormData();
	for (const [k, v] of Object.entries(opts.form ?? {})) fd.append(k, v);
	return {
		url,
		params: {},
		request: new Request(url, action ? { method: 'POST', body: fd } : undefined),
		locals: { user: opts.user, authed: !!opts.user },
		platform: { env: { ...(env as any), MAIL_TOKEN_KEY: MAIL_KEY, ANTHROPIC_API_KEY: '', ...opts.envOver } },
		fetch: opts.fetch
	} as any;
}

describe('resolveAnthropicKey (#297)', () => {
	it('in-app key, then the Worker secret, then none', async () => {
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY })).toBe('');
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY, ANTHROPIC_API_KEY: ` ${ENV_KEY} ` })).toBe(ENV_KEY);
		await setAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY }, APP_KEY, admin.id);
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY, ANTHROPIC_API_KEY: ENV_KEY })).toBe(APP_KEY);
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY })).toBe(APP_KEY);
		// Without a usable MAIL_TOKEN_KEY the stored key can't open → the secret.
		expect(await resolveAnthropicKey(db, { ANTHROPIC_API_KEY: ENV_KEY })).toBe(ENV_KEY);
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: newKey(), ANTHROPIC_API_KEY: ENV_KEY })).toBe(ENV_KEY);
		await removeAnthropicKey(db);
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY, ANTHROPIC_API_KEY: ENV_KEY })).toBe(ENV_KEY);
		expect(await resolveAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY })).toBe('');
	});

	it('stores only the sealed blob and audits set/remove with last4', async () => {
		await setAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY }, APP_KEY, admin.id);
		const row = await db.prepare(`SELECT blob, last4 FROM integration_secrets WHERE provider = 'anthropic'`).first<{ blob: string; last4: string }>();
		expect(row!.last4).toBe('9xYz');
		expect(row!.blob).not.toContain(APP_KEY);
		await removeAnthropicKey(db);
		const audit = await db
			.prepare(`SELECT trigger, detail FROM integration_syncs WHERE provider = 'anthropic' ORDER BY id DESC LIMIT 2`)
			.all<{ trigger: string; detail: string }>();
		expect(audit.results.map((r) => [r.trigger, JSON.parse(r.detail)])).toEqual([
			['token', { action: 'removed', last4: '9xYz' }],
			['token', { action: 'set', last4: '9xYz' }]
		]);
		expect(JSON.stringify(audit.results)).not.toContain(APP_KEY);
	});

	it('validates the format', () => {
		expect(cleanAnthropicKey(`  ${APP_KEY}\n`)).toEqual({ ok: true, key: APP_KEY });
		expect(cleanAnthropicKey('')).toMatchObject({ ok: false });
		expect(cleanAnthropicKey('sk-proj-abcdefghijklmnopqrstuvwxyz')).toMatchObject({ ok: false, error: expect.stringMatching(/sk-ant-/) });
		expect(cleanAnthropicKey('sk-ant-short')).toMatchObject({ ok: false, error: expect.stringMatching(/short/) });
		expect(cleanAnthropicKey('sk-ant-api03 abcdefghijklmnopqrst')).toMatchObject({ ok: false, error: expect.stringMatching(/spaces/) });
		expect(cleanAnthropicKey('sk-ant-' + 'a'.repeat(400))).toMatchObject({ ok: false, error: expect.stringMatching(/long/) });
		for (const bad of ['sk-proj-abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03 abcdefghijklmnopqrst']) {
			const r = cleanAnthropicKey(bad);
			expect(r.ok ? '' : r.error).not.toContain(bad);
		}
	});
});

describe('Settings → Assistant key actions (#297)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('set and remove round-trip; load exposes only last4', async () => {
		const saved: any = await actions.setKey(pageEvent('setKey', { user: admin, form: { key: APP_KEY } }));
		expect(saved).toEqual({ keySaved: '9xYz' });
		const data: any = await load(pageEvent(null, { user: admin }));
		expect(data.keySet).toBe(true);
		expect(data.key).toMatchObject({ source: 'app', last4: '9xYz', setBy: admin.github_login, storeReady: true, workerSecret: false });
		expect(JSON.stringify(data)).not.toContain(APP_KEY);
		expect(JSON.stringify(data)).not.toContain('inAppSecretValue');

		const removed: any = await actions.removeKey(pageEvent('removeKey', { user: admin, envOver: { ANTHROPIC_API_KEY: ENV_KEY } }));
		expect(removed).toEqual({ keyRemoved: true, fallback: true });
		const after: any = await load(pageEvent(null, { user: admin, envOver: { ANTHROPIC_API_KEY: ENV_KEY } }));
		expect(after.key).toMatchObject({ source: 'worker', last4: null, workerSecret: true });
		expect(JSON.stringify(after)).not.toContain(ENV_KEY);
		const none: any = await load(pageEvent(null, { user: admin }));
		expect(none.keySet).toBe(false);
		expect(none.key.source).toBeNull();
	});

	it('refuses the form without a valid MAIL_TOKEN_KEY', async () => {
		for (const MAIL_TOKEN_KEY of ['', 'not-a-key']) {
			const r: any = await actions.setKey(pageEvent('setKey', { user: admin, form: { key: APP_KEY }, envOver: { MAIL_TOKEN_KEY } }));
			expect(r.status).toBe(400);
			expect(r.data.keyError).toBe(KEY_STORE_MISSING);
			expect(JSON.stringify(r.data)).not.toContain(APP_KEY);
		}
		expect(await anthropicKeyInfo(db, { MAIL_TOKEN_KEY: '' })).toMatchObject({ storeReady: false, source: null });
		const row = await db.prepare(`SELECT 1 AS x FROM integration_secrets WHERE provider = 'anthropic'`).first();
		expect(row).toBeNull();
	});

	it('refuses non-admins (load and every action)', async () => {
		await expect(load(pageEvent(null, { user: member }))).rejects.toMatchObject({ status: 403 });
		for (const a of ['setKey', 'removeKey', 'testKey'] as const) {
			const r: any = await actions[a](pageEvent(a, { user: member, form: { key: APP_KEY } }));
			expect(r.status).toBe(403);
		}
		const row = await db.prepare(`SELECT 1 AS x FROM integration_secrets WHERE provider = 'anthropic'`).first();
		expect(row).toBeNull();
	});

	it('rejects invalid formats without storing or echoing them', async () => {
		for (const key of ['', 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'sk-ant-short', 'sk-ant-api03 with space inside']) {
			const r: any = await actions.setKey(pageEvent('setKey', { user: admin, form: { key } }));
			expect(r.status).toBe(400);
			if (key) expect(JSON.stringify(r.data)).not.toContain(key);
		}
		const row = await db.prepare(`SELECT 1 AS x FROM integration_secrets WHERE provider = 'anthropic'`).first();
		expect(row).toBeNull();
	});

	it('Test key calls /v1/models with the key in effect and scrubs it from errors', async () => {
		await setAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY }, APP_KEY, admin.id);
		const seen: { url: string; key: string | null }[] = [];
		const okFetch = (async (u: string, init: RequestInit) => {
			seen.push({ url: String(u), key: new Headers(init.headers).get('x-api-key') });
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		vi.stubGlobal('fetch', okFetch);
		expect(await actions.testKey(pageEvent('testKey', { user: admin }))).toEqual({ keyTest: 'ok' });
		expect(seen).toEqual([{ url: 'https://api.anthropic.com/v1/models', key: APP_KEY }]);

		const echoFetch = (async () =>
			new Response(JSON.stringify({ error: { type: 'authentication_error', message: `invalid x-api-key ${APP_KEY}` } }), { status: 401 })) as unknown as typeof fetch;
		vi.stubGlobal('fetch', echoFetch);
		const bad: any = await actions.testKey(pageEvent('testKey', { user: admin }));
		expect(bad.status).toBe(400);
		expect(bad.data.keyTestError).toMatch(/rejected the key/);
		expect(bad.data.keyTestError).not.toContain(APP_KEY);

		const throwFetch = (async () => {
			throw new Error(`connect failed for ${APP_KEY}`);
		}) as unknown as typeof fetch;
		const net = await testAnthropicKey(APP_KEY, throwFetch);
		expect(net.ok).toBe(false);
		expect(JSON.stringify(net)).not.toContain(APP_KEY);

		// A long message is scrubbed before it's cut, so no fragment of the key survives.
		const longFetch = (async () =>
			new Response(JSON.stringify({ error: { message: 'x'.repeat(270) + APP_KEY } }), { status: 500 })) as unknown as typeof fetch;
		const long = await testAnthropicKey(APP_KEY, longFetch);
		expect(JSON.stringify(long)).not.toContain('sk-ant');
		expect(scrubKey(`a ${APP_KEY} b ${APP_KEY}`, APP_KEY)).toBe('a [key] b [key]');
	});
});

describe('Test key never looks like a browser CORS call (#297)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('testAnthropicKey sends no Origin and no direct-browser-access header', async () => {
		let headers: Headers | null = null;
		const spy = (async (_u: string, init: RequestInit) => {
			headers = new Headers(init.headers);
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		expect(await testAnthropicKey(APP_KEY, spy)).toEqual({ ok: true });
		expect(headers!.get('x-api-key')).toBe(APP_KEY);
		expect(headers!.has('origin')).toBe(false);
		expect(headers!.has('anthropic-dangerous-direct-browser-access')).toBe(false);
	});

	it('the testKey action uses the global fetch, not event.fetch (which adds Origin)', async () => {
		await setAnthropicKey(db, { MAIL_TOKEN_KEY: MAIL_KEY }, APP_KEY, admin.id);
		const eventFetch = (async () => {
			throw new Error('event.fetch must not be used for Anthropic calls');
		}) as unknown as typeof fetch;
		const seen: Headers[] = [];
		vi.stubGlobal('fetch', (async (_u: string, init: RequestInit) => {
			seen.push(new Headers(init.headers));
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch);
		expect(await actions.testKey(pageEvent('testKey', { user: admin, fetch: eventFetch }))).toEqual({ keyTest: 'ok' });
		expect(seen).toHaveLength(1);
		expect(seen[0].has('origin')).toBe(false);
		expect(seen[0].has('anthropic-dangerous-direct-browser-access')).toBe(false);
	});
});

describe('availability and chat use the in-app key (#297)', () => {
	it('works with the secret empty', async () => {
		const envNoSecret = { MAIL_TOKEN_KEY: MAIL_KEY, ANTHROPIC_API_KEY: '' };
		const cfg = normalizeConfig({ access: 'everyone' });
		expect(await availability(db, cfg, envNoSecret, member)).toMatchObject({ reason: 'no_key' });
		await setAnthropicKey(db, envNoSecret, APP_KEY, admin.id);
		expect(await availability(db, cfg, envNoSecret, member)).toEqual({ available: true });

		await saveAssistantConfig(db, { ...ASSISTANT_DEFAULTS, access: 'everyone' });
		const keys: (string | null)[] = [];
		const fakeFetch = (async (_u: string, init: RequestInit) => {
			keys.push(new Headers(init.headers).get('x-api-key'));
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
		}) as unknown as typeof fetch;
		const url = new URL('https://app.test/api/assistant/chat');
		const event = {
			url,
			params: {},
			request: new Request(url, { method: 'POST', body: JSON.stringify({ message: 'hi' }), headers: { 'content-type': 'application/json' } }),
			locals: { user: member, authed: true },
			platform: { env: { ...(env as any), ...envNoSecret, PUBLIC_BASE_URL: 'https://app.test' } }
		} as any;
		const res = await handleChat(event, { fetch: fakeFetch });
		expect(res.status).toBe(200);
		await res.text();
		expect(keys[0]).toBe(APP_KEY);
	});
});
