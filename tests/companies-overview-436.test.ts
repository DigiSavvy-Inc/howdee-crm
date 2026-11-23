// #436: /companies overview strip, ?filter= chips, Outstanding / Last touch columns, and the
// "billing never reaches a viewer without billing access" rule.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	billingVisible,
	defaultDirFor,
	defaultSortFor,
	dominantCurrency,
	lastTouchSource,
	parseCompanyFilter,
	parseCompanySort,
	tileVisibility,
	visibleFilters,
	type SourceState
} from '../src/lib/company-overview';
import { FILTER_SQL, getCompany, listCompanies, serializeCompany } from '../src/lib/server/company-read';
import { loadCompanyOverview } from '../src/lib/server/company-overview';
import { setMemberAccess } from '../src/lib/server/integrations/zoho';
import { load } from '../src/routes/companies/+page.server';

const db = (env as any).DB as D1Database;

const NONE: SourceState = { timing: false, github: false, zoho: false, billing: false };
const ALL: SourceState = { timing: true, github: true, zoho: true, billing: true };

describe('filters + sorts (pure)', () => {
	it('whitelists filters; unknown or not permitted → all', () => {
		expect(parseCompanyFilter('active', ALL)).toBe('active');
		expect(parseCompanyFilter('nope', ALL)).toBe('all');
		expect(parseCompanyFilter(null, ALL)).toBe('all');
		expect(parseCompanyFilter('active', NONE)).toBe('all');
		expect(parseCompanyFilter('issues', { ...NONE, github: true })).toBe('issues');
		expect(parseCompanyFilter('overdue', { ...ALL, billing: false })).toBe('all');
		expect(parseCompanyFilter('overdue', { ...ALL, zoho: false })).toBe('all');
		expect(parseCompanyFilter('unlinked', NONE)).toBe('unlinked');
	});

	it('chip order and visibility follow the sources', () => {
		expect(visibleFilters(NONE).map((f) => f.key)).toEqual(['all', 'unlinked']);
		expect(visibleFilters(ALL).map((f) => f.key)).toEqual(['all', 'active', 'quiet', 'issues', 'overdue', 'unlinked']);
		expect(visibleFilters({ ...ALL, billing: false }).map((f) => f.key)).not.toContain('overdue');
	});

	it('every filter has a WHERE fragment without values', () => {
		expect(FILTER_SQL.all).toBeNull();
		for (const k of ['active', 'quiet', 'issues', 'overdue', 'unlinked'] as const) {
			expect(FILTER_SQL[k]).toBeTruthy();
			expect(FILTER_SQL[k]).not.toContain('?');
		}
	});

	it('default sort per filter, default direction per sort', () => {
		expect(defaultSortFor('all')).toBe('name');
		expect(defaultSortFor('active')).toBe('hours_30d');
		expect(defaultSortFor('quiet')).toBe('hours_30d');
		expect(defaultSortFor('issues')).toBe('open_issues');
		expect(defaultSortFor('overdue')).toBe('outstanding');
		expect(defaultSortFor('unlinked')).toBe('name');
		expect(defaultDirFor('name')).toBe('asc');
		expect(defaultDirFor('last_touch')).toBe('desc');
	});

	it('outstanding sort needs billing', () => {
		expect(parseCompanySort('outstanding', true)).toBe('outstanding');
		expect(parseCompanySort('outstanding', false)).toBe('name');
		expect(parseCompanySort('last_touch', false)).toBe('last_touch');
		expect(parseCompanySort('bogus', true)).toBeNull();
		expect(parseCompanySort(null, true)).toBeNull();
	});

	it('tile visibility for never synced / synced', () => {
		expect(tileVisibility(NONE)).toEqual({ active: false, quiet: false, issues: false, outstanding: false, invoiced: false });
		expect(tileVisibility(ALL)).toEqual({ active: true, quiet: true, issues: true, outstanding: true, invoiced: true });
		expect(tileVisibility({ ...ALL, billing: false }).outstanding).toBe(false);
		expect(billingVisible({ ...NONE, billing: true })).toBe(false);
	});

	it('dominantCurrency: single, mixed, none', () => {
		expect(dominantCurrency([{ currency: 'USD', n: 3 }])).toEqual({ currency: 'USD', mixed: false });
		expect(dominantCurrency([{ currency: 'EUR', n: 1 }, { currency: 'USD', n: 4 }])).toEqual({ currency: 'USD', mixed: true });
		expect(dominantCurrency([{ currency: 'USD', n: 2 }, { currency: 'EUR', n: 2 }])).toEqual({ currency: 'EUR', mixed: true });
		expect(dominantCurrency([])).toEqual({ currency: null, mixed: false });
		expect(dominantCurrency([{ currency: null, n: 5 }])).toEqual({ currency: null, mixed: false });
	});

	it('lastTouchSource picks the newest signal across formats', () => {
		expect(lastTouchSource({ last_activity_at: null, last_tracked_at: null, last_issue_at: null })).toBeNull();
		expect(
			lastTouchSource({ last_activity_at: '2026-10-01 10:00:00', last_tracked_at: '2026-10-05T09:00:00+00:00', last_issue_at: null })
		).toBe('timing');
		expect(
			lastTouchSource({ last_activity_at: '2026-10-06 10:00:00', last_tracked_at: '2026-10-05T09:00:00Z', last_issue_at: '2026-10-02T00:00:00Z' })
		).toBe('mail');
		expect(lastTouchSource({ last_activity_at: null, last_tracked_at: null, last_issue_at: '2026-10-02T00:00:00Z' })).toBe('github');
	});
});

