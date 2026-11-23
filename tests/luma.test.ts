import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	verifyLumaSignature,
	mapApprovalStatus,
	extractGuest,
	slugifyTag,
	parseSignatureHeader
} from '../src/lib/server/luma';
import { setSettings } from '../src/lib/server/settings';
import { POST } from '../src/routes/api/luma/+server';

const db = (env as any).DB as D1Database;
const SECRET = 'whsec_testsecret123';

// Mirror Luma's signing (HMAC-SHA256 hex of `${t}.${body}`) to build valid test deliveries.
async function signHex(secret: string, t: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
	let hex = '';
	for (const b of sig) hex += b.toString(16).padStart(2, '0');
	return hex;
}

function makeEvent(body: string, headers: Record<string, string>) {
	return {
		request: new Request('https://app.test/api/luma', { method: 'POST', headers, body }),
		platform: { env },
		url: new URL('https://app.test/api/luma')
	} as any;
}

async function postLuma(payload: unknown, opts: { webhookId?: string; secret?: string; tsOffset?: number } = {}) {
	const body = JSON.stringify(payload);
	const t = String(Math.floor(Date.now() / 1000) + (opts.tsOffset ?? 0));
	const sig = await signHex(opts.secret ?? SECRET, t, body);
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'webhook-signature': `t=${t},v1=${sig}`
	};
	if (opts.webhookId) headers['webhook-id'] = opts.webhookId;
	const res = await POST(makeEvent(body, headers));
	return { res, json: (await res.json()) as any };
}

describe('parseSignatureHeader', () => {
	it('pulls t + all v1 values', () => {
		expect(parseSignatureHeader('t=123,v1=abc,v1=def')).toEqual({ t: '123', sigs: ['abc', 'def'] });
		expect(parseSignatureHeader('garbage')).toEqual({ t: null, sigs: [] });
	});
});

describe('verifyLumaSignature', () => {
	const now = 1_000_000;
	const body = '{"hello":"world"}';

	it('accepts a valid hex signature within tolerance', async () => {
		const sig = await signHex(SECRET, String(now), body);
		const r = await verifyLumaSignature(SECRET, `t=${now},v1=${sig}`, body, now);
		expect(r.ok).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const sig = await signHex(SECRET, String(now), body);
		const r = await verifyLumaSignature(SECRET, `t=${now},v1=${sig}`, body + 'x', now);
		expect(r.ok).toBe(false);
	});

	it('rejects the wrong secret', async () => {
		const sig = await signHex('whsec_wrong', String(now), body);
		const r = await verifyLumaSignature(SECRET, `t=${now},v1=${sig}`, body, now);
		expect(r.ok).toBe(false);
	});

	it('rejects a stale timestamp (replay guard)', async () => {
		const sig = await signHex(SECRET, String(now), body);
		const r = await verifyLumaSignature(SECRET, `t=${now},v1=${sig}`, body, now + 10_000);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/tolerance/);
	});

	it('rejects missing header / secret', async () => {
		expect((await verifyLumaSignature(SECRET, null, body, now)).ok).toBe(false);
		expect((await verifyLumaSignature('', `t=${now},v1=x`, body, now)).ok).toBe(false);
	});

	it('accepts when one of several v1 candidates matches (rotation)', async () => {
		const sig = await signHex(SECRET, String(now), body);
		const r = await verifyLumaSignature(SECRET, `t=${now},v1=deadbeef,v1=${sig}`, body, now);
		expect(r.ok).toBe(true);
	});
});

describe('mapApprovalStatus', () => {
	it('maps known Luma statuses to UI labels', () => {
		expect(mapApprovalStatus('approved')).toBe('going');
		expect(mapApprovalStatus('pending_approval')).toBe('pending');
		expect(mapApprovalStatus('waitlist')).toBe('pending');
		expect(mapApprovalStatus('declined')).toBe('not-going');
		expect(mapApprovalStatus('weird')).toBe(null);
		expect(mapApprovalStatus(null)).toBe(null);
	});
});

describe('extractGuest', () => {
	it('normalizes a Luma guest payload', () => {
		const g = extractGuest({
			type: 'guest.registered',
			data: {
				email: 'Jane@Example.com',
				name: 'Jane Doe',
				approval_status: 'approved',
				registration_answers: [
					{ label: 'Interests', answer: 'AI, Web3' },
					{ label: 'Role', answer: 'Engineer' }
				],
				event: { name: 'Pasadena AI Night' }
			}
		});
		expect(g.email).toBe('jane@example.com');
		expect(g.first).toBe('Jane');
		expect(g.last).toBe('Doe');
		expect(g.status).toBe('going');
		expect(g.eventName).toBe('Pasadena AI Night');
		expect(g.answers).toEqual([
			{ label: 'Interests', answer: 'AI, Web3' },
			{ label: 'Role', answer: 'Engineer' }
		]);
	});

	it('falls back through nested guest + missing name', () => {
		const g = extractGuest({ data: { guest: { user: { email: 'x@y.example.net' } } } });
		expect(g.email).toBe('x@y.example.net');
		expect(g.status).toBe(null);
	});
});

