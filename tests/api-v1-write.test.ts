import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { POST as createContact } from '../src/routes/api/v1/contacts/+server';
import { PATCH as patchContact, DELETE as deleteContact } from '../src/routes/api/v1/contacts/[id]/+server';

const db = (env as any).DB as D1Database;

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, method: string, token: string | undefined, body?: unknown, params: Record<string, string> = {}) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		platform: { env },
		url,
		params
	} as any;
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM list_members'),
		db.prepare("DELETE FROM lists WHERE name IN ('Acme','vip','News')"),
		db.prepare("DELETE FROM contacts WHERE email LIKE '%@w.test'")
	]);
});

describe('POST /api/v1/contacts', () => {
	it('rejects a read key (403)', async () => {
		const token = await makeKey('read');
		expect((await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'a@w.test' }))).status).toBe(403);
	});

	it('creates a contact with company sync + tags (201)', async () => {
		const token = await makeKey('read_write');
		const res = await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'Ann@w.test', company: 'Acme', tags: ['vip'], source: 'crm' }));
		expect(res.status).toBe(201);
		const d = (await jsonOf(res)).data;
		expect(d).toMatchObject({ email: 'ann@w.test', company: 'Acme', source: 'crm', tags: ['vip'] });
		expect(d.lists).toContain('Acme'); // company group
	});

	it('requires a valid email and rejects duplicates (400 / 409)', async () => {
		const token = await makeKey('read_write');
		expect((await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'nope' }))).status).toBe(400);
		await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'dup@w.test' }));
		const res = await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'DUP@w.test' }));
		expect(res.status).toBe(409);
		expect((await jsonOf(res)).conflict_id).toBeGreaterThan(0);
	});
});

describe('PATCH /api/v1/contacts/:id', () => {
	async function seed(token: string): Promise<number> {
		const res = await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'p@w.test', first_name: 'P', tags: ['vip'] }));
		return (await jsonOf(res)).data.id;
	}

	it('updates fields, unsubscribes, removes a tag, adds a list', async () => {
		const token = await makeKey('read_write');
		const id = await seed(token);
		const res = await patchContact(
			ev(`/api/v1/contacts/${id}`, 'PATCH', token, { first_name: 'Renamed', subscribed: false, remove_tags: ['vip'], list: 'News' }, { id: String(id) })
		);
		expect(res.status).toBe(200);
		const d = (await jsonOf(res)).data;
		expect(d).toMatchObject({ first_name: 'Renamed', subscribed: false, tags: [] });
		expect(d.lists).toContain('News');
	});

	it('409 on rename to an existing email, 404 on missing', async () => {
		const token = await makeKey('read_write');
		const id = await seed(token);
		await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'taken@w.test' }));
		const clash = await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', token, { email: 'taken@w.test' }, { id: String(id) }));
		expect(clash.status).toBe(409);
		const missing = await patchContact(ev('/api/v1/contacts/999999', 'PATCH', token, { first_name: 'x' }, { id: '999999' }));
		expect(missing.status).toBe(404);
	});

	it('rejects a read key (403)', async () => {
		const rw = await makeKey('read_write');
		const id = await seed(rw);
		const ro = await makeKey('read');
		expect((await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', ro, { first_name: 'x' }, { id: String(id) }))).status).toBe(403);
	});
});

describe('write-body validation (review fixes)', () => {
	it('rejects a JSON `null` body with 400, not a 500', async () => {
		const token = await makeKey('read_write');
		expect((await createContact(ev('/api/v1/contacts', 'POST', token, null))).status).toBe(400);
		const id = (await jsonOf(await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'nb@w.test' })))).data.id;
		expect((await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', token, null, { id: String(id) }))).status).toBe(400);
	});

	it('coerces subscribed strictly: "false" unsubscribes (never truthy-1), garbage is 400', async () => {
		const token = await makeKey('read_write');
		const id = (await jsonOf(await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'sub@w.test' })))).data.id;
		// The compliance case: the string "false" must unsubscribe — NOT coerce to subscribed=1.
		const strFalse = await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', token, { subscribed: 'false' }, { id: String(id) }));
		expect((await jsonOf(strFalse)).data.subscribed).toBe(false);
		// Unrecognized values are rejected, not guessed at.
		expect((await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', token, { subscribed: 'yes' }, { id: String(id) }))).status).toBe(400);
		const ok = await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', token, { subscribed: true }, { id: String(id) }));
		expect((await jsonOf(ok)).data.subscribed).toBe(true);
	});

	it('rejects scalar tags/remove_tags with 400 instead of silently dropping them', async () => {
		const token = await makeKey('read_write');
		const res = await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'tg@w.test', tags: 'vip' }));
		expect(res.status).toBe(400);
		expect((await jsonOf(res)).error).toMatch(/tags/);
	});

	it('creates with subscribed:false honored and empty source defaulting to "api"', async () => {
		const token = await makeKey('read_write');
		const res = await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'so@w.test', source: '', subscribed: false }));
		expect(res.status).toBe(201);
		const d = (await jsonOf(res)).data;
		expect(d.source).toBe('api'); // "" must not clear the create default
		expect(d.subscribed).toBe(false);
	});
});

describe('DELETE /api/v1/contacts/:id', () => {
	it('deletes then 404s, and 404s on a missing contact', async () => {
		const token = await makeKey('read_write');
		const id = (await jsonOf(await createContact(ev('/api/v1/contacts', 'POST', token, { email: 'del@w.test' })))).data.id;
		expect((await deleteContact(ev(`/api/v1/contacts/${id}`, 'DELETE', token, undefined, { id: String(id) }))).status).toBe(200);
		expect((await deleteContact(ev(`/api/v1/contacts/${id}`, 'DELETE', token, undefined, { id: String(id) }))).status).toBe(404);
	});

	it('rejects a read key (403)', async () => {
		const ro = await makeKey('read');
		expect((await deleteContact(ev('/api/v1/contacts/1', 'DELETE', ro, undefined, { id: '1' }))).status).toBe(403);
	});
});
