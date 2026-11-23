import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	signVisitorToken,
	verifyVisitorToken,
	signVisitorId,
	verifyVisitorId,
	VISITOR_TOKEN_TTL_SECONDS
} from '../src/lib/server/track-token';
import {
	decorateLinks,
	linkMatcherFor,
	loadLinkMatcher,
	pruneSiteEvents,
	resetRateLimits,
	sanitizeBeacon,
	takeRateToken,
	RATE_PER_MINUTE
} from '../src/lib/server/site-tracking';
import { sendCampaignEmail } from '../src/lib/server/send';
import { deleteContactsByIds } from '../src/lib/server/contacts';
import { POST as trackPOST, OPTIONS as trackOPTIONS } from '../src/routes/api/track/+server';
import { POST as identifyPOST } from '../src/routes/api/track/identify/+server';

const db = (env as any).DB as D1Database;
const SECRET = 'test-session-secret';
const ORIGIN = 'https://ourco.example';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const testEnv = { ...(env as any), SESSION_SECRET: SECRET };

let siteId: number;
let contactId: number;

beforeEach(async () => {
	resetRateLimits();
	await db.batch([
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key IN ('site_tracking_links', 'site_events_prune_at')")
	]);
	siteId = (await db
		.prepare(
			`INSERT INTO tracking_sites (name, domain, origins, site_key) VALUES ('DS', 'ourco.example', ?, 'sk_test') RETURNING id`
		)
		.bind(JSON.stringify([ORIGIN, 'https://www.ourco.example']))
		.first<{ id: number }>())!.id;
	contactId = (await db.prepare("INSERT INTO contacts (email) VALUES ('v@x.example.net') RETURNING id").first<{ id: number }>())!.id;
});

afterEach(() => vi.restoreAllMocks());

function ev(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
	const url = `https://app.test${path}`;
	return {
		request: new Request(url, {
			method,
			headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': UA, ...headers },
			body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
		}),
		platform: { env: testEnv },
		url: new URL(url)
	} as any;
}

async function visitorId(c = contactId, s = siteId) {
	return signVisitorId(SECRET, { c, s });
}

async function rows() {
	return (await db.prepare('SELECT * FROM site_events ORDER BY id').all<any>()).results;
}

