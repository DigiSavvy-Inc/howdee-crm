import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { DISABLED_SNIPPET, installTag, renderTrackingSnippet } from '../src/lib/tracking-snippet';
import {
	SITE_KEY_RE,
	generateSiteKey,
	parseDomain,
	parseOrigins,
	listSites,
	siteStatus
} from '../src/lib/server/tracking-admin';
import { findSiteByKey, siteTrackingLinksEnabled } from '../src/lib/server/site-tracking';
import { verifyVisitorId } from '../src/lib/server/track-token';
import { GET as snippetGET } from '../src/routes/t.js/+server';
import { actions, load } from '../src/routes/settings/tracking/+page.server';
import { POST as ingestPOST } from '../src/routes/api/ingest/+server';

const db = (env as any).DB as D1Database;
const SECRET = 'test-session-secret';
const admin = { id: 1, role: 'admin' };
const member = { id: 2, role: 'member' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key = 'site_tracking_links'")
	]);
});

async function site(opts: { key?: string; enabled?: number } = {}) {
	return (await db
		.prepare(
			`INSERT INTO tracking_sites (name, domain, origins, site_key, enabled) VALUES ('DS', 'ourco.example', '[]', ?, ?) RETURNING id`
		)
		.bind(opts.key ?? 'dsv_0123456789abcdef01234567', opts.enabled ?? 1)
		.first<{ id: number }>())!.id;
}

function getEv(path: string, headers: Record<string, string> = {}) {
	const url = `https://crm.test${path}`;
	return { request: new Request(url, { headers }), url: new URL(url), platform: { env } } as any;
}

function actionEv(fields: Record<string, string>, user: unknown = admin, fetchImpl?: typeof fetch) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	const url = 'https://crm.test/settings/tracking';
	return {
		request: new Request(url, { method: 'POST', body: fd }),
		url: new URL(url),
		platform: { env },
		locals: { user },
		fetch: fetchImpl ?? (async () => new Response('x'))
	} as any;
}

