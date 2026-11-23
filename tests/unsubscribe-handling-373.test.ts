import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #373: custom unsubscribe handling on the broadcast stream — the stream check + Switch to
// custom (domain-auth.ts, /deliverability), and the guard that keeps a broadcast without our
// unsubscribe link / headers from going out (send.ts, pre-send checks).
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import {
	applyTransitions,
	bannerText,
	checkStream,
	checkUnsubscribeHandling,
	CUSTOM_UNSUB_BODY,
	fetchStreamConfig,
	switchToCustomUnsubscribe,
	UNSUB_HANDLING_FIX,
	type AuthCheck,
	type DomainAuthResult
} from '../src/lib/server/domain-auth';
import { actions as deliverabilityActions } from '../src/routes/deliverability/+page.server';
import { sendCampaignEmail, UNSUB_REFUSED_PREFIX } from '../src/lib/server/send';
import { contentChecks } from '../src/lib/presend-checks';
import { listUnsubscribeHeaders, unsubscribeProblems, UNSUB_PROBLEMS } from '../src/lib/list-unsubscribe';
import { actions as composeActions } from '../src/routes/compose/+page.server';
import { POST as oneClickPOST } from '../src/routes/unsubscribe/one-click/+server';
import { verifyUnsub } from '../src/lib/server/token';

