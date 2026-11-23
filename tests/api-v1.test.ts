import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listContacts } from '../src/routes/api/v1/contacts/+server';
import { GET as getContact } from '../src/routes/api/v1/contacts/[id]/+server';
import { GET as listEvents } from '../src/routes/api/v1/events/+server';

const db = (env as any).DB as D1Database;

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('test', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, token?: string, params: Record<string, string> = {}) {
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, { headers }),
		platform: { env },
		url,
		params
	} as any;
}

async function bodyOf(res: Response): Promise<any> {
	return JSON.parse(await res.text());
}

let contactId = 0;
beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM list_members'),
		db.prepare("DELETE FROM lists WHERE name = 'vtag'"),
		db.prepare("DELETE FROM contacts WHERE email IN ('a@ex.example.net','b@ex.example.net')")
	]);
	const c = await db
		.prepare(`INSERT INTO contacts (email, first_name, subscribed, source, meta) VALUES ('a@ex.example.net','Ann',1,'s','{"k":1}') RETURNING id`)
		.first<{ id: number }>();
	contactId = c!.id;
	await db.prepare(`INSERT INTO contacts (email, subscribed) VALUES ('b@ex.example.net', 0)`).run();
	const l = await db.prepare(`INSERT INTO lists (name, kind) VALUES ('vtag','tag') RETURNING id`).first<{ id: number }>();
	await db.prepare(`INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)`).bind(l!.id, contactId).run();
	await db.prepare(`INSERT INTO events (contact_id, type) VALUES (?, 'open')`).bind(contactId).run();
});

describe('GET /api/v1/contacts', () => {
	it('401 without a key', async () => {
		expect((await listContacts(ev('/api/v1/contacts'))).status).toBe(401);
	});

	it('lists contacts with envelope + parsed meta/tags/subscribed', async () => {
		const token = await makeKey('read');
		const res = await listContacts(ev('/api/v1/contacts', token));
		expect(res.status).toBe(200);
		const b = await bodyOf(res);
		expect(b.pagination.total).toBeGreaterThanOrEqual(1);
		const ann = b.data.find((c: any) => c.email === 'a@ex.example.net');
		expect(ann).toMatchObject({ subscribed: true, tags: ['vtag'], meta: { k: 1 } });
		// #705: the unsubscribed contact isn't in the default list (subscribed=false finds it).
		expect(b.data.map((c: any) => c.email)).not.toContain('b@ex.example.net');
	});

	it('filters by tag, email, and subscribed', async () => {
		const token = await makeKey('read');
		const byTag = await bodyOf(await listContacts(ev('/api/v1/contacts?tag=vtag', token)));
		expect(byTag.data.map((c: any) => c.email)).toEqual(['a@ex.example.net']);
		const byEmail = await bodyOf(await listContacts(ev('/api/v1/contacts?email=a@ex.example.net', token)));
		expect(byEmail.data).toHaveLength(1);
		const unsub = await bodyOf(await listContacts(ev('/api/v1/contacts?subscribed=false', token)));
		expect(unsub.data.map((c: any) => c.email)).toEqual(['b@ex.example.net']);
	});
});

describe('pagination + dynamic segments (review fixes)', () => {
	it('falls back to the default limit for fractional/zero limits (no LIMIT 0 loop)', async () => {
		const token = await makeKey('read');
		for (const bad of ['0.5', '0', '-3', 'abc']) {
			const b = await bodyOf(await listContacts(ev(`/api/v1/contacts?limit=${bad}`, token)));
			expect(b.pagination.limit).toBe(50);
			expect(b.data.length).toBeGreaterThan(0);
		}
	});

	it('?list= resolves a dynamic (rules-based) segment and lists include its name', async () => {
		const token = await makeKey('read');
		// Dynamic segment: contacts with the 'vtag' tag (no list_members rows at all).
		const rules = JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: 'vtag' }] });
		await db.prepare("INSERT INTO lists (name, kind, rules) VALUES ('dynseg', 'segment', ?)").bind(rules).run();

		const byList = await bodyOf(await listContacts(ev('/api/v1/contacts?list=dynseg', token)));
		expect(byList.data.map((c: any) => c.email)).toEqual(['a@ex.example.net']);
		expect(byList.data[0].lists).toContain('dynseg');

		const single = await bodyOf(await getContact(ev(`/api/v1/contacts/${contactId}`, token, { id: String(contactId) })));
		expect(single.data.lists).toContain('dynseg');

		const unknown = await bodyOf(await listContacts(ev('/api/v1/contacts?list=no-such-list', token)));
		expect(unknown.data).toEqual([]);
		expect(unknown.pagination.total).toBe(0);
		await db.prepare("DELETE FROM lists WHERE name = 'dynseg'").run();
	});
});

describe('GET /api/v1/contacts/:id', () => {
	it('returns one, 404 for missing, 400 for bad id', async () => {
		const token = await makeKey('read');
		const ok = await getContact(ev(`/api/v1/contacts/${contactId}`, token, { id: String(contactId) }));
		expect(ok.status).toBe(200);
		expect((await bodyOf(ok)).data.email).toBe('a@ex.example.net');
		expect((await getContact(ev('/api/v1/contacts/999999', token, { id: '999999' }))).status).toBe(404);
		expect((await getContact(ev('/api/v1/contacts/abc', token, { id: 'abc' }))).status).toBe(400);
	});
});

describe('GET /api/v1/events', () => {
	it('lists events with contact email join + contact_id filter', async () => {
		const token = await makeKey('read');
		const res = await listEvents(ev(`/api/v1/events?contact_id=${contactId}`, token));
		const b = await bodyOf(res);
		expect(b.data).toHaveLength(1);
		expect(b.data[0]).toMatchObject({ type: 'open', email: 'a@ex.example.net', contact_id: contactId });
	});

	it('400 on bad campaign_id', async () => {
		const token = await makeKey('read');
		expect((await listEvents(ev('/api/v1/events?campaign_id=abc', token))).status).toBe(400);
	});
});
