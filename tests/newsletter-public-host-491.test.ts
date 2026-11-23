import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';

// #491: the newsletter archive on a public host (ourco.example/newsletter) — public mode by
// host and by proxy secret, no CRM URL in the output, /newsletter/img, the hooks guard, the
// CRM → public redirect, Settings → Domain never redirecting the public host, the secret, and
// Test connection.

import { handle } from '../src/hooks.server';
import { GET as indexGET } from '../src/routes/newsletter/+server';
import { GET as issueGET } from '../src/routes/newsletter/[slug]/+server';
import { GET as feedGET } from '../src/routes/newsletter/feed.xml/+server';
import { GET as imgGET } from '../src/routes/newsletter/img/[...rest]/+server';
import { actions as settingsActions } from '../src/routes/settings/newsletter/+page.server';
import { publishIssue, saveArchiveSettings } from '../src/lib/server/newsletter-archive';
import {
	archiveRedirectTarget,
	archiveRequestMode,
	clearArchivePublicCache,
	publicizeHtml,
	readArchivePublicConfig,
	removeProxySecret,
	rotateProxySecret,
	savePublicHost,
	setArchiveRedirect,
	testPublicConnection,
	validatePublicHost,
	PROXY_SECRET_HEADER,
	SOURCE_HEADER
} from '../src/lib/server/archive-public';
import { clearDomainCache, redirectTarget, saveCustomDomain } from '../src/lib/server/public-url';

const db = (env as { DB: D1Database }).DB;
const CRM = 'https://crm.test';
const CRM_HOST = 'crm.test';
const PUB = 'ourco.example';
const IMG = 'a0004000-a000-4000-a000-4000a0004000.png';
const LOGO = 'branding/logo-0123456789abcdef.png';

/** Minimal in-memory R2 stand-in (get only). */
function fakeBucket() {
	const store = new Map<string, string>([
		[IMG, 'PNGDATA'],
		[LOGO, 'LOGODATA']
	]);
	return {
		async get(key: string) {
			const v = store.get(key);
			return v ? { body: v, httpMetadata: { contentType: 'image/png' }, httpEtag: '"e"' } : null;
		}
	};
}
// #596: PUB is a Workers route host (the ARCHIVE_ROUTE_HOSTS var), as ourco.example is in production.
const platformEnv = () => ({ ...(env as any), PUBLIC_BASE_URL: CRM, SESSION_SECRET: 'secret', MEDIA: fakeBucket(), ARCHIVE_ROUTE_HOSTS: PUB });

function hookEvent(
	url: string,
	opts: { method?: string; headers?: Record<string, string>; params?: Record<string, string>; env?: Record<string, unknown> } = {}
) {
	return {
		request: new Request(url, { method: opts.method ?? 'GET', headers: opts.headers }),
		url: new URL(url),
		params: opts.params ?? {},
		route: { id: null },
		locals: {} as App.Locals,
		cookies: { get: () => undefined, set() {}, delete() {}, getAll: () => [], serialize: () => '' },
		platform: { env: { ...platformEnv(), ...opts.env } },
		isDataRequest: false,
		isSubRequest: false
	};
}

type Handler = (e: any) => Response | Promise<Response>;
/** Run the request through hooks.server.ts, resolving with `route` (a route GET). */
async function hit(url: string, route: Handler = async () => new Response('app', { status: 200 }), opts: Parameters<typeof hookEvent>[1] = {}) {
	try {
		const res = await handle({ event: hookEvent(url, opts) as never, resolve: (async (ev: unknown) => route(ev)) as never } as never);
		return { status: res.status, location: res.headers.get('location'), body: await res.text(), headers: res.headers };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, location: null, body: '', headers: new Headers() };
		const r = e as { status?: number; location?: string };
		if (r.status) return { status: r.status, location: r.location ?? null, body: '', headers: new Headers() };
		throw e;
	}
}

async function put(key: string, value: string) {
	await db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}
async function passStatus(host = PUB) {
	await put('archive_public_status', JSON.stringify({ ok: true, code: 200, checkedAt: new Date().toISOString(), host }));
	clearArchivePublicCache();
}

async function reset() {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaign_audiences'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare("DELETE FROM templates WHERE kind = 'web'"),
		db.prepare("DELETE FROM app_state WHERE key LIKE 'archive_%' OR key LIKE 'custom_domain%' OR key IN ('logo_key', 'mailing_address')")
	]);
	clearArchivePublicCache();
	clearDomainCache();
}
beforeEach(reset);
afterEach(reset);

