// #445: Zoho billing + closed-issue metrics in the company-metric vocabulary — groups, the
// billing visibility helper, SQL for money / billing-date conditions, money merge values, and
// the "Company metric crossed" trigger after a Zoho Books sync.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	BILLING_HIDDEN_LABEL,
	COMPANY_MERGE_KEYS,
	COMPANY_METRICS,
	TRIGGER_METRICS,
	conditionLabel,
	formatMergeValue,
	groupMetrics,
	metricDef,
	triggerLabel,
	visibleMetrics
} from '../src/lib/company-metrics';
import { companyMergeFields, metricClause } from '../src/lib/server/company-metrics';
import { evaluateMetricCrossings } from '../src/lib/server/metric-trigger';
import { runProviderSync, zohoBooksProvider } from '../src/lib/server/integrations';
import { clearZohoTokenCache, linkCustomer } from '../src/lib/server/integrations/zoho';
import type { ZohoEnv } from '../src/lib/server/integrations/secrets';
import { parseReportSpec } from '../src/lib/report-spec';

const db = (env as any).DB as D1Database;

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
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM zoho_invoices'),
		db.prepare('DELETE FROM zoho_payments'),
		db.prepare('DELETE FROM company_zoho_contacts'),
		db.prepare('DELETE FROM integration_syncs'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'integration_%' OR key LIKE 'zoho_books%'`),
		db.prepare('DELETE FROM company_metrics_prev'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

async function company(name: string, metrics: Record<string, number | string | null> = {}): Promise<number> {
	const r = await db.prepare('INSERT INTO companies (name, domain) VALUES (?, ?) RETURNING id').bind(name, `${name.toLowerCase()}.test`).first<{ id: number }>();
	await db.prepare('INSERT OR IGNORE INTO company_metrics (company_id) VALUES (?)').bind(r!.id).run();
	for (const [k, v] of Object.entries(metrics)) {
		await db.prepare(`UPDATE company_metrics SET ${k} = ? WHERE company_id = ?`).bind(v, r!.id).run();
	}
	return r!.id;
}

async function contact(email: string, companyId: number | null): Promise<number> {
	const r = await db.prepare('INSERT INTO contacts (email, company_id, subscribed) VALUES (?, ?, 1) RETURNING id').bind(email, companyId).first<{ id: number }>();
	return r!.id;
}

async function matching(cond: { metric: string; op: string; value: number }): Promise<string[]> {
	const m = metricClause(cond, 'c.company_id')!;
	const rows = await db.prepare(`SELECT email FROM contacts c WHERE ${m.clause} ORDER BY email`).bind(...m.binds).all<{ email: string }>();
	return rows.results.map((r) => r.email);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

describe('vocabulary', () => {
	it('has the billing and closed-issue metrics, grouped by source', () => {
		expect(metricDef('ar_outstanding')).toMatchObject({ label: 'Outstanding balance', kind: 'number', group: 'billing', format: 'money' });
		expect(metricDef('ar_overdue')).toMatchObject({ label: 'Overdue balance', group: 'billing', format: 'money' });
		expect(metricDef('invoiced_12m')).toMatchObject({ label: 'Invoiced (12 months)', format: 'money' });
		expect(metricDef('paid_12m')).toMatchObject({ label: 'Paid (12 months)', format: 'money' });
		expect(metricDef('last_payment_at')).toMatchObject({ label: 'Last payment', kind: 'date', group: 'billing' });
		expect(metricDef('last_invoice_at')).toMatchObject({ label: 'Last invoice', kind: 'date', group: 'billing' });
		expect(metricDef('issues_closed')).toMatchObject({ label: 'Closed issues (all time)', kind: 'number', group: 'github' });
		expect(metricDef('hours_30d')?.group).toBe('timing');
		expect(COMPANY_METRICS.every((m) => ['timing', 'github', 'billing'].includes(m.group))).toBe(true);
		expect(groupMetrics(COMPANY_METRICS).map((g) => g.label)).toEqual(['Timing', 'GitHub', 'Billing']);
	});

	it('visibleMetrics(false) hides the billing group', () => {
		expect(visibleMetrics(false).some((m) => m.group === 'billing')).toBe(false);
		expect(visibleMetrics(false).some((m) => m.key === 'issues_closed')).toBe(true);
		expect(visibleMetrics(true)).toHaveLength(COMPANY_METRICS.length);
	});

	it('trigger metrics include the numeric billing keys, not the dates', () => {
		const keys = TRIGGER_METRICS.map((m) => m.key);
		expect(keys).toEqual(expect.arrayContaining(['ar_outstanding', 'ar_overdue', 'invoiced_12m', 'paid_12m', 'issues_closed']));
		expect(keys).not.toContain('last_payment_at');
	});

	it('labels hide a billing metric without billing access', () => {
		const c = { metric: 'ar_overdue', op: 'gt', value: 1000 };
		expect(conditionLabel(c)).toBe('Overdue balance > 1000');
		expect(conditionLabel(c, { billing: false })).toBe(BILLING_HIDDEN_LABEL);
		expect(conditionLabel({ metric: 'issues_open', op: 'gt', value: 3 }, { billing: false })).toBe('Open issues > 3');
		expect(triggerLabel('ar_overdue', 'above', 1000)).toBe('Overdue balance crosses above 1000');
		expect(triggerLabel('ar_overdue', 'above', 1000, { billing: false })).not.toContain('1000');
	});

	it('reports still refuse the billing metrics', () => {
		const spec = (field: string) => ({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			columns: ['name'],
			entityFilters: [{ field, op: 'gt', value: '1' }]
		});
		expect(() => parseReportSpec(spec('issues_closed'))).not.toThrow();
		expect(() => parseReportSpec(spec('ar_overdue'))).toThrow(/Unknown filter/);
	});
});

describe('metricClause', () => {
	it('a money metric compares the stored number', async () => {
		const big = await company('Big', { ar_overdue: 1500 });
		const small = await company('Small', { ar_overdue: 200 });
		const none = await company('None');
		await contact('big@x.test', big);
		await contact('small@x.test', small);
		await contact('none@x.test', none);
		await contact('solo@x.test', null);
		expect(await matching({ metric: 'ar_overdue', op: 'gt', value: 1000 })).toEqual(['big@x.test']);
		expect(await matching({ metric: 'ar_overdue', op: 'lte', value: 1000 })).toEqual(['small@x.test']);
	});

	it('a billing date metric: no payment in 60 days', async () => {
		const late = await company('Late', { last_payment_at: daysAgo(90) });
		const recent = await company('Recent', { last_payment_at: daysAgo(10) });
		await contact('late@x.test', late);
		await contact('recent@x.test', recent);
		expect(await matching({ metric: 'last_payment_at', op: 'older', value: 60 })).toEqual(['late@x.test']);
		expect(await matching({ metric: 'last_payment_at', op: 'within', value: 60 })).toEqual(['recent@x.test']);
	});
});

describe('{{company.*}} money keys', () => {
	it('formatMergeValue formats money in the currency, blank when null', () => {
		expect(COMPANY_MERGE_KEYS).toEqual(expect.arrayContaining(['ar_outstanding', 'ar_overdue', 'invoiced_12m', 'paid_12m', 'last_payment_at', 'last_invoice_at']));
		expect(formatMergeValue('ar_overdue', 1234.5, 'USD')).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(1234.5));
		expect(formatMergeValue('ar_overdue', 1234.5, 'USD')).toContain('1,234.50');
		expect(formatMergeValue('ar_overdue', null, 'USD')).toBe('');
		expect(formatMergeValue('last_payment_at', '2026-09-01 10:00:00')).toBe('2026-09-01');
		expect(formatMergeValue('hours_30d', 3.14159)).toBe('3.1');
	});

	it('companyMergeFields uses the company billing currency', async () => {
		const co = await company('Acme', { ar_overdue: 250, billing_currency: 'EUR', issues_closed: 7 });
		const cid = await contact('a@x.test', co);
		const vals = (await companyMergeFields(db, [cid])).get(cid)!;
		expect(vals.ar_overdue).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(250));
		expect(vals.ar_outstanding).toBe('');
		expect(vals.issues_closed).toBe('7');
	});
});

describe('crossing trigger on a billing metric', () => {
	async function overdueAutomation(threshold = 1000): Promise<number> {
		const a = await db
			.prepare(
				`INSERT INTO automations (name, status, trigger_type, trigger_metric, trigger_direction, trigger_threshold)
				 VALUES ('Dunning', 'active', 'company_metric', 'ar_overdue', 'above', ?) RETURNING id`
			)
			.bind(threshold)
			.first<{ id: number }>();
		await db
			.prepare(`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email)
			          VALUES (?, 0, 'tag', 'add', 'dunning', '', '', '')`)
			.bind(a!.id)
			.run();
		return a!.id;
	}
	const enrolledCount = async (aid: number) =>
		(await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?').bind(aid).first<{ n: number }>())!.n;

	it('ar_overdue below → above enrolls once, not on the next unchanged evaluation', async () => {
		const aid = await overdueAutomation();
		const co = await company('Acme', { ar_overdue: 400 });
		await contact('billing@acme.test', co);
		await evaluateMetricCrossings(db); // baseline
		expect(await enrolledCount(aid)).toBe(0);
		await db.prepare('UPDATE company_metrics SET ar_overdue = 1500 WHERE company_id = ?').bind(co).run();
		const res = await evaluateMetricCrossings(db);
		expect(res.crossings).toBe(1);
		expect(await enrolledCount(aid)).toBe(1);
		const again = await evaluateMetricCrossings(db);
		expect(again.crossings).toBe(0);
		expect(await enrolledCount(aid)).toBe(1);
	});

	it('a Zoho Books sync runs the crossing check', async () => {
		const aid = await overdueAutomation();
		const co = await company('Acme');
		await contact('billing@acme.test', co);
		await linkCustomer(db, co, { zoho_contact_id: '501', contact_name: 'Acme Inc' }, null);

		let balance = 400;
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		const f = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.hostname.startsWith('accounts.zoho.')) return json({ access_token: 'acc-token', expires_in: 3600 });
			const page_context = { page: 1, has_more_page: false };
			if (url.pathname.endsWith('/invoices')) {
				return json({
					code: 0,
					invoices: [
						{
							invoice_id: '1',
							invoice_number: 'INV-1',
							status: 'overdue',
							date: daysAgo(60),
							due_date: daysAgo(30),
							total: balance,
							balance,
							currency_code: 'USD',
							last_modified_time: new Date().toISOString()
						}
					],
					page_context
				});
			}
			if (url.pathname.endsWith('/customerpayments')) return json({ code: 0, customerpayments: [], page_context });
			if (url.pathname.endsWith('/contacts')) return json({ code: 0, contacts: [], page_context });
			return json({ code: 1, message: 'not found' }, 404);
		}) as typeof fetch;

		const first = await runProviderSync(db, { ZOHO_BOOKS: ZENV }, zohoBooksProvider, 'manual', { fetch: f });
		expect('ok' in first && first.ok).toBe(true);
		expect((await db.prepare('SELECT ar_overdue FROM company_metrics WHERE company_id = ?').bind(co).first<{ ar_overdue: number }>())!.ar_overdue).toBe(400);
		expect(await enrolledCount(aid)).toBe(0); // baseline

		balance = 1500;
		await runProviderSync(db, { ZOHO_BOOKS: ZENV }, zohoBooksProvider, 'manual', { fetch: f });
		expect((await db.prepare('SELECT ar_overdue FROM company_metrics WHERE company_id = ?').bind(co).first<{ ar_overdue: number }>())!.ar_overdue).toBe(1500);
		expect(await enrolledCount(aid)).toBe(1);

		await runProviderSync(db, { ZOHO_BOOKS: ZENV }, zohoBooksProvider, 'manual', { fetch: f });
		expect(await enrolledCount(aid)).toBe(1);
	});
});
