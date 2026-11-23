import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	attachDomain,
	checkDomainStatus,
	clearCustomDomain,
	clearDomainCache,
	publicBaseUrl,
	readDomainConfig,
	REDIRECT_EXEMPT,
	resolveBaseUrl,
	saveCustomDomain,
	setRedirect,
	validateHostname,
	zoneCandidates
} from '../src/lib/server/public-url';
import { handle } from '../src/hooks.server';
import { GET as renderGET } from '../src/routes/campaign/[id]/render/+server';

// #120: Settings → Domain — base-URL helper precedence, hostname validation, the browser
// redirect + its machine-path allow-list, the status-gated toggle, attach, and an email
// path picking up the custom domain.

const db = (env as { DB: D1Database }).DB;
const DOMAIN = 'crm.example.com';

async function reset() {
	await db.prepare(`DELETE FROM app_state WHERE key LIKE 'custom_domain%'`).run();
	clearDomainCache();
}
beforeEach(reset);
afterEach(reset);

async function setDomain(domain: string, opts: { redirect?: boolean; ok?: boolean } = {}) {
	await saveCustomDomain(db, domain);
	if (opts.ok !== undefined) {
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('custom_domain_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(JSON.stringify({ ok: opts.ok, code: opts.ok ? 200 : 522, checkedAt: new Date().toISOString(), domain }))
			.run();
	}
	if (opts.redirect) {
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('custom_domain_redirect', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
	}
	clearDomainCache();
}

describe('publicBaseUrl precedence', () => {
	it('resolveBaseUrl: setting → env → fallback, trailing slashes stripped', () => {
		expect(resolveBaseUrl('crm.example.com', 'https://old.workers.dev/', 'http://localhost:5173')).toEqual({ url: 'https://crm.example.com', source: 'setting' });
		expect(resolveBaseUrl(null, 'https://old.workers.dev//', 'http://localhost:5173')).toEqual({ url: 'https://old.workers.dev', source: 'env' });
		expect(resolveBaseUrl('', '  ', 'http://localhost:5173/')).toEqual({ url: 'http://localhost:5173', source: 'request' });
		expect(resolveBaseUrl(null, undefined, undefined)).toEqual({ url: '', source: 'none' });
	});

	it('reads app_state.custom_domain from D1', async () => {
		expect(await publicBaseUrl(db, { PUBLIC_BASE_URL: 'https://old.workers.dev/' }, 'https://req.test')).toBe('https://old.workers.dev');
		expect(await publicBaseUrl(db, {}, 'https://req.test/')).toBe('https://req.test');
		await setDomain(DOMAIN);
		expect(await publicBaseUrl(db, { PUBLIC_BASE_URL: 'https://old.workers.dev' }, 'https://req.test')).toBe(`https://${DOMAIN}`);
		await clearCustomDomain(db);
		expect(await publicBaseUrl(db, { PUBLIC_BASE_URL: 'https://old.workers.dev' })).toBe('https://old.workers.dev');
	});
});

describe('validateHostname', () => {
	it('accepts and lowercases valid hostnames', () => {
		expect(validateHostname('CRM.Example.com')).toEqual({ ok: true, hostname: 'crm.example.com' });
		expect(validateHostname(' a-b.example.co.uk. ')).toEqual({ ok: true, hostname: 'a-b.example.co.uk' });
	});
	it('rejects scheme, path, port, single labels, bad labels, IPs and workers.dev', () => {
		for (const bad of ['', 'https://crm.example.com', 'crm.example.com/login', 'crm.example.com:8443', 'localhost', '-a.example.com', 'a_b.example.com', 'a..example.com', '10.0.0.1', 'x.notionds.workers.dev', `${'a'.repeat(64)}.com`]) {
			expect(validateHostname(bad).ok, bad).toBe(false);
		}
	});
});

function hookEvent(url: string, method = 'GET') {
	return {
		request: new Request(url, { method }),
		url: new URL(url),
		params: {},
		route: { id: null },
		locals: {},
		cookies: { get: () => undefined, set() {}, delete() {}, getAll: () => [], serialize: () => '' },
		platform: { env: { DB: db, SESSION_SECRET: 'cd-secret' } },
		isDataRequest: false,
		isSubRequest: false
	};
}

async function hit(url: string, method = 'GET') {
	try {
		const res = await handle({
			event: hookEvent(url, method) as never,
			resolve: async () => new Response('ok', { status: 200 })
		} as never);
		return { status: res.status, location: res.headers.get('location') };
	} catch (e) {
		// SvelteKit's redirect(303, '/login') for an unauthenticated browser route.
		const r = e as { status?: number; location?: string };
		return { status: r.status ?? 0, location: r.location ?? null };
	}
}

describe('redirect other hosts (hooks.server.ts)', () => {
	const OLD = 'https://crm-app.my-account.workers.dev';

	it('301s a browser GET on another host, keeping path and query', async () => {
		await setDomain(DOMAIN, { ok: true, redirect: true });
		expect(await hit(`${OLD}/campaigns?status=sent&page=2`)).toEqual({ status: 301, location: `https://${DOMAIN}/campaigns?status=sent&page=2` });
		expect(await hit(`${OLD}/login`)).toEqual({ status: 301, location: `https://${DOMAIN}/login` });
		expect((await hit(`${OLD}/unsubscribe?t=abc`)).location).toBe(`https://${DOMAIN}/unsubscribe?t=abc`);
		expect((await hit(`${OLD}/p/hello`, 'HEAD')).status).toBe(301);
	});

	it('never redirects allow-listed machine paths', async () => {
		await setDomain(DOMAIN, { ok: true, redirect: true });
		const paths = [
			'/api/webhook?key=x',
			'/api/ingest',
			'/api/inbound',
			'/api/luma',
			'/api/automations/tick',
			'/api/contacts/upsert',
			'/api/v1',
			'/api/v1/contacts?limit=1',
			'/unsubscribe/one-click?t=x',
			'/img/abc.png',
			'/t.js?k=dsv_x',
			'/api/track',
			'/api/track/identify'
		];
		expect(REDIRECT_EXEMPT.length).toBeGreaterThan(0);
		for (const p of paths) {
			expect((await hit(`${OLD}${p}`)).status, p).not.toBe(301);
		}
	});

	it('never redirects POST', async () => {
		await setDomain(DOMAIN, { ok: true, redirect: true });
		expect((await hit(`${OLD}/login`, 'POST')).status).not.toBe(301);
		expect((await hit(`${OLD}/api/webhook`, 'POST')).status).not.toBe(301);
	});

	it('exempts localhost, 127.0.0.1 and the custom domain itself', async () => {
		await setDomain(DOMAIN, { ok: true, redirect: true });
		expect((await hit('http://localhost:5173/login')).status).toBe(200);
		expect((await hit('http://127.0.0.1:5173/login')).status).toBe(200);
		expect((await hit(`https://${DOMAIN}/login`)).status).toBe(200);
	});

	it('does nothing while the toggle is off', async () => {
		await setDomain(DOMAIN, { ok: true });
		expect((await hit(`${OLD}/login`)).status).toBe(200);
	});
});

describe('redirect toggle', () => {
	it('is refused without a passing status for the current domain', async () => {
		expect((await setRedirect(db, true)).ok).toBe(false); // no domain
		await setDomain(DOMAIN);
		expect((await setRedirect(db, true)).ok).toBe(false); // never checked
		await setDomain(DOMAIN, { ok: false });
		expect((await setRedirect(db, true)).ok).toBe(false); // failed check
		expect((await readDomainConfig(db)).redirect).toBe(false);

		await setDomain(DOMAIN, { ok: true });
		expect((await setRedirect(db, true)).ok).toBe(true);
		expect((await readDomainConfig(db)).redirect).toBe(true);
	});

	it('a passing check for another domain does not count; changing the domain turns it off', async () => {
		await setDomain(DOMAIN, { ok: true, redirect: true });
		await saveCustomDomain(db, 'other.example.com');
		const cfg = await readDomainConfig(db);
		expect(cfg.redirect).toBe(false);
		expect(cfg.status).toBeNull();
		expect((await setRedirect(db, true)).ok).toBe(false);
	});

	it('checkDomainStatus stores { ok, code, checkedAt } from fetching /login', async () => {
		await setDomain(DOMAIN);
		const fetcher = vi.fn(async () => new Response('login', { status: 200 }));
		const st = await checkDomainStatus(db, DOMAIN, fetcher as unknown as typeof fetch);
		expect(fetcher).toHaveBeenCalledWith(`https://${DOMAIN}/login`, expect.objectContaining({ method: 'GET' }));
		expect(st).toMatchObject({ ok: true, code: 200, domain: DOMAIN });
		expect((await readDomainConfig(db)).status).toMatchObject({ ok: true, code: 200 });
		expect((await setRedirect(db, true)).ok).toBe(true);

		const down = await checkDomainStatus(db, DOMAIN, (async () => { throw new Error('dns'); }) as unknown as typeof fetch);
		expect(down).toMatchObject({ ok: false, code: null });
	});
});

describe('attach to this Worker', () => {
	it('returns instructions without CF_API_TOKEN', async () => {
		const fetcher = vi.fn();
		expect(await attachDomain(DOMAIN, {}, fetcher as unknown as typeof fetch)).toEqual({ mode: 'instructions', hostname: DOMAIN });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('with a token: finds the zone, then PUTs the Workers custom domain', async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (url.includes('/zones?name=example.com')) {
				return Response.json({ success: true, errors: [], result: [{ id: 'zone123', name: 'example.com' }] });
			}
			if (url.includes('/workers/domains')) {
				return Response.json({ success: true, errors: [], result: { id: 'd1', hostname: DOMAIN } });
			}
			return Response.json({ success: true, result: [] });
		});
		const r = await attachDomain(DOMAIN, { CF_API_TOKEN: 'tok-secret', CF_ACCOUNT_ID: 'acct-test', WORKER_NAME: 'crm-worker' }, fetcher as unknown as typeof fetch);
		expect(r).toMatchObject({ mode: 'api', ok: true, zone: 'example.com' });
		expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/zones?name=example.com');
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-secret');
		const put = calls.find((c) => c.init?.method === 'PUT')!;
		expect(put.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-test/workers/domains');
		expect(JSON.parse(String(put.init?.body))).toEqual({
			hostname: DOMAIN,
			zone_id: 'zone123',
			service: 'crm-worker',
			environment: 'production'
		});
		expect(JSON.stringify(r)).not.toContain('tok-secret');
	});

	it('#596: with a token but no CF_ACCOUNT_ID / WORKER_NAME it says what is missing and calls nothing', async () => {
		const fetcher = vi.fn();
		const r = await attachDomain(DOMAIN, { CF_API_TOKEN: 'tok-secret' }, fetcher as unknown as typeof fetch);
		expect(r).toMatchObject({ mode: 'api', ok: false });
		expect(r.mode === 'api' && r.message).toBe('Not configured: set the CF_ACCOUNT_ID and WORKER_NAME vars in wrangler.jsonc.');
		const r2 = await attachDomain(DOMAIN, { CF_API_TOKEN: 'tok-secret', CF_ACCOUNT_ID: 'a' }, fetcher as unknown as typeof fetch);
		expect(r2.mode === 'api' && r2.message).toBe('Not configured: set the WORKER_NAME var in wrangler.jsonc.');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('reports a Cloudflare error and honours CF_ACCOUNT_ID', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/zones')) return Response.json({ success: true, result: [{ id: 'z', name: 'example.com' }] });
			return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
		});
		const r = await attachDomain(DOMAIN, { CF_API_TOKEN: 'cf_test_token_0123456789abcdef', CF_ACCOUNT_ID: 'acct9', WORKER_NAME: 'crm-worker' }, fetcher as unknown as typeof fetch);
		expect(r).toMatchObject({ mode: 'api', ok: false });
		expect(r.mode === 'api' && r.message).toContain('Authentication error');
		expect(fetcher.mock.calls.some((c) => String(c[0]).includes('/accounts/acct9/workers/domains'))).toBe(true);
	});

	it('redacts a realistic token echoed back in a Cloudflare error', async () => {
		const token = 'cf_test_token_0123456789abcdef';
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/zones')) return Response.json({ success: true, result: [{ id: 'z', name: 'example.com' }] });
			return Response.json(
				{ success: false, errors: [{ code: 10000, message: `Invalid token ${token}; header was Bearer ${token}` }] },
				{ status: 403 }
			);
		});
		const r = await attachDomain(DOMAIN, { CF_API_TOKEN: token, CF_ACCOUNT_ID: 'acct-test', WORKER_NAME: 'crm-worker' }, fetcher as unknown as typeof fetch);
		expect(r).toMatchObject({ mode: 'api', ok: false });
		const message = r.mode === 'api' ? r.message : '';
		expect(message).not.toContain(token);
		expect(message).toContain('Invalid token [REDACTED]');
		expect(message).toContain('Bearer [REDACTED]');
	});

	it('a short token does not mangle the message', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/zones')) return Response.json({ success: true, result: [{ id: 'z', name: 'example.com' }] });
			return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
		});
		const r = await attachDomain(DOMAIN, { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct-test', WORKER_NAME: 'crm-worker' }, fetcher as unknown as typeof fetch);
		expect(r.mode === 'api' && r.message).toBe('Attach failed: 10000 Authentication error');
	});

	it('zoneCandidates tries the registrable-looking name first', () => {
		expect(zoneCandidates('crm.a.example.com')).toEqual(['example.com', 'a.example.com', 'crm.a.example.com']);
	});
});

