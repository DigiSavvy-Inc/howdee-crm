import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	addCrmTracking,
	newTrackId,
	signClickToken,
	signOpenToken,
	skipTracking,
	verifyClickToken,
	verifyOpenToken
} from '../src/lib/server/crm-tracking';
import { MAX_CRM_CLICKS_PER_HOUR, MAX_CRM_OPENS_PER_HOUR, recordCrmTrackingEvent } from '../src/lib/server/crm-tracking-events';
import { b64urlEncode, hmac, signUnsub } from '../src/lib/server/token';
import { load as unsubscribeLoad } from '../src/routes/unsubscribe/+page.server';
import { sendCampaignEmail } from '../src/lib/server/send';
import { getMailProvider, type MailProvider, type OutboundMessage } from '../src/lib/server/mail';
import { resolveMailCredentials, setTrackingMode } from '../src/lib/server/mail/config';
import { GET as openRoute } from '../src/routes/t/o/[token]/+server';
import { GET as clickRoute } from '../src/routes/t/c/[token]/+server';
import { POST as webhook } from '../src/routes/api/webhook/+server';
import { REDIRECT_EXEMPT } from '../src/lib/server/public-url';

// #701 (2/5 of #699): open and click tracking done by the CRM. Signed pixel + click links on the
// app's own address; the click route never redirects anywhere but the signed destination; the
// events written are the same rows (and the same scanner-click / unsubscribe-link rules) as the
// provider webhook's.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'test-secret-701';
const BASE = 'https://crm.myapp.example';
const KEY = 'test-key-701';

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contact_engagement'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key IN ('mail_settings', 'mail_settings_events')`)
	]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function trackedSend(email = 'reader@ourco.example'): Promise<{ trackId: string; recipientId: number; contactId: number; campaignId: number; mid: string }> {
	const contactId = (await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id').bind(email).first<{ id: number }>())!.id;
	const campaignId = (await db
		.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'news@ourco.example', 'sent') RETURNING id`)
		.first<{ id: number }>())!.id;
	const trackId = newTrackId();
	const mid = `msg-701-${trackId.slice(0, 8)}`;
	const recipientId = (await db
		.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status, track_id) VALUES (?, ?, ?, ?, 'accepted', ?) RETURNING id")
		.bind(campaignId, contactId, email, mid, trackId)
		.first<{ id: number }>())!.id;
	return { trackId, recipientId, contactId, campaignId, mid };
}

const routeEvent = (token: string, path: 'o' | 'c') => ({
	platform: { env: { ...env, SESSION_SECRET: SECRET }, cf: { country: 'NZ' } },
	params: { token },
	url: new URL(`${BASE}/t/${path}/${token}`),
	request: new Request(`${BASE}/t/${path}/${token}`, { headers: { 'user-agent': 'Mozilla/5.0 (Test) 701' } })
});

const eventsFor = (recipientId: number) =>
	db.prepare('SELECT type, detail, campaign_id, contact_id FROM events WHERE recipient_id = ? ORDER BY id').bind(recipientId).all<{ type: string; detail: string; campaign_id: number; contact_id: number }>();

describe('signing', () => {
	it('open tokens verify, and a changed id, signature or secret does not', async () => {
		const id = newTrackId();
		expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const t = await signOpenToken(SECRET, id);
		expect(await verifyOpenToken(SECRET, t)).toEqual({ trackId: id });
		expect(await verifyOpenToken('other-secret', t)).toBeNull();
		expect(await verifyOpenToken(SECRET, id)).toBeNull(); // unsigned
		const [tid, sig] = t.split('.');
		const flipped = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
		expect(await verifyOpenToken(SECRET, `${tid}.${flipped}`)).toBeNull();
		const otherId = newTrackId();
		expect(await verifyOpenToken(SECRET, `${otherId}.${sig}`)).toBeNull();
	});

	it('click tokens carry the destination; swapping it, cutting the token or dropping the signature fails', async () => {
		const id = newTrackId();
		const t = await signClickToken(SECRET, id, 'https://www.ourco.example/pricing?a=1&b=2');
		expect(await verifyClickToken(SECRET, t)).toEqual({ trackId: id, url: 'https://www.ourco.example/pricing?a=1&b=2' });

		const [tid, dest, sig] = t.split('.');
		const evil = btoa('https://evil.invalid/').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		expect(await verifyClickToken(SECRET, `${tid}.${evil}.${sig}`)).toBeNull();
		expect(await verifyClickToken(SECRET, `${tid}.${dest}`)).toBeNull();
		expect(await verifyClickToken(SECRET, `${tid}.${dest}.`)).toBeNull();
		expect(await verifyClickToken(SECRET, t.slice(0, -3))).toBeNull();
		expect(await verifyClickToken('other-secret', t)).toBeNull();
	});

	it('a signed non-http destination is still refused', async () => {
		const id = newTrackId();
		expect(await verifyClickToken(SECRET, await signClickToken(SECRET, id, 'javascript:alert(1)'))).toBeNull();
		expect(await verifyClickToken(SECRET, await signClickToken(SECRET, id, '//evil.invalid/'))).toBeNull();
		expect(await verifyClickToken(SECRET, await signClickToken(SECRET, id, 'https://user:pw@evil.invalid/'))).toBeNull();
	});
});

describe('rewriting the HTML', () => {
	const unsub = `${BASE}/unsubscribe?t=abc`;
	const html = `<html><body><p><a href="https://www.ourco.example/a?x=1&amp;y=2">A</a>
<a href='mailto:hi@ourco.example'>mail</a> <a href="#top">top</a> <a href="tel:123">call</a>
<a href="${unsub}">Unsubscribe</a> <a href="/relative">rel</a></p></body></html>`;

	it('rewrites http(s) links to signed click links and adds the pixel before </body>', async () => {
		const id = newTrackId();
		const out = await addCrmTracking(html, { base: BASE, secret: SECRET, trackId: id, links: true, opens: true });
		const m = /href="(https:\/\/crm\.myapp\.example\/t\/c\/[^"]+)"/.exec(out);
		expect(m).toBeTruthy();
		const token = m![1].split('/t/c/')[1];
		expect(await verifyClickToken(SECRET, token)).toEqual({ trackId: id, url: 'https://www.ourco.example/a?x=1&y=2' });
		expect(out).toContain(`href="${unsub}"`);
		expect(out).toContain("href='mailto:hi@ourco.example'");
		expect(out).toContain('href="#top"');
		expect(out).toContain('href="tel:123"');
		expect(out).toContain('href="/relative"');
		expect(out).toMatch(/<img src="https:\/\/crm\.myapp\.example\/t\/o\/[^"]+" width="1" height="1"[^>]*\/><\/body>/);
	});

	it('links only / opens only', async () => {
		const id = newTrackId();
		const linksOnly = await addCrmTracking(html, { base: BASE, secret: SECRET, trackId: id, links: true, opens: false });
		expect(linksOnly).toContain('/t/c/');
		expect(linksOnly).not.toContain('/t/o/');
		const opensOnly = await addCrmTracking(html, { base: BASE, secret: SECRET, trackId: id, links: false, opens: true });
		expect(opensOnly).not.toContain('/t/c/');
		expect(opensOnly).toContain('/t/o/');
	});

	it('rewrites only a real href attribute, never data-href and the like', async () => {
		const id = newTrackId();
		const src = '<a data-href="https://a.example/" href="https://b.example/">x</a> <a x-href="https://c.example/">y</a>';
		const out = await addCrmTracking(src, { base: BASE, secret: SECRET, trackId: id, links: true, opens: false });
		expect(out).toContain('data-href="https://a.example/"');
		expect(out).toContain('x-href="https://c.example/"');
		const m = /\shref="([^"]+)"/.exec(out);
		const token = m![1].split('/t/c/')[1];
		expect(await verifyClickToken(SECRET, token)).toEqual({ trackId: id, url: 'https://b.example/' });
		expect(out.match(/\/t\/c\//g)).toHaveLength(1);
	});

	it('signs the normalised destination: non-ASCII and inner newlines end up ASCII-safe', async () => {
		const id = newTrackId();
		const src = '<a href="https://www.ourco.example/caf\u00e9?q=\u00fc">x</a><a href="https://www.ourco.example/a\nb">y</a>';
		const out = await addCrmTracking(src, { base: BASE, secret: SECRET, trackId: id, links: true, opens: false });
		const urls: string[] = [];
		for (const m of out.matchAll(/href="[^"]*\/t\/c\/([^"]+)"/g)) urls.push((await verifyClickToken(SECRET, m[1]))!.url);
		expect(urls).toEqual(['https://www.ourco.example/caf%C3%A9?q=%C3%BC', 'https://www.ourco.example/ab']);
	});

	it('never tracks the unsubscribe or preference page, or an already tracked link', () => {
		expect(skipTracking(`${BASE}/unsubscribe?t=x`, BASE)).toBe(true);
		expect(skipTracking(`${BASE}/unsubscribe/one-click?t=x`, BASE)).toBe(true);
		expect(skipTracking(`${BASE}/t/c/abc`, BASE)).toBe(true);
		expect(skipTracking('https://www.ourco.example/{{field:x}}', BASE)).toBe(true);
		expect(skipTracking('https://www.ourco.example/', BASE)).toBe(false);
	});
});

describe('the click route', () => {
	it('records a click and redirects to the signed destination', async () => {
		const s = await trackedSend();
		const token = await signClickToken(SECRET, s.trackId, 'https://www.ourco.example/pricing');
		const res = await clickRoute(routeEvent(token, 'c') as never);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://www.ourco.example/pricing');
		const rows = (await eventsFor(s.recipientId)).results;
		expect(rows.map((r) => r.type)).toEqual(['click']);
		expect(rows[0].campaign_id).toBe(s.campaignId);
		expect(rows[0].contact_id).toBe(s.contactId);
		const detail = JSON.parse(rows[0].detail);
		expect(detail).toMatchObject({ RecordType: 'Click', OriginalLink: 'https://www.ourco.example/pricing', MessageID: s.mid, UserAgent: 'Mozilla/5.0 (Test) 701', Geo: { CountryISOCode: 'NZ' }, Source: 'crm' });
		expect(JSON.stringify(detail)).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no IP address
		const eng = await db.prepare('SELECT dirty FROM contact_engagement WHERE contact_id = ?').bind(s.contactId).first<{ dirty: number }>();
		expect(eng?.dirty).toBe(1);
	});

	it('a tampered or unsigned token is a 400 that redirects nowhere and records nothing', async () => {
		const s = await trackedSend();
		const token = await signClickToken(SECRET, s.trackId, 'https://www.ourco.example/pricing');
		const [tid, , sig] = token.split('.');
		const evil = btoa('https://evil.invalid/').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		for (const bad of [`${tid}.${evil}.${sig}`, `${tid}.${evil}`, 'nonsense', `${token}x`]) {
			const res = await clickRoute(routeEvent(bad, 'c') as never);
			expect(res.status).toBe(400);
			expect(res.headers.get('location')).toBeNull();
			expect(await res.text()).toContain("This link isn't valid");
		}
		expect((await eventsFor(s.recipientId)).results).toEqual([]);
	});

	it('a non-ASCII path, a non-ASCII host and an inner newline all redirect to an ASCII-safe Location', async () => {
		const s = await trackedSend();
		const cases: [string, string][] = [
			['https://www.ourco.example/caf\u00e9', 'https://www.ourco.example/caf%C3%A9'],
			['https://b\u00fccher.example/x', 'https://xn--bcher-kva.example/x'],
			['https://www.ourco.example/a\nb\tc', 'https://www.ourco.example/abc']
		];
		for (const [raw, expected] of cases) {
			const res = await clickRoute(routeEvent(await signClickToken(SECRET, s.trackId, raw), 'c') as never);
			expect(res.status).toBe(302);
			const loc = res.headers.get('location')!;
			expect(loc).toBe(expected);
			expect(loc).toMatch(/^[\x21-\x7e]+$/);
		}
	});

	it('a signed destination that does not round-trip (raw, un-normalised) is a 400 with no Location', async () => {
		const s = await trackedSend();
		const rawSigned = async (url: string) => {
			const body = `${s.trackId}.${b64urlEncode(new TextEncoder().encode(url))}`;
			return `${body}.${b64urlEncode((await hmac(SECRET, 'dsv-click:' + body)).slice(0, 16))}`;
		};
		for (const raw of ['https://www.ourco.example/caf\u00e9', 'https://www.ourco.example/a\nb', 'https://www.ourco.example']) {
			const res = await clickRoute(routeEvent(await rawSigned(raw), 'c') as never);
			expect(res.status).toBe(400);
			expect(res.headers.get('location')).toBeNull();
		}
		expect((await eventsFor(s.recipientId)).results).toEqual([]);
	});

	it(`stores at most ${MAX_CRM_CLICKS_PER_HOUR} clicks per message per hour; past that it still redirects and writes nothing`, async () => {
		const s = await trackedSend();
		const ins = db.prepare(
			"INSERT INTO events (campaign_id, recipient_id, contact_id, type, message_id, detail, recorded_at) VALUES (?, ?, ?, ?, ?, '{}', datetime('now', ?))"
		);
		// Old rows (2 h ago) don't count toward the cap.
		await db.batch(Array.from({ length: MAX_CRM_CLICKS_PER_HOUR }, () => ins.bind(s.campaignId, s.recipientId, s.contactId, 'click', s.mid, '-2 hours')));
		expect(await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'click', url: 'https://www.ourco.example/x' })).toEqual({ recorded: true });
		await db.batch(Array.from({ length: MAX_CRM_CLICKS_PER_HOUR - 1 }, (_, i) => ins.bind(s.campaignId, s.recipientId, s.contactId, i % 2 ? 'scanner_click' : 'click', s.mid, '-10 minutes')));
		const before = (await eventsFor(s.recipientId)).results.length;
		const res = await clickRoute(routeEvent(await signClickToken(SECRET, s.trackId, 'https://www.ourco.example/y'), 'c') as never);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://www.ourco.example/y');
		expect((await eventsFor(s.recipientId)).results).toHaveLength(before);
		expect(await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'click', url: 'https://www.ourco.example/z' })).toEqual({ recorded: false, capped: true });
	});

	it('a valid link whose send is gone still redirects, without an event', async () => {
		const token = await signClickToken(SECRET, newTrackId(), 'https://www.ourco.example/');
		const res = await clickRoute(routeEvent(token, 'c') as never);
		expect(res.status).toBe(302);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(0);
	});
});

describe('the open route', () => {
	it('answers a GIF, records an open with FirstOpen, and a 400 for a bad token', async () => {
		const s = await trackedSend();
		const res = await openRoute(routeEvent(await signOpenToken(SECRET, s.trackId), 'o') as never);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/gif');
		expect(res.headers.get('cache-control')).toContain('no-store');
		const rows = (await eventsFor(s.recipientId)).results;
		expect(rows.map((r) => r.type)).toEqual(['open']);
		expect(JSON.parse(rows[0].detail)).toMatchObject({ RecordType: 'Open', FirstOpen: true, MessageID: s.mid });

		await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'open', now: new Date(Date.now() + 5000) });
		const again = (await eventsFor(s.recipientId)).results;
		expect(again).toHaveLength(2);
		expect(JSON.parse(again[1].detail).FirstOpen).toBe(false);

		const bad = await openRoute(routeEvent(`${s.trackId}.AAAAAAAAAAAAAAAAAAAAAA`, 'o') as never);
		expect(bad.status).toBe(400);
		expect((await eventsFor(s.recipientId)).results).toHaveLength(2);
	});

	it(`stores at most ${MAX_CRM_OPENS_PER_HOUR} opens per message per hour; past that the GIF still answers and nothing is written`, async () => {
		const s = await trackedSend();
		const ins = db.prepare(
			"INSERT INTO events (campaign_id, recipient_id, contact_id, type, message_id, detail, recorded_at) VALUES (?, ?, ?, 'open', ?, '{}', datetime('now', '-5 minutes'))"
		);
		await db.batch(Array.from({ length: MAX_CRM_OPENS_PER_HOUR }, () => ins.bind(s.campaignId, s.recipientId, s.contactId, s.mid)));
		const res = await openRoute(routeEvent(await signOpenToken(SECRET, s.trackId), 'o') as never);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/gif');
		expect((await eventsFor(s.recipientId)).results).toHaveLength(MAX_CRM_OPENS_PER_HOUR);
		expect(await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'open' })).toEqual({ recorded: false, capped: true });
		// Clicks have their own cap.
		expect(await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'click', url: 'https://www.ourco.example/' })).toEqual({ recorded: true });
	});

	it('a reload in the same second is one event (dedupe)', async () => {
		const s = await trackedSend();
		const now = new Date('2026-11-24T10:00:00.100Z');
		expect(await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'open', now })).toEqual({ recorded: true });
		expect(await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'open', now: new Date('2026-11-24T10:00:00.900Z') })).toEqual({ recorded: false });
		expect((await eventsFor(s.recipientId)).results).toHaveLength(1);
	});
});

describe('the same rules as provider events', () => {
	it('a burst of clicks on 3 different links is reclassified as scanner clicks', async () => {
		const s = await trackedSend();
		for (const p of ['a', 'b', 'c']) {
			await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'click', url: `https://www.ourco.example/${p}` });
		}
		const types = (await eventsFor(s.recipientId)).results.map((r) => r.type);
		expect(types).toEqual(['scanner_click', 'scanner_click', 'scanner_click']);
	});

	it('a click on the unsubscribe link is stored as unsubscribe_click, never a click', async () => {
		const s = await trackedSend();
		await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'click', url: `${BASE}/unsubscribe?t=abc` });
		expect((await eventsFor(s.recipientId)).results.map((r) => r.type)).toEqual(['unsubscribe_click']);
	});

	const unsubPage = async (token: string, opts: { isDataRequest?: boolean; method?: string; db?: D1Database } = {}) =>
		unsubscribeLoad({
			url: new URL(`${BASE}/unsubscribe?t=${encodeURIComponent(token)}`),
			request: new Request(`${BASE}/unsubscribe?t=${encodeURIComponent(token)}`, { method: opts.method ?? 'GET', headers: { 'user-agent': 'Scanner/1.0 701' } }),
			platform: { env: { ...env, SESSION_SECRET: SECRET, ...(opts.db ? { DB: opts.db } : {}) }, cf: { country: 'NZ' } },
			isDataRequest: opts.isDataRequest ?? false,
			setHeaders: () => undefined
		} as never);

	it('a GET of the unsubscribe page for a CRM-tracked send is its unsubscribe_click, so the scanner rule fires', async () => {
		const s = await trackedSend();
		await recordCrmTrackingEvent(db, { trackId: s.trackId, type: 'click', url: 'https://www.ourco.example/a' });
		const token = await signUnsub(SECRET, { c: s.campaignId, k: s.contactId, e: 'reader@ourco.example' });
		const data = (await unsubPage(token)) as { invalid: boolean };
		expect(data.invalid).toBe(false);
		const rows = (await eventsFor(s.recipientId)).results;
		expect(rows.map((r) => r.type)).toEqual(['scanner_click', 'scanner_click']);
		const unsub = JSON.parse(rows[1].detail);
		expect(unsub).toMatchObject({ RecordType: 'Click', OriginalLink: `${BASE}/unsubscribe?t=`, Source: 'crm' });
		expect(rows[1].detail).not.toContain(token); // the token is never stored
		// Nobody is unsubscribed by a page view.
		const c = await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(s.contactId).first<{ subscribed: number }>();
		expect(c?.subscribed).toBe(1);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM unsubscribes').first<{ n: number }>())!.n).toBe(0);
	});

	it('a lone unsubscribe page view stays an unsubscribe_click (not a click, not a scanner)', async () => {
		const s = await trackedSend();
		await unsubPage(await signUnsub(SECRET, { c: s.campaignId, k: s.contactId, e: 'reader@ourco.example' }));
		expect((await eventsFor(s.recipientId)).results.map((r) => r.type)).toEqual(['unsubscribe_click']);
	});

	it('records nothing for a send without track_id, an ambiguous token (resend), a data reload or a HEAD', async () => {
		// Provider-tracked send: no track_id → nothing (default mode unchanged).
		const contactId = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('plain@ourco.example', 1) RETURNING id").first<{ id: number }>())!.id;
		const campaignId = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'news@ourco.example', 'sent') RETURNING id`)
			.first<{ id: number }>())!.id;
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'plain@ourco.example', 'msg-plain', 'accepted')").bind(campaignId, contactId).run();
		await unsubPage(await signUnsub(SECRET, { c: campaignId, k: contactId, e: 'plain@ourco.example' }));
		expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(0);

		// A resend to the same contact on the same campaign reuses the token: can't tell which mail.
		const s = await trackedSend();
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status, send_pass, track_id) VALUES (?, ?, 'reader@ourco.example', 'msg-resend', 'accepted', 'resend', ?)")
			.bind(s.campaignId, s.contactId, newTrackId())
			.run();
		const token = await signUnsub(SECRET, { c: s.campaignId, k: s.contactId, e: 'reader@ourco.example' });
		await unsubPage(token);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(0);

		// Unambiguous again, but a data reload (after a form action) or a HEAD records nothing.
		await db.prepare("DELETE FROM recipients WHERE message_id = 'msg-resend'").run();
		await unsubPage(token, { isDataRequest: true });
		await unsubPage(token, { method: 'HEAD' });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(0);
	});

	it('a failure while recording never breaks the unsubscribe page', async () => {
		const s = await trackedSend();
		const token = await signUnsub(SECRET, { c: s.campaignId, k: s.contactId, e: 'reader@ourco.example' });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		// A DB whose recipients lookup for the page view fails; everything else is the real one.
		const failing = {
			prepare(q: string) {
				if (q.includes('FROM recipients') && q.includes('LIMIT 2')) throw new Error('boom');
				return db.prepare(q);
			},
			async batch(statements: D1PreparedStatement[]) {
				return db.batch(statements);
			}
		} as unknown as D1Database;
		const data = (await unsubPage(token, { db: failing })) as { invalid: boolean; email?: string };
		expect(data.invalid).toBe(false);
		expect(data.email).toBe('reader@ourco.example');
		expect(logged.mock.calls.some((c) => String(c[0]).includes('unsubscribe page view tracking failed'))).toBe(true);
		expect((await eventsFor(s.recipientId)).results).toEqual([]);
	});

	it('the provider webhook ignores opens and clicks of a CRM-tracked send, but not its delivery', async () => {
		const s = await trackedSend();
		const hook = (payload: object) =>
			webhook({
				platform: { env: { ...env, WEBHOOK_KEY: KEY } },
				url: new URL(`${BASE}/api/webhook?key=${KEY}`),
				request: new Request(`${BASE}/api/webhook?key=${KEY}`, { method: 'POST', body: JSON.stringify(payload) })
			} as never);
		const open = await hook({ RecordType: 'Open', MessageID: s.mid, Recipient: 'reader@ourco.example', ReceivedAt: '2026-11-24T10:00:00Z' });
		expect(await open.json()).toEqual({ ignored: 'tracked by the CRM' });
		const delivery = await hook({ RecordType: 'Delivery', MessageID: s.mid, Recipient: 'reader@ourco.example', DeliveredAt: '2026-11-24T09:59:00Z' });
		expect(await delivery.json()).toEqual({ ok: true });
		expect((await eventsFor(s.recipientId)).results.map((r) => r.type)).toEqual(['delivery']);
	});
});

function fakeProvider(trackingBy?: 'provider' | 'crm') {
	const sent: OutboundMessage[] = [];
	const provider: MailProvider = {
		id: 'postmark',
		label: 'Fake',
		maxBatch: 50,
		streams: { broadcast: 'b', transactional: 't' },
		capabilities: { tracking: true, suppressions: 'none', webhooks: true, inbound: false, domainApi: false, streams: true },
		...(trackingBy ? { trackingBy } : {}),
		async sendBatch(messages) {
			const start = sent.length;
			sent.push(...messages);
			return messages.map((_, i) => ({ ok: true as const, messageId: `fake-701-${start + i}` }));
		},
		async check() {
			return { ok: true, summary: 'ok', rows: [] };
		}
	};
	return { provider, sent };
}

describe('the send path', () => {
	const HTML = '<html><body><p>Hi {{first_name}} <a href="https://www.ourco.example/offer">Offer</a></p><p><a href="%%UNSUB_URL%%">Unsubscribe</a></p></body></html>';
	const TEXT = 'Hi {{first_name}} https://www.ourco.example/offer\n\nUnsubscribe: %%UNSUB_URL%%';
	const send = async (provider: MailProvider, unsubscribe = true) => {
		const cid = (await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('s', 'b', '<p>b</p>', 'news@ourco.example', 'sending') RETURNING id`)
			.first<{ id: number }>())!.id;
		const res = await sendCampaignEmail(db, {
			provider,
			secret: SECRET,
			baseUrl: BASE,
			campaignId: cid,
			recipients: [{ id: null, email: 'pat@ourco.example', name: null, first_name: 'Pat', last_name: null }],
			subject: 'Hi',
			htmlTemplate: HTML,
			textTemplate: TEXT,
			from: 'news@ourco.example',
			stream: 'b',
			streamKind: unsubscribe ? 'broadcast' : 'transactional',
			unsubscribe
		});
		const row = await db.prepare('SELECT track_id FROM recipients WHERE campaign_id = ?').bind(cid).first<{ track_id: string | null }>();
		return { res, trackId: row?.track_id ?? null };
	};

	it('CRM tracking: links rewritten, pixel added, unsubscribe untouched, the provider asked not to track, track_id stored', async () => {
		const fake = fakeProvider('crm');
		const { res, trackId } = await send(fake.provider);
		expect(res.accepted).toBe(1);
		const m = fake.sent[0];
		expect(m.tracking).toEqual({ opens: false, links: 'none' });
		expect(m.html).not.toContain('href="https://www.ourco.example/offer"');
		expect(m.html).toContain(`${BASE}/t/c/`);
		expect(m.html).toContain(`${BASE}/t/o/`);
		expect(m.html).toContain(`${BASE}/unsubscribe?t=`);
		expect(m.text).toContain('https://www.ourco.example/offer'); // text part never rewritten
		expect(trackId).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const pixel = /\/t\/o\/([^"]+)"/.exec(m.html)![1];
		expect(await verifyOpenToken(SECRET, pixel)).toEqual({ trackId });
	});

	it('a personal 1:1 email gets no pixel and no rewritten links, and no provider tracking either', async () => {
		const fake = fakeProvider('crm');
		const { trackId } = await send(fake.provider, false);
		const m = fake.sent[0];
		expect(m.html).not.toContain('/t/c/');
		expect(m.html).not.toContain('/t/o/');
		expect(m.tracking).toEqual({ opens: false, links: 'none' });
		expect(trackId).toBeNull();
	});

	it('provider tracking (the default) sends exactly what it did before', async () => {
		const fake = fakeProvider();
		const { trackId } = await send(fake.provider);
		const m = fake.sent[0];
		expect(m.html).toContain('href="https://www.ourco.example/offer"');
		expect(m.html).not.toContain('/t/o/');
		expect(m.tracking).toEqual({ opens: true, links: 'html_and_text' });
		expect(trackId).toBeNull();
	});
});