let slug = '';
/** Archive on, a published issue with an uploaded image, optionally a custom web template
 *  holding absolute CRM links. */
async function seed(opts: { template?: boolean } = {}) {
	const listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id").first<{ id: number }>())!.id;
	let templateId: number | null = null;
	if (opts.template) {
		const blocks = [
			{ id: 'logo', type: 'image', src: `${CRM}/img/${IMG}`, alt: 'Logo', href: `${CRM}/newsletter` },
			{ id: 'c', type: 'content' },
			{ id: 'f', type: 'paragraph', content: [{ type: 'text', text: 'All issues', marks: [{ type: 'link', href: `${CRM}/newsletter/feed.xml` }] }] }
		];
		templateId = (await db
			.prepare("INSERT INTO templates (name, kind, blocks, canvas) VALUES ('Web', 'web', ?, '{}') RETURNING id")
			.bind(JSON.stringify(blocks))
			.first<{ id: number }>())!.id;
	}
	await saveArchiveSettings(db, { enabled: true, title: 'Newsletter', intro: '', subscribeUrl: '', templateId, indexable: true, autoGroups: [] });
	const blocks = [
		{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Issue body' }] },
		{ id: 'i', type: 'image', src: `${CRM}/img/${IMG}`, alt: 'Chart' }
	];
	const cid = (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_blocks, body_html, list_id, from_email, status, sent_at, preheader)
			 VALUES ('Big news', 'Issue body', ?, '<p>x</p>', ?, 'alan@ourco.example', 'sent', '2026-10-14 15:00:00', 'A teaser') RETURNING id`
		)
		.bind(JSON.stringify(blocks), listId)
		.first<{ id: number }>())!.id;
	const r = await publishIssue(db, cid);
	slug = r.ok ? r.slug : '';
	await put('logo_key', LOGO);
}

describe('public mode', () => {
	it('by host, by secret, and neither on a plain CRM request', async () => {
		await savePublicHost(db, PUB);
		const secret = await rotateProxySecret(db);
		const cfg = await readArchivePublicConfig(db);
		expect(await archiveRequestMode(new URL(`https://${PUB}/newsletter`), new Headers(), cfg)).toEqual({ kind: 'public', base: `https://${PUB}` });
		expect(await archiveRequestMode(new URL(`${CRM}/newsletter/x`), new Headers({ [PROXY_SECRET_HEADER]: secret }), cfg)).toEqual({
			kind: 'public',
			base: `https://${PUB}`
		});
		expect(await archiveRequestMode(new URL(`${CRM}/newsletter`), new Headers(), cfg)).toEqual({ kind: 'crm' });
		expect(await archiveRequestMode(new URL(`${CRM}/newsletter`), new Headers({ [PROXY_SECRET_HEADER]: 'wrong' }), cfg)).toEqual({ kind: 'crm' });
	});

	it('secret: only the hash is stored, rotate invalidates the old one, remove turns it off', async () => {
		await savePublicHost(db, PUB);
		const first = await rotateProxySecret(db);
		let cfg = await readArchivePublicConfig(db);
		expect(cfg.secretHash).toMatch(/^[a-f0-9]{64}$/);
		expect(cfg.secretHash).not.toContain(first);
		const second = await rotateProxySecret(db);
		expect(second).not.toBe(first);
		cfg = await readArchivePublicConfig(db);
		const mode = (s: string) => archiveRequestMode(new URL(`${CRM}/newsletter`), new Headers({ [PROXY_SECRET_HEADER]: s }), cfg);
		expect((await mode(first)).kind).toBe('crm');
		expect((await mode(second)).kind).toBe('public');
		await removeProxySecret(db);
		cfg = await readArchivePublicConfig(db);
		expect((await mode(second)).kind).toBe('crm');
	});

	it('a proxied request (secret) for a non-archive path is a 404', async () => {
		await savePublicHost(db, PUB);
		const secret = await rotateProxySecret(db);
		expect((await hit(`${CRM}/login`, undefined, { headers: { [PROXY_SECRET_HEADER]: secret } })).status).toBe(404);
	});
});

