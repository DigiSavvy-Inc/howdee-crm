import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #264: broadcast sends carry our own RFC 8058 one-click headers; 1:1 sends carry none;
// POST /unsubscribe/one-click?t= unsubscribes (idempotent, 400 on a bad token, no Origin needed).
const spies = vi.hoisted(() => ({ sendBatch: vi.fn(), suppress: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: spies.suppress }));

import { sendCampaignEmail } from '../src/lib/server/send';
import { enroll, tick } from '../src/lib/server/automations';
import { signUnsub, verifyUnsub } from '../src/lib/server/token';
import { POST } from '../src/routes/unsubscribe/one-click/+server';
import { handle } from '../src/hooks.server';

const db = (env as any).DB as D1Database;
const SECRET = 'list-unsub-secret';
const BASE = 'https://app.test';

type Msg = { To: string; Headers?: { Name: string; Value: string }[] };
const sentMessages = (): Msg[] => spies.sendBatch.mock.calls.flatMap((c) => c[1] as Msg[]);
const header = (m: Msg, name: string) => m.Headers?.find((h) => h.Name === name)?.Value;

let contactId: number;
let campaignId: number;

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `lu-${Date.now()}-${i}` }))
	);
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts')
	]);
	contactId = (await db
		.prepare("INSERT INTO contacts (email, first_name, subscribed) VALUES ('ann@example.com', 'Ann', 1) RETURNING id")
		.first<{ id: number }>())!.id;
	campaignId = (await db
		.prepare("INSERT INTO campaigns (subject, body_md, body_html, body_text, from_email, status) VALUES ('Hi', 'x', '<p>x</p>', 'x', 'alan@ourco.example', 'sending') RETURNING id")
		.first<{ id: number }>())!.id;
});

function send(unsubscribe: boolean, extraHeaders?: { Name: string; Value: string }[]) {
	return sendCampaignEmail(db, {
		token: 'x',
		secret: SECRET,
		baseUrl: BASE,
		campaignId,
		recipients: [
			{ id: contactId, email: 'ann@example.com', name: null, first_name: 'Ann', last_name: null },
			{ id: null, email: 'bob@example.com', name: null, first_name: null, last_name: null }
		],
		subject: 'Hi',
		htmlTemplate: '<p>x <a href="%%UNSUB_URL%%">u</a></p>',
		textTemplate: 'x %%UNSUB_URL%%',
		from: 'alan@ourco.example',
		stream: unsubscribe ? 'broadcast' : 'outbound',
		unsubscribe,
		headers: extraHeaders
	});
}

async function tokenFromHeader(m: Msg) {
	const v = header(m, 'List-Unsubscribe')!;
	const match = /^<(https:\/\/app\.test\/unsubscribe\/one-click\?t=([^>]+))>$/.exec(v);
	expect(match).not.toBeNull();
	return verifyUnsub(SECRET, decodeURIComponent(match![2]));
}

