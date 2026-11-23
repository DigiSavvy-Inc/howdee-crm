// Zoho Books on companies (#353) — read-only: the CRM never creates, edits or emails anything
// in Zoho. Invoices and customer payments of the Zoho customers linked to a company
// (`company_zoho_contacts`) are mirrored into `zoho_invoices` / `zoho_payments` and rolled up
// into the company's `company_metrics` billing columns (only those columns are written).
//
// Connection: a Zoho **Self Client** (api-console.zoho.com). The admin pastes the data center,
// client id/secret and a one-time grant code; `exchangeGrantCode` swaps the code for a refresh
// token and the whole config is sealed into `integration_secrets` (provider 'zoho_books',
// ./secrets.ts). Access tokens (1 h) are cached per isolate only and refreshed on demand; a
// refresh Zoho refuses throws ZohoAuthError, which the registry turns into a "rejected" card.
//
// Sync (per linked customer, least-recently-synced first, sequential):
//  - invoices, then payments: `customer_id` + `per_page=200`, paged. First run: `date_start`
//    24 months back; after that `last_modified_time` since the stored cursor (run start minus
//    CURSOR_OVERLAP_MS). Each list's cursor moves only once that list was read to the end.
//  - Zoho allows 100 requests/min per org and a plan-dependent daily cap (as low as
//    1,000/day). A run makes at most MAX_REQUESTS_PER_RUN calls and the day at most
//    DAILY_REQUEST_CAP (counted in app_state); hitting either, or an HTTP 429, stops the run
//    cleanly — what didn't run is the oldest next time, so the next cron resumes there.
//  - The customer list used for link suggestions is cached for 24 h (≤ CUSTOMER_PAGES pages).
//
// Money: each invoice/payment keeps its own currency. Roll-ups count the organization's base
// currency only (`company_metrics.billing_currency`); other currencies are listed, not summed.

import type { FetchFn, SyncDetail, SyncTrigger } from './index';
import { readZohoOrg, ZOHO_ORG_KEY, type ZohoCreds, type ZohoEnv, type ZohoOrg } from './secrets';
import { CUSTOMER_SEARCH_CAP, matchCustomers, mergeCustomers } from '$lib/zoho-customer-search';

export const ZOHO_DCS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa'] as const;
export type ZohoDc = (typeof ZOHO_DCS)[number];
export const ZOHO_SCOPES =
	'ZohoBooks.contacts.READ,ZohoBooks.invoices.READ,ZohoBooks.customerpayments.READ,ZohoBooks.creditnotes.READ,ZohoBooks.settings.READ';

const FETCH_TIMEOUT_MS = 10_000;
/** Under Zoho's 100 requests/min per organization (a run finishes well inside a minute). */
export const MAX_REQUESTS_PER_RUN = 80;
/** Under the smallest plan's 1,000 requests/day, leaving room for searches and tests. */
export const DAILY_REQUEST_CAP = 800;
export const PER_PAGE = 200;
export const BACKFILL_MONTHS = 24;
const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
const CUSTOMERS_CACHE_KEY = 'zoho_books_customers';
const ORGS_CACHE_KEY = 'zoho_books_orgs';
const USAGE_KEY = 'zoho_books_usage';
export const MEMBER_ACCESS_KEY = 'zoho_books_member_access';
const CUSTOMERS_CACHE_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_PAGES = 5;
const RECENT_KEEP = 10;

export class ZohoAuthError extends Error {}
export class ZohoRateLimitError extends Error {}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export function isZohoDc(v: string): v is ZohoDc {
	return (ZOHO_DCS as readonly string[]).includes(v);
}

export const accountsBase = (dc: string) => `https://accounts.zoho.${dc}`;

/** The API host: the token response's api_domain when it's a Zoho API host, else by data center. */
export function apiBase(env: Pick<ZohoCreds, 'dc' | 'api_domain'>): string {
	const d = env.api_domain ?? '';
	const host = /^https:\/\/(www\.)?zohoapis\.[a-z.]{2,8}$/.test(d) ? d : `https://www.zohoapis.${env.dc}`;
	return `${host}/books/v3`;
}

/** Link to the invoice in the Zoho Books web app. */
export function invoiceUrl(dc: string, orgId: string, invoiceId: string): string {
	return `https://books.zoho.${dc}/app/${encodeURIComponent(orgId)}#/invoices/${encodeURIComponent(invoiceId)}`;
}

