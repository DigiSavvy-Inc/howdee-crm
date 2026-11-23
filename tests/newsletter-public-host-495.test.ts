import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';

// #495: Test connection falls back to a browser-side check — the public feed (and only it)
// carries CORS headers for the CRM origin, and `recordPublicTest` stores the browser's result,
// which gates the redirect exactly like a server-side pass.

import { handle } from '../src/hooks.server';
import { GET as feedGET } from '../src/routes/newsletter/feed.xml/+server';
import { actions as settingsActions } from '../src/routes/settings/newsletter/+page.server';
import { saveArchiveSettings } from '../src/lib/server/newsletter-archive';
import { clearArchivePublicCache, feedCorsHeaders, readArchivePublicConfig, savePublicHost, SOURCE_HEADER } from '../src/lib/server/archive-public';
import { clearDomainCache } from '../src/lib/server/public-url';

const db = (env as { DB: D1Database }).DB;
const CRM = 'https://crm.test';
const PUB = 'ourco.example';
const ACAO = 'access-control-allow-origin';
const ACEH = 'access-control-expose-headers';

const platformEnv = () => ({ ...(env as any), PUBLIC_BASE_URL: `${CRM}/`, SESSION_SECRET: 'secret' });

function hookEvent(url: string) {
	return {
		request: new Request(url),
		url: new URL(url),
		params: {},
		route: { id: null },
		locals: {} as App.Locals,
		cookies: { get: () => undefined, set() {}, delete() {}, getAll: () => [], serialize: () => '' },
		platform: { env: platformEnv() },
		isDataRequest: false,
		isSubRequest: false
	};
}

type Handler = (e: any) => Response | Promise<Response>;
async function hit(url: string, route: Handler = async () => new Response('app', { status: 200 })) {
	try {
		const res = await handle({ event: hookEvent(url) as never, resolve: (async (ev: unknown) => route(ev)) as never } as never);
		return { status: res.status, headers: res.headers };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, headers: new Headers() };
		const r = e as { status?: number };
		if (r.status) return { status: r.status, headers: new Headers() };
		throw e;
	}
}

function actionEvent(action: string, user: unknown, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = `${CRM}/settings/newsletter?/${action}`;
	return { request: new Request(url, { method: 'POST', body: fd }), url: new URL(url), platform: { env: platformEnv() }, locals: { user } } as any;
}
const ADMIN = { id: 1, role: 'admin' };
const MEMBER = { id: 2, role: 'member' };

async function reset() {
	await db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%' OR key LIKE 'custom_domain%'").run();
	clearArchivePublicCache();
	clearDomainCache();
}
beforeEach(reset);
afterEach(reset);

describe('CORS on the public feed', () => {
	it('the public feed carries both headers with the CRM origin', async () => {
		await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] });
		await savePublicHost(db, PUB);
		const res = await hit(`https://${PUB}/newsletter/feed.xml?t=123`, feedGET);
		expect(res.status).toBe(200);
		expect(res.headers.get(SOURCE_HEADER)).toBe('crm');
		expect(res.headers.get(ACAO)).toBe(CRM);
		expect(res.headers.get(ACEH)).toBe(SOURCE_HEADER);
	});

	it('the CRM-host feed and other public paths carry neither', async () => {
		await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId: null, indexable: true, autoGroups: [] });
		await savePublicHost(db, PUB);
		const crm = await hit(`${CRM}/newsletter/feed.xml`, feedGET);
		expect(crm.status).toBe(200);
		expect(crm.headers.get(ACAO)).toBeNull();
		expect(crm.headers.get(ACEH)).toBeNull();
		for (const p of ['/newsletter', '/newsletter/some-issue', '/newsletter/feed.xml/x', '/newsletter/img/a.png']) {
			const res = await hit(`https://${PUB}${p}`);
			expect(res.status, p).toBe(200);
			expect(res.headers.get(SOURCE_HEADER), p).toBe('crm');
			expect(res.headers.get(ACAO), p).toBeNull();
			expect(res.headers.get(ACEH), p).toBeNull();
		}
	});

	it('feedCorsHeaders: only the exact feed path, only with a valid base', () => {
		expect(feedCorsHeaders('/newsletter/feed.xml', 'https://crm.myapp.example/')).toEqual({
			'Access-Control-Allow-Origin': 'https://crm.myapp.example',
			'Access-Control-Expose-Headers': SOURCE_HEADER
		});
		expect(feedCorsHeaders('/newsletter', 'https://crm.myapp.example')).toEqual({});
		expect(feedCorsHeaders('/newsletter/feed.xml', '')).toEqual({});
	});
});

describe('recordPublicTest', () => {
	it('member refused; admin without a saved host refused', async () => {
		expect(((await settingsActions.recordPublicTest(actionEvent('recordPublicTest', MEMBER, { ok: '1', code: '200' }))) as any).status).toBe(403);
		expect(((await settingsActions.recordPublicTest(actionEvent('recordPublicTest', ADMIN, { ok: '1', code: '200' }))) as any).status).toBe(400);
		await savePublicHost(db, PUB);
		expect(((await settingsActions.recordPublicTest(actionEvent('recordPublicTest', MEMBER, { ok: '1', code: '200' }))) as any).status).toBe(403);
		expect((await readArchivePublicConfig(db)).status).toBeNull();
	});

	it('a browser pass is stored with via: browser and unlocks the redirect', async () => {
		await savePublicHost(db, PUB);
		// The server-side test failed first: the redirect stays locked.
		expect(((await settingsActions.setPublicRedirect(actionEvent('setPublicRedirect', ADMIN, { on: '1' }))) as any).status).toBe(400);
		const res = await settingsActions.recordPublicTest(actionEvent('recordPublicTest', ADMIN, { ok: '1', code: '200' }));
		expect(res).toEqual({ hostTested: true });
		const cfg = await readArchivePublicConfig(db);
		expect(cfg.status).toMatchObject({ ok: true, code: 200, via: 'browser', host: PUB });
		expect(cfg.status?.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(await settingsActions.setPublicRedirect(actionEvent('setPublicRedirect', ADMIN, { on: '1' }))).toEqual({ redirectSaved: true });
		expect((await readArchivePublicConfig(db)).redirect).toBe(true);
	});

	it('a browser fail is stored and keeps the redirect locked', async () => {
		await savePublicHost(db, PUB);
		expect(await settingsActions.recordPublicTest(actionEvent('recordPublicTest', ADMIN, { ok: '0', code: '404' }))).toEqual({ hostTested: false });
		expect((await readArchivePublicConfig(db)).status).toMatchObject({ ok: false, code: 404, via: 'browser', host: PUB });
		expect(((await settingsActions.setPublicRedirect(actionEvent('setPublicRedirect', ADMIN, { on: '1' }))) as any).status).toBe(400);
		// A thrown fetch (no answer) is a fail with no code.
		expect(await settingsActions.recordPublicTest(actionEvent('recordPublicTest', ADMIN, { ok: '0', code: '' }))).toEqual({ hostTested: false });
		expect((await readArchivePublicConfig(db)).status).toMatchObject({ ok: false, code: null, via: 'browser' });
		// ok=1 without a 200 isn't a pass.
		expect(await settingsActions.recordPublicTest(actionEvent('recordPublicTest', ADMIN, { ok: '1', code: '404' }))).toEqual({ hostTested: false });
		expect(((await settingsActions.setPublicRedirect(actionEvent('setPublicRedirect', ADMIN, { on: '1' }))) as any).status).toBe(400);
		expect((await readArchivePublicConfig(db)).redirect).toBe(false);
	});
});