describe('the setting', () => {
	it('defaults to the provider; MAIL_TRACKING and Settings → Sending switch it', async () => {
		const base = { ...env, POSTMARK_TOKEN: 'pm-token-701' };
		expect((await getMailProvider(db, base))?.trackingBy).toBe('provider');
		const fromEnv = await resolveMailCredentials(db, { ...base, MAIL_TRACKING: 'crm' });
		expect([fromEnv.tracking, fromEnv.trackingFrom]).toEqual(['crm', 'env']);
		expect((await getMailProvider(db, { ...base, MAIL_TRACKING: 'crm' }))?.trackingBy).toBe('crm');
		expect((await resolveMailCredentials(db, { ...base, MAIL_TRACKING: 'nonsense' })).tracking).toBe('provider');

		expect(await setTrackingMode(db, 'crm', { id: 1, github_login: 'jdoe' })).toEqual({ ok: true, changed: true });
		expect((await getMailProvider(db, base))?.trackingBy).toBe('crm');
		// Settings win over the env.
		expect(await setTrackingMode(db, 'provider', { id: 1, github_login: 'jdoe' })).toEqual({ ok: true, changed: true });
		expect((await getMailProvider(db, { ...base, MAIL_TRACKING: 'crm' }))?.trackingBy).toBe('provider');
	});

	it('the tracking routes keep answering on every host (no redirect to the custom domain)', () => {
		expect(REDIRECT_EXEMPT).toContain('/t/o');
		expect(REDIRECT_EXEMPT).toContain('/t/c');
	});
});