describe('visitor token', () => {
	it('round-trips, is short, and rejects tampering/other secrets', async () => {
		const t = await signVisitorToken(SECRET, { c: 12345 });
		expect(t.length).toBeLessThanOrEqual(60);
		expect(t).toMatch(/^[0-9a-z]+\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
		expect((await verifyVisitorToken(SECRET, t))?.c).toBe(12345);
		expect(await verifyVisitorToken('other', t)).toBeNull();
		expect(await verifyVisitorToken(SECRET, t.replace(/^[0-9a-z]+/, 'zz'))).toBeNull();
		expect(await verifyVisitorToken(SECRET, 'garbage')).toBeNull();
	});

	it('expires after 30 days', async () => {
		const now = Math.floor(Date.now() / 1000);
		const t = await signVisitorToken(SECRET, { c: 1 });
		expect(await verifyVisitorToken(SECRET, t, now + VISITOR_TOKEN_TTL_SECONDS - 60)).not.toBeNull();
		expect(await verifyVisitorToken(SECRET, t, now + VISITOR_TOKEN_TTL_SECONDS + 60)).toBeNull();
	});

	it('a link token is not a visitor id (domain separation)', async () => {
		const id = await signVisitorId(SECRET, { c: 1, s: 2 });
		expect((await verifyVisitorId(SECRET, id))?.s).toBe(2);
		expect(await verifyVisitorToken(SECRET, id)).toBeNull();
		const old = await signVisitorId(SECRET, { c: 1, s: 2, iat: Math.floor(Date.now() / 1000) - 181 * 86400 });
		expect(await verifyVisitorId(SECRET, old)).toBeNull();
	});
});

describe('decorateLinks', () => {
	const m = linkMatcherFor([{ domain: 'ourco.example', origins: '["https://shop.example.org"]' }])!;
	const d = (html: string) => decorateLinks(html, m, 'TOK', 'crm.myapp.example');

	it('adds to matching hosts only, keeping query and hash', () => {
		expect(d('<a href="https://ourco.example/x">')).toBe('<a href="https://ourco.example/x?dsv=TOK">');
		expect(d('<a href="https://www.ourco.example/x?a=1&amp;b=2#top">')).toBe(
			'<a href="https://www.ourco.example/x?a=1&amp;b=2&amp;dsv=TOK#top">'
		);
		expect(d("<a href='https://blog.ourco.example/?a=1#h'>")).toBe("<a href='https://blog.ourco.example/?a=1&dsv=TOK#h'>");
		expect(d('<a href="https://ourco.example/x?">')).toBe('<a href="https://ourco.example/x?dsv=TOK">');
		expect(d('<a href="https://shop.example.org/p">')).toBe('<a href="https://shop.example.org/p?dsv=TOK">');
		expect(d('<a HREF = " https://ourco.example " >')).toBe('<a HREF = "https://ourco.example?dsv=TOK" >');
	});

	it('leaves other hosts, mailto, unsubscribe, hosted pages and relative links alone', () => {
		const untouched = [
			'<a href="https://notourco.example/">',
			'<a href="https://ourco.example.evil.io/">',
			'<a href="https://example.org/">',
			'<a href="mailto:alan@ourco.example">',
			'<a href="https://crm.myapp.example/unsubscribe?t=abc">',
			'<a href="https://crm.myapp.example/p/landing">',
			'<a href="https://ourco.example/unsubscribe?x=1">',
			'<a href="/relative">',
			'<a href="#anchor">',
			'<a href="https://ourco.example/x?dsv=already">',
			'<a href="tel:+15555555555">'
		];
		for (const h of untouched) expect(d(h)).toBe(h);
	});
});

describe('link decoration in the send path', () => {
	function capture() {
		const sent: any[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			const msgs = JSON.parse(String((init as RequestInit).body));
			sent.push(...msgs);
			return new Response(JSON.stringify(msgs.map(() => ({ ErrorCode: 0, MessageID: crypto.randomUUID() }))));
		});
		return sent;
	}
	async function send() {
		const camp = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email) VALUES ('s','m','h','f@x.example.net') RETURNING id")
			.first<{ id: number }>())!.id;
		await sendCampaignEmail(db, {
			token: 't',
			secret: SECRET,
			baseUrl: 'https://crm.myapp.example',
			campaignId: camp,
			recipients: [{ id: contactId, email: 'v@x.example.net', name: null, first_name: null, last_name: null }],
			subject: 'Hi',
			htmlTemplate: '<a href="https://ourco.example/pricing">p</a> <a href="%%UNSUB_URL%%">u</a>',
			textTemplate: 'https://ourco.example/pricing %%UNSUB_URL%%',
			from: 'f@x.example.net',
			stream: 'broadcast'
		});
	}

	it('decorates matching hrefs with a token for the recipient', async () => {
		const sent = capture();
		await send();
		const m = /https:\/\/ourco\.example\/pricing\?dsv=([^"]+)"/.exec(sent[0].HtmlBody);
		expect(m).not.toBeNull();
		expect((await verifyVisitorToken(SECRET, decodeURIComponent(m![1])))?.c).toBe(contactId);
		expect(sent[0].HtmlBody).toMatch(/href="https:\/\/crm\.myapp\.example\/unsubscribe\?t=[^"]+"/);
		expect(sent[0].HtmlBody).not.toMatch(/unsubscribe[^"]*dsv=/);
	});

	it('respects the Settings toggle and disabled sites', async () => {
		await db.prepare("INSERT INTO app_state (key, value) VALUES ('site_tracking_links', 'off')").run();
		expect(await loadLinkMatcher(db)).toBeNull();
		const sent = capture();
		await send();
		expect(sent[0].HtmlBody).not.toContain('dsv=');

		await db.prepare("DELETE FROM app_state WHERE key = 'site_tracking_links'").run();
		await db.prepare('UPDATE tracking_sites SET enabled = 0').run();
		expect(await loadLinkMatcher(db)).toBeNull();
	});
});

describe('POST /api/track/identify', () => {
	it('rejects a bad key, bad origin, or bad token', async () => {
		const token = await signVisitorToken(SECRET, { c: contactId });
		expect((await identifyPOST(ev('/api/track/identify', { site_key: 'nope', token }))).status).toBe(404);
		expect(
			(await identifyPOST(ev('/api/track/identify', { site_key: 'sk_test', token }, { origin: 'https://evil.io' }))).status
		).toBe(403);
		expect((await identifyPOST(ev('/api/track/identify', { site_key: 'sk_test', token: 'x.y.z' }))).status).toBe(401);
		expect((await identifyPOST(ev('/api/track/identify', 'not json'))).status).toBe(400);
		const gone = await signVisitorToken(SECRET, { c: contactId + 999 });
		expect((await identifyPOST(ev('/api/track/identify', { site_key: 'sk_test', token: gone }))).status).toBe(401);
	});

	it('returns a signed visitor id bound to the site, with CORS for the origin', async () => {
		const token = await signVisitorToken(SECRET, { c: contactId });
		const res = await identifyPOST(ev('/api/track/identify', { site_key: 'sk_test', token }));
		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		const { id } = (await res.json()) as { id: string };
		expect(await verifyVisitorId(SECRET, id)).toMatchObject({ c: contactId, s: siteId });
	});

	it('issues no id for DNT or an opted-out contact', async () => {
		const token = await signVisitorToken(SECRET, { c: contactId });
		expect((await identifyPOST(ev('/api/track/identify', { site_key: 'sk_test', token }, { dnt: '1' }))).status).toBe(204);
		await db.prepare('UPDATE contacts SET tracking_optout = 1 WHERE id = ?').bind(contactId).run();
		expect((await identifyPOST(ev('/api/track/identify', { site_key: 'sk_test', token }))).status).toBe(204);
	});
});

describe('POST /api/track', () => {
	const base = { site_key: 'sk_test', kind: 'pageview', path: '/pricing', title: 'Pricing' };

	it('rejects a bad key or origin', async () => {
		const id = await visitorId();
		expect((await trackPOST(ev('/api/track', { ...base, id, site_key: 'x' }))).status).toBe(404);
		expect((await trackPOST(ev('/api/track', { ...base, id }, { origin: 'https://evil.io' }))).status).toBe(403);
		expect((await trackPOST(ev('/api/track', { ...base, id }, { origin: '' }))).status).toBe(403);
	});

	it('drops: no id, foreign-site id, opt-out, DNT, GPC, bot UA, prefetch', async () => {
		const id = await visitorId();
		const cases: [Record<string, unknown>, Record<string, string>][] = [
			[{ ...base }, {}],
			[{ ...base, id: 'bogus' }, {}],
			[{ ...base, id: await visitorId(contactId, siteId + 1) }, {}],
			[{ ...base, id }, { dnt: '1' }],
			[{ ...base, id }, { 'sec-gpc': '1' }],
			[{ ...base, id }, { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }],
			[{ ...base, id }, { 'user-agent': '' }],
			[{ ...base, id }, { 'sec-purpose': 'prefetch;prerender' }],
			[{ ...base, id }, { purpose: 'prefetch' }]
		];
		for (const [body, headers] of cases) {
			const res = await trackPOST(ev('/api/track', body, headers));
			expect(res.status).toBe(204);
		}
		await db.prepare('UPDATE contacts SET tracking_optout = 1 WHERE id = ?').bind(contactId).run();
		expect((await trackPOST(ev('/api/track', { ...base, id }))).status).toBe(204);
		expect(await rows()).toHaveLength(0);
	});

	it('stores a pageview: query stripped, UTM allowlist only, id via header, marks dirty', async () => {
		const id = await visitorId();
		const res = await trackPOST(
			ev(
				'/api/track',
				{
					...base,
					path: '/pricing?utm_source=news&utm_medium=email&gclid=SECRET&email=v@x.example.net#plans',
					referrer: 'https://www.google.com/search?q=private',
					utm: { campaign: 'oct', evil: 'x', utm_term: 'seo' },
					props: { ignored: true }
				},
				{ 'x-dsv-id': id, 'cf-ipcountry': 'us' }
			)
		);
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		const [r] = await rows();
		expect(r).toMatchObject({
			site_id: siteId,
			contact_id: contactId,
			kind: 'pageview',
			name: 'pageview',
			path: '/pricing',
			title: 'Pricing',
			referrer_host: 'www.google.com',
			props: null,
			country: 'US'
		});
		expect(JSON.parse(r.utm)).toEqual({ source: 'news', medium: 'email', campaign: 'oct', term: 'seo' });
		const site = await db.prepare('SELECT last_event_at FROM tracking_sites WHERE id = ?').bind(siteId).first<any>();
		expect(site.last_event_at).not.toBeNull();
		const eng = await db.prepare('SELECT dirty FROM contact_engagement WHERE contact_id = ?').bind(contactId).first<any>();
		expect(eng?.dirty).toBe(1);
	});

	it('stores custom events with props ≤ 2 KB', async () => {
		const id = await visitorId();
		await trackPOST(ev('/api/track', { site_key: 'sk_test', id, kind: 'event', name: 'signup', path: '/', props: { plan: 'pro' } }));
		await trackPOST(
			ev('/api/track', { site_key: 'sk_test', id, kind: 'event', name: 'big', path: '/', props: { x: 'y'.repeat(3000) } })
		);
		await trackPOST(ev('/api/track', { site_key: 'sk_test', id, kind: 'event', path: '/' })); // no name → dropped
		const r = await rows();
		expect(r.map((x: any) => [x.name, x.props])).toEqual([
			['signup', '{"plan":"pro"}'],
			['big', null]
		]);
	});

	it('coalesces duplicate pageviews within 10 s', async () => {
		const id = await visitorId();
		const now = Date.now();
		await trackPOST(ev('/api/track', { ...base, id, ts: now - 20_000 }));
		await trackPOST(ev('/api/track', { ...base, id, ts: now - 15_000 }));
		await trackPOST(ev('/api/track', { ...base, id, ts: now }));
		await trackPOST(ev('/api/track', { ...base, id, path: '/other', ts: now }));
		expect((await rows()).map((x: any) => x.path)).toEqual(['/pricing', '/pricing', '/other']);
	});

	it('answers a CORS preflight only for an allowlisted origin', async () => {
		const ok = await trackOPTIONS(ev('/api/track', null, {}, 'OPTIONS'));
		expect(ok.status).toBe(204);
		expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(ok.headers.get('access-control-allow-headers')).toContain('content-type');
		const bad = await trackOPTIONS(ev('/api/track', null, { origin: 'https://evil.io' }, 'OPTIONS'));
		expect(bad.status).toBe(403);
		expect(bad.headers.get('access-control-allow-origin')).toBeNull();
	});
});

describe('sanitizeBeacon + rate limit', () => {
	it('caps lengths and rejects unknown kinds', () => {
		const s = sanitizeBeacon({ kind: 'pageview', path: '/' + 'a'.repeat(900), title: 't'.repeat(500) })!;
		expect(s.path!.length).toBe(500);
		expect(s.title!.length).toBe(200);
		expect(sanitizeBeacon({ kind: 'click' })).toBeNull();
	});

	it('allows 600 per minute per site key, then refills', () => {
		const t0 = 1_000_000;
		for (let i = 0; i < RATE_PER_MINUTE; i++) expect(takeRateToken('k', t0)).toBe(true);
		expect(takeRateToken('k', t0)).toBe(false);
		expect(takeRateToken('other', t0)).toBe(true);
		expect(takeRateToken('k', t0 + 1000)).toBe(true);
	});
});

describe('housekeeping', () => {
	async function seed(n: number, occurred: string, cid = contactId) {
		const stmt = db.prepare(
			`INSERT INTO site_events (site_id, contact_id, kind, name, path, occurred_at) VALUES (?, ?, 'pageview', 'pageview', '/', ?)`
		);
		const all = Array.from({ length: n }, () => stmt.bind(siteId, cid, occurred));
		for (let i = 0; i < all.length; i += 100) await db.batch(all.slice(i, i + 100));
	}

	it('prunes rows older than 180 days in batches, then sleeps 24 h', async () => {
		const now = new Date('2026-10-06T12:00:00Z');
		await seed(5, '2026-01-01 00:00:00');
		await seed(2, '2026-10-01 00:00:00');
		const first = await pruneSiteEvents(db, { now, batch: 3 });
		expect(first).toMatchObject({ ran: true, aged: 3, done: false });
		const second = await pruneSiteEvents(db, { now, batch: 3 });
		expect(second).toMatchObject({ ran: true, aged: 2, done: true });
		expect(await rows()).toHaveLength(2);
		expect((await pruneSiteEvents(db, { now })).ran).toBe(false);
	});

	it('caps each contact, deleting the oldest first', async () => {
		await seed(3, '2026-10-01 00:00:00');
		await seed(2, '2026-10-02 00:00:00');
		const r = await pruneSiteEvents(db, { now: new Date('2026-10-06T00:00:00Z'), perContactCap: 2, force: true });
		expect(r.capped).toBe(3);
		expect((await rows()).map((x: any) => x.occurred_at)).toEqual(['2026-10-02 00:00:00', '2026-10-02 00:00:00']);
	});

	it('cascades on contact delete', async () => {
		await seed(3, '2026-10-01 00:00:00');
		expect(await deleteContactsByIds(db, [contactId])).toBe(1);
		expect(await rows()).toHaveLength(0);
	});
});
