// Company reads (#166) — list, one, Data API shape. Split out of companies.ts (#287) so a
// read-only caller doesn't import its write path (which auto-enrolls).

import type { CompanyFilterKey, CompanySortKey } from '../company-overview';
import { activeContactSql } from './active-audience';
import { containsSql } from './sql-match';

export type Company = {
	id: number;
	name: string;
	domain: string | null;
	website: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
};

export type CompanyListRow = Company & {
	contact_count: number;
	/** Newest email event of a linked contact — deliveries and scanner clicks left out (#564). */
	last_activity_at: string | null;
	/** Timing hours in the last 30 days (#168); null when no project / never synced. */
	hours_30d: number | null;
	hours_7d: number | null;
	last_tracked_at: string | null;
	/** GitHub open issues across attached repos (#169) — null until synced. */
	issues_open: number | null;
	issues_opened_30d: number | null;
	issues_closed_30d: number | null;
	last_issue_at: string | null;
	/** Newest of last email event, Timing entry and GitHub issue activity (#436), 'YYYY-MM-DD HH:MM:SS'. */
	last_touch_at: string | null;
	/** 1 = a Timing project, a GitHub repo or a Zoho customer is attached (#436). */
	linked: number;
};

/** Zoho billing roll-ups (#353) — only selected when the caller asked for `billing` (#436). */
export type CompanyBillingCols = {
	ar_outstanding: number | null;
	ar_overdue: number | null;
	billing_currency: string | null;
	last_invoice_at: string | null;
	last_payment_at: string | null;
};

/** Nothing attached: no Timing project, no GitHub repo, no Zoho customer. */
export const UNLINKED_SQL = `(COALESCE(co.timing_project_id, '') = ''
	AND NOT EXISTS (SELECT 1 FROM company_repos r WHERE r.company_id = co.id)
	AND NOT EXISTS (SELECT 1 FROM company_zoho_contacts z WHERE z.company_id = co.id))`;

const LIST_FROM = `companies co LEFT JOIN company_metrics m ON m.company_id = co.id`;

// No billing columns here: getCompany's row reaches the company page for every viewer.
export const LIST_COLS = `co.id, co.name, co.domain, co.website, co.notes, co.created_at, co.updated_at,
	(SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id AND ${activeContactSql('c')}) AS contact_count,
	(SELECT MAX(e.recorded_at) FROM events e JOIN contacts c ON c.id = e.contact_id
	 WHERE c.company_id = co.id AND e.type NOT IN ('delivery', 'scanner_click')) AS last_activity_at,
	m.hours_30d, m.hours_7d, m.last_tracked_at,
	m.issues_open, m.issues_opened_30d, m.issues_closed_30d, m.last_issue_at,
	CASE WHEN ${UNLINKED_SQL} THEN 0 ELSE 1 END AS linked`;

const BILLING_COLS = `m.ar_outstanding, m.ar_overdue, m.billing_currency, m.last_invoice_at, m.last_payment_at`;

// Over the derived table `b`: normalised with datetime() so SQLite timestamps and ISO strings
// compare; a NULL source is ignored (billing dates deliberately left out — same for everyone).
const LAST_TOUCH_SQL = `NULLIF(MAX(COALESCE(datetime(b.last_activity_at), ''), COALESCE(datetime(b.last_tracked_at), ''),
	COALESCE(datetime(b.last_issue_at), '')), '') AS last_touch_at`;

/** `/companies?filter=` (#436) → WHERE fragment (no values). 'overdue' needs `billing`. */
export const FILTER_SQL: Record<CompanyFilterKey, string | null> = {
	all: null,
	active: 'm.hours_30d > 0',
	quiet: 'm.hours_90d > 0 AND m.hours_30d = 0',
	issues: 'm.issues_open > 0',
	overdue: 'm.ar_overdue > 0',
	unlinked: UNLINKED_SQL
};

export type CompanySort = CompanySortKey;

/**
 * Companies for /companies and GET /api/v1/companies — `q` matches name or domain, `filter` is
 * #436's whitelist. Billing columns, the `overdue` filter and the `outstanding` sort only with
 * `billing: true` (otherwise: no billing keys, filter → all, sort → name).
 */
export async function listCompanies(
	db: D1Database,
	opts: {
		q?: string;
		limit?: number;
		offset?: number;
		sort?: CompanySort;
		dir?: 'asc' | 'desc';
		filter?: CompanyFilterKey;
		billing?: boolean;
	} = {}
): Promise<{ rows: (CompanyListRow & Partial<CompanyBillingCols>)[]; total: number }> {
	const billing = opts.billing === true;
	const q = (opts.q ?? '').trim().slice(0, 100);
	const conds: string[] = [];
	const binds: string[] = [];
	if (q) {
		// #485: instr, not LIKE (D1 caps LIKE patterns at 50 bytes).
		conds.push(`(${containsSql('co.name')} OR ${containsSql("COALESCE(co.domain, '')")})`);
		binds.push(q, q);
	}
	let filter: CompanyFilterKey = opts.filter && opts.filter in FILTER_SQL ? opts.filter : 'all';
	if (filter === 'overdue' && !billing) filter = 'all';
	const frag = FILTER_SQL[filter];
	if (frag) conds.push(`(${frag})`);
	const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
	const limit = opts.limit ?? 500;
	const offset = opts.offset ?? 0;
	const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';
	const sort = opts.sort === 'outstanding' && !billing ? 'name' : opts.sort;
	// Numbers / dates: never-synced companies sort last either way, ties by name.
	const nullsLast = (col: string) => `${col} IS NULL, ${col} ${dir}, name COLLATE NOCASE`;
	const order =
		sort === 'hours_30d'
			? nullsLast('hours_30d')
			: sort === 'open_issues'
				? nullsLast('issues_open')
				: sort === 'outstanding'
					? nullsLast('ar_outstanding')
					: sort === 'last_touch'
						? nullsLast('last_touch_at')
						: `name COLLATE NOCASE ${dir}`;
	const cols = billing ? `${LIST_COLS}, ${BILLING_COLS}` : LIST_COLS;
	const [rows, total] = await Promise.all([
		db
			.prepare(
				`SELECT b.*, ${LAST_TOUCH_SQL} FROM (SELECT ${cols} FROM ${LIST_FROM} ${where}) b
				 ORDER BY ${order} LIMIT ? OFFSET ?`
			)
			.bind(...binds, limit, offset)
			.all<CompanyListRow & Partial<CompanyBillingCols>>(),
		db.prepare(`SELECT COUNT(*) AS n FROM ${LIST_FROM} ${where}`).bind(...binds).first<{ n: number }>()
	]);
	return { rows: rows.results, total: total?.n ?? 0 };
}

export async function getCompany(db: D1Database, id: number): Promise<CompanyListRow | null> {
	return db
		.prepare(`SELECT b.*, ${LAST_TOUCH_SQL} FROM (SELECT ${LIST_COLS} FROM ${LIST_FROM} WHERE co.id = ?) b`)
		.bind(id)
		.first<CompanyListRow>();
}

/** Data API (#71) shape for a company row. */
export function serializeCompany(r: CompanyListRow) {
	return {
		id: r.id,
		name: r.name,
		domain: r.domain,
		website: r.website,
		notes: r.notes,
		contact_count: r.contact_count,
		last_activity_at: r.last_activity_at,
		created_at: r.created_at,
		updated_at: r.updated_at
	};
}
