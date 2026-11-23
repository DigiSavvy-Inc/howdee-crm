import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	accessToken,
	backfillStart,
	canSeeBilling,
	clearZohoTokenCache,
	DAILY_REQUEST_CAP,
	exchangeGrantCode,
	linkCustomer,
	rollupBilling,
	setMemberAccess,
	suggestMatches,
	syncZohoBooks,
	unlinkCustomer,
	ZohoAuthError,
	type ZohoCustomer
} from '../src/lib/server/integrations/zoho';
import { integrationsStatus, runProviderSync, zohoBooksProvider } from '../src/lib/server/integrations';
import type { ZohoEnv } from '../src/lib/server/integrations/secrets';
import { companyMetrics } from '../src/lib/server/company-metrics';
import { load as companyLoad } from '../src/routes/companies/[id]/+page.server';
import { GET as searchGET } from '../src/routes/api/integrations/zoho/customers/+server';

const db = (env as any).DB as D1Database;
const NOW = new Date('2026-10-20T12:00:00Z');

const ZENV: ZohoEnv = {
	dc: 'com',
	client_id: '1000.CLIENTID',
	client_secret: 'zoho-client-secret-value',
	refresh_token: '1000.refresh-token-value',
	api_domain: 'https://www.zohoapis.com',
	organization_id: '777',
	currency_code: 'USD'
};

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
});

async function company(name: string, domain: string | null = null): Promise<number> {
	const r = await db.prepare('INSERT INTO companies (name, domain) VALUES (?, ?) RETURNING id').bind(name, domain).first<{ id: number }>();
	return r!.id;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Docs = { invoices: Record<string, unknown>[]; payments: Record<string, unknown>[] };

/**
 * A fake Zoho: the accounts token endpoint + Books invoices / customerpayments / contacts.
 * Lists are paged at `pageSize`; `limitAfter` makes every API call after N return 429.
 */
function fakeZoho(byCustomer: Record<string, Docs>, opts: { pageSize?: number; refresh?: 'ok' | 'invalid' } = {}) {
	const calls: URL[] = [];
	const tokenBodies: URLSearchParams[] = [];
	let apiCalls = 0;
	let limitAfter = Infinity;
	const pageSize = opts.pageSize ?? 200;
	const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.hostname.startsWith('accounts.zoho.')) {
			const body = new URLSearchParams(String(init?.body ?? ''));
			tokenBodies.push(body);
			if (body.get('grant_type') === 'authorization_code') {
				return body.get('code') === 'good-code'
					? json({ access_token: 'acc', refresh_token: 'new-refresh', api_domain: 'https://www.zohoapis.eu', expires_in: 3600 })
					: json({ error: 'invalid_code' });
			}
			return opts.refresh === 'invalid' ? json({ error: 'invalid_code' }) : json({ access_token: 'acc-token', expires_in: 3600 });
		}
		calls.push(url);
		if (++apiCalls > limitAfter) return json({ code: 44, message: 'Too many requests' }, 429);
		const page = Number(url.searchParams.get('page') ?? 1);
		const slice = <T>(list: T[]) => ({
			rows: list.slice((page - 1) * pageSize, page * pageSize),
			page_context: { page, has_more_page: page * pageSize < list.length }
		});
		const cust = url.searchParams.get('customer_id') ?? '';
		if (url.pathname.endsWith('/invoices')) {
			const s = slice(byCustomer[cust]?.invoices ?? []);
			return json({ code: 0, message: 'success', invoices: s.rows, page_context: s.page_context });
		}
		if (url.pathname.endsWith('/customerpayments')) {
			const s = slice(byCustomer[cust]?.payments ?? []);
			return json({ code: 0, message: 'success', customerpayments: s.rows, page_context: s.page_context });
		}
		if (url.pathname.endsWith('/contacts')) {
			return json({
				code: 0,
				contacts: [
					{ contact_id: '501', contact_name: 'Acme Inc', email: 'ap@acme.example.net' },
					{ contact_id: '502', contact_name: 'Globex', email: 'billing@globex.example.net' }
				],
				page_context: { has_more_page: false }
			});
		}
		if (url.pathname.endsWith('/organizations')) {
			return json({ code: 0, organizations: [{ organization_id: '777', name: 'Ourco', currency_code: 'USD' }] });
		}
		return json({ code: 1, message: 'not found' }, 404);
	}) as typeof fetch;
	return {
		f,
		calls,
		tokenBodies,
		limitAfter(n: number) {
			limitAfter = n;
		}
	};
}