const db = (env as any).DB as D1Database;
const original = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = original;
	vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('stream config → check', () => {
	it('Custom → pass, Postmark → warn with the fix, anything else → unknown', () => {
		const custom = checkUnsubscribeHandling('broadcast', { ok: true, body: { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } } });
		expect(custom.status).toBe('pass');
		expect(custom.key).toBe('unsubscribe_handling');

		const pm = checkUnsubscribeHandling('broadcast', { ok: true, body: { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Postmark' } } });
		expect(pm.status).toBe('warn');
		expect(pm.fix).toBe(UNSUB_HANDLING_FIX);
		expect(pm.fix).toContain('Postmark is still adding its own unsubscribe link.');

		expect(checkUnsubscribeHandling('broadcast', { ok: true, body: {} }).status).toBe('unknown');
		expect(checkUnsubscribeHandling('broadcast', { ok: false, error: 'Postmark error 500' }).status).toBe('unknown');
	});

	it('reads GET /message-streams/{stream} with the server token; an HTTP error is unknown', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).toBe('https://api.postmarkapp.com/message-streams/broadcast');
			expect((init?.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe('srv');
			return json({ ID: 'broadcast', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } });
		});
		vi.stubGlobal('fetch', fetchMock);
		expect((await checkStream({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast' })).check.status).toBe('pass');

		vi.stubGlobal('fetch', vi.fn(async () => json({ Message: 'boom' }, 500)));
		const read = await fetchStreamConfig('srv', 'broadcast');
		expect(read).toEqual({ ok: false, error: 'Postmark error 500' });
		const r = await checkStream({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast' });
		expect(r.check.status).toBe('unknown');

		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
		expect((await checkStream({ POSTMARK_TOKEN: 'srv' })).check.status).toBe('unknown');
	});

	it('no token, or a broadcast stream set to the transactional one → unknown, no request', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect((await checkStream({ POSTMARK_STREAM: 'broadcast' })).check.status).toBe('unknown');
		expect((await checkStream({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'outbound' })).check.status).toBe('unknown');
		expect((await checkStream({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'tx', POSTMARK_STREAM_TX: 'tx' })).check.status).toBe('unknown');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('banner: pass → warn raises', () => {
	const check = (status: AuthCheck['status']): AuthCheck => ({ key: 'unsubscribe_handling', label: 'Broadcast unsubscribe handling', status, summary: status });
	const result = (at: string, status: AuthCheck['status']): DomainAuthResult => ({
		at,
		trigger: 'cron',
		postmarkError: null,
		domains: [],
		stream: { stream: 'broadcast', check: check(status) }
	});

	it('raises once on pass → warn, keeps it while warn / unknown, clears on pass', () => {
		const first = applyTransitions(result('2026-10-19T09:00:00.000Z', 'pass'), result('2026-10-20T09:00:00.000Z', 'warn'), null);
		expect(first.alert.items).toHaveLength(1);
		expect(first.alert.items[0]).toMatchObject({ domain: 'broadcast', key: 'unsubscribe_handling' });
		expect(first.raised).toHaveLength(1);
		expect(bannerText(first.alert.items[0])).toBe('Postmark is adding its own unsubscribe link on the broadcast stream');

		const still = applyTransitions(result('2026-10-20T09:00:00.000Z', 'warn'), result('2026-10-21T09:00:00.000Z', 'warn'), first.alert);
		expect(still.alert.items).toHaveLength(1);
		expect(still.raised).toHaveLength(0);

		const blip = applyTransitions(result('2026-10-21T09:00:00.000Z', 'warn'), result('2026-10-22T09:00:00.000Z', 'unknown'), still.alert);
		expect(blip.alert.items).toHaveLength(1);

		const fixed = applyTransitions(result('2026-10-22T09:00:00.000Z', 'unknown'), result('2026-10-23T09:00:00.000Z', 'pass'), blip.alert);
		expect(fixed.alert.items).toHaveLength(0);
	});

	it('a first run that is already warn raises nothing (no pass before it)', () => {
		const out = applyTransitions(null, result('2026-10-20T09:00:00.000Z', 'warn'), null);
		expect(out.raised).toHaveLength(0);
	});
});

describe('Switch to custom', () => {
	it('PATCHes the broadcast stream with the Custom body', async () => {
		const fetchMock = vi.fn(async () => json({ ID: 'broadcast' }));
		vi.stubGlobal('fetch', fetchMock);
		const out = await switchToCustomUnsubscribe({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast', POSTMARK_STREAM_TX: 'outbound' });
		expect(out).toEqual({ ok: true, stream: 'broadcast' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.postmarkapp.com/message-streams/broadcast');
		expect(init.method).toBe('PATCH');
		expect((init.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe('srv');
		expect(JSON.parse(String(init.body))).toEqual({ SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } });
		expect(CUSTOM_UNSUB_BODY).toEqual(JSON.parse(String(init.body)));
	});

	it('never touches the transactional stream', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect((await switchToCustomUnsubscribe({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'outbound' })).ok).toBe(false);
		expect((await switchToCustomUnsubscribe({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'tx', POSTMARK_STREAM_TX: 'tx' })).ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reports a Postmark error', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => json({ Message: 'Not allowed' }, 422)));
		expect(await switchToCustomUnsubscribe({ POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast' })).toEqual({ ok: false, error: 'Postmark error 422: Not allowed' });
	});

	function event(role: 'admin' | 'member') {
		return {
			locals: { user: { id: 1, role } },
			platform: { env: { DB: db, POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast', POSTMARK_STREAM_TX: 'outbound' } },
			request: new Request('https://app.test/deliverability?/switchUnsubscribeHandling', { method: 'POST', body: new FormData() })
		} as any;
	}

	it('the action is admin-only', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const out = (await deliverabilityActions.switchUnsubscribeHandling(event('member'))) as any;
		expect(out.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('an admin switches, then the checks re-run and store a pass', async () => {
		await db.prepare("DELETE FROM app_state WHERE key IN ('domain_auth', 'domain_auth_alert', 'domain_auth_events')").run();
		const calls: { url: string; method: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, method: init?.method ?? 'GET' });
				if (url.endsWith('/message-streams/broadcast')) {
					return json(init?.method === 'PATCH' ? { ID: 'broadcast' } : { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } });
				}
				if (url.includes('/domains')) return json({ Domains: [] });
				return json({ Status: 2 }); // DNS: NXDOMAIN-ish, checks land on unknown / fail
			})
		);
		const out = (await deliverabilityActions.switchUnsubscribeHandling(event('admin'))) as any;
		expect(out.unsubSwitched).toBe('broadcast');
		expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.url)).toEqual(['https://api.postmarkapp.com/message-streams/broadcast']);
		expect(calls.some((c) => c.url.includes('/message-streams/outbound'))).toBe(false);
		const row = await db.prepare("SELECT value FROM app_state WHERE key = 'domain_auth'").first<{ value: string }>();
		expect(JSON.parse(row!.value).stream.check.status).toBe('pass');
	});
});

describe('pre-send guard', () => {
	const PH = '%%UNSUB_URL%%';
	const headers = listUnsubscribeHeaders('https://app.test/unsubscribe/one-click?t=x');

	it('unsubscribeProblems names each missing part', () => {
		expect(unsubscribeProblems({ html: `<a href="${PH}">u</a>`, text: `u ${PH}`, headers }, PH)).toEqual([]);
		expect(unsubscribeProblems({ html: '<p>x</p>', text: 'x', headers: [] }, PH)).toEqual([
			UNSUB_PROBLEMS.html,
			UNSUB_PROBLEMS.text,
			UNSUB_PROBLEMS.header,
			UNSUB_PROBLEMS.post
		]);
		expect(unsubscribeProblems({ html: `<a href="${PH}">u</a>`, text: `u ${PH}`, headers: headers.slice(0, 1) }, PH)).toEqual([UNSUB_PROBLEMS.post]);
	});

	const base = { subject: 'Hello', preheader: 'p', contentText: 'Hello there, 123 Main St, Pasadena CA 91101', mailingAddress: null };
	it('content.unsubscribe blocks on a missing link in the HTML or text, or missing headers', () => {
		const ok = contentChecks({ ...base, html: `<a href="${PH}">u</a>`, text: `u ${PH}`, headers });
		expect(ok.find((c) => c.id === 'content.unsubscribe')!.level).toBe('pass');

		const noText = contentChecks({ ...base, html: `<a href="${PH}">u</a>`, text: 'u', headers }).find((c) => c.id === 'content.unsubscribe')!;
		expect(noText.level).toBe('block');
		expect(noText.title).toBe(UNSUB_PROBLEMS.text);

		const noHeaders = contentChecks({ ...base, html: `<a href="${PH}">u</a>`, text: `u ${PH}`, headers: [] }).find((c) => c.id === 'content.unsubscribe')!;
		expect(noHeaders.level).toBe('block');
		expect(noHeaders.items).toEqual([UNSUB_PROBLEMS.header, UNSUB_PROBLEMS.post]);
	});

	let campaignId: number;
	beforeEach(async () => {
		vi.clearAllMocks();
		spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `g-${Date.now()}-${i}` })));
		await db.batch([db.prepare('DELETE FROM recipients'), db.prepare('DELETE FROM events')]);
		campaignId = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('G', 'x', 'x', 'alan@ourco.example', 'sending') RETURNING id")
			.first<{ id: number }>())!.id;
	});

	function send(unsubscribe: boolean, html: string, text: string) {
		return sendCampaignEmail(db, {
			token: 't',
			secret: 'guard-secret',
			baseUrl: 'https://app.test',
			campaignId,
			recipients: [{ id: null, email: 'zed@example.com', name: null, first_name: null, last_name: null }],
			subject: 'Hi',
			htmlTemplate: html,
			textTemplate: text,
			from: 'alan@ourco.example',
			stream: unsubscribe ? 'broadcast' : 'outbound',
			unsubscribe
		});
	}

	it('a broadcast without the link in the HTML or the text is never handed to Postmark', async () => {
		for (const [html, text] of [
			['<p>x</p>', `x ${PH}`],
			[`<a href="${PH}">u</a>`, 'x']
		]) {
			const res = await send(true, html, text);
			expect(res.accepted).toBe(0);
			expect(res.failed).toBe(1);
			expect(res.firstError).toContain(UNSUB_REFUSED_PREFIX);
		}
		const sent = spies.sendBatch.mock.calls.flatMap((c) => c[1] as unknown[]);
		expect(sent).toHaveLength(0);
		const rows = await db.prepare('SELECT status, error FROM recipients WHERE campaign_id = ?').bind(campaignId).all<{ status: string; error: string }>();
		expect(rows.results).toHaveLength(2);
		for (const r of rows.results) {
			expect(r.status).toBe('error');
			expect(r.error).toContain(UNSUB_REFUSED_PREFIX);
		}
	});

	it('a complete broadcast goes out with the link and both headers', async () => {
		const res = await send(true, `<a href="${PH}">u</a>`, `u ${PH}`);
		expect(res.accepted).toBe(1);
		const [m] = spies.sendBatch.mock.calls[0][1] as { HtmlBody: string; Headers: { Name: string }[] }[];
		expect(m.HtmlBody).toContain('https://app.test/unsubscribe?t=');
		expect(m.Headers.map((h) => h.Name)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
	});

	it('a 1:1 direct send (unsubscribe: false) is exempt', async () => {
		const res = await send(false, '<p>Hi Ann</p>', 'Hi Ann');
		expect(res.accepted).toBe(1);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
	});
});

describe('compose test sends', () => {
	const SECRET = 'test-send-secret';
	const platformEnv = { ...(env as any), POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: SECRET, PUBLIC_BASE_URL: 'https://app.test' };

	function testEvent(fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries({ subject: 'Hello', from: 'alan@ourco.example', body_md: 'Hi there', ...fields })) fd.append(k, v);
		const url = new URL('https://app.test/compose?/test');
		return { platform: { env: platformEnv }, params: {}, url, request: new Request(url, { method: 'POST', body: fd }) } as any;
	}
	type Sent = { HtmlBody: string; TextBody: string; Headers?: { Name: string; Value: string }[] };
	const sent = () => spies.sendBatch.mock.calls.flatMap((c) => c[1] as Sent[]);
	const tokenOf = (m: Sent) => {
		const v = m.Headers!.find((h) => h.Name === 'List-Unsubscribe')!.Value;
		return decodeURIComponent(v.match(/[?&]t=([^>&]+)/)![1]);
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map(() => ({ ErrorCode: 0, Message: 'OK', MessageID: 'm' })));
		await db.batch([db.prepare("DELETE FROM unsubscribes WHERE email IN ('tester@example.com', 'nobody@example.com')"), db.prepare("DELETE FROM contacts WHERE email IN ('tester@example.com', 'nobody@example.com')")]);
	});

	it('a broadcast test carries both headers, pointing at the one-click URL with the body link token', async () => {
		const out = (await composeActions.test(testEvent({ test_to: 'nobody@example.com' }))) as any;
		expect(out.testSuccess).toBe(true);
		const [m] = sent();
		expect(m.Headers!.map((h) => h.Name)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
		const lu = m.Headers![0].Value;
		expect(lu).toMatch(/^<https:\/\/app\.test\/unsubscribe\/one-click\?t=[^>]+>$/);
		expect(m.Headers![1].Value).toBe('List-Unsubscribe=One-Click');
		// Same token as the body link, so header and link act identically.
		const t = lu.slice(lu.indexOf('?t=') + 3, -1);
		expect(m.HtmlBody).toContain(`https://app.test/unsubscribe?t=${t}`);
		expect(await verifyUnsub(SECRET, tokenOf(m))).toEqual({ c: null, k: null, e: 'nobody@example.com' });
	});

	it('the token is signed with the matching contact, and one-click acts on that contact', async () => {
		const id = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('tester@example.com', 1) RETURNING id").first<{ id: number }>())!.id;
		await composeActions.test(testEvent({ test_to: 'tester@example.com' }));
		const [m] = sent();
		expect(await verifyUnsub(SECRET, tokenOf(m))).toEqual({ c: null, k: id, e: 'tester@example.com' });

		const url = m.Headers![0].Value.slice(1, -1);
		const res = await oneClickPOST({ url: new URL(url), platform: { env: { DB: db, SESSION_SECRET: SECRET } } } as any);
		expect(res.status).toBe(200);
		expect((await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(id).first<{ subscribed: number }>())!.subscribed).toBe(0);
		const u = await db.prepare("SELECT contact_id, campaign_id FROM unsubscribes WHERE email = 'tester@example.com'").first<{ contact_id: number; campaign_id: number | null }>();
		expect(u).toEqual({ contact_id: id, campaign_id: null });
	});

	it('one-click on a no-contact test token (k null) records the address without crashing', async () => {
		await composeActions.test(testEvent({ test_to: 'nobody@example.com' }));
		const url = sent()[0].Headers![0].Value.slice(1, -1);
		const res = await oneClickPOST({ url: new URL(url), platform: { env: { DB: db, SESSION_SECRET: SECRET } } } as any);
		expect(res.status).toBe(200);
		const u = await db.prepare("SELECT contact_id FROM unsubscribes WHERE email = 'nobody@example.com'").first<{ contact_id: number | null }>();
		expect(u).toEqual({ contact_id: null });
	});

	it('an HTML-template test passes the guard: its text version ends with the unsubscribe line, as the real send does', async () => {
		const tplId = (await db.prepare("INSERT INTO templates (name, kind, html) VALUES ('T373', 'html', '<p>Raw</p>') RETURNING id").first<{ id: number }>())!.id;
		const ok = (await composeActions.test(testEvent({ test_to: 'nobody@example.com', template_id: String(tplId) }))) as any;
		expect(ok.testSuccess).toBe(true);
		expect(sent()[0].TextBody).toContain('Unsubscribe: https://app.test/unsubscribe?t=');

		await db.prepare("DELETE FROM templates WHERE name IN ('T373')").run();
	});

	it('a direct (1:1) test has no unsubscribe headers', async () => {
		const out = (await composeActions.test(testEvent({ test_to: 'nobody@example.com', direct: '1' }))) as any;
		expect(out.testSuccess).toBe(true);
		const [m] = sent();
		expect(m.Headers).toBeUndefined();
	});
});
