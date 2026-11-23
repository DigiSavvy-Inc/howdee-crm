// #166: Companies entity — backfill, find-or-create on contact writes, ON DELETE SET NULL,
// list search, rename/delete, and the /api/v1/companies scopes.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import {
	createCompany,
	deleteCompany,
	listCompanies,
	normalizeDomain,
	normalizeWebsite,
	syncCompanyMembership,
	updateCompany
} from '../src/lib/server/companies';
import { contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { GET as listApi, POST as createApi } from '../src/routes/api/v1/companies/+server';
import { GET as getApi, PATCH as patchApi } from '../src/routes/api/v1/companies/[id]/+server';
import { PATCH as patchContact } from '../src/routes/api/v1/contacts/[id]/+server';
import { POST as upsert } from '../src/routes/api/contacts/upsert/+server';

const db = (env as any).DB as D1Database;
const INGEST = 'test-ingest-key';

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
		platform: { env: { ...(env as any), INGEST_KEY: INGEST } },
		url,
		params
	} as any;
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

async function addContact(email: string, company: string | null): Promise<number> {
	const r = await db
		.prepare('INSERT INTO contacts (email, company) VALUES (?, ?) RETURNING id')
		.bind(email, company)
		.first<{ id: number }>();
	return r!.id;
}

const companyIdOf = async (contactId: number) =>
	(await db.prepare('SELECT company_id FROM contacts WHERE id = ?').bind(contactId).first<{ company_id: number | null }>())!
		.company_id;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare("DELETE FROM list_members WHERE contact_id IN (SELECT id FROM contacts WHERE email LIKE '%@co.test')"),
		db.prepare("DELETE FROM contacts WHERE email LIKE '%@co.test'"),
		db.prepare('DELETE FROM companies'),
		db.prepare("DELETE FROM lists WHERE kind = 'company'")
	]);
});

describe('migration backfill', () => {
	// Re-run 0050's backfill statements over freshly-seeded, unlinked contacts.
	async function runBackfill() {
		const mig = ((env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) =>
			m.name.startsWith('0050_')
		)!;
		const stmts = mig.queries.filter((q) => /^\s*(INSERT|UPDATE)/i.test(q.replace(/^\s*--.*$/gm, '')));
		expect(stmts.length).toBe(2);
		for (const q of stmts) await db.prepare(q).run();
	}

	it('groups case-insensitively, trims, and leaves blank/unmatched text alone', async () => {
		const a = await addContact('a@co.test', 'Acme');
		const b = await addContact('b@co.test', '  acme ');
		const c = await addContact('c@co.test', 'Beta LLC');
		const d = await addContact('d@co.test', '   ');
		const e = await addContact('e@co.test', null);
		await runBackfill();

		const cos = await db.prepare('SELECT id, name FROM companies ORDER BY name').all<{ id: number; name: string }>();
		expect(cos.results.map((r) => r.name.toLowerCase())).toEqual(['acme', 'beta llc']);
		expect(await companyIdOf(a)).toBe(await companyIdOf(b));
		expect(await companyIdOf(a)).not.toBeNull();
		expect(await companyIdOf(c)).toBe(cos.results.find((r) => r.name === 'Beta LLC')!.id);
		expect(await companyIdOf(d)).toBeNull();
		expect(await companyIdOf(e)).toBeNull();
		// Text is never rewritten by the backfill.
		const txt = await db.prepare('SELECT company FROM contacts WHERE id = ?').bind(b).first<{ company: string }>();
		expect(txt!.company).toBe('  acme ');
	});
});

describe('find-or-create on contact writes', () => {
	it('syncCompanyMembership links by name (case-insensitive) and unlinks on clear', async () => {
		const a = await addContact('a@co.test', null);
		const b = await addContact('b@co.test', null);
		await syncCompanyMembership(db, a, 'NewCo');
		await syncCompanyMembership(db, b, 'newco');
		const n = await db.prepare('SELECT COUNT(*) AS n FROM companies').first<{ n: number }>();
		expect(n!.n).toBe(1);
		expect(await companyIdOf(a)).toBe(await companyIdOf(b));
		await syncCompanyMembership(db, a, '');
		expect(await companyIdOf(a)).toBeNull();
	});

	it('/api/contacts/upsert with company creates + links the company', async () => {
		const res = await upsert(ev('/api/contacts/upsert', 'POST', INGEST, { email: 'u@co.test', company: 'Upsert Co' }));
		expect(res.status).toBeLessThan(300);
		const row = await db
			.prepare('SELECT c.company_id, co.name FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.email = ?')
			.bind('u@co.test')
			.first<{ company_id: number; name: string }>();
		expect(row?.name).toBe('Upsert Co');
	});

	it('PATCH /api/v1/contacts/:id company re-links and serializes company_id', async () => {
		const token = await makeKey('read_write');
		const id = await addContact('p@co.test', null);
		const res = await patchContact(ev(`/api/v1/contacts/${id}`, 'PATCH', token, { company: 'Patch Co' }, { id: String(id) }));
		expect(res.status).toBe(200);
		const d = (await jsonOf(res)).data;
		expect(d.company).toBe('Patch Co');
		expect(d.company_id).toBe(await companyIdOf(id));
		expect(d.company_id).not.toBeNull();
	});
});