describe('no CRM URL in public output', () => {
	const leaks = (s: string) => {
		expect(s).not.toContain(CRM_HOST);
		expect(s).not.toContain('crm.myapp.example');
	};

	it('issue page, index and feed — built-in template with the uploaded logo', async () => {
		await seed();
		await savePublicHost(db, PUB);
		const issue = await hit(`https://${PUB}/newsletter/${slug}`, issueGET, { params: { slug } });
		expect(issue.status).toBe(200);
		expect(issue.headers.get(SOURCE_HEADER)).toBe('crm');
		leaks(issue.body);
		expect(issue.body).toContain(`<link rel="canonical" href="https://${PUB}/newsletter/${slug}">`);
		expect(issue.body).toContain(`https://${PUB}/newsletter/img/${IMG}`);
		expect(issue.body).toContain(`https://${PUB}/newsletter/img/${LOGO}`);
		expect(issue.body).toContain(`https://${PUB}/newsletter/feed.xml`);
		expect(issue.body).not.toMatch(/["'(\s]\/img\//);

		const index = await hit(`https://${PUB}/newsletter`, indexGET);
		expect(index.status).toBe(200);
		leaks(index.body);
		expect(index.body).toContain(`https://${PUB}/newsletter`);

		const feed = await hit(`https://${PUB}/newsletter/feed.xml`, feedGET);
		expect(feed.status).toBe(200);
		leaks(feed.body);
		expect(feed.body).toContain(`<link>https://${PUB}/newsletter/${slug}</link>`);
	});

	it('a custom web template with absolute CRM links', async () => {
		await seed({ template: true });
		await savePublicHost(db, PUB);
		for (const [path, route, params] of [
			[`/newsletter/${slug}`, issueGET, { slug }],
			['/newsletter', indexGET, {}]
		] as const) {
			const res = await hit(`https://${PUB}${path}`, route, { params: { ...params } });
			expect(res.status).toBe(200);
			leaks(res.body);
			expect(res.body).toContain(`href="https://${PUB}/newsletter"`);
			expect(res.body).toContain(`https://${PUB}/newsletter/feed.xml`);
			expect(res.body).toContain(`src="https://${PUB}/newsletter/img/${IMG}"`);
		}
	});

	it('outside public mode nothing changes', async () => {
		await seed();
		await savePublicHost(db, PUB);
		const res = await hit(`${CRM}/newsletter/${slug}`, issueGET, { params: { slug } });
		expect(res.status).toBe(200);
		expect(res.headers.get(SOURCE_HEADER)).toBeNull();
		expect(res.body).toContain(`${CRM}/newsletter/${slug}`);
		expect(res.body).toContain(`${CRM}/img/${IMG}`);
	});

	it('publicizeHtml rewrites only CRM / root-relative image URLs', () => {
		const out = publicizeHtml(
			`<img src="${CRM}/img/a.png"><a href="${CRM}/newsletter?page=2">x</a><img src="/img/b.png"><a href="${CRM}/p/about">p</a><img src="https://other.example.net/img/c.png"><a href="${CRM}/newsletters">n</a>`,
			CRM,
			`https://${PUB}`
		);
		expect(out).toContain(`src="https://${PUB}/newsletter/img/a.png"`);
		expect(out).toContain(`href="https://${PUB}/newsletter?page=2"`);
		expect(out).toContain('src="/newsletter/img/b.png"');
		expect(out).toContain('src="https://other.example.net/img/c.png"');
		expect(out).toContain(`href="${CRM}/newsletters"`);
	});
});

describe('/newsletter/img', () => {
	const img = (rest: string) =>
		Promise.resolve(imgGET({ params: { rest }, platform: { env: platformEnv() }, url: new URL(`https://${PUB}/newsletter/img/${rest}`) } as any)).catch((e) => {
			if (isHttpError(e)) return new Response(null, { status: e.status });
			throw e;
		});

	it('serves the same R2 objects as /img with the immutable cache header', async () => {
		const res = await img(IMG);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('PNGDATA');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		const logo = await img(LOGO);
		expect(logo.status).toBe(200);
		expect(await logo.text()).toBe('LOGODATA');
		expect(logo.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
	});

	it('404 for unknown keys and other paths', async () => {
		expect((await img('nope.png')).status).toBe(404);
		expect((await img(`x/${IMG}`)).status).toBe(404);
		expect((await img('branding/../secret.png')).status).toBe(404);
	});
});

describe('hooks guard on the public host', () => {
	it('/login and every non-archive path are 404 on the public host', async () => {
		await savePublicHost(db, PUB);
		for (const p of ['/login', '/', '/contacts', '/api/v1', '/img/' + IMG, '/newsletters', '/settings/newsletter']) {
			expect((await hit(`https://${PUB}${p}`)).status, p).toBe(404);
		}
		expect((await hit(`https://${PUB}/newsletter`)).status).toBe(200);
	});

	it('the route host is a 404 until Settings has it saved', async () => {
		expect((await hit(`https://${PUB}/newsletter`)).status).toBe(404);
		await savePublicHost(db, `news.${PUB}`);
		expect((await hit(`https://${PUB}/newsletter`)).status).toBe(404);
	});

	it('#596: with ARCHIVE_ROUTE_HOSTS unset, a host that is not the saved public host is the CRM', async () => {
		const unset = { env: { ARCHIVE_ROUTE_HOSTS: undefined } };
		expect((await hit(`https://${PUB}/newsletter`, undefined, unset)).status).toBe(200);
		expect((await hit(`https://${PUB}/login`, undefined, unset)).status).toBe(200);
		await savePublicHost(db, `news.${PUB}`);
		expect((await hit(`https://${PUB}/newsletter`, undefined, unset)).status).toBe(200);
	});
});

describe('redirect CRM host → public host', () => {
	it('on: CRM /newsletter/x?y=1 → 301 to the public URL; the public host is never redirected', async () => {
		await savePublicHost(db, PUB);
		await passStatus();
		expect(await setArchiveRedirect(db, true)).toEqual({ ok: true });
		const r = await hit(`${CRM}/newsletter/x?y=1`);
		expect(r).toMatchObject({ status: 301, location: `https://${PUB}/newsletter/x?y=1` });
		expect((await hit(`${CRM}/newsletter`)).location).toBe(`https://${PUB}/newsletter`);
		expect((await hit(`${CRM}/newsletter/feed.xml`)).location).toBe(`https://${PUB}/newsletter/feed.xml`);
		expect((await hit(`${CRM}/newsletter`, undefined, { method: 'POST' })).status).not.toBe(301);
		const pub = await hit(`https://${PUB}/newsletter/x?y=1`);
		expect(pub.status).toBe(200);
		expect(pub.location).toBeNull();
		// The admin preview isn't under /newsletter.
		expect(archiveRedirectTarget(new URL(`${CRM}/campaign/1/archive/preview`), 'GET', await readArchivePublicConfig(db), false)).toBeNull();
		// Never in public mode (no loops).
		expect(archiveRedirectTarget(new URL(`${CRM}/newsletter`), 'GET', await readArchivePublicConfig(db), true)).toBeNull();
	});

	it('the toggle refuses to turn on without a passing status for the current host', async () => {
		expect((await setArchiveRedirect(db, true)).ok).toBe(false);
		await savePublicHost(db, PUB);
		expect((await setArchiveRedirect(db, true)).ok).toBe(false);
		await passStatus('other.example.net');
		expect((await setArchiveRedirect(db, true)).ok).toBe(false);
		await put('archive_public_status', JSON.stringify({ ok: false, code: 404, checkedAt: '', host: PUB }));
		expect((await setArchiveRedirect(db, true)).ok).toBe(false);
		await passStatus();
		expect((await setArchiveRedirect(db, true)).ok).toBe(true);
		// Changing the host resets the status and turns the redirect off.
		await savePublicHost(db, `www.${PUB}`);
		const cfg = await readArchivePublicConfig(db);
		expect(cfg.redirect).toBe(false);
		expect(cfg.status).toBeNull();
	});

	it('Settings action: member refused; admin refused without a pass', async () => {
		const ev = (user: unknown, fields: Record<string, string>) => {
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.append(k, v);
			const url = `${CRM}/settings/newsletter?/setPublicRedirect`;
			return { request: new Request(url, { method: 'POST', body: fd }), url: new URL(url), platform: { env: platformEnv() }, locals: { user } } as any;
		};
		await savePublicHost(db, PUB);
		expect(((await settingsActions.setPublicRedirect(ev({ id: 2, role: 'member' }, { on: '1' }))) as any).status).toBe(403);
		expect(((await settingsActions.setPublicRedirect(ev({ id: 1, role: 'admin' }, { on: '1' }))) as any).status).toBe(400);
		expect((await readArchivePublicConfig(db)).redirect).toBe(false);
	});
});

describe('Settings → Domain redirect never redirects the public host', () => {
	it('redirectTarget skips the archive host', async () => {
		const cfg = { domain: 'crm.example.com', redirect: true, status: null };
		expect(redirectTarget(new URL(`https://${PUB}/newsletter`), 'GET', cfg, { archiveHost: PUB })).toBeNull();
		expect(redirectTarget(new URL(`https://old.workers.dev/newsletter`), 'GET', cfg, { archiveHost: PUB })).toBe('https://crm.example.com/newsletter');
	});

	it('through hooks, with both redirects on', async () => {
		await saveCustomDomain(db, 'crm.example.com');
		await put('custom_domain_redirect', '1');
		clearDomainCache();
		await savePublicHost(db, PUB);
		const r = await hit(`https://${PUB}/newsletter`);
		expect(r.status).toBe(200);
	});
});

describe('host validation', () => {
	it('a bare hostname that differs from the CRM host', () => {
		expect(validatePublicHost('Ourco.example', [CRM])).toEqual({ ok: true, hostname: PUB });
		expect(validatePublicHost('https://ourco.example', [CRM]).ok).toBe(false);
		expect(validatePublicHost(CRM_HOST, [CRM]).ok).toBe(false);
	});
});

describe('Test connection', () => {
	it('pass = 200 + X-Archive-Source: crm; stored with the host', async () => {
		let called = '';
		let init: RequestInit | undefined;
		const fetcher = (async (url: string, i?: RequestInit) => {
			called = url;
			init = i;
			return new Response('<rss/>', { status: 200, headers: { [SOURCE_HEADER]: 'crm' } });
		}) as unknown as typeof fetch;
		const s = await testPublicConnection(db, PUB, fetcher);
		expect(called).toMatch(new RegExp(`^https://${PUB}/newsletter/feed\\.xml\\?t=\\d+$`));
		expect(init?.redirect).toBe('manual');
		expect(init?.cache).toBe('no-store');
		expect(s).toMatchObject({ ok: true, code: 200, host: PUB });
		expect((await readArchivePublicConfig(db)).status).toMatchObject({ ok: true, host: PUB });
	});

	it('fail: 200 without the header (WordPress), a redirect, or a network error', async () => {
		const answer = (res: Response | Error) => (async () => {
			if (res instanceof Error) throw res;
			return res;
		}) as unknown as typeof fetch;
		expect((await testPublicConnection(db, PUB, answer(new Response('ok', { status: 200 })))).ok).toBe(false);
		expect((await testPublicConnection(db, PUB, answer(new Response(null, { status: 301, headers: { location: '/journal/' } })))).ok).toBe(false);
		const err = await testPublicConnection(db, PUB, answer(new Error('boom')));
		expect(err).toMatchObject({ ok: false, code: null, error: 'boom' });
	});

	it('#495: a stale 404 then a 200 on the same feed passes on the second run, cache-busted each time', async () => {
		const urls: string[] = [];
		const answers = [
			new Response('Not found', { status: 404 }),
			new Response('<rss/>', { status: 200, headers: { [SOURCE_HEADER]: 'crm' } })
		];
		const fetcher = (async (url: string) => {
			urls.push(url);
			return answers.shift()!;
		}) as unknown as typeof fetch;
		const first = await testPublicConnection(db, PUB, fetcher, new Date('2026-11-03T02:01:00Z'));
		expect(first).toMatchObject({ ok: false, code: 404 });
		const second = await testPublicConnection(db, PUB, fetcher, new Date('2026-11-03T02:01:05Z'));
		expect(second).toMatchObject({ ok: true, code: 200, host: PUB });
		expect((await readArchivePublicConfig(db)).status).toMatchObject({ ok: true, host: PUB });
		expect(urls[0]).not.toBe(urls[1]);
	});

	it('#495: the blocked 404 carries Cache-Control: no-store', async () => {
		const res = await hit(`https://${PUB}/newsletter/feed.xml`);
		expect(res.status).toBe(404);
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('the feed answers with X-Archive-Source only in public mode', async () => {
		await seed();
		await savePublicHost(db, PUB);
		expect((await hit(`https://${PUB}/newsletter/feed.xml`, feedGET)).headers.get(SOURCE_HEADER)).toBe('crm');
		expect((await hit(`${CRM}/newsletter/feed.xml`, feedGET)).headers.get(SOURCE_HEADER)).toBeNull();
	});
});