describe('email paths use the custom domain', () => {
	it('the rendered per-recipient unsubscribe link is on the custom domain', async () => {
		await db.batch([db.prepare('DELETE FROM recipients'), db.prepare("DELETE FROM contacts WHERE email = 'cd@x.example.net'")]);
		const c = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status)
				 VALUES ('Hi', 'md', '<p><a href="%%UNSUB_URL%%">Unsubscribe</a></p>', 'x', 'alan@ourco.example', 'sent') RETURNING id`
			)
			.first<{ id: number }>();
		const contact = await db.prepare(`INSERT INTO contacts (email, first_name) VALUES ('cd@x.example.net', 'Cee') RETURNING id`).first<{ id: number }>();
		const r = await db
			.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'cd@x.example.net', 'accepted') RETURNING id`)
			.bind(c!.id, contact!.id)
			.first<{ id: number }>();
		await setDomain(DOMAIN);

		const res = await renderGET({
			params: { id: String(c!.id) },
			url: new URL(`https://old.test/campaign/${c!.id}/render?as=${r!.id}`),
			locals: { user: { id: 1 } },
			platform: { env: { ...(env as object), SESSION_SECRET: 'cd-secret', PUBLIC_BASE_URL: 'https://old.workers.dev' } }
		} as never);
		const body = (await res.json()) as { html: string };
		expect(body.html).toContain(`https://${DOMAIN}/unsubscribe?t=`);
		expect(body.html).not.toContain('old.workers.dev');
	});
});