const inv = (id: string, o: Record<string, unknown> = {}) => ({
	invoice_id: id,
	invoice_number: `INV-${id}`,
	status: 'sent',
	date: '2026-09-01',
	due_date: '2026-10-01',
	total: 100,
	balance: 100,
	currency_code: 'USD',
	last_modified_time: '2026-09-01T10:00:00-0700',
	...o
});

describe('OAuth', () => {
	it('exchanges a grant code for a refresh token at the chosen data center', async () => {
		const z = fakeZoho({});
		const res = await exchangeGrantCode({ dc: 'eu', client_id: 'cid', client_secret: 'sec', code: 'good-code' }, z.f);
		expect(res).toEqual({
			ok: true,
			creds: { dc: 'eu', client_id: 'cid', client_secret: 'sec', refresh_token: 'new-refresh', api_domain: 'https://www.zohoapis.eu' }
		});
		expect(z.tokenBodies[0].get('grant_type')).toBe('authorization_code');
		expect(z.tokenBodies[0].get('code')).toBe('good-code');
	});

	it('explains invalid_code without echoing the secret', async () => {
		const res = await exchangeGrantCode({ dc: 'com', client_id: 'cid', client_secret: 'super-secret', code: 'stale' }, fakeZoho({}).f);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toMatch(/expired|already used/i);
			expect(res.error).not.toContain('super-secret');
		}
		const bad = await exchangeGrantCode({ dc: 'mars', client_id: 'a', client_secret: 'b', code: 'c' }, fakeZoho({}).f);
		expect(bad.ok).toBe(false);
	});

	it('refreshes an access token once and caches it', async () => {
		const z = fakeZoho({});
		expect(await accessToken(ZENV, z.f)).toBe('acc-token');
		expect(await accessToken(ZENV, z.f)).toBe('acc-token');
		expect(z.tokenBodies).toHaveLength(1);
		expect(z.tokenBodies[0].get('grant_type')).toBe('refresh_token');
	});

	it('a refused refresh fails the sync and marks the provider rejected', async () => {
		const id = await company('Acme');
		await linkCustomer(db, id, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		const z = fakeZoho({}, { refresh: 'invalid' });
		await expect(accessToken(ZENV, z.f)).rejects.toBeInstanceOf(ZohoAuthError);
		const run = await runProviderSync(db, { ZOHO_BOOKS: ZENV }, zohoBooksProvider, 'manual', { fetch: z.f });
		expect('ok' in run && run.ok).toBe(false);
		if ('detail' in run) expect(JSON.stringify(run.detail)).not.toContain(ZENV.client_secret);
		const status = (await integrationsStatus(db, { ZOHO_BOOKS: ZENV })).find((p) => p.provider === 'zoho_books')!;
		expect(status.state).toBe('rejected');
	});

	it('is only configured once an organization is picked', () => {
		expect(zohoBooksProvider.isConfigured({ ZOHO_BOOKS: ZENV })).toBe(true);
		expect(zohoBooksProvider.isConfigured({ ZOHO_BOOKS: { ...ZENV, organization_id: null } })).toBe(false);
		expect(zohoBooksProvider.isConfigured({ ZOHO_BOOKS: null })).toBe(false);
	});
});

