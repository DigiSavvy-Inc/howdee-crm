// /companies overview strip (#436): one aggregate query over companies / company_metrics /
// company_repos / company_zoho_contacts (+ whether a sealed zoho_books secret exists). Covers
// every company — not the page's search or filter. Billing sums only with `billing: true`.

import { dominantCurrency, type SourceState } from '../company-overview';
import { UNLINKED_SQL } from './company-read';
import { ZOHO_PROVIDER } from './integrations/secrets';

export type CompanyOverviewBilling = {
	currency: string | null;
	/** More than one currency exists — only `currency` rows are summed. */
	mixed: boolean;
	outstanding: number;
	overdue: number;
	overdueCount: number;
	invoiced12m: number;
	paid12m: number;
};

export type CompanyOverview = {
	total: number;
	/** Companies with a Timing project, a GitHub repo or a Zoho customer attached. */
	linked: number;
	timing: { synced: boolean; linked: number };
	github: { synced: boolean; linked: number };
	/** connected = a sealed zoho_books row exists (Settings → Integrations' Connect). */
	zoho: { synced: boolean; linked: number; connected: boolean };
	active: number;
	quiet: number;
	hours30d: number;
	hours7d: number;
	issuesOpen: number;
	opened30d: number;
	closed30d: number;
	/** null when billing isn't visible or Zoho never synced. */
	billing: CompanyOverviewBilling | null;
};

type Row = {
	total: number;
	linked: number;
	timing_linked: number;
	github_linked: number;
	zoho_linked: number;
	zoho_connected: number;
	timing_synced: number;
	github_synced: number;
	zoho_synced: number;
	active: number | null;
	quiet: number | null;
	hours_30d: number | null;
	hours_7d: number | null;
	issues_open: number | null;
	opened_30d: number | null;
	closed_30d: number | null;
	currencies: string | null;
};

type CurrencyRow = {
	currency: string;
	n: number;
	outstanding: number | null;
	overdue: number | null;
	overdue_n: number | null;
	invoiced: number | null;
	paid: number | null;
};

export async function loadCompanyOverview(db: D1Database, opts: { billing: boolean }): Promise<CompanyOverview> {
	// Per-currency billing sums ride along as JSON so this stays one round-trip.
	const currencies = opts.billing
		? `(SELECT json_group_array(json_object('currency', c, 'n', n, 'outstanding', outstanding, 'overdue', overdue,
				'overdue_n', overdue_n, 'invoiced', invoiced, 'paid', paid))
			FROM (SELECT billing_currency AS c, COUNT(*) AS n, SUM(ar_outstanding) AS outstanding, SUM(ar_overdue) AS overdue,
				SUM(ar_overdue > 0) AS overdue_n, SUM(invoiced_12m) AS invoiced, SUM(paid_12m) AS paid
				FROM company_metrics WHERE billing_currency IS NOT NULL GROUP BY billing_currency))`
		: 'NULL';
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM companies) AS total,
				(SELECT COUNT(*) FROM companies co WHERE NOT ${UNLINKED_SQL}) AS linked,
				(SELECT COUNT(*) FROM companies WHERE COALESCE(timing_project_id, '') <> '') AS timing_linked,
				(SELECT COUNT(DISTINCT company_id) FROM company_repos) AS github_linked,
				(SELECT COUNT(DISTINCT company_id) FROM company_zoho_contacts) AS zoho_linked,
				EXISTS (SELECT 1 FROM integration_secrets WHERE provider = ?) AS zoho_connected,
				COUNT(m.timing_synced_at) AS timing_synced,
				COUNT(m.github_synced_at) AS github_synced,
				COUNT(m.zoho_synced_at) AS zoho_synced,
				SUM(m.hours_30d > 0) AS active,
				SUM(m.hours_90d > 0 AND m.hours_30d = 0) AS quiet,
				SUM(m.hours_30d) AS hours_30d,
				SUM(m.hours_7d) AS hours_7d,
				SUM(m.issues_open) AS issues_open,
				SUM(m.issues_opened_30d) AS opened_30d,
				SUM(m.issues_closed_30d) AS closed_30d,
				${currencies} AS currencies
			 FROM company_metrics m`
		)
		.bind(ZOHO_PROVIDER)
		.first<Row>();
	const r = row as Row;
	const zohoSynced = r.zoho_synced > 0;
	let billing: CompanyOverviewBilling | null = null;
	if (opts.billing && zohoSynced) {
		const list = r.currencies ? (JSON.parse(r.currencies) as CurrencyRow[]) : [];
		const { currency, mixed } = dominantCurrency(list);
		const top = list.find((c) => c.currency === currency);
		billing = {
			currency,
			mixed,
			outstanding: top?.outstanding ?? 0,
			overdue: top?.overdue ?? 0,
			overdueCount: top?.overdue_n ?? 0,
			invoiced12m: top?.invoiced ?? 0,
			paid12m: top?.paid ?? 0
		};
	}
	return {
		total: r.total,
		linked: r.linked,
		timing: { synced: r.timing_synced > 0, linked: r.timing_linked },
		github: { synced: r.github_synced > 0, linked: r.github_linked },
		zoho: { synced: zohoSynced, linked: r.zoho_linked, connected: r.zoho_connected === 1 },
		active: r.active ?? 0,
		quiet: r.quiet ?? 0,
		hours30d: r.hours_30d ?? 0,
		hours7d: r.hours_7d ?? 0,
		issuesOpen: r.issues_open ?? 0,
		opened30d: r.opened_30d ?? 0,
		closed30d: r.closed_30d ?? 0,
		billing
	};
}

/** The tile / chip / column switches for this overview + viewer. */
export function sourceState(ov: CompanyOverview, billing: boolean): SourceState {
	return { timing: ov.timing.synced, github: ov.github.synced, zoho: ov.zoho.synced, billing };
}
