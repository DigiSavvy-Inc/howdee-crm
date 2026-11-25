// #731: first run with no hand-edited vars. A database with no users and an env with none of the
// template's vars (POSTMARK_FROM, the two streams, PUBLIC_BASE_URL, WORKER_NAME): the app starts,
// /setup takes its token from the link fragment, the first admin's request origin becomes the
// app's address (the built-in clock uses it), sending is refused with "Finish setup" instead of a
// 500, and the Settings → Setup wizard connects Postmark, creates its webhook and sends only the
// test the admin asks for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { tokenFromHash } from '../src/lib/setup-link';
import setupPageSrc from '../src/routes/setup/+page.svelte?raw';
import setupServerSrc from '../src/routes/setup/+page.server.ts?raw';
import {
	clearDomainCache,
	publicBaseUrl,
	recordSeenOrigin,
	resolveBaseUrl,
	SEEN_BASE_URL_KEY,
	seenOriginProblem
} from '../src/lib/server/public-url';
import { FINISH_SETUP_FROM, FINISH_SETUP_SENDING, mailToken } from '../src/lib/server/db';
import { resolveMailCredentials } from '../src/lib/server/mail/config';
import { ensurePostmarkWebhook, webhookTriggersFor } from '../src/lib/server/mail/postmark-webhook';
import { sendWizardTest, wizardStepFrom, nextStep } from '../src/lib/server/setup-wizard';
import { localRequiredChecks } from '../src/lib/server/setup-checks';
import { INTERNAL_TICK_ORIGIN, SENDS_SKIPPED_KEY, SKIP_KEY, TICK_PATH, withClock } from '../src/lib/server/internal-tick';
import { MAX_USERNAME_FAILURES } from '../src/lib/server/login-attempts';
import { POST as tickPOST } from '../src/routes/api/automations/tick/+server';
import { actions as setupActions } from '../src/routes/setup/+page.server';
import { load as setupPageLoad, actions as wizardActions } from '../src/routes/settings/setup/+page.server';
import { load as sendingLoad } from '../src/routes/settings/sending/+page.server';
import { load as domainLoad } from '../src/routes/settings/domain/+page.server';

const db = (testEnv as any).DB as D1Database;
const TOKEN = 'setup-token-731-abcdefghijklmnop';
const PASSWORD = 'plum tractor velvet';

/** An env with none of the template's vars: only the bindings and the generated secrets. */
function bareEnv(extra: Record<string | symbol, unknown> = {}): Record<string | symbol, unknown> {
	return { DB: db, SESSION_SECRET: 'secret-731', SETUP_TOKEN: TOKEN, ...extra };
}

async function state(key: string): Promise<string | null> {
	return (await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(key).first<{ value: string | null }>())?.value ?? null;
}

function cookieJar() {
	const jar: Record<string, string | undefined> = {};
	return {
		get: (n: string) => jar[n],
		set: (n: string, v: string) => {
			jar[n] = v;
		},
		delete: (n: string) => {
			jar[n] = undefined;
		},
		getAll: () => [],
		serialize: () => ''
	};
}

function event(url: string, opts: { fields?: Record<string, string>; env?: Record<string | symbol, unknown>; user?: any } = {}) {
	const u = new URL(url);
	let request: Request;
	if (opts.fields) {
		const body = new FormData();
		for (const [k, v] of Object.entries(opts.fields)) body.set(k, v);
		request = new Request(u, { method: 'POST', body, headers: { 'cf-connecting-ip': 'ip-731' } });
	} else request = new Request(u, { method: 'GET' });
	return {
		request,
		url: u,
		params: {},
		platform: { env: opts.env ?? bareEnv() },
		locals: { user: opts.user ?? null },
		cookies: cookieJar(),
		getClientAddress: () => '203.0.113.9'
	} as any;
}

const ADMIN = { id: 1, github_login: 'ourco-admin', role: 'admin' };

beforeEach(async () => {
	await db
		.prepare(`DELETE FROM app_state WHERE key LIKE 'custom_domain%' OR key IN (?, ?, ?, 'last_tick', 'last_tick_clock', 'default_from', 'mail_settings')`)
		.bind(SEEN_BASE_URL_KEY, SKIP_KEY, SENDS_SKIPPED_KEY)
		.run();
	await db.prepare(`DELETE FROM login_attempts`).run();
	clearDomainCache();
});
afterEach(() => vi.restoreAllMocks());