describe('slugifyTag', () => {
	it('slugs free text', () => {
		expect(slugifyTag('Hello, World!')).toBe('hello-world');
	});
});

describe('POST /api/luma (integration)', () => {
	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM luma_events'),
			db.prepare('DELETE FROM list_members'),
			db.prepare('DELETE FROM lists'),
			db.prepare('DELETE FROM contacts'),
			db.prepare("DELETE FROM app_state WHERE key LIKE 'luma%'")
		]);
		await setSettings(db, { luma_webhook_secret: SECRET, luma_list: 'Newsletter' });
	});

	async function tagsFor(email: string): Promise<string[]> {
		const rows = await db
			.prepare(
				`SELECT l.name FROM list_members lm
				 JOIN lists l ON l.id = lm.list_id
				 JOIN contacts c ON c.id = lm.contact_id
				 WHERE c.email = ? AND l.kind = 'tag' ORDER BY l.name`
			)
			.bind(email)
			.all<{ name: string }>();
		return rows.results.map((r) => r.name);
	}
	async function listsFor(email: string): Promise<string[]> {
		const rows = await db
			.prepare(
				`SELECT l.name FROM list_members lm
				 JOIN lists l ON l.id = lm.list_id
				 JOIN contacts c ON c.id = lm.contact_id
				 WHERE c.email = ? AND l.kind = 'list' ORDER BY l.name`
			)
			.bind(email)
			.all<{ name: string }>();
		return rows.results.map((r) => r.name);
	}

	it('guest.registered → creates contact, adds to list, tags status + interests', async () => {
		const { res, json } = await postLuma(
			{
				type: 'guest.registered',
				data: {
					email: 'reg@x.example.net',
					name: 'Reg Person',
					approval_status: 'approved',
					registration_answers: [{ label: 'Interests', answer: 'AI, Robotics' }],
					event: { name: 'AI Night' }
				}
			},
			{ webhookId: 'evt_1' }
		);
		expect(res.status).toBe(200);
		expect(json.status).toBe('added');
		expect(await listsFor('reg@x.example.net')).toEqual(['Newsletter']);
		expect(await tagsFor('reg@x.example.net')).toEqual(
			expect.arrayContaining(['AI', 'Luma: AI Night', 'Luma: Going', 'Robotics'])
		);
	});

	it('guest.updated → reconciles status tag (removes the stale one)', async () => {
		await postLuma(
			{ type: 'guest.registered', data: { email: 'u@x.example.net', name: 'U', approval_status: 'pending_approval' } },
			{ webhookId: 'evt_a' }
		);
		expect(await tagsFor('u@x.example.net')).toContain('Luma: Pending');

		await postLuma(
			{ type: 'guest.updated', data: { email: 'u@x.example.net', approval_status: 'approved' } },
			{ webhookId: 'evt_b' }
		);
		const tags = await tagsFor('u@x.example.net');
		expect(tags).toContain('Luma: Going');
		expect(tags).not.toContain('Luma: Pending');
	});

	it('stores answers + status + event in contacts.meta', async () => {
		await postLuma(
			{
				type: 'guest.registered',
				data: {
					email: 'meta@x.example.net',
					approval_status: 'approved',
					registration_answers: [{ label: 'Company', answer: 'Acme' }],
					event: { name: 'Demo' }
				}
			},
			{ webhookId: 'evt_m' }
		);
		const row = await db.prepare('SELECT meta FROM contacts WHERE email = ?').bind('meta@x.example.net').first<{ meta: string }>();
		const meta = JSON.parse(row!.meta);
		expect(meta['luma_status']).toBe('approved');
		expect(meta['luma_event']).toBe('Demo');
		expect(meta['luma: Company']).toBe('Acme');
	});

	it('dedupes a duplicate Webhook-Id', async () => {
		const payload = { type: 'guest.registered', data: { email: 'dup@x.example.net', approval_status: 'approved' } };
		const first = await postLuma(payload, { webhookId: 'evt_dup' });
		expect(first.json.status).toBe('added');
		const second = await postLuma(payload, { webhookId: 'evt_dup' });
		expect(second.json.status).toBe('duplicate');
		const n = await db.prepare('SELECT COUNT(*) AS n FROM luma_events WHERE webhook_id = ?').bind('evt_dup').first<{ n: number }>();
		expect(n?.n).toBe(1);
	});

	it('rejects a bad signature without creating a contact', async () => {
		const body = JSON.stringify({ type: 'guest.registered', data: { email: 'bad@x.example.net' } });
		const t = String(Math.floor(Date.now() / 1000));
		const res = await POST(
			makeEvent(body, { 'content-type': 'application/json', 'webhook-signature': `t=${t},v1=deadbeef` })
		);
		expect(res.status).toBe(401);
		const c = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind('bad@x.example.net').first();
		expect(c).toBe(null);
	});

	it('ignores a payload with no usable email', async () => {
		const { res, json } = await postLuma({ type: 'guest.updated', data: {} }, { webhookId: 'evt_noemail' });
		expect(res.status).toBe(200);
		expect(json.status).toBe('ignored');
	});
});