describe('List-Unsubscribe headers', () => {
	it('broadcast sends carry both headers with a per-recipient token', async () => {
		await send(true);
		const [ann, bob] = sentMessages();
		expect(header(ann, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
		expect(header(bob, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
		expect(await tokenFromHeader(ann)).toEqual({ c: campaignId, k: contactId, e: 'ann@example.com' });
		expect(await tokenFromHeader(bob)).toEqual({ c: campaignId, k: null, e: 'bob@example.com' });
	});

	it('keeps caller headers alongside the unsubscribe headers', async () => {
		await send(true, [{ Name: 'X-Test', Value: '1' }]);
		const [ann] = sentMessages();
		expect(header(ann, 'X-Test')).toBe('1');
		expect(header(ann, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
	});

	it('1:1 sends (unsubscribe: false) get no unsubscribe headers', async () => {
		await send(false);
		for (const m of sentMessages()) expect(m.Headers).toBeUndefined();
		await send(false, [{ Name: 'In-Reply-To', Value: '<a@b>' }]);
		const last = sentMessages().at(-1)!;
		expect(last.Headers).toEqual([{ Name: 'In-Reply-To', Value: '<a@b>' }]);
	});

	it('automation email steps include the headers', async () => {
		const automationId = (await db
			.prepare("INSERT INTO automations (name, status) VALUES ('Drip', 'active') RETURNING id")
			.first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email)
				 VALUES (?, 0, 0, 'email', 'Welcome', 'Hello', 'alan@ourco.example')`
			)
			.bind(automationId)
			.run();
		await enroll(db, automationId, [contactId]);
		await tick(db, { token: 'x', secret: SECRET, baseUrl: BASE, stream: 'broadcast' });
		const [m] = sentMessages();
		expect(header(m, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
		const payload = await tokenFromHeader(m);
		expect(payload).toMatchObject({ k: contactId, e: 'ann@example.com' });
	});
});

function oneClickEvent(token: string | null, origin?: string) {
	const url = new URL(`${BASE}/unsubscribe/one-click${token === null ? '' : `?t=${encodeURIComponent(token)}`}`);
	const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
	if (origin) headers.origin = origin;
	return {
		request: new Request(url, { method: 'POST', headers, body: 'List-Unsubscribe=One-Click' }),
		url,
		params: {},
		route: { id: '/unsubscribe/one-click' },
		locals: {},
		cookies: { get: () => undefined, set() {}, delete() {}, getAll: () => [], serialize: () => '' },
		platform: { env: { DB: db, SESSION_SECRET: SECRET, POSTMARK_TOKEN: 'pm', POSTMARK_STREAM: 'broadcast' } },
		isDataRequest: false,
		isSubRequest: false
	} as any;
}

describe('POST /unsubscribe/one-click', () => {
	it('unsubscribes, records reason one-click, suppresses, and is idempotent', async () => {
		const t = await signUnsub(SECRET, { c: campaignId, k: contactId, e: 'Ann@example.com' });
		const res = await POST(oneClickEvent(t));
		expect(res.status).toBe(200);
		const c = await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(contactId).first<{ subscribed: number }>();
		expect(c!.subscribed).toBe(0);
		expect(spies.suppress).toHaveBeenCalledWith('pm', 'broadcast', 'ann@example.com');

		const again = await POST(oneClickEvent(t));
		expect(again.status).toBe(200);
		const rows = await db.prepare('SELECT contact_id, campaign_id, email, reason FROM unsubscribes').all();
		expect(rows.results).toEqual([{ contact_id: contactId, campaign_id: campaignId, email: 'ann@example.com', reason: 'one-click' }]);
	});

	it('rejects a missing, tampered or foreign-secret token with 400', async () => {
		expect((await POST(oneClickEvent(null))).status).toBe(400);
		expect((await POST(oneClickEvent('garbage'))).status).toBe(400);
		const other = await signUnsub('another-secret', { c: campaignId, k: contactId, e: 'ann@example.com' });
		expect((await POST(oneClickEvent(other))).status).toBe(400);
		const c = await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(contactId).first<{ subscribed: number }>();
		expect(c!.subscribed).toBe(1);
	});

	it('survives a token whose contact and campaign are gone', async () => {
		const t = await signUnsub(SECRET, { c: 999999, k: 999999, e: 'gone@example.com' });
		const res = await POST(oneClickEvent(t));
		expect(res.status).toBe(200);
		const row = await db.prepare("SELECT contact_id, campaign_id FROM unsubscribes WHERE email = 'gone@example.com'").first();
		expect(row).toEqual({ contact_id: null, campaign_id: null });
	});

	it('passes the hook without an Origin header (no CSRF block, no login redirect)', async () => {
		const t = await signUnsub(SECRET, { c: campaignId, k: contactId, e: 'ann@example.com' });
		const event = oneClickEvent(t);
		const res = await handle({ event, resolve: (e: any) => POST(e) } as any);
		expect(res.status).toBe(200);
		const c = await db.prepare('SELECT subscribed FROM contacts WHERE id = ?').bind(contactId).first<{ subscribed: number }>();
		expect(c!.subscribed).toBe(0);
	});

	it('the hook still blocks cross-site form posts to the unsubscribe page', async () => {
		const url = new URL(`${BASE}/unsubscribe?/unsubscribeAll`);
		const event = {
			...oneClickEvent('x'),
			url,
			request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=x' })
		};
		const res = await handle({ event, resolve: async () => new Response('ok') } as any);
		expect(res.status).toBe(403);
	});
});
