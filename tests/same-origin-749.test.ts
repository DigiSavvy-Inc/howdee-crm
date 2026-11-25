import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { handle } from '../src/hooks.server';
import { createSession, SESSION_COOKIE } from '../src/lib/server/auth';
import { crossSiteRefused, CROSS_SITE_MESSAGE } from '../src/lib/server/same-origin';

// #749: a state-changing request that carries a session cookie must come from the app's
// own origin, whatever its content type. Machine endpoints on the exempt list keep working.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'same-origin-749-secret';
const APP = 'https://app.test';
const OTHER = 'https://sibling.app.test';
const LOGIN = 'sameorigin749-member';

let token = '';
let userId = 0;

beforeAll(async () => {
	await db.prepare('DELETE FROM users WHERE github_login = ?').bind(LOGIN).run();
	const res = await db.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member')`).bind(LOGIN).run();
	userId = res.meta.last_row_id as number;
	token = await createSession(SECRET, userId);
});

afterAll(async () => {
	await db.prepare('DELETE FROM users WHERE github_login = ?').bind(LOGIN).run();
});

type HitOpts = {
	method?: string;
	headers?: Record<string, string>;
	body?: BodyInit | null;
	session?: string;
	/** The app origin the request reached (default APP). */
	base?: string;
};

/** Run the hook; `resolved` tells whether the request got past it to the route. */
async function hit(path: string, opts: HitOpts = {}) {
	const url = new URL(`${opts.base ?? APP}${path}`);
	const method = opts.method ?? 'POST';
	const request = new Request(url, {
		method,
		headers: opts.headers ?? {},
		body: method === 'GET' || method === 'HEAD' ? undefined : opts.body ?? null
	});
	const session = opts.session;
	const cookieWrites: string[] = [];
	const event = {
		request,
		url,
		params: {},
		route: { id: null },
		locals: {} as Record<string, unknown>,
		cookies: {
			get: (name: string) => (name === SESSION_COOKIE ? session : undefined),
			set: (name: string) => void cookieWrites.push(`set ${name}`),
			delete: (name: string) => void cookieWrites.push(`delete ${name}`),
			getAll: () => [],
			serialize: () => ''
		},
		platform: { env: { DB: db, SESSION_SECRET: SECRET } },
		isDataRequest: false,
		isSubRequest: false
	};
	let resolved = false;
	try {
		const res = await handle({
			event: event as never,
			resolve: async () => {
				resolved = true;
				return new Response('ok', { status: 200 });
			}
		} as never);
		return { status: res.status, text: await res.text(), resolved, locals: event.locals, cookieWrites };
	} catch (e) {
		if (isRedirect(e)) return { status: e.status, text: '', resolved, locals: event.locals, cookieWrites };
		throw e;
	}
}

describe('crossSiteRefused (#749)', () => {
	const h = (o: Record<string, string>) => new Headers(o);

	it('ignores GET and HEAD', () => {
		expect(crossSiteRefused('GET', h({ origin: OTHER }), APP, true)).toBe(false);
		expect(crossSiteRefused('HEAD', h({}), APP, true)).toBe(false);
	});

	it('with a session: Origin must equal the app origin, whatever the content type', () => {
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(crossSiteRefused(m, h({ origin: OTHER }), APP, true)).toBe(true);
			expect(crossSiteRefused(m, h({ origin: OTHER, 'content-type': 'application/json' }), APP, true)).toBe(true);
			expect(crossSiteRefused(m, h({ origin: 'null' }), APP, true)).toBe(true);
			expect(crossSiteRefused(m, h({ origin: APP }), APP, true)).toBe(false);
		}
	});

	it('with a session and no Origin: only Sec-Fetch-Site same-origin or none passes', () => {
		expect(crossSiteRefused('POST', h({ 'sec-fetch-site': 'same-origin' }), APP, true)).toBe(false);
		expect(crossSiteRefused('POST', h({ 'sec-fetch-site': 'none' }), APP, true)).toBe(false);
		expect(crossSiteRefused('POST', h({ 'sec-fetch-site': 'same-site' }), APP, true)).toBe(true);
		expect(crossSiteRefused('POST', h({ 'sec-fetch-site': 'cross-site' }), APP, true)).toBe(true);
		expect(crossSiteRefused('POST', h({}), APP, true)).toBe(true);
	});

	it('without a session: only cross-origin form-type bodies are refused (as before)', () => {
		expect(crossSiteRefused('POST', h({ 'content-type': 'application/x-www-form-urlencoded', origin: OTHER }), APP, false)).toBe(true);
		expect(crossSiteRefused('POST', h({ 'content-type': 'text/plain' }), APP, false)).toBe(true);
		expect(crossSiteRefused('POST', h({ 'content-type': 'multipart/form-data; boundary=x', origin: APP }), APP, false)).toBe(false);
		expect(crossSiteRefused('POST', h({ 'content-type': 'application/json', origin: OTHER }), APP, false)).toBe(false);
		expect(crossSiteRefused('POST', h({}), APP, false)).toBe(false);
	});
});