describe('delete + rename', () => {
	it('FK ON DELETE SET NULL nulls company_id and keeps the text', async () => {
		const id = await addContact('a@co.test', 'Gone Co');
		await syncCompanyMembership(db, id, 'Gone Co');
		const cid = (await companyIdOf(id))!;
		await db.prepare('DELETE FROM companies WHERE id = ?').bind(cid).run();
		expect(await companyIdOf(id)).toBeNull();
		const txt = await db.prepare('SELECT company FROM contacts WHERE id = ?').bind(id).first<{ company: string }>();
		expect(txt!.company).toBe('Gone Co');
	});

	it('deleteCompany unlinks contacts', async () => {
		const id = await addContact('a@co.test', null);
		await syncCompanyMembership(db, id, 'Del Co');
		expect(await deleteCompany(db, (await companyIdOf(id))!)).toBe(true);
		expect(await companyIdOf(id)).toBeNull();
	});

	it('rename rewrites linked contacts and rejects a taken name', async () => {
		const id = await addContact('a@co.test', null);
		await syncCompanyMembership(db, id, 'Old Co');
		const cid = (await companyIdOf(id))!;
		await createCompany(db, { name: 'Other Co' });
		expect(await updateCompany(db, cid, { name: 'other co' })).toEqual({ ok: false, error: 'exists' });
		expect(await updateCompany(db, cid, { name: 'New Co', domain: 'https://www.New.co/x', website: 'new.co' })).toEqual({ ok: true });
		const c = await db.prepare('SELECT company, company_id FROM contacts WHERE id = ?').bind(id).first<{ company: string; company_id: number }>();
		expect(c).toEqual({ company: 'New Co', company_id: cid });
		const co = await db.prepare('SELECT domain, website FROM companies WHERE id = ?').bind(cid).first();
		expect(co).toEqual({ domain: 'www.new.co', website: 'https://new.co/' });
	});
});

describe('listing', () => {
	it('searches name or domain and counts contacts', async () => {
		await createCompany(db, { name: 'Alpha Inc', domain: 'alpha.io' });
		await createCompany(db, { name: 'Bravo', domain: 'bravo-alpha.com' });
		await createCompany(db, { name: 'Charlie' });
		const id = await addContact('a@co.test', null);
		await syncCompanyMembership(db, id, 'charlie');

		const all = await listCompanies(db);
		expect(all.total).toBe(3);
		expect(all.rows.find((r) => r.name === 'Charlie')!.contact_count).toBe(1);
		const hit = await listCompanies(db, { q: 'alpha' });
		expect(hit.rows.map((r) => r.name)).toEqual(['Alpha Inc', 'Bravo']);
		const none = await listCompanies(db, { q: '%' });
		expect(none.total).toBe(0);
	});

	it('contacts filter company_id narrows to linked contacts', async () => {
		const a = await addContact('a@co.test', null);
		await addContact('b@co.test', 'Unlinked text');
		await syncCompanyMembership(db, a, 'Filter Co');
		const f = parseContactsFilter(new URLSearchParams({ company_id: String(await companyIdOf(a)) }));
		const { where, params } = contactsWhere(f);
		const rows = await db.prepare(`SELECT email FROM contacts ${where}`).bind(...params).all<{ email: string }>();
		expect(rows.results.map((r) => r.email)).toEqual(['a@co.test']);
	});

	it('normalizes domain + website input', () => {
		expect(normalizeDomain(' HTTPS://Acme.com:443/path?q ')).toBe('acme.com');
		expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
		expect(normalizeWebsite('acme.com')).toBe('https://acme.com/');
	});
});

describe('/api/v1/companies scopes', () => {
	it('401 without a key; read key can GET but not write', async () => {
		expect((await listApi(ev('/api/v1/companies', 'GET', undefined))).status).toBe(401);
		const read = await makeKey('read');
		expect((await listApi(ev('/api/v1/companies', 'GET', read))).status).toBe(200);
		expect((await createApi(ev('/api/v1/companies', 'POST', read, { name: 'X' }))).status).toBe(403);
		const created = await createCompany(db, { name: 'Y' });
		const id = String((created as { id: number }).id);
		expect((await patchApi(ev(`/api/v1/companies/${id}`, 'PATCH', read, { notes: 'n' }, { id }))).status).toBe(403);
	});

	it('read_write creates (201 / 409), patches, and GET :id includes contacts', async () => {
		const rw = await makeKey('read_write');
		const res = await createApi(ev('/api/v1/companies', 'POST', rw, { name: 'Api Co', domain: 'api.co' }));
		expect(res.status).toBe(201);
		const co = (await jsonOf(res)).data;
		expect(co).toMatchObject({ name: 'Api Co', domain: 'api.co', contact_count: 0 });

		const dup = await createApi(ev('/api/v1/companies', 'POST', rw, { name: 'API CO' }));
		expect(dup.status).toBe(409);
		expect((await jsonOf(dup)).conflict_id).toBe(co.id);
		expect((await createApi(ev('/api/v1/companies', 'POST', rw, {}))).status).toBe(400);

		const cid = await addContact('a@co.test', null);
		await syncCompanyMembership(db, cid, 'Api Co');

		const id = String(co.id);
		const patched = await patchApi(ev(`/api/v1/companies/${id}`, 'PATCH', rw, { notes: 'Big client' }, { id }));
		expect((await jsonOf(patched)).data.notes).toBe('Big client');

		const one = await getApi(ev(`/api/v1/companies/${id}`, 'GET', rw, undefined, { id }));
		const d = (await jsonOf(one)).data;
		expect(d.contact_count).toBe(1);
		expect(d.contacts.map((c: { email: string }) => c.email)).toEqual(['a@co.test']);

		expect((await getApi(ev('/api/v1/companies/999999', 'GET', rw, undefined, { id: '999999' }))).status).toBe(404);
		expect((await getApi(ev('/api/v1/companies/x', 'GET', rw, undefined, { id: 'x' }))).status).toBe(400);
	});
});