async function company(name: string, metrics: Record<string, unknown> | null, opts: { timing?: boolean } = {}): Promise<number> {
	const r = await db
		.prepare('INSERT INTO companies (name, timing_project_id) VALUES (?, ?) RETURNING id')
		.bind(name, opts.timing ? '/projects/1' : null)
		.first<{ id: number }>();
	const id = r!.id;
	if (metrics) {
		const keys = Object.keys(metrics);
		await db
			.prepare(`INSERT INTO company_metrics (company_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`)
			.bind(id, ...keys.map((k) => metrics[k]))
			.run();
	}
	return id;
}

beforeEach(async () => {
	await setMemberAccess(db, false);
	await db.batch([
		db.prepare('DELETE FROM company_zoho_contacts'),
		db.prepare('DELETE FROM company_repos'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM companies'),
		db.prepare("DELETE FROM integration_secrets WHERE provider = 'zoho_books'")
	]);
});

describe('loadCompanyOverview + listCompanies (D1)', () => {
	it('never synced: hidden sources, zeros', async () => {
		await company('Plain', null);
		const ov = await loadCompanyOverview(db, { billing: true });
		expect(ov.total).toBe(1);
		expect(ov.linked).toBe(0);
		expect(ov.timing.synced).toBe(false);
		expect(ov.github.synced).toBe(false);
		expect(ov.zoho).toEqual({ synced: false, linked: 0, connected: false });
		expect(ov.billing).toBeNull();
	});

	it('rolls up Timing, GitHub and Zoho; filters + sorts', async () => {
		const now = '2026-10-20 00:00:00';
		const a = await company(
			'Acme',
			{ hours_7d: 2, hours_30d: 10, hours_90d: 20, timing_synced_at: now, last_tracked_at: '2026-10-19T12:00:00Z',
				ar_outstanding: 500, ar_overdue: 200, invoiced_12m: 1000, paid_12m: 800, billing_currency: 'USD', zoho_synced_at: now },
			{ timing: true }
		);
		const b = await company(
			'Beta',
			{ hours_7d: 0, hours_30d: 0, hours_90d: 5, timing_synced_at: now, issues_open: 4, issues_opened_30d: 3,
				issues_closed_30d: 1, github_synced_at: now, last_issue_at: '2026-10-21T00:00:00Z',
				ar_outstanding: 50, ar_overdue: 0, invoiced_12m: 100, paid_12m: 100, billing_currency: 'USD', zoho_synced_at: now },
			{ timing: true }
		);
		await company('Gamma', { ar_outstanding: 999, ar_overdue: 999, billing_currency: 'EUR', zoho_synced_at: now });
		const plain = await company('Zed', null);
		await db.prepare("INSERT INTO company_repos (company_id, owner, repo) VALUES (?, 'o', 'r')").bind(b).run();
		await db
			.prepare("INSERT INTO company_zoho_contacts (company_id, zoho_contact_id, contact_name) VALUES (?, 'z1', 'Gamma')")
			.bind((await db.prepare("SELECT id FROM companies WHERE name = 'Gamma'").first<{ id: number }>())!.id)
			.run();

		const ov = await loadCompanyOverview(db, { billing: true });
		expect(ov.total).toBe(4);
		expect(ov.linked).toBe(3);
		expect(ov.timing).toEqual({ synced: true, linked: 2 });
		expect(ov.github).toEqual({ synced: true, linked: 1 });
		expect(ov.zoho).toEqual({ synced: true, linked: 1, connected: false });
		expect(ov.active).toBe(1);
		expect(ov.quiet).toBe(1);
		expect(ov.hours30d).toBe(10);
		expect(ov.hours7d).toBe(2);
		expect(ov.issuesOpen).toBe(4);
		expect(ov.opened30d).toBe(3);
		expect(ov.closed30d).toBe(1);
		expect(ov.billing).toEqual({
			currency: 'USD', mixed: true, outstanding: 550, overdue: 200, overdueCount: 1, invoiced12m: 1100, paid12m: 900
		});
		expect((await loadCompanyOverview(db, { billing: false })).billing).toBeNull();

		const names = async (o: Parameters<typeof listCompanies>[1]) => (await listCompanies(db, o)).rows.map((r) => r.name);
		expect(await names({ filter: 'active' })).toEqual(['Acme']);
		expect(await names({ filter: 'quiet' })).toEqual(['Beta']);
		expect(await names({ filter: 'issues' })).toEqual(['Beta']);
		expect(await names({ filter: 'unlinked' })).toEqual(['Zed']);
		expect(await names({ filter: 'overdue', billing: true, sort: 'outstanding', dir: 'desc' })).toEqual(['Gamma', 'Acme']);
		// Without billing: the overdue filter is ignored and the outstanding sort falls back to name.
		expect(await names({ filter: 'overdue', sort: 'outstanding', dir: 'desc' })).toEqual(['Zed', 'Gamma', 'Beta', 'Acme']);
		expect(await names({ filter: 'active', q: 'zzz' })).toEqual([]);
		expect(await names({ sort: 'last_touch', dir: 'desc' })).toEqual(['Beta', 'Acme', 'Gamma', 'Zed']);

		const rows = (await listCompanies(db, {})).rows;
		const acme = rows.find((r) => r.id === a)!;
		expect(acme.last_touch_at).toBe('2026-10-19 12:00:00');
		expect(acme.linked).toBe(1);
		expect(rows.find((r) => r.id === plain)!.linked).toBe(0);
		expect('ar_outstanding' in acme).toBe(false);
		const withBilling = (await listCompanies(db, { billing: true })).rows.find((r) => r.id === a)!;
		expect(withBilling.ar_outstanding).toBe(500);

		// getCompany (company page, API) and the Data API shape stay billing-free.
		const one = await getCompany(db, a);
		expect(one && 'ar_outstanding' in one).toBe(false);
		expect(Object.keys(serializeCompany(one!))).not.toContain('ar_outstanding');
	});

	it('zoho connected = a sealed zoho_books row exists', async () => {
		await db
			.prepare("INSERT INTO integration_secrets (provider, blob, last4, set_at) VALUES ('zoho_books', 'v1.x', 'abcd', datetime('now'))")
			.run();
		expect((await loadCompanyOverview(db, { billing: false })).zoho.connected).toBe(true);
	});
});

describe('page load', () => {
	const admin = { id: 1, role: 'admin', login: 'a' };
	const member = { id: 2, role: 'member', login: 'm' };
	const ev = (qs: string, user: unknown) =>
		({ url: new URL(`https://crm.test/companies${qs}`), platform: { env: env as any }, locals: { user } }) as any;
	const BILLING_KEYS = ['ar_outstanding', 'ar_overdue', 'billing_currency', 'last_invoice_at', 'last_payment_at'];

	beforeEach(async () => {
		await company('Acme', {
			hours_30d: 1, timing_synced_at: '2026-10-20', ar_outstanding: 500, ar_overdue: 100,
			billing_currency: 'USD', zoho_synced_at: '2026-10-20', last_invoice_at: '2026-10-01'
		}, { timing: true });
	});

	it('strips every billing figure for a viewer without billing access', async () => {
		const data = (await load(ev('?filter=overdue&sort=outstanding', member))) as any;
		expect(data.billing).toBe(false);
		expect(data.filter).toBe('all');
		expect(data.sort).toBe('name');
		expect(data.overview.billing).toBeNull();
		expect(data.filters.map((f: { key: string }) => f.key)).not.toContain('overdue');
		expect(data.setup).toBeNull();
		for (const row of data.companies) for (const k of BILLING_KEYS) expect(k in row).toBe(false);
		const blob = JSON.stringify(data);
		for (const k of [...BILLING_KEYS, 'invoiced12m', 'outstanding']) expect(blob).not.toContain(`"${k}"`);
	});

	it('admin sees billing, the overdue filter and the setup line', async () => {
		const data = (await load(ev('?filter=overdue', admin))) as any;
		expect(data.billing).toBe(true);
		expect(data.filter).toBe('overdue');
		expect(data.sort).toBe('outstanding');
		expect(data.dir).toBe('desc');
		expect(data.overview.billing.outstanding).toBe(500);
		expect(data.companies[0].ar_outstanding).toBe(500);
		expect(data.setup).toEqual({ timing: 1, github: 0, zohoConnected: false, zoho: 0 });
	});

	it('members get billing once the setting allows it', async () => {
		await setMemberAccess(db, true);
		const data = (await load(ev('', member))) as any;
		expect(data.billing).toBe(true);
		expect(data.companies[0].ar_outstanding).toBe(500);
	});
});