describe('hook: session-gated writes need the same origin (#749)', () => {
	const ACTION = '/api/assistant/actions/1';
	const SUGGESTION = '/api/suggestions/1';
	// Bytes, not a string: a string body would get a text/plain content type.
	const typeless = (text: string) => new TextEncoder().encode(text);

	for (const path of [ACTION, SUGGESTION]) {
		it(`${path}: a cross-origin POST with no content type is refused`, async () => {
			const r = await hit(path, { session: token, headers: { origin: OTHER }, body: typeless('{"op":"undo"}') });
			expect(r.status).toBe(403);
			expect(r.text).toBe(CROSS_SITE_MESSAGE);
			expect(r.resolved).toBe(false);
		});

		it(`${path}: a POST with neither Origin nor Sec-Fetch-Site is refused`, async () => {
			const r = await hit(path, { session: token, body: typeless('{"op":"undo"}') });
			expect(r.status).toBe(403);
			expect(r.resolved).toBe(false);
		});

		it(`${path}: the same request from the app's own origin reaches the route`, async () => {
			const r = await hit(path, { session: token, headers: { origin: APP }, body: typeless('{"op":"undo"}') });
			expect(r.status).toBe(200);
			expect(r.resolved).toBe(true);
			expect((r.locals.user as { id: number } | null)?.id).toBe(userId);
		});

		it(`${path}: no Origin but Sec-Fetch-Site same-origin reaches the route`, async () => {
			const r = await hit(path, { session: token, headers: { 'sec-fetch-site': 'same-origin' }, body: typeless('{}') });
			expect(r.resolved).toBe(true);
		});
	}

	it('a cross-origin JSON POST with a session is refused', async () => {
		const r = await hit(SUGGESTION, {
			session: token,
			headers: { origin: OTHER, 'content-type': 'application/json' },
			body: '{"action":"done"}'
		});
		expect(r.status).toBe(403);
	});

	it('a cross-origin DELETE and PATCH with a session are refused', async () => {
		expect((await hit(SUGGESTION, { method: 'DELETE', session: token, headers: { origin: OTHER } })).status).toBe(403);
		expect((await hit(SUGGESTION, { method: 'PATCH', session: token, headers: { origin: OTHER } })).status).toBe(403);
	});

	it('a form action posted cross-origin with a session is refused', async () => {
		const r = await hit('/settings?/setNavLayout', {
			session: token,
			headers: { origin: OTHER, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'nav_layout=left'
		});
		expect(r.status).toBe(403);
	});

	it('a cross-origin POST with an invalid or stale session cookie is refused before the session is read', async () => {
		for (const bad of ['u.1.2.not-a-signature', 'garbage', `${token}x`]) {
			const r = await hit(SUGGESTION, {
				session: bad,
				headers: { origin: OTHER, 'content-type': 'application/json' },
				body: '{"action":"done"}'
			});
			expect(r.status).toBe(403);
			expect(r.text).toBe(CROSS_SITE_MESSAGE);
			expect(r.resolved).toBe(false);
			expect(r.cookieWrites).toEqual([]); // the hook did not clear the cookie
			expect(r.locals.user).toBeUndefined();
		}
	});

	it('an Origin naming another hostname of the same app is refused', async () => {
		const r = await hit(SUGGESTION, {
			base: 'https://app.test',
			session: token,
			headers: { origin: 'https://crm.app.test', 'content-type': 'application/json' },
			body: '{"action":"done"}'
		});
		expect(r.status).toBe(403);
		expect(r.resolved).toBe(false);
		const back = await hit(SUGGESTION, {
			base: 'https://crm.app.test',
			session: token,
			headers: { origin: 'https://app.test', 'content-type': 'application/json' },
			body: '{"action":"done"}'
		});
		expect(back.status).toBe(403);
		expect(back.resolved).toBe(false);
	});

	it('Origin: null with a session is refused', async () => {
		const r = await hit(SUGGESTION, { session: token, headers: { origin: 'null' }, body: typeless('{}') });
		expect(r.status).toBe(403);
		expect(r.text).toBe(CROSS_SITE_MESSAGE);
		expect(r.resolved).toBe(false);
	});

	it('GET is not checked', async () => {
		const r = await hit('/conversations', { method: 'GET', session: token, headers: { 'sec-fetch-site': 'cross-site' } });
		expect(r.resolved).toBe(true);
	});

	it('without a session, a cross-origin JSON POST is not refused by the check (it acts as nobody)', async () => {
		const r = await hit(SUGGESTION, { headers: { origin: OTHER, 'content-type': 'application/json' }, body: '{}' });
		expect(r.status).not.toBe(403);
		expect(r.resolved).toBe(false); // sent to /login instead
	});
});

describe('hook: exempt machine callers still pass (#749)', () => {
	const cases: { name: string; path: string; headers: Record<string, string>; body?: string; session?: boolean }[] = [
		{ name: 'Data API (Bearer key)', path: '/api/v1/contacts', headers: { authorization: 'Bearer dk_live_test', 'content-type': 'application/json', origin: OTHER }, body: '{}' }, // gitleaks:allow
		{ name: 'MCP (Bearer key)', path: '/mcp', headers: { authorization: 'Bearer dk_live_test', 'content-type': 'application/json' }, body: '{}' }, // gitleaks:allow
		{ name: 'heartbeat tick', path: '/api/automations/tick', headers: { authorization: 'Bearer cron-test' } },
		{ name: 'Postmark webhook', path: '/api/webhook?key=k', headers: { 'content-type': 'application/json' }, body: '{}' },
		{ name: 'form ingest (cross-origin form post)', path: '/api/ingest?key=k', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: OTHER }, body: 'email=a%40x.test' },
		{ name: 'contact upsert', path: '/api/contacts/upsert', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: '{}' },
		{ name: 'inbound replies', path: '/api/inbound?key=k', headers: { 'content-type': 'application/json' }, body: '{}' },
		{ name: 'Luma (signature)', path: '/api/luma', headers: { 'content-type': 'application/json', 'webhook-signature': 't=1,v1=x' }, body: '{}' },
		{ name: 'health check', path: '/api/health', headers: { authorization: 'Bearer cron-test' } },
		{ name: 'tracking beacon (sendBeacon text/plain)', path: '/api/track', headers: { 'content-type': 'text/plain;charset=UTF-8', origin: OTHER }, body: '{}' },
		{ name: 'tracking beacon with a session cookie', path: '/api/track', headers: { 'content-type': 'text/plain', origin: OTHER }, body: '{}', session: true },
		{ name: 'public form submit (cross-origin)', path: '/f/signup/submit', headers: { 'content-type': 'multipart/form-data; boundary=x', origin: OTHER }, body: '--x--' },
		{ name: 'newsletter sign-up', path: '/newsletter/subscribe', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: OTHER }, body: 'email=a%40x.test' },
		{ name: 'one-click unsubscribe (no Origin)', path: '/unsubscribe/one-click?t=x', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }
	];

	for (const c of cases) {
		it(c.name, async () => {
			const r = await hit(c.path, { headers: c.headers, body: c.body ?? null, session: c.session ? token : undefined });
			expect(r.status).not.toBe(403);
			expect(r.resolved).toBe(true);
		});
	}

	it('the embedded form page (GET, cross-origin frame) is served', async () => {
		const r = await hit('/f/signup?embed=1', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } });
		expect(r.resolved).toBe(true);
	});
});