async function timed(f: FetchFn, url: string, init: RequestInit = {}): Promise<Response> {
	return await f(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	api_domain?: string;
	expires_in?: number;
	error?: string;
};

async function tokenCall(f: FetchFn, dc: string, params: Record<string, string>): Promise<{ status: number; body: TokenResponse }> {
	const res = await timed(f, `${accountsBase(dc)}/oauth/v2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams(params).toString()
	});
	const body = ((await res.json().catch(() => null)) ?? {}) as TokenResponse;
	return { status: res.status, body };
}

const EXCHANGE_ERRORS: Record<string, string> = {
	invalid_code: 'Zoho rejected the grant code — it was already used or has expired (they last minutes). Generate a new one.',
	invalid_client: 'Zoho rejected the client ID or secret, or they belong to another data center.',
	invalid_client_secret: 'Zoho rejected the client secret.'
};

export type ExchangeInput = { dc: string; client_id: string; client_secret: string; code: string };

/** Swap a Self Client grant code for a refresh token. Never returns the secret in an error. */
export async function exchangeGrantCode(
	input: ExchangeInput,
	f: FetchFn = fetch
): Promise<{ ok: true; creds: ZohoCreds } | { ok: false; error: string }> {
	if (!isZohoDc(input.dc)) return { ok: false, error: 'Pick a data center.' };
	const client_id = input.client_id.trim();
	const client_secret = input.client_secret.trim();
	const code = input.code.trim();
	if (!client_id || !client_secret || !code) return { ok: false, error: 'Client ID, client secret and grant code are all required.' };
	if (/\s/.test(client_id + client_secret + code) || client_id.length > 200 || client_secret.length > 200 || code.length > 500) {
		return { ok: false, error: 'Those values look wrong — paste them without spaces.' };
	}
	let r: { status: number; body: TokenResponse };
	try {
		r = await tokenCall(f, input.dc, { grant_type: 'authorization_code', client_id, client_secret, code });
	} catch {
		return { ok: false, error: `Couldn't reach accounts.zoho.${input.dc}.` };
	}
	if (r.body.error) return { ok: false, error: EXCHANGE_ERRORS[r.body.error] ?? `Zoho refused the code (${String(r.body.error).slice(0, 60)}).` };
	if (!r.body.refresh_token) {
		return { ok: false, error: r.status >= 400 ? `Zoho returned HTTP ${r.status}.` : 'Zoho returned no refresh token — generate a new grant code.' };
	}
	return {
		ok: true,
		creds: { dc: input.dc, client_id, client_secret, refresh_token: r.body.refresh_token, api_domain: r.body.api_domain ?? null }
	};
}

const tokenCache = new Map<string, { token: string; exp: number }>();

export function clearZohoTokenCache(): void {
	tokenCache.clear();
}

const cacheKey = (c: ZohoCreds) => `${c.dc}:${c.client_id}:${c.refresh_token.slice(-12)}`;

/** A valid access token (cached per isolate until a minute before it expires). */
export async function accessToken(creds: ZohoCreds, f: FetchFn = fetch, now = Date.now()): Promise<string> {
	const hit = tokenCache.get(cacheKey(creds));
	if (hit && hit.exp > now) return hit.token;
	const r = await tokenCall(f, creds.dc, {
		grant_type: 'refresh_token',
		refresh_token: creds.refresh_token,
		client_id: creds.client_id,
		client_secret: creds.client_secret
	});
	if (r.body.error || r.status === 400 || r.status === 401) {
		throw new ZohoAuthError(`Zoho refused the refresh token (${String(r.body.error ?? `HTTP ${r.status}`).slice(0, 60)}) — reconnect in Settings → Integrations.`);
	}
	if (!r.body.access_token) throw new Error(`Zoho token refresh failed (HTTP ${r.status}).`);
	const ttl = Math.max(60, Number(r.body.expires_in) || 3600) * 1000;
	tokenCache.set(cacheKey(creds), { token: r.body.access_token, exp: now + ttl - 60_000 });
	return r.body.access_token;
}

// ---------------------------------------------------------------------------
// API calls + budget
// ---------------------------------------------------------------------------

export type Budget = { used: number; max: number };

type ApiBody = { code?: number; message?: string; page_context?: { has_more_page?: boolean } } & Record<string, unknown>;

/**
 * GET a Books API path. Counts against `budget` (throws ZohoRateLimitError when spent). A 401
 * drops the cached access token and retries once; a second 401 is an auth failure.
 */
export async function zohoGet(
	env: ZohoEnv,
	path: string,
	params: Record<string, string | number>,
	opts: { fetch?: FetchFn; budget?: Budget; withOrg?: boolean } = {}
): Promise<ApiBody> {
	const f = opts.fetch ?? fetch;
	const q = new URLSearchParams();
	if (opts.withOrg !== false && env.organization_id) q.set('organization_id', env.organization_id);
	for (const [k, v] of Object.entries(params)) q.set(k, String(v));
	const url = `${apiBase(env)}${path}${q.size ? `?${q}` : ''}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (opts.budget) {
			if (opts.budget.used >= opts.budget.max) throw new ZohoRateLimitError('Zoho request budget reached — resuming next run');
			opts.budget.used++;
		}
		const token = await accessToken(env, f);
		const res = await timed(f, url, { headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' } });
		if (res.status === 401 && attempt === 0) {
			tokenCache.delete(cacheKey(env));
			continue;
		}
		const body = ((await res.json().catch(() => null)) ?? {}) as ApiBody;
		const failed = !res.ok || (typeof body.code === 'number' && body.code !== 0);
		if (res.status === 429 || (failed && /too many requests|rate limit|exceeded/i.test(String(body.message ?? '')))) {
			throw new ZohoRateLimitError('Zoho rate limit hit — resuming next run');
		}
		if (res.status === 401) throw new ZohoAuthError('Zoho rejected the access token — reconnect in Settings → Integrations.');
		if (failed) {
			throw new Error(`Zoho ${path} HTTP ${res.status}${body.message ? `: ${String(body.message).slice(0, 120)}` : ''}`);
		}
		return body;
	}
	throw new ZohoAuthError('Zoho rejected the access token.');
}

async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(key).first<{ value: string | null }>();
	return row?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

/** Today's request count (UTC day) — what's left of DAILY_REQUEST_CAP. */
export async function usageToday(db: D1Database, now: Date): Promise<number> {
	try {
		const u = JSON.parse((await getState(db, USAGE_KEY)) ?? 'null') as { day?: string; count?: number } | null;
		return u?.day === now.toISOString().slice(0, 10) ? Number(u.count) || 0 : 0;
	} catch {
		return 0;
	}
}

async function addUsage(db: D1Database, n: number, now: Date): Promise<void> {
	if (n <= 0) return;
	const count = (await usageToday(db, now)) + n;
	await setState(db, USAGE_KEY, JSON.stringify({ day: now.toISOString().slice(0, 10), count }));
}

/** A budget for one interactive call path (search, org list): whatever the day has left, ≤ max. */
async function dayBudget(db: D1Database, now: Date, max: number): Promise<Budget> {
	return { used: 0, max: Math.max(0, Math.min(max, DAILY_REQUEST_CAP - (await usageToday(db, now)))) };
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export function parseOrgs(body: unknown): ZohoOrg[] {
	const list = (body as { organizations?: unknown } | null)?.organizations;
	if (!Array.isArray(list)) return [];
	return list
		.filter((o) => o && typeof o === 'object' && (o as { organization_id?: unknown }).organization_id)
		.map((o) => {
			const r = o as { organization_id: unknown; name?: unknown; currency_code?: unknown };
			return {
				id: String(r.organization_id),
				name: String(r.name ?? r.organization_id).slice(0, 200),
				currency_code: r.currency_code ? String(r.currency_code).toUpperCase().slice(0, 8) : null
			};
		});
}

/** GET /organizations and cache the list for the Settings picker. */
export async function fetchOrganizations(
	db: D1Database,
	creds: ZohoCreds,
	f: FetchFn = fetch,
	now = new Date()
): Promise<ZohoOrg[]> {
	const env: ZohoEnv = { ...creds, organization_id: null, currency_code: null };
	const budget = await dayBudget(db, now, 2);
	try {
		const orgs = parseOrgs(await zohoGet(env, '/organizations', {}, { fetch: f, budget, withOrg: false }));
		await setState(db, ORGS_CACHE_KEY, JSON.stringify(orgs));
		return orgs;
	} finally {
		await addUsage(db, budget.used, now);
	}
}

export async function cachedOrganizations(db: D1Database): Promise<ZohoOrg[]> {
	try {
		const v = JSON.parse((await getState(db, ORGS_CACHE_KEY)) ?? '[]');
		return Array.isArray(v) ? (v as ZohoOrg[]) : [];
	} catch {
		return [];
	}
}

/** Pick the organization (must be in the cached list). Resets the sync cursors. */
export async function chooseOrganization(db: D1Database, orgId: string): Promise<ZohoOrg | null> {
	const org = (await cachedOrganizations(db)).find((o) => o.id === orgId);
	if (!org) return null;
	const prev = await readZohoOrg(db);
	await setState(db, ZOHO_ORG_KEY, JSON.stringify(org));
	if (prev && prev.id !== org.id) {
		// Another org's documents don't belong to these links any more.
		await db.batch([
			db.prepare('DELETE FROM zoho_invoices'),
			db.prepare('DELETE FROM zoho_payments'),
			db.prepare('UPDATE company_zoho_contacts SET invoices_cursor = NULL, payments_cursor = NULL, last_synced_at = NULL, last_error = NULL'),
			db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(CUSTOMERS_CACHE_KEY)
		]);
	}
	return org;
}

/** Forget the org choice and the cached lists (on disconnect). Links + mirrors are kept. */
export async function clearZohoState(db: D1Database): Promise<void> {
	await db
		.prepare(`DELETE FROM app_state WHERE key IN (?, ?, ?)`)
		.bind(ZOHO_ORG_KEY, ORGS_CACHE_KEY, CUSTOMERS_CACHE_KEY)
		.run();
	clearZohoTokenCache();
}

// ---------------------------------------------------------------------------
// Customers: search, cache, suggestions, link / unlink
// ---------------------------------------------------------------------------

/** A Zoho customer as the CRM keeps it — only the email's domain, never the address. */
export type ZohoCustomer = { id: string; name: string; company_name: string | null; domain: string | null };

export function parseCustomers(body: unknown): ZohoCustomer[] {
	const list = (body as { contacts?: unknown } | null)?.contacts;
	if (!Array.isArray(list)) return [];
	const out: ZohoCustomer[] = [];
	for (const c of list) {
		if (!c || typeof c !== 'object') continue;
		const r = c as { contact_id?: unknown; contact_name?: unknown; company_name?: unknown; email?: unknown };
		if (!r.contact_id) continue;
		const email = String(r.email ?? '').trim().toLowerCase();
		const at = email.lastIndexOf('@');
		out.push({
			id: String(r.contact_id),
			name: String(r.contact_name ?? '').slice(0, 200),
			company_name: r.company_name ? String(r.company_name).slice(0, 200) : null,
			domain: at > 0 ? normDomain(email.slice(at + 1)) : null
		});
	}
	return out;
}

function normDomain(d: string | null | undefined): string | null {
	const s = (d ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
	return s || null;
}

export type Suggestion = ZohoCustomer & { reason: 'domain' | 'name' };

/**
 * "Link?" suggestions for a company: a customer whose email domain is the company's domain,
 * or whose name (or company name) equals the company's name, case-insensitively. A blank
 * domain or name never matches; already-linked customers are left out.
 */
export function suggestMatches(
	company: { name: string; domain: string | null },
	customers: ZohoCustomer[],
	linked: Set<string>,
	limit = 5
): Suggestion[] {
	const domain = normDomain(company.domain);
	const name = company.name.trim().toLowerCase();
	const out: Suggestion[] = [];
	for (const c of customers) {
		if (linked.has(c.id)) continue;
		if (domain && c.domain && c.domain === domain) out.push({ ...c, reason: 'domain' });
		else if (name && [c.name, c.company_name].some((n) => (n ?? '').trim().toLowerCase() === name)) out.push({ ...c, reason: 'name' });
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Live search (company page fallback, #439). Not `search_text`: on /contacts it was observed to
 * return the unfiltered first page. `contact_name_contains` first, then `company_name_contains`
 * only when that found nothing — at most 2 requests from the day's budget.
 */
export async function searchCustomers(db: D1Database, env: ZohoEnv, q: string, f: FetchFn = fetch, now = new Date()): Promise<ZohoCustomer[]> {
	const budget = await dayBudget(db, now, 2);
	const term = q.slice(0, 100);
	try {
		const byName = parseCustomers(
			await zohoGet(env, '/contacts', { contact_type: 'customer', contact_name_contains: term, per_page: 25 }, { fetch: f, budget })
		);
		if (byName.length) return byName;
		return parseCustomers(
			await zohoGet(env, '/contacts', { contact_type: 'customer', company_name_contains: term, per_page: 25 }, { fetch: f, budget })
		);
	} finally {
		await addUsage(db, budget.used, now);
	}
}

export type CustomerSearchResult = { customers: ZohoCustomer[]; total: number; source: 'cache' | 'live' | 'both' };

/**
 * The Billing panel's search (#439): the cached customer list first (no Zoho request); one live
 * search only when the cache is empty / stale or found nothing. A live failure still returns the
 * local matches; it throws only when there is nothing to show.
 */
export async function customerSearch(
	db: D1Database,
	env: ZohoEnv,
	q: string,
	opts: { fetch?: FetchFn; now?: Date } = {}
): Promise<CustomerSearchResult> {
	const now = opts.now ?? new Date();
	const cache = await cachedCustomers(db);
	const all = matchCustomers(cache.customers, q, Number.MAX_SAFE_INTEGER);
	const local = { customers: all.customers.slice(0, CUSTOMER_SEARCH_CAP), total: all.total };
	const stale = !cache.customers.length || !cache.at || !(now.getTime() - Date.parse(cache.at) < CUSTOMERS_CACHE_MS);
	if (local.total && !stale) return { ...local, source: 'cache' };
	let live: ZohoCustomer[];
	try {
		live = await searchCustomers(db, env, q, opts.fetch ?? fetch, now);
	} catch (e) {
		if (local.total) return { ...local, source: 'cache' };
		throw e;
	}
	return { ...mergeCustomers(all, live), source: local.total ? 'both' : 'live' };
}

export async function cachedCustomers(db: D1Database): Promise<{ at: string | null; customers: ZohoCustomer[] }> {
	try {
		const v = JSON.parse((await getState(db, CUSTOMERS_CACHE_KEY)) ?? 'null') as { at?: string; customers?: ZohoCustomer[] } | null;
		return { at: v?.at ?? null, customers: Array.isArray(v?.customers) ? v!.customers! : [] };
	} catch {
		return { at: null, customers: [] };
	}
}

async function refreshCustomerCache(db: D1Database, env: ZohoEnv, f: FetchFn, budget: Budget, now: Date): Promise<number | null> {
	const cached = await cachedCustomers(db);
	if (cached.at && now.getTime() - Date.parse(cached.at) < CUSTOMERS_CACHE_MS) return null;
	const all: ZohoCustomer[] = [];
	for (let page = 1; page <= CUSTOMER_PAGES; page++) {
		const body = await zohoGet(env, '/contacts', { contact_type: 'customer', per_page: PER_PAGE, page }, { fetch: f, budget });
		all.push(...parseCustomers(body));
		if (!body.page_context?.has_more_page) break;
	}
	await setState(db, CUSTOMERS_CACHE_KEY, JSON.stringify({ at: now.toISOString(), customers: all }));
	return all.length;
}

export type LinkRow = {
	id: number;
	company_id: number;
	zoho_contact_id: string;
	contact_name: string;
	linked_by: number | null;
	linked_at: string;
	invoices_cursor: string | null;
	payments_cursor: string | null;
	last_synced_at: string | null;
	last_error: string | null;
};

export async function companyLinks(db: D1Database, companyId: number): Promise<LinkRow[]> {
	const rows = await db
		.prepare('SELECT * FROM company_zoho_contacts WHERE company_id = ? ORDER BY contact_name COLLATE NOCASE, id')
		.bind(companyId)
		.all<LinkRow>();
	return rows.results;
}

export async function linkCustomer(
	db: D1Database,
	companyId: number,
	input: { zoho_contact_id: string; contact_name: string },
	userId: number | null
): Promise<{ ok: true } | { ok: false; error: string }> {
	const id = input.zoho_contact_id.trim();
	if (!/^\d{1,30}$/.test(id)) return { ok: false, error: 'Pick a Zoho customer.' };
	const name = input.contact_name.trim().slice(0, 200) || id;
	const taken = await db
		.prepare(
			`SELECT z.company_id, co.name FROM company_zoho_contacts z JOIN companies co ON co.id = z.company_id
			 WHERE z.zoho_contact_id = ?`
		)
		.bind(id)
		.first<{ company_id: number; name: string }>();
	if (taken) {
		return { ok: false, error: taken.company_id === companyId ? 'That customer is already linked.' : `That customer is already linked to ${taken.name}.` };
	}
	await db
		.prepare('INSERT INTO company_zoho_contacts (company_id, zoho_contact_id, contact_name, linked_by) VALUES (?, ?, ?, ?)')
		.bind(companyId, id, name, userId)
		.run();
	return { ok: true };
}

/** Unlink: the customer's mirrored invoices and payments go with it, then re-roll the company. */
export async function unlinkCustomer(db: D1Database, companyId: number, linkId: number, now = new Date()): Promise<boolean> {
	const row = await db
		.prepare('SELECT zoho_contact_id FROM company_zoho_contacts WHERE id = ? AND company_id = ?')
		.bind(linkId, companyId)
		.first<{ zoho_contact_id: string }>();
	if (!row) return false;
	await db.batch([
		db.prepare('DELETE FROM zoho_invoices WHERE zoho_contact_id = ?').bind(row.zoho_contact_id),
		db.prepare('DELETE FROM zoho_payments WHERE zoho_contact_id = ?').bind(row.zoho_contact_id),
		db.prepare('DELETE FROM company_zoho_contacts WHERE id = ?').bind(linkId)
	]);
	const org = await readZohoOrg(db);
	await writeBillingMetrics(db, companyId, org?.currency_code ?? null, now);
	return true;
}

// ---------------------------------------------------------------------------
// Mirrors
// ---------------------------------------------------------------------------

export type InvoiceRow = {
	invoice_id: string;
	zoho_contact_id: string;
	invoice_number: string | null;
	status: string | null;
	date: string | null;
	due_date: string | null;
	total: number | null;
	balance: number | null;
	currency_code: string | null;
	zoho_url: string | null;
	last_modified: string | null;
};

export type PaymentRow = {
	payment_id: string;
	zoho_contact_id: string;
	payment_number: string | null;
	date: string | null;
	amount: number | null;
	invoice_numbers: string | null;
	payment_mode: string | null;
	currency_code: string | null;
	last_modified: string | null;
};

const str = (v: unknown, max = 200) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));
const num = (v: unknown) => {
	const n = Number(v);
	return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};
const day = (v: unknown) => {
	const s = str(v, 40);
	return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export function mapInvoice(raw: unknown, ctx: { contactId: string; dc: string; orgId: string }): InvoiceRow | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = str(r.invoice_id, 40);
	if (!id) return null;
	return {
		invoice_id: id,
		zoho_contact_id: ctx.contactId,
		invoice_number: str(r.invoice_number, 60),
		status: str(r.status, 30)?.toLowerCase() ?? null,
		date: day(r.date),
		due_date: day(r.due_date),
		total: num(r.total),
		balance: num(r.balance),
		currency_code: str(r.currency_code, 8)?.toUpperCase() ?? null,
		zoho_url: invoiceUrl(ctx.dc, ctx.orgId, id),
		last_modified: str(r.last_modified_time, 40)
	};
}

export function mapPayment(raw: unknown, ctx: { contactId: string }): PaymentRow | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = str(r.payment_id, 40);
	if (!id) return null;
	return {
		payment_id: id,
		zoho_contact_id: ctx.contactId,
		payment_number: str(r.payment_number, 60),
		date: day(r.date),
		amount: num(r.amount),
		invoice_numbers: str(r.invoice_numbers, 500),
		payment_mode: str(r.payment_mode, 60),
		currency_code: str(r.currency_code, 8)?.toUpperCase() ?? null,
		last_modified: str(r.last_modified_time, 40)
	};
}

/** Zoho's last_modified_time filter format: 2026-10-20T08:15:00+0000. */
export function zohoTime(d: Date): string {
	return `${d.toISOString().slice(0, 19)}+0000`;
}

export function backfillStart(now: Date): string {
	const d = new Date(now.getTime());
	d.setUTCMonth(d.getUTCMonth() - BACKFILL_MONTHS);
	return d.toISOString().slice(0, 10);
}

type ListKind = 'invoices' | 'payments';

/** Read one customer's list to the end (all pages). Throws on a budget/rate limit. */
async function readList(
	env: ZohoEnv,
	kind: ListKind,
	link: LinkRow,
	ctx: { fetch: FetchFn; budget: Budget; now: Date }
): Promise<unknown[]> {
	const cursor = kind === 'invoices' ? link.invoices_cursor : link.payments_cursor;
	const filter: Record<string, string> = cursor
		? { last_modified_time: zohoTime(new Date(cursor)) }
		: { date_start: backfillStart(ctx.now) };
	const path = kind === 'invoices' ? '/invoices' : '/customerpayments';
	const key = kind === 'invoices' ? 'invoices' : 'customerpayments';
	const rows: unknown[] = [];
	for (let page = 1; page < 1000; page++) {
		const body = await zohoGet(
			env,
			path,
			{ customer_id: link.zoho_contact_id, ...filter, per_page: PER_PAGE, page },
			{ fetch: ctx.fetch, budget: ctx.budget }
		);
		const list = body[key];
		if (Array.isArray(list)) rows.push(...list);
		if (!body.page_context?.has_more_page) break;
	}
	return rows;
}

async function upsertInvoices(db: D1Database, rows: InvoiceRow[]): Promise<void> {
	const stmt = db.prepare(
		`INSERT INTO zoho_invoices (invoice_id, zoho_contact_id, invoice_number, status, date, due_date, total, balance,
		   currency_code, zoho_url, last_modified)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(invoice_id) DO UPDATE SET zoho_contact_id = excluded.zoho_contact_id,
		   invoice_number = excluded.invoice_number, status = excluded.status, date = excluded.date,
		   due_date = excluded.due_date, total = excluded.total, balance = excluded.balance,
		   currency_code = excluded.currency_code, zoho_url = excluded.zoho_url, last_modified = excluded.last_modified`
	);
	const all = rows.map((r) =>
		stmt.bind(r.invoice_id, r.zoho_contact_id, r.invoice_number, r.status, r.date, r.due_date, r.total, r.balance, r.currency_code, r.zoho_url, r.last_modified)
	);
	for (let i = 0; i < all.length; i += 50) await db.batch(all.slice(i, i + 50));
}

async function upsertPayments(db: D1Database, rows: PaymentRow[]): Promise<void> {
	const stmt = db.prepare(
		`INSERT INTO zoho_payments (payment_id, zoho_contact_id, payment_number, date, amount, invoice_numbers,
		   payment_mode, currency_code, last_modified)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(payment_id) DO UPDATE SET zoho_contact_id = excluded.zoho_contact_id,
		   payment_number = excluded.payment_number, date = excluded.date, amount = excluded.amount,
		   invoice_numbers = excluded.invoice_numbers, payment_mode = excluded.payment_mode,
		   currency_code = excluded.currency_code, last_modified = excluded.last_modified`
	);
	const all = rows.map((r) =>
		stmt.bind(r.payment_id, r.zoho_contact_id, r.payment_number, r.date, r.amount, r.invoice_numbers, r.payment_mode, r.currency_code, r.last_modified)
	);
	for (let i = 0; i < all.length; i += 50) await db.batch(all.slice(i, i + 50));
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

export type BillingMetrics = {
	ar_outstanding: number | null;
	ar_overdue: number | null;
	invoiced_12m: number | null;
	paid_12m: number | null;
	last_payment_at: string | null;
	last_invoice_at: string | null;
	billing_currency: string | null;
};

/** Not money owed or invoiced yet (draft) or cancelled (void). */
const NOT_BILLED = new Set(['draft', 'void']);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure roll-up. Outstanding = open balance of billed invoices; overdue = the part of that
 * whose due date is before today (dates, not Zoho's status, so it's right between syncs);
 * invoiced / paid 12m = invoice totals / payment amounts dated in the last 365 days. Only
 * `base` currency rows are summed — no conversion; no base currency → the sums are null.
 * The last-invoice / last-payment dates count every currency.
 */
export function rollupBilling(
	invoices: Pick<InvoiceRow, 'status' | 'date' | 'due_date' | 'total' | 'balance' | 'currency_code'>[],
	payments: Pick<PaymentRow, 'date' | 'amount' | 'currency_code'>[],
	base: string | null,
	now: Date
): BillingMetrics {
	const today = now.toISOString().slice(0, 10);
	const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
	const cur = base?.toUpperCase() ?? null;
	const inBase = (c: string | null) => cur !== null && (c ?? '').toUpperCase() === cur;
	let outstanding = 0;
	let overdue = 0;
	let invoiced = 0;
	let paid = 0;
	let lastInvoice: string | null = null;
	let lastPayment: string | null = null;
	for (const i of invoices) {
		if (NOT_BILLED.has((i.status ?? '').toLowerCase())) continue;
		if (i.date && (!lastInvoice || i.date > lastInvoice)) lastInvoice = i.date;
		if (!inBase(i.currency_code)) continue;
		const bal = i.balance ?? 0;
		if (bal > 0) {
			outstanding += bal;
			if (i.due_date && i.due_date < today) overdue += bal;
		}
		if (i.date && i.date >= yearAgo) invoiced += i.total ?? 0;
	}
	for (const p of payments) {
		if (p.date && (!lastPayment || p.date > lastPayment)) lastPayment = p.date;
		if (inBase(p.currency_code) && p.date && p.date >= yearAgo) paid += p.amount ?? 0;
	}
	return {
		ar_outstanding: cur ? round2(outstanding) : null,
		ar_overdue: cur ? round2(overdue) : null,
		invoiced_12m: cur ? round2(invoiced) : null,
		paid_12m: cur ? round2(paid) : null,
		last_payment_at: lastPayment,
		last_invoice_at: lastInvoice,
		billing_currency: cur
	};
}

/** Re-roll a company's billing columns in company_metrics. No links → all billing columns NULL. */
export async function writeBillingMetrics(db: D1Database, companyId: number, base: string | null, now: Date): Promise<BillingMetrics | null> {
	const links = await db.prepare('SELECT COUNT(*) AS n FROM company_zoho_contacts WHERE company_id = ?').bind(companyId).first<{ n: number }>();
	let m: BillingMetrics | null = null;
	if (links?.n) {
		const inv = await db
			.prepare(
				`SELECT i.status, i.date, i.due_date, i.total, i.balance, i.currency_code FROM zoho_invoices i
				 JOIN company_zoho_contacts z ON z.zoho_contact_id = i.zoho_contact_id WHERE z.company_id = ?`
			)
			.bind(companyId)
			.all<InvoiceRow>();
		const pay = await db
			.prepare(
				`SELECT p.date, p.amount, p.currency_code FROM zoho_payments p
				 JOIN company_zoho_contacts z ON z.zoho_contact_id = p.zoho_contact_id WHERE z.company_id = ?`
			)
			.bind(companyId)
			.all<PaymentRow>();
		m = rollupBilling(inv.results, pay.results, base, now);
	}
	const syncedAt = m ? now.toISOString().slice(0, 19).replace('T', ' ') : null;
	await db
		.prepare(
			`INSERT INTO company_metrics (company_id, ar_outstanding, ar_overdue, invoiced_12m, paid_12m, last_payment_at,
			   last_invoice_at, billing_currency, zoho_synced_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(company_id) DO UPDATE SET ar_outstanding = excluded.ar_outstanding,
			   ar_overdue = excluded.ar_overdue, invoiced_12m = excluded.invoiced_12m, paid_12m = excluded.paid_12m,
			   last_payment_at = excluded.last_payment_at, last_invoice_at = excluded.last_invoice_at,
			   billing_currency = excluded.billing_currency, zoho_synced_at = excluded.zoho_synced_at`
		)
		.bind(
			companyId,
			m?.ar_outstanding ?? null,
			m?.ar_overdue ?? null,
			m?.invoiced_12m ?? null,
			m?.paid_12m ?? null,
			m?.last_payment_at ?? null,
			m?.last_invoice_at ?? null,
			m?.billing_currency ?? null,
			syncedAt
		)
		.run();
	return m;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * The Zoho Books provider's sync (cron + Sync now). `companyId` limits it to one company's
 * customers. Per-customer failures land in `errors` and on the link's `last_error`; a budget
 * or rate limit stops the run; ZohoAuthError propagates (the registry marks the card rejected).
 */
export async function syncZohoBooks(
	db: D1Database,
	env: ZohoEnv,
	opts: { trigger: SyncTrigger; fetch?: FetchFn; companyId?: number; now?: Date }
): Promise<SyncDetail> {
	const f = opts.fetch ?? fetch;
	const now = opts.now ?? new Date();
	if (!env.organization_id) throw new Error('Pick a Zoho Books organization in Settings → Integrations.');
	const orgId = env.organization_id;
	const budget: Budget = { used: 0, max: Math.max(0, Math.min(MAX_REQUESTS_PER_RUN, DAILY_REQUEST_CAP - (await usageToday(db, now)))) };
	const counts = { customers: 0, synced: 0, failed: 0, deferred: 0, invoices: 0, payments: 0, requests: 0, customer_list: 0 };
	const errors: string[] = [];
	const touched = new Set<number>();
	try {
		const where = opts.companyId ? 'WHERE company_id = ?' : '';
		const links = await db
			.prepare(
				`SELECT * FROM company_zoho_contacts ${where}
				 ORDER BY last_error IS NOT NULL, last_synced_at IS NOT NULL, last_synced_at, id`
			)
			.bind(...(opts.companyId ? [opts.companyId] : []))
			.all<LinkRow>();
		counts.customers = links.results.length;
		let stopped = false;
		for (const link of links.results) {
			const cursorAt = new Date(now.getTime() - CURSOR_OVERLAP_MS).toISOString();
			try {
				const rawInv = await readList(env, 'invoices', link, { fetch: f, budget, now });
				const inv = rawInv.map((r) => mapInvoice(r, { contactId: link.zoho_contact_id, dc: env.dc, orgId })).filter((r): r is InvoiceRow => !!r);
				await upsertInvoices(db, inv);
				counts.invoices += inv.length;
				touched.add(link.company_id);
				// Read to the end: the next run only asks for what changed since.
				await db.prepare('UPDATE company_zoho_contacts SET invoices_cursor = ? WHERE id = ?').bind(cursorAt, link.id).run();
				const rawPay = await readList(env, 'payments', link, { fetch: f, budget, now });
				const pay = rawPay.map((r) => mapPayment(r, { contactId: link.zoho_contact_id })).filter((r): r is PaymentRow => !!r);
				await upsertPayments(db, pay);
				counts.payments += pay.length;
				await db
					.prepare(`UPDATE company_zoho_contacts SET payments_cursor = ?, last_synced_at = datetime('now'), last_error = NULL WHERE id = ?`)
					.bind(cursorAt, link.id)
					.run();
				counts.synced++;
			} catch (e) {
				if (e instanceof ZohoAuthError) throw e;
				const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
				errors.push(`${link.contact_name}: ${msg}`);
				if (e instanceof ZohoRateLimitError) {
					stopped = true;
					break;
				}
				counts.failed++;
				await db.prepare('UPDATE company_zoho_contacts SET last_error = ? WHERE id = ?').bind(msg, link.id).run();
			}
		}
		counts.deferred = counts.customers - counts.synced - counts.failed;
		// Suggestions list: whole-org runs only, after the linked customers, with what's left.
		if (!opts.companyId && !stopped) {
			try {
				counts.customer_list = (await refreshCustomerCache(db, env, f, budget, now)) ?? 0;
			} catch (e) {
				if (e instanceof ZohoAuthError) throw e;
				errors.push(`customer list: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
			}
		}
	} finally {
		counts.requests = budget.used;
		await addUsage(db, budget.used, now);
		for (const cid of touched) await writeBillingMetrics(db, cid, env.currency_code, now);
	}
	return { counts, errors };
}