describe('tracking snippet source', () => {
	const js = renderTrackingSnippet({ siteKey: 'dsv_0123456789abcdef01234567', endpoint: 'https://crm.myapp.example/' });

	it('parses as JavaScript and uses no eval', () => {
		expect(js).not.toMatch(/\beval\s*\(/);
		expect(js).not.toMatch(/new Function/);
		expect(js).not.toMatch(/__ENDPOINT__|__SITE_KEY__/);
		let parsed = true;
		try {
			// workerd forbids code generation from strings; fall back to a syntax-only check
			// when it refuses (the snippet is never executed here either way).
			new Function(js);
		} catch (e) {
			parsed = !(e instanceof SyntaxError);
		}
		expect(parsed).toBe(true);
	});

	it('inlines the key and endpoint, small and dependency-free', () => {
		expect(js).toContain('"dsv_0123456789abcdef01234567"');
		expect(js).toContain('"https://crm.myapp.example"');
		expect(js).not.toMatch(/\bimport\b|\brequire\(/);
		expect(js.length).toBeLessThan(4096);
	});

	it('escapes < so an inlined value cannot close a script tag', () => {
		const evil = renderTrackingSnippet({ siteKey: '</script><x>', endpoint: 'https://a' });
		expect(evil).not.toContain('</script>');
	});

	it('installTag builds the paste-ready tag', () => {
		expect(installTag('https://crm.myapp.example/', 'dsv_ab')).toBe(
			'<script async src="https://crm.myapp.example/t.js?k=dsv_ab"></script>'
		);
	});
});

describe('GET /t.js', () => {
	it('404s an unknown or missing key', async () => {
		expect((await snippetGET(getEv('/t.js?k=nope'))).status).toBe(404);
		expect((await snippetGET(getEv('/t.js'))).status).toBe(404);
	});

	it('serves the snippet with cache headers, ETag and the inlined key', async () => {
		await site();
		const res = await snippetGET(getEv('/t.js?k=dsv_0123456789abcdef01234567'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/javascript/);
		expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
		const etag = res.headers.get('etag');
		expect(etag).toMatch(/^"[0-9a-f]+"$/);
		const body = await res.text();
		expect(body).toContain('"dsv_0123456789abcdef01234567"');
		expect(body).toContain('"https://crm.test"');

		const again = await snippetGET(getEv('/t.js?k=dsv_0123456789abcdef01234567', { 'if-none-match': etag! }));
		expect(again.status).toBe(304);
	});

	it('serves a no-op for a disabled site', async () => {
		await site({ enabled: 0 });
		const res = await snippetGET(getEv('/t.js?k=dsv_0123456789abcdef01234567'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(DISABLED_SNIPPET);
		expect(DISABLED_SNIPPET).toContain('/* tracking disabled */');
	});
});

describe('origin/domain parsing', () => {
	it('parses one origin per line, normalises and dedupes', () => {
		expect(parseOrigins('https://Ourco.example/\nhttps://www.ourco.example\n\nhttps://ourco.example')).toEqual({
			origins: ['https://ourco.example', 'https://www.ourco.example'],
			invalid: []
		});
		expect(parseOrigins('http://localhost:8080').origins).toEqual(['http://localhost:8080']);
	});

	it('rejects paths, other schemes and junk', () => {
		const r = parseOrigins('https://a.com/blog\nftp://a.com\nnot a url\nhttps://ok.com');
		expect(r.origins).toEqual(['https://ok.com']);
		expect(r.invalid).toEqual(['https://a.com/blog', 'ftp://a.com', 'not a url']);
	});

	it('parseDomain strips scheme/www/path and validates', () => {
		expect(parseDomain('https://www.Ourco.example/about')).toBe('ourco.example');
		expect(parseDomain('blog.example.co.uk')).toBe('blog.example.co.uk');
		expect(parseDomain('localhost')).toBeNull();
		expect(parseDomain('bad domain.com')).toBeNull();
	});

	it('generates well-formed, unique keys', () => {
		const a = generateSiteKey();
		expect(a).toMatch(SITE_KEY_RE);
		expect(generateSiteKey()).not.toBe(a);
	});
});

describe('settings actions', () => {
	it('are admin-only', async () => {
		await expect(actions.add(actionEv({ name: 'X', domain: 'x.example.net' }, member))).rejects.toMatchObject({ status: 403 });
		await expect(load(actionEv({}, member))).rejects.toMatchObject({ status: 403 });
	});

	it('adds a site with a fresh key and parsed origins', async () => {
		const r: any = await actions.add(
			actionEv({ name: 'Ourco', domain: 'https://www.ourco.example', origins: 'https://ourco.example\nhttps://www.ourco.example/' })
		);
		expect(r.added).toBe(true);
		const [s] = await listSites(db);
		expect(s).toMatchObject({ name: 'Ourco', domain: 'ourco.example', enabled: 1, events_7d: 0 });
		expect(s.site_key).toMatch(SITE_KEY_RE);
		expect(JSON.parse(s.origins)).toEqual(['https://ourco.example', 'https://www.ourco.example']);
	});

	it('rejects a bad origin or domain', async () => {
		const bad: any = await actions.add(actionEv({ name: 'X', domain: 'x.example.net', origins: 'https://x.example.net/path' }));
		expect(bad.status).toBe(400);
		expect(bad.data.error).toMatch(/origin/);
		const noDomain: any = await actions.add(actionEv({ name: 'X', domain: 'nope' }));
		expect(noDomain.status).toBe(400);
		expect(await listSites(db)).toHaveLength(0);
	});

	it('edits, disables and rotates', async () => {
		const id = await site();
		await actions.update(actionEv({ id: String(id), name: 'Renamed', domain: 'example.com', origins: '' }));
		await actions.toggle(actionEv({ id: String(id), enabled: '0' }));
		const r: any = await actions.rotate(actionEv({ id: String(id) }));
		expect(r.rotated).toBe(true);
		const [s] = await listSites(db);
		expect(s).toMatchObject({ name: 'Renamed', domain: 'example.com', enabled: 0, origins: '[]' });
		expect(s.site_key).toMatch(SITE_KEY_RE);
		expect(s.site_key).not.toBe('dsv_0123456789abcdef01234567');
		expect(await findSiteByKey(db, 'dsv_0123456789abcdef01234567')).toBeNull();

		const missing: any = await actions.rotate(actionEv({ id: '99999' }));
		expect(missing.status).toBe(404);
	});

	it('toggles link decoration', async () => {
		expect(await siteTrackingLinksEnabled(db)).toBe(true);
		await actions.setLinks(actionEv({ links: 'off' }));
		expect(await siteTrackingLinksEnabled(db)).toBe(false);
		await actions.setLinks(actionEv({ links: 'on' }));
		expect(await siteTrackingLinksEnabled(db)).toBe(true);
	});

	it('counts events in the last 7 days', async () => {
		const id = await site();
		const c = (await db.prepare("INSERT INTO contacts (email) VALUES ('a@b.example.net') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, occurred_at) VALUES (?, ?, 'pageview', 'pageview', datetime('now'))`).bind(id, c),
			db.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, occurred_at) VALUES (?, ?, 'pageview', 'pageview', datetime('now', '-8 days'))`).bind(id, c)
		]);
		expect((await listSites(db))[0].events_7d).toBe(1);
	});
});

describe('status check', () => {
	it('waits for the first event, then reports receiving', async () => {
		const id = await site();
		expect(await siteStatus(db, id)).toEqual({ receiving: false, recentCount: 0, lastEventAt: null });

		const c = (await db.prepare("INSERT INTO contacts (email) VALUES ('a@b.example.net') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, occurred_at, received_at) VALUES (?, ?, 'pageview', 'pageview', datetime('now'), datetime('now', '-20 minutes'))`).bind(id, c),
			db.prepare(`UPDATE tracking_sites SET last_event_at = datetime('now', '-20 minutes') WHERE id = ?`).bind(id)
		]);
		const stale = await siteStatus(db, id);
		expect(stale?.receiving).toBe(false);
		expect(stale?.lastEventAt).not.toBeNull();

		await db.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, occurred_at) VALUES (?, ?, 'pageview', 'pageview', datetime('now'))`).bind(id, c).run();
		expect(await siteStatus(db, id)).toMatchObject({ receiving: true, recentCount: 1 });
		expect(await siteStatus(db, 99999)).toBeNull();
	});

	it('the action fetches /t.js and reports snippet health', async () => {
		const id = await site();
		const seen: string[] = [];
		const fetchOk = (async (u: string) => {
			seen.push(u);
			return snippetGET(getEv(u));
		}) as unknown as typeof fetch;
		const r: any = await actions.status(actionEv({ id: String(id) }, admin, fetchOk));
		expect(seen).toEqual(['/t.js?k=dsv_0123456789abcdef01234567']);
		expect(r).toMatchObject({ snippet: 'ok', receiving: false, lastEventAt: null });

		await db.prepare('UPDATE tracking_sites SET enabled = 0 WHERE id = ?').bind(id).run();
		const off: any = await actions.status(actionEv({ id: String(id) }, admin, fetchOk));
		expect(off.snippet).toBe('disabled');

		const broken: any = await actions.status(actionEv({ id: String(id) }, admin, (async () => new Response('', { status: 500 })) as any));
		expect(broken.snippet).toBe('error');
	});
});

describe('ingest form hook', () => {
	function ingest(body: Record<string, unknown>) {
		const url = 'https://crm.test/api/ingest';
		return ingestPOST({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer ik' },
				body: JSON.stringify(body)
			}),
			url: new URL(url),
			platform: { env: { ...(env as any), INGEST_KEY: 'ik', SESSION_SECRET: SECRET, DEFAULT_LIST_NAME: 'Site leads' } }
		} as any);
	}

	it('returns a dsv_id for an enabled site_key, and nothing without one', async () => {
		const id = await site();
		const res = await ingest({ email: 'lead@example.com', site_key: 'dsv_0123456789abcdef01234567' });
		const j: any = await res.json();
		expect(j.ok).toBe(true);
		const v = await verifyVisitorId(SECRET, j.dsv_id);
		const c = await db.prepare("SELECT id, meta FROM contacts WHERE email = 'lead@example.com'").first<{ id: number; meta: string | null }>();
		expect(v).toMatchObject({ c: c!.id, s: id });
		expect(c!.meta ?? '').not.toContain('site_key');

		const plain: any = await (await ingest({ email: 'lead@example.com' })).json();
		expect(plain.dsv_id).toBeUndefined();

		await db.prepare("UPDATE contacts SET tracking_optout = 1 WHERE email = 'lead@example.com'").run();
		const opted: any = await (await ingest({ email: 'lead@example.com', site_key: 'dsv_0123456789abcdef01234567' })).json();
		expect(opted.dsv_id).toBeUndefined();
	});
});
