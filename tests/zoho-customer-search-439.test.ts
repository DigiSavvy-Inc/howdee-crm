import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { matchCustomers, mergeCustomers, type SearchableCustomer } from '../src/lib/zoho-customer-search';
import { clearZohoTokenCache } from '../src/lib/server/integrations/zoho';
import { storeSecret, ZOHO_ORG_KEY, ZOHO_PROVIDER } from '../src/lib/server/integrations/secrets';
import { GET as searchGET } from '../src/routes/api/integrations/zoho/customers/+server';
import { actions as companyActions } from '../src/routes/companies/[id]/+page.server';

const db = (env as any).DB as D1Database;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const KEY = newKey();
const admin = { id: 1, role: 'admin' };

const cust = (id: string, name: string, company_name: string | null = null, domain: string | null = null): SearchableCustomer => ({
	id,
	name,
	company_name,
	domain
});

const CUSTOMERS = [
	cust('1', 'Northpeak Resources', null, 'northpeak.example.net'),
	cust('2', 'Sunnyday Care Village', null, 'sunnyday.example.org'),
	cust('3', 'Jane Doe', 'Brightway Sports LLC', 'gmail.com'),
	cust('4', 'Brightway Inc', null, 'brightway.example.net'),
	cust('5', 'Bob Smith', null, 'brightwaysports.example.net'),
	cust('6', 'Unbright Way Co', null, null)
];

describe('matchCustomers', () => {
	it('matches name, company name and domain, case-insensitively', () => {
		const r = matchCustomers(CUSTOMERS, 'BRIGHTWAY');
		expect(r.customers.map((c) => c.id).sort()).toEqual(['3', '4', '5']);
		expect(r.total).toBe(3);
		expect(matchCustomers(CUSTOMERS, 'sunnyday').customers.map((c) => c.id)).toEqual(['2']);
	});

	it('ranks starts-with before contains', () => {
		const r = matchCustomers([cust('a', 'The Brightway Group'), cust('b', 'Brightway Inc'), cust('c', 'X', null, 'brightway.example.net')], 'brightway');
		expect(r.customers.map((c) => c.id)).toEqual(['b', 'c', 'a']);
	});

	it('caps the list and reports the total', () => {
		const many = Array.from({ length: 40 }, (_, i) => cust(String(i), `Acme ${String(i).padStart(2, '0')}`));
		const r = matchCustomers(many, 'acme');
		expect(r.customers).toHaveLength(25);
		expect(r.total).toBe(40);
		expect(matchCustomers(many, 'acme', 5).customers).toHaveLength(5);
	});

	it('an empty query matches nothing', () => {
		expect(matchCustomers(CUSTOMERS, '  ')).toEqual({ customers: [], total: 0 });
	});
});

describe('mergeCustomers', () => {
	it('keeps local first, dedupes live by id and counts the new ones', () => {
		const local = matchCustomers(CUSTOMERS, 'brightway inc');
		const r = mergeCustomers(local, [cust('4', 'Brightway Inc'), cust('9', 'Brightway Inc (EU)')]);
		expect(r.customers.map((c) => c.id)).toEqual(['4', '9']);
		expect(r.total).toBe(2);
	});

	it('caps the merged list', () => {
		const live = Array.from({ length: 30 }, (_, i) => cust(`L${i}`, `Live ${i}`));
		const r = mergeCustomers({ customers: [], total: 0 }, live);
		expect(r.customers).toHaveLength(25);
		expect(r.total).toBe(30);
	});
});

// ---- route + link action, with a fake Zoho behind global fetch ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FakeOpts = { contacts?: (url: URL) => Response };
function fakeZoho(opts: FakeOpts = {}) {
	const calls: URL[] = [];
	const f = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.hostname.startsWith('accounts.zoho.')) return json({ access_token: 'acc-token', expires_in: 3600 });
		calls.push(url);
		if (url.pathname.endsWith('/contacts')) return opts.contacts ? opts.contacts(url) : json({ code: 0, contacts: [] });
		if (url.pathname.endsWith('/invoices')) {
			return json({
				code: 0,
				invoices: [
					{
						invoice_id: 'i1',
						invoice_number: 'INV-1',
						status: 'sent',
						date: '2026-10-01',
						due_date: '2099-01-01',
						total: 250,
						balance: 250,
						currency_code: 'USD',
						last_modified_time: '2026-10-01T10:00:00-0700'
					}
				],
				page_context: { has_more_page: false }
			});
		}
		if (url.pathname.endsWith('/customerpayments')) return json({ code: 0, customerpayments: [], page_context: { has_more_page: false } });
		return json({ code: 1, message: 'not found' }, 404);
	});
	vi.stubGlobal('fetch', f);
	return { calls, f };
}

const platform = { env: { ...(env as any), MAIL_TOKEN_KEY: KEY } };

function searchEvent(q: string) {
	return { url: new URL(`https://crm.test/api/integrations/zoho/customers?q=${encodeURIComponent(q)}`), platform, locals: { user: admin } } as any;
}

async function setCache(customers: SearchableCustomer[], at: Date | null) {
	await db
		.prepare(`INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('zoho_books_customers', ?, datetime('now'))`)
		.bind(JSON.stringify({ at: at ? at.toISOString() : null, customers }))
		.run();
}