describe('setup link token (#token= in the fragment)', () => {
	it('reads the token and ignores anything unusable', () => {
		expect(tokenFromHash('#token=abc_DEF-123')).toBe('abc_DEF-123');
		expect(tokenFromHash('token=abc')).toBe('abc');
		expect(tokenFromHash('#token=two%20words')).toBe('two words');
		expect(tokenFromHash('')).toBe('');
		expect(tokenFromHash('#other=1')).toBe('');
		expect(tokenFromHash('#token=')).toBe('');
		expect(tokenFromHash(`#token=${'x'.repeat(600)}`)).toBe('');
		expect(tokenFromHash('#token=a%0Ab')).toBe('');
	});

	it('the page reads the fragment on the client and strips it from the address bar', () => {
		expect(setupPageSrc).toContain('tokenFromHash(location.hash)');
		expect(setupPageSrc).toContain('replaceState(location.pathname + location.search');
		// No server read of a query token: the server only sees the form body.
		expect(setupServerSrc).not.toMatch(/searchParams\.get\(['"]token['"]\)/);
	});
});

describe('the origin seen at setup', () => {
	it('never stores the internal tick origin, a loopback host or plain http', () => {
		expect(seenOriginProblem('https://crm.example.com')).toBeNull();
		expect(seenOriginProblem('https://crm-731.example.net')).toBeNull();
		expect(seenOriginProblem(INTERNAL_TICK_ORIGIN)).not.toBeNull();
		expect(seenOriginProblem('https://other.invalid')).not.toBeNull();
		expect(seenOriginProblem('https://localhost:8787')).not.toBeNull();
		expect(seenOriginProblem('http://localhost:5173')).not.toBeNull();
		expect(seenOriginProblem('http://127.0.0.1:5173')).not.toBeNull();
		expect(seenOriginProblem('http://crm.example.com')).not.toBeNull();
		expect(seenOriginProblem('ftp://crm.example.com')).not.toBeNull();
	});

	it('/setup writes it once, from the request URL only', async () => {
		expect(await recordSeenOrigin(db, new URL('https://crm.example.com/setup?x=1'))).toBe(true);
		expect(await recordSeenOrigin(db, new URL('https://other.example.com/setup'))).toBe(false);
		expect(await state(SEEN_BASE_URL_KEY)).toBe('https://crm.example.com');
		expect(await recordSeenOrigin(db, new URL(`${INTERNAL_TICK_ORIGIN}${TICK_PATH}`))).toBe(false);
	});

	it('precedence: Settings → Domain, PUBLIC_BASE_URL, the seen origin, the request', async () => {
		expect(resolveBaseUrl(null, '', 'https://req.example.com', 'https://seen.example.com')).toEqual({ url: 'https://seen.example.com', source: 'seen' });
		expect(resolveBaseUrl(null, 'https://env.example.com', 'https://req.example.com', 'https://seen.example.com').source).toBe('env');
		expect(resolveBaseUrl('crm.example.com', 'https://env.example.com', null, 'https://seen.example.com').source).toBe('setting');
		await recordSeenOrigin(db, new URL('https://seen.example.com/setup'));
		expect(await publicBaseUrl(db, {}, INTERNAL_TICK_ORIGIN)).toBe('https://seen.example.com');
		expect(await publicBaseUrl(db, { PUBLIC_BASE_URL: 'https://env.example.com' }, INTERNAL_TICK_ORIGIN)).toBe('https://env.example.com');
	});
});

describe('/setup on a database with no users and an env with no vars', () => {
	beforeEach(async () => {
		await db.prepare(`DELETE FROM users`).run();
	});
	afterEach(async () => {
		await db.prepare(`DELETE FROM users`).run();
		await db.prepare(`INSERT OR IGNORE INTO users (id, github_login, role) VALUES (1, 'ourco-admin', 'admin')`).run();
	});

	it('creates the admin, records the address and opens the wizard', async () => {
		const ev = event('https://crm-731.example.net/setup', {
			fields: { token: TOKEN, name: 'Ada', email: 'ada@example.com', github_login: '', password: PASSWORD, confirm: PASSWORD }
		});
		await expect((setupActions as any).default(ev)).rejects.toSatisfy((e: unknown) => isRedirect(e) && e.location === '/settings/setup?first=1');
		expect(await state(SEEN_BASE_URL_KEY)).toBe('https://crm-731.example.net');
	});

	it('a wrong token stores nothing, and after the limit even the right token is locked out', async () => {
		const attempt = (token: string) =>
			(setupActions as any).default(
				event('https://crm.example.com/setup', { fields: { token, name: 'Ada', email: 'ada@example.com', github_login: '', password: PASSWORD, confirm: PASSWORD } })
			);
		const first = await attempt('nope');
		expect(first.status).toBe(401);
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
		for (let i = 1; i < MAX_USERNAME_FAILURES; i++) expect((await attempt(`nope-${i}`)).status).toBe(401);
		const n = await db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'setup:token'`).first<number>('n');
		expect(n).toBe(MAX_USERNAME_FAILURES);
		// Locked out: the right token (as a setup link would fill it in) is refused too, and nothing is created.
		const locked = await attempt(TOKEN);
		expect(locked.status).toBe(429);
		expect(locked.data.error).toMatch(/Too many attempts/);
		expect(await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<number>('n')).toBe(0);
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
	});

	it('a local-dev setup on localhost stores no address', async () => {
		const ev = event('http://localhost:5173/setup', {
			fields: { token: TOKEN, name: 'Ada', email: 'ada@example.com', github_login: '', password: PASSWORD, confirm: PASSWORD }
		});
		await expect((setupActions as any).default(ev)).rejects.toSatisfy((e: unknown) => isRedirect(e));
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
	});
});

describe('stand-ins for the vars', () => {
	it('stream names default to broadcast / outbound', async () => {
		const c = await resolveMailCredentials(db, bareEnv());
		expect(c.postmark.stream).toBe('broadcast');
		expect(c.postmark.txStream).toBe('outbound');
		expect(c.postmark.token).toBe('');
	});

	it('a send with no token is a 409 "Finish setup", not a 500', async () => {
		const creds = await resolveMailCredentials(db, bareEnv());
		let err: unknown;
		try {
			mailToken(event('https://crm.example.com/compose'), creds);
		} catch (e) {
			err = e;
		}
		expect(isHttpError(err) && err.status).toBe(409);
		expect(isHttpError(err) && err.body.message).toBe(FINISH_SETUP_SENDING);
	});

	it('signed-in settings pages load with no vars', async () => {
		const env = bareEnv();
		const setup = (await setupPageLoad(event('https://crm.example.com/settings/setup', { env, user: ADMIN }) as any)) as any;
		expect(Array.isArray(setup.checks)).toBe(true);
		expect(setup.wizard).toBeNull();
		const sending = (await sendingLoad(event('https://crm.example.com/settings/sending', { env, user: ADMIN }) as any)) as any;
		expect(sending.postmark.stream.effective).toBe('broadcast');
		const domain = (await domainLoad(event('https://crm.example.com/settings/domain', { env, user: ADMIN }) as any)) as any;
		expect(domain.effective.url).toBe('https://crm.example.com');
	});
});

describe('the built-in clock on a fresh install', () => {
	function routeApp() {
		const seen: { status: number; body: any }[] = [];
		const app = {
			fetch: async (req: Request, env: Record<string | symbol, unknown>) => {
				const res = await tickPOST({ url: new URL(req.url), params: {}, request: req, locals: { user: null }, platform: { env } } as any);
				seen.push({ status: res.status, body: await res.clone().json() });
				return res;
			}
		};
		return { app, seen };
	}

	it('uses the address recorded at setup instead of skipping', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await recordSeenOrigin(db, new URL('https://crm.example.com/setup'));
		const { app, seen } = routeApp();
		await withClock(app).scheduled({}, bareEnv({ POSTMARK_TOKEN: 't' }), { waitUntil() {} });
		expect(seen[0].body.skipped).toBeUndefined();
		expect(seen[0].body.ok).toBe(true);
		expect(await state(SKIP_KEY)).toBeNull();
	});

	it('with no token it skips the sends, still ticks, says why, and is not a 500', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await recordSeenOrigin(db, new URL('https://crm.example.com/setup'));
		const { app, seen } = routeApp();
		await withClock(app).scheduled({}, bareEnv(), { waitUntil() {} });
		expect(seen[0].status).toBe(200);
		expect(seen[0].body).toMatchObject({ ok: true, skipped_sends: 'no_sending_token', scheduled: { skipped: 'no_sending_token' } });
		expect(await state('last_tick')).not.toBeNull();
		const row = (await localRequiredChecks(db, bareEnv() as Record<string, unknown>)).find((c) => c.id === 'tick_no_sending');
		expect(row?.state).toBe('attention');
		// Once a token is set the row goes.
		expect((await localRequiredChecks(db, bareEnv({ POSTMARK_TOKEN: 't' }) as Record<string, unknown>)).some((c) => c.id === 'tick_no_sending')).toBe(false);
	});

	it('the no-address row is gone once an address was recorded', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { app } = routeApp();
		await withClock(app).scheduled({}, bareEnv({ POSTMARK_TOKEN: 't' }), { waitUntil() {} });
		expect(await state(SKIP_KEY)).toBe('no_public_url');
		expect((await localRequiredChecks(db, bareEnv() as Record<string, unknown>)).some((c) => c.id === 'public_url')).toBe(true);
		await recordSeenOrigin(db, new URL('https://crm.example.com/settings/setup'));
		expect((await localRequiredChecks(db, bareEnv() as Record<string, unknown>)).some((c) => c.id === 'public_url')).toBe(false);
	});
});

/** A fake Postmark API: path → response, and every request seen. */
function fakePostmark(routes: Record<string, { status: number; body?: unknown }>) {
	const seen: { method: string; path: string; body: any; token: string | null }[] = [];
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const u = new URL(String(input));
		const method = init?.method ?? 'GET';
		const path = u.pathname + u.search;
		seen.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null, token: new Headers(init?.headers).get('X-Postmark-Server-Token') });
		const r = routes[`${method} ${path}`] ?? routes[`${method} ${u.pathname}`] ?? { status: 404, body: { Message: 'not found' } };
		return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { fn, seen };
}

const STREAM_OK = { status: 200, body: { ID: 'broadcast', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Postmark' } } };

describe('Postmark webhook button', () => {
	const cfg = { token: 'server-token', broadcast: 'broadcast', transactional: 'outbound', webhookKey: 'whk-731', baseUrl: 'https://crm.example.com' };

	it('creates the webhook with the install key and every trigger, and reports the stream', async () => {
		const pm = fakePostmark({
			'GET /message-streams/broadcast': STREAM_OK,
			'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [] } },
			'POST /webhooks': { status: 200, body: { ID: 1 } }
		});
		const res = await ensurePostmarkWebhook(cfg, pm.fn);
		expect(res).toMatchObject({ ok: true, created: true, present: true, streamOk: true, unsubscribe: { status: 'warn' } });
		const post = pm.seen.find((s) => s.method === 'POST')!;
		expect(post.body).toEqual({ Url: 'https://crm.example.com/api/webhook?key=whk-731', MessageStream: 'broadcast', Triggers: webhookTriggersFor() });
		// It never sends: no /email request of any kind.
		expect(pm.seen.every((s) => !s.path.startsWith('/email'))).toBe(true);
		expect(pm.seen.every((s) => s.token === 'server-token')).toBe(true);
	});

	it('finds an existing webhook and creates nothing', async () => {
		const pm = fakePostmark({
			'GET /message-streams/broadcast': STREAM_OK,
			'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [{ Url: 'https://crm.example.com/api/webhook?key=whk-731' }] } }
		});
		const res = await ensurePostmarkWebhook(cfg, pm.fn);
		expect(res).toMatchObject({ ok: true, state: 'present', created: false, present: true });
		expect(pm.seen.some((s) => s.method === 'POST')).toBe(false);
	});

	it('refuses without a token, a key or an https address, and on a missing stream', async () => {
		const pm = fakePostmark({});
		expect((await ensurePostmarkWebhook({ ...cfg, token: '' }, pm.fn)).ok).toBe(false);
		expect((await ensurePostmarkWebhook({ ...cfg, webhookKey: '' }, pm.fn)).ok).toBe(false);
		expect((await ensurePostmarkWebhook({ ...cfg, baseUrl: 'http://localhost:5173' }, pm.fn)).ok).toBe(false);
		expect((await ensurePostmarkWebhook({ ...cfg, baseUrl: INTERNAL_TICK_ORIGIN }, pm.fn)).ok).toBe(false);
		expect(pm.seen).toEqual([]);
		const missing = fakePostmark({ 'GET /webhooks?MessageStream=broadcast': { status: 200, body: { Webhooks: [] } } });
		const res = await ensurePostmarkWebhook(cfg, missing.fn);
		expect(res).toMatchObject({ ok: true, created: false, present: false, streamOk: false });
		expect(missing.seen.some((s) => s.method === 'POST')).toBe(false);
	});

	it('a rejected token is an error that carries neither the token nor the key', async () => {
		const pm = fakePostmark({ 'GET /message-streams/broadcast': { status: 401 }, 'GET /webhooks?MessageStream=broadcast': { status: 401 } });
		const res = await ensurePostmarkWebhook(cfg, pm.fn);
		expect(res.ok).toBe(false);
		const text = JSON.stringify(res);
		expect(text).not.toContain('server-token');
		expect(text).not.toContain('whk-731');
	});
});

describe('the wizard', () => {
	it('opens on ?first=1 and ?wizard=<step>; steps run in order', () => {
		expect(wizardStepFrom(new URL('https://x.test/settings/setup?first=1'))).toBe('address');
		expect(wizardStepFrom(new URL('https://x.test/settings/setup?wizard=webhook'))).toBe('webhook');
		expect(wizardStepFrom(new URL('https://x.test/settings/setup?wizard=junk'))).toBe('address');
		expect(wizardStepFrom(new URL('https://x.test/settings/setup'))).toBeNull();
		expect(nextStep('address')).toBe('sending');
		expect(nextStep('done')).toBe('done');
	});

	it('is admin-only (load and actions)', async () => {
		const member = { id: 2, github_login: 'jdoe', role: 'member' };
		await expect(setupPageLoad(event('https://crm.example.com/settings/setup?first=1', { user: member }) as any)).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 403);
		await expect((wizardActions as any).test(event('https://crm.example.com/settings/setup?/test', { fields: {}, user: member }))).rejects.toSatisfy(
			(e: unknown) => isHttpError(e) && e.status === 403
		);
	});

	it('loads the wizard with no vars and never records the address on a page load', async () => {
		const data = (await setupPageLoad(event('https://crm.example.com/settings/setup?first=1', { user: ADMIN }) as any)) as any;
		expect(data.first).toBe(true);
		expect(data.wizard.step).toBe('address');
		expect(data.wizard.address).toMatchObject({ url: 'https://crm.example.com', source: 'request', canUse: true });
		expect(data.wizard.webhookUrl).toBe('https://crm.example.com/api/webhook?key=••••••••');
		expect(await state(SEEN_BASE_URL_KEY)).toBeNull();
	});

	it('saves the Default From', async () => {
		const res = await (wizardActions as any).address(event('https://crm.example.com/settings/setup?/address', { fields: { default_from: 'news@example.com' }, user: ADMIN }));
		expect(res.saved).toContain('news@example.com');
		expect(await state('default_from')).toBe('news@example.com');
		const bad = await (wizardActions as any).address(event('https://crm.example.com/settings/setup?/address', { fields: { default_from: 'nope' }, user: ADMIN }));
		expect(bad.status).toBe(400);
	});

	it('the test step says "Finish setup" until sending and a sender are set', async () => {
		expect(await sendWizardTest(db, bareEnv(), 1)).toEqual({ ok: false, error: FINISH_SETUP_SENDING });
		await db.prepare(`UPDATE users SET email = 'admin@example.com' WHERE id = 1`).run();
		expect(await sendWizardTest(db, bareEnv({ POSTMARK_TOKEN: 't' }), 1)).toEqual({ ok: false, error: FINISH_SETUP_FROM });
	});

	it('never hands out the webhook key except when asked, to an admin', async () => {
		const env = bareEnv({ WEBHOOK_KEY: 'whk-731' });
		const data = (await setupPageLoad(event('https://crm.example.com/settings/setup?wizard=webhook', { env, user: ADMIN }) as any)) as any;
		expect(JSON.stringify(data)).not.toContain('whk-731');
		const res = await (wizardActions as any).revealWebhook(event('https://crm.example.com/settings/setup?/revealWebhook', { fields: {}, env, user: ADMIN }));
		expect(res.revealed).toBe('https://crm.example.com/api/webhook?key=whk-731');
	});
});