describe('sync', () => {
	it('backfills 24 months with paging, then asks only for what changed', async () => {
		const id = await company('Acme');
		await linkCustomer(db, id, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		const docs = {
			'501': {
				invoices: [inv('1'), inv('2'), inv('3', { status: 'paid', balance: 0 })],
				payments: [{ payment_id: 'p1', payment_number: 'PAY-1', date: '2026-10-05', amount: 50, currency_code: 'USD', invoice_numbers: 'INV-1', payment_mode: 'Bank Transfer' }]
			}
		};
		const z = fakeZoho(docs, { pageSize: 2 });
		const res = await syncZohoBooks(db, ZENV, { trigger: 'manual', fetch: z.f, now: NOW });
		expect(res.errors).toEqual([]);
		expect(res.counts).toMatchObject({ synced: 1, invoices: 3, payments: 1 });
		const invCalls = z.calls.filter((u) => u.pathname.endsWith('/invoices'));
		expect(invCalls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2']);
		expect(invCalls[0].searchParams.get('date_start')).toBe(backfillStart(NOW));
		expect(backfillStart(NOW)).toBe('2024-10-20');
		expect(invCalls[0].searchParams.get('customer_id')).toBe('501');
		expect(invCalls[0].searchParams.get('organization_id')).toBe('777');
		expect(invCalls[0].searchParams.get('per_page')).toBe('200');
		expect(invCalls[0].searchParams.has('last_modified_time')).toBe(false);

		const n = await db.prepare('SELECT COUNT(*) AS n FROM zoho_invoices').first<number>('n');
		expect(n).toBe(3);
		const row = await db.prepare(`SELECT * FROM zoho_invoices WHERE invoice_id = '1'`).first<Record<string, unknown>>();
		expect(row).toMatchObject({ zoho_contact_id: '501', status: 'sent', total: 100, currency_code: 'USD' });
		expect(row!.zoho_url).toBe('https://books.zoho.com/app/777#/invoices/1');

		// Second run: incremental by last_modified_time, no backfill window.
		const z2 = fakeZoho(docs);
		await syncZohoBooks(db, ZENV, { trigger: 'cron', fetch: z2.f, now: new Date('2026-10-21T12:00:00Z') });
		const again = z2.calls.find((u) => u.pathname.endsWith('/invoices'))!;
		expect(again.searchParams.has('date_start')).toBe(false);
		expect(again.searchParams.get('last_modified_time')).toBe('2026-10-20T11:50:00+0000');
		const pay = z2.calls.find((u) => u.pathname.endsWith('/customerpayments'))!;
		expect(pay.searchParams.get('last_modified_time')).toBe('2026-10-20T11:50:00+0000');
	});

	it('stops cleanly at a rate limit and resumes next run', async () => {
		const a = await company('Acme');
		const b = await company('Globex');
		await linkCustomer(db, a, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		await linkCustomer(db, b, { zoho_contact_id: '502', contact_name: 'Globex' }, null);
		const docs = { '501': { invoices: [inv('1')], payments: [] }, '502': { invoices: [inv('2')], payments: [] } };
		const z = fakeZoho(docs);
		z.limitAfter(2); // 501 invoices + payments, then 429
		const res = await syncZohoBooks(db, ZENV, { trigger: 'cron', fetch: z.f, now: NOW });
		expect(res.counts).toMatchObject({ customers: 2, synced: 1, failed: 0, deferred: 1 });
		expect(res.errors.join(' ')).toMatch(/rate limit/i);
		const globex = await db.prepare(`SELECT invoices_cursor, last_error FROM company_zoho_contacts WHERE zoho_contact_id = '502'`).first<Record<string, unknown>>();
		expect(globex).toEqual({ invoices_cursor: null, last_error: null });

		// Next run: Globex has never synced, so it goes first and backfills.
		const z2 = fakeZoho(docs);
		const res2 = await syncZohoBooks(db, ZENV, { trigger: 'cron', fetch: z2.f, now: new Date('2026-10-20T18:00:00Z') });
		expect(z2.calls[0].searchParams.get('customer_id')).toBe('502');
		expect(z2.calls[0].searchParams.has('date_start')).toBe(true);
		expect(res2.counts.synced).toBe(2);
		expect(await db.prepare('SELECT COUNT(*) AS n FROM zoho_invoices').first<number>('n')).toBe(2);
	});

	it('respects the daily request cap', async () => {
		const a = await company('Acme');
		await linkCustomer(db, a, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('zoho_books_usage', ?)`)
			.bind(JSON.stringify({ day: '2026-10-20', count: DAILY_REQUEST_CAP - 1 }))
			.run();
		const z = fakeZoho({ '501': { invoices: [inv('1')], payments: [] } });
		const res = await syncZohoBooks(db, ZENV, { trigger: 'cron', fetch: z.f, now: NOW });
		expect(z.calls).toHaveLength(1);
		expect(res.counts.synced).toBe(0);
		expect(res.errors.join(' ')).toMatch(/budget/i);
		// Invoices were read to the end, so their cursor moved; payments resume next run.
		const link = await db.prepare(`SELECT invoices_cursor, payments_cursor FROM company_zoho_contacts`).first<Record<string, unknown>>();
		expect(link!.invoices_cursor).not.toBeNull();
		expect(link!.payments_cursor).toBeNull();
	});

	it('rolls up into company_metrics and unlinking removes the mirrored rows', async () => {
		const id = await company('Acme');
		await linkCustomer(db, id, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		const docs = {
			'501': {
				invoices: [inv('1'), inv('2', { due_date: '2026-11-30', balance: 40 })],
				payments: [{ payment_id: 'p1', date: '2026-10-05', amount: 60, currency_code: 'USD' }]
			}
		};
		await syncZohoBooks(db, ZENV, { trigger: 'manual', fetch: fakeZoho(docs).f, now: NOW });
		const m = await db.prepare('SELECT * FROM company_metrics WHERE company_id = ?').bind(id).first<Record<string, unknown>>();
		expect(m).toMatchObject({ ar_outstanding: 140, ar_overdue: 100, invoiced_12m: 200, paid_12m: 60, billing_currency: 'USD', last_payment_at: '2026-10-05' });

		const link = await db.prepare('SELECT id FROM company_zoho_contacts').first<number>('id');
		expect(await unlinkCustomer(db, id, link!, NOW)).toBe(true);
		expect(await db.prepare('SELECT COUNT(*) AS n FROM zoho_invoices').first<number>('n')).toBe(0);
		expect(await db.prepare('SELECT COUNT(*) AS n FROM zoho_payments').first<number>('n')).toBe(0);
		const after = await db.prepare('SELECT ar_outstanding, zoho_synced_at FROM company_metrics WHERE company_id = ?').bind(id).first();
		expect(after).toEqual({ ar_outstanding: null, zoho_synced_at: null });
	});

	it('refuses linking one customer to two companies', async () => {
		const a = await company('Acme');
		const b = await company('Other');
		expect(await linkCustomer(db, a, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null)).toEqual({ ok: true });
		const res = await linkCustomer(db, b, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		expect(res).toEqual({ ok: false, error: 'That customer is already linked to Acme.' });
		expect((await linkCustomer(db, b, { zoho_contact_id: 'abc', contact_name: 'x' }, null)).ok).toBe(false);
	});
});

describe('rollupBilling', () => {
	const base = { status: 'sent', date: '2026-09-01', due_date: '2026-10-01', total: 100, balance: 100, currency_code: 'USD' };

	it('separates overdue from outstanding by due date', () => {
		const m = rollupBilling(
			[
				base,
				{ ...base, due_date: '2026-10-20', balance: 30 }, // due today: outstanding, not overdue
				{ ...base, due_date: '2026-12-01', balance: 50 },
				{ ...base, status: 'paid', balance: 0 }
			],
			[],
			'USD',
			NOW
		);
		expect(m.ar_outstanding).toBe(180);
		expect(m.ar_overdue).toBe(100);
	});

	it('uses 12-month windows and skips drafts and voids', () => {
		const m = rollupBilling(
			[
				{ ...base, date: '2025-10-21', total: 10, balance: 0 }, // inside 365 days
				{ ...base, date: '2025-10-19', total: 1000, balance: 0 }, // outside
				{ ...base, status: 'draft', total: 5000, balance: 5000 },
				{ ...base, status: 'void', total: 7000, balance: 7000, date: '2026-10-19' }
			],
			[
				{ date: '2026-01-01', amount: 25, currency_code: 'USD' },
				{ date: '2025-01-01', amount: 999, currency_code: 'USD' }
			],
			'USD',
			NOW
		);
		expect(m.invoiced_12m).toBe(10);
		expect(m.ar_outstanding).toBe(0);
		expect(m.paid_12m).toBe(25);
		expect(m.last_invoice_at).toBe('2025-10-21');
		expect(m.last_payment_at).toBe('2026-01-01');
	});

	it('sums the base currency only, with no conversion', () => {
		const m = rollupBilling(
			[base, { ...base, currency_code: 'EUR', balance: 900, total: 900, date: '2026-10-01' }],
			[{ date: '2026-10-10', amount: 500, currency_code: 'EUR' }],
			'usd',
			NOW
		);
		expect(m).toMatchObject({ ar_outstanding: 100, invoiced_12m: 100, paid_12m: 0, billing_currency: 'USD' });
		// Dates count every currency.
		expect(m.last_invoice_at).toBe('2026-10-01');
		expect(m.last_payment_at).toBe('2026-10-10');
		expect(rollupBilling([base], [], null, NOW).ar_outstanding).toBeNull();
	});
});

describe('suggestMatches', () => {
	const customers: ZohoCustomer[] = [
		{ id: '1', name: 'Acme Billing', company_name: null, domain: 'acme.example.net' },
		{ id: '2', name: 'globex corporation', company_name: null, domain: 'gmail.com' },
		{ id: '3', name: 'Nobody', company_name: null, domain: null },
		{ id: '4', name: 'Someone', company_name: 'Initech', domain: 'initech.io' }
	];

	it('matches on the email domain', () => {
		expect(suggestMatches({ name: 'Acme', domain: 'www.Acme.example.net' }, customers, new Set()).map((s) => [s.id, s.reason])).toEqual([['1', 'domain']]);
	});

	it('matches on the name, case-insensitively (customer or company name)', () => {
		expect(suggestMatches({ name: 'Globex Corporation', domain: null }, customers, new Set()).map((s) => [s.id, s.reason])).toEqual([['2', 'name']]);
		expect(suggestMatches({ name: 'initech', domain: null }, customers, new Set()).map((s) => s.id)).toEqual(['4']);
	});

	it('never matches a blank domain and skips linked customers', () => {
		expect(suggestMatches({ name: 'Unrelated', domain: null }, customers, new Set())).toEqual([]);
		expect(suggestMatches({ name: 'Unrelated', domain: '' }, customers, new Set())).toEqual([]);
		expect(suggestMatches({ name: 'Acme', domain: 'acme.example.net' }, customers, new Set(['1']))).toEqual([]);
	});
});

describe('permissions', () => {
	const admin = { id: 1, role: 'admin' };
	const member = { id: 2, role: 'member' };

	function pageEvent(id: number, user: unknown) {
		const url = new URL(`https://crm.test/companies/${id}`);
		return { url, params: { id: String(id) }, platform: { env: env as any }, locals: { user } } as any;
	}

	it('money is admin-only until the setting lets members see it', async () => {
		expect(await canSeeBilling(db, admin)).toBe(true);
		expect(await canSeeBilling(db, member)).toBe(false);
		expect(await canSeeBilling(db, null)).toBe(false);
		await setMemberAccess(db, true);
		expect(await canSeeBilling(db, member)).toBe(true);
		await setMemberAccess(db, false);
		expect(await canSeeBilling(db, member)).toBe(false);
	});

	it('the company page loads no billing data for a member without access', async () => {
		const id = await company('Acme', 'acme.example.net');
		await linkCustomer(db, id, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);
		await syncZohoBooks(db, ZENV, { trigger: 'manual', fetch: fakeZoho({ '501': { invoices: [inv('1')], payments: [] } }).f, now: NOW });

		const asMember = (await companyLoad(pageEvent(id, member))) as any;
		expect(asMember.billing).toBeNull();
		const asAdmin = (await companyLoad(pageEvent(id, admin))) as any;
		expect(asAdmin.billing.links).toHaveLength(1);
		expect(asAdmin.billing.invoices).toHaveLength(1);
		expect(asAdmin.billing.metrics.ar_outstanding).toBe(100);
		await setMemberAccess(db, true);
		expect(((await companyLoad(pageEvent(id, member))) as any).billing.links).toHaveLength(1);
	});

	it('the customer search refuses a member without access', async () => {
		const ev = { url: new URL('https://crm.test/api/integrations/zoho/customers?q=acme'), platform: { env: env as any }, locals: { user: member } } as any;
		const res = await searchGET(ev);
		expect(res.status).toBe(403);
	});

	it('the Data API metrics carry no billing fields', async () => {
		const id = await company('Acme');
		await db.prepare('INSERT INTO company_metrics (company_id, ar_outstanding, zoho_synced_at) VALUES (?, 5, ?)').bind(id, '2026-10-20 00:00:00').run();
		const m = (await companyMetrics(db, id)) as Record<string, unknown>;
		for (const k of ['ar_outstanding', 'ar_overdue', 'invoiced_12m', 'paid_12m', 'last_payment_at', 'last_invoice_at', 'billing_currency']) {
			expect(k in m).toBe(false);
		}
	});
});