beforeEach(async () => {
	clearZohoTokenCache();
	await db.batch([
		db.prepare('DELETE FROM zoho_invoices'),
		db.prepare('DELETE FROM zoho_payments'),
		db.prepare('DELETE FROM company_zoho_contacts'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM companies'),
		db.prepare('DELETE FROM integration_syncs'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'integration_%' OR key LIKE 'zoho_books%'`)
	]);
	await storeSecret(
		db,
		KEY,
		ZOHO_PROVIDER,
		JSON.stringify({ dc: 'com', client_id: '1000.CID', client_secret: 'sec', refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' }),
		null,
		{ last4: '.CID' }
	);
	await db
		.prepare(`INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
		.bind(ZOHO_ORG_KEY, JSON.stringify({ id: '777', name: 'Ourco', currency_code: 'USD' }))
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /api/integrations/zoho/customers', () => {
	it('a fresh cache answers without calling Zoho', async () => {
		const z = fakeZoho();
		await setCache(CUSTOMERS, new Date());
		const res = await searchGET(searchEvent('brightway'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.source).toBe('cache');
		expect(body.total).toBe(3);
		expect(body.customers.map((c: any) => c.id).sort()).toEqual(['3', '4', '5']);
		expect(z.f).not.toHaveBeenCalled();
	});

	it('a cold cache searches live with contact_name_contains (never search_text)', async () => {
		const z = fakeZoho({
			contacts: () => json({ code: 0, contacts: [{ contact_id: '88', contact_name: 'Brightway Inc', email: 'ap@brightway.example.net' }] })
		});
		const res = await searchGET(searchEvent('brightway'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toEqual({ customers: [{ id: '88', name: 'Brightway Inc', company_name: null, domain: 'brightway.example.net' }], total: 1, source: 'live' });
		expect(z.calls).toHaveLength(1);
		expect(z.calls[0].searchParams.get('contact_name_contains')).toBe('brightway');
		expect(z.calls[0].searchParams.has('search_text')).toBe(false);
	});

	it('falls back to company_name_contains only when the name search is empty', async () => {
		const z = fakeZoho({
			contacts: (url) =>
				url.searchParams.has('company_name_contains')
					? json({ code: 0, contacts: [{ contact_id: '90', contact_name: 'Jane', company_name: 'Brightway LLC' }] })
					: json({ code: 0, contacts: [] })
		});
		const body = (await (await searchGET(searchEvent('brightway'))).json()) as any;
		expect(body.customers.map((c: any) => c.id)).toEqual(['90']);
		expect(z.calls.map((u) => [...u.searchParams.keys()].find((k) => k.endsWith('_contains')))).toEqual([
			'contact_name_contains',
			'company_name_contains'
		]);
	});

	it('a stale cache merges local and live results, deduped', async () => {
		fakeZoho({
			contacts: () =>
				json({
					code: 0,
					contacts: [
						{ contact_id: '4', contact_name: 'Brightway Inc', email: 'x@brightway.example.net' },
						{ contact_id: '77', contact_name: 'Brightway New', email: '' }
					]
				})
		});
		await setCache(CUSTOMERS, new Date(Date.now() - 48 * 3600 * 1000));
		const body = (await (await searchGET(searchEvent('brightway'))).json()) as any;
		expect(body.source).toBe('both');
		expect(body.total).toBe(4);
		expect(body.customers.map((c: any) => c.id).sort()).toEqual(['3', '4', '5', '77']);
	});

	it('a live failure still returns the local matches', async () => {
		fakeZoho({ contacts: () => json({ code: 5, message: 'boom' }, 500) });
		await setCache(CUSTOMERS, new Date(Date.now() - 48 * 3600 * 1000));
		const res = await searchGET(searchEvent('brightway'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.source).toBe('cache');
		expect(body.total).toBe(3);
	});

	it('a live failure with nothing local is a 502', async () => {
		fakeZoho({ contacts: () => json({ code: 5, message: 'boom' }, 500) });
		await setCache(CUSTOMERS, new Date());
		const res = await searchGET(searchEvent('nomatchanywhere'));
		expect(res.status).toBe(502);
	});
});

describe('linkZoho', () => {
	async function company(name: string): Promise<number> {
		const r = await db.prepare('INSERT INTO companies (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>();
		return r!.id;
	}
	function linkEvent(id: number) {
		const fd = new FormData();
		fd.set('zoho_contact_id', '501');
		fd.set('contact_name', 'Acme Inc');
		return {
			params: { id: String(id) },
			platform,
			locals: { user: admin },
			request: new Request(`https://crm.test/companies/${id}?/linkZoho`, { method: 'POST', body: fd }),
			url: new URL(`https://crm.test/companies/${id}`)
		} as any;
	}

	it('syncs the company right after linking', async () => {
		fakeZoho();
		const id = await company('Acme');
		const r = (await (companyActions.linkZoho as any)(linkEvent(id))) as any;
		expect(r).toEqual({ zohoOk: 'linked' });
		const inv = await db.prepare('SELECT COUNT(*) AS n FROM zoho_invoices').first<{ n: number }>();
		expect(inv!.n).toBe(1);
		const m = await db.prepare('SELECT ar_outstanding, zoho_synced_at FROM company_metrics WHERE company_id = ?').bind(id).first<any>();
		expect(m.ar_outstanding).toBe(250);
		expect(m.zoho_synced_at).toBeTruthy();
	});

	it('keeps the link with a note when the sync lock is held', async () => {
		fakeZoho();
		const id = await company('Acme');
		await db
			.prepare(`INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('integration_lock:zoho_books', ?, datetime('now'))`)
			.bind(new Date(Date.now() + 5 * 60_000).toISOString())
			.run();
		const r = (await (companyActions.linkZoho as any)(linkEvent(id))) as any;
		expect(r).toEqual({ zohoOk: 'linked', zohoNote: 'Linked. Figures arrive with the next sync.' });
		const links = await db.prepare('SELECT COUNT(*) AS n FROM company_zoho_contacts WHERE company_id = ?').bind(id).first<{ n: number }>();
		expect(links!.n).toBe(1);
	});
});