// ---------------------------------------------------------------------------
// Read side + permissions
// ---------------------------------------------------------------------------

/** Money is admin-only unless Settings → Integrations lets members see it. */
export async function memberAccessOn(db: D1Database): Promise<boolean> {
	return (await getState(db, MEMBER_ACCESS_KEY)) === '1';
}

export async function setMemberAccess(db: D1Database, on: boolean): Promise<void> {
	await setState(db, MEMBER_ACCESS_KEY, on ? '1' : '0');
}

/** Can this signed-in user see billing data (company Billing panel, links, search)? */
export async function canSeeBilling(db: D1Database, user: { role: string } | null | undefined): Promise<boolean> {
	if (!user) return false;
	if (user.role === 'admin') return true;
	return memberAccessOn(db);
}

export type BillingView = {
	metrics: (BillingMetrics & { zoho_synced_at: string | null }) | null;
	links: LinkRow[];
	invoices: InvoiceRow[];
	payments: PaymentRow[];
	suggestions: Suggestion[];
	customersCachedAt: string | null;
};

/** Everything the company page's Billing panel shows. Call only after `canSeeBilling`. */
export async function companyBilling(db: D1Database, company: { id: number; name: string; domain: string | null }): Promise<BillingView> {
	const links = await companyLinks(db, company.id);
	const metrics = await db
		.prepare(
			`SELECT ar_outstanding, ar_overdue, invoiced_12m, paid_12m, last_payment_at, last_invoice_at, billing_currency,
			   zoho_synced_at FROM company_metrics WHERE company_id = ? AND zoho_synced_at IS NOT NULL`
		)
		.bind(company.id)
		.first<BillingMetrics & { zoho_synced_at: string | null }>();
	const invoices = await db
		.prepare(
			`SELECT i.* FROM zoho_invoices i JOIN company_zoho_contacts z ON z.zoho_contact_id = i.zoho_contact_id
			 WHERE z.company_id = ? ORDER BY i.date DESC, i.invoice_number DESC LIMIT ?`
		)
		.bind(company.id, RECENT_KEEP)
		.all<InvoiceRow>();
	const payments = await db
		.prepare(
			`SELECT p.* FROM zoho_payments p JOIN company_zoho_contacts z ON z.zoho_contact_id = p.zoho_contact_id
			 WHERE z.company_id = ? ORDER BY p.date DESC, p.payment_number DESC LIMIT ?`
		)
		.bind(company.id, RECENT_KEEP)
		.all<PaymentRow>();
	const cache = await cachedCustomers(db);
	const allLinked = await db.prepare('SELECT zoho_contact_id FROM company_zoho_contacts').all<{ zoho_contact_id: string }>();
	return {
		metrics: metrics ?? null,
		links,
		invoices: invoices.results,
		payments: payments.results,
		suggestions: suggestMatches(company, cache.customers, new Set(allLinked.results.map((r) => r.zoho_contact_id))),
		customersCachedAt: cache.at
	};
}
