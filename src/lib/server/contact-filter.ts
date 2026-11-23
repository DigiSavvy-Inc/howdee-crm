/**
 * Filtering / sorting for the members of a list, segment or tag.
 *
 * Used by `/lists/[id]`: the same filter is parsed from the URL (for the table) and
 * from a form POST (so a bulk action can re-resolve "all N matching", not just the
 * checked rows on the current page).
 */

import { parseMetricConditions, serializeMetricConditions, type MetricCondition } from '$lib/company-metrics';
import { metricClause } from './company-metrics';
import { formSubmittedClause } from './form-reads';
import { parseFormFilter, type FormFilter } from './contacts-query';
import { activeContactSql } from './active-audience';

// pending = double opt-in not confirmed yet (#510). #705: a group's members are always the active
// audience (active-audience.ts), so 'all' = subscribed or pending and there is no 'unsubscribed' —
// unsubscribed members are only found on /contacts (Status filter + In group).
export type StatusFilter = 'all' | 'subscribed' | 'pending';
export type SortKey = 'added' | 'email' | 'name' | 'created' | 'status';
export type SortDir = 'asc' | 'desc';

export type MemberFilter = {
	q: string;
	status: StatusFilter;
	source: string;
	addedFrom: string; // YYYY-MM-DD (inclusive)
	addedTo: string; // YYYY-MM-DD (inclusive)
	inGroup: number | null; // also a member of this list/segment/tag
	notInGroup: number | null; // NOT a member of this list/segment/tag
	hasCompany: 'yes' | 'no' | ''; // #170: linked to any companies row / to none
	metrics: MetricCondition[]; // #170: company metric conditions (`cm`), ALL must match
	form: FormFilter | null; // #516: `form=any|<id>` submitted a form…
	formDays: number | null; // …in the last N days (`form_days`)
	sort: SortKey;
	dir: SortDir;
};

export const DEFAULT_SORT: SortKey = 'added';
export const DEFAULT_DIR: SortDir = 'desc';

const SORTS: SortKey[] = ['added', 'email', 'name', 'created', 'status'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Anything that can hand back a raw string param (URLSearchParams, FormData). */
type Source = { get(key: string): string | File | null; getAll?(key: string): (string | File)[] };

function str(src: Source, key: string, max = 120): string {
	const v = src.get(key);
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function groupId(src: Source, key: string): number | null {
	const n = Number(str(src, key));
	return Number.isInteger(n) && n > 0 ? n : null;
}

function isoDate(src: Source, key: string): string {
	const v = str(src, key, 10);
	return ISO_DATE.test(v) ? v : '';
}

function formDays(src: Source): number | null {
	const n = Number(str(src, 'form_days', 6));
	return Number.isInteger(n) && n > 0 ? Math.min(n, 3650) : null;
}

export function parseFilter(src: Source): MemberFilter {
	const status = str(src, 'status');
	const sort = str(src, 'sort') as SortKey;
	return {
		q: str(src, 'q'),
		status: status === 'subscribed' || status === 'pending' ? status : 'all',
		source: str(src, 'source'),
		addedFrom: isoDate(src, 'added_from'),
		addedTo: isoDate(src, 'added_to'),
		inGroup: groupId(src, 'in'),
		notInGroup: groupId(src, 'notin'),
		hasCompany: str(src, 'has_company') === 'yes' ? 'yes' : str(src, 'has_company') === 'no' ? 'no' : '',
		metrics: parseMetricConditions(src),
		form: parseFormFilter(str(src, 'form', 12)),
		formDays: parseFormFilter(str(src, 'form', 12)) ? formDays(src) : null,
		sort: SORTS.includes(sort) ? sort : DEFAULT_SORT,
		dir: str(src, 'dir') === 'asc' ? 'asc' : 'desc'
	};
}

export function emptyFilter(): MemberFilter {
	return {
		q: '',
		status: 'all',
		source: '',
		addedFrom: '',
		addedTo: '',
		inGroup: null,
		notInGroup: null,
		hasCompany: '',
		metrics: [],
		form: null,
		formDays: null,
		sort: DEFAULT_SORT,
		dir: DEFAULT_DIR
	};
}

/** True when the filter actually narrows the member set (sorting doesn't count). */
export function isFiltered(f: MemberFilter): boolean {
	return !!(
		f.q ||
		f.source ||
		f.addedFrom ||
		f.addedTo ||
		f.inGroup ||
		f.notInGroup ||
		f.hasCompany ||
		f.metrics.length ||
		f.form ||
		f.status !== 'all'
	);
}

/** Serialize back to URL params — for pagination links and form round-trips. */
export function filterParams(f: MemberFilter): Record<string, string> {
	const p: Record<string, string> = {};
	if (f.q) p.q = f.q;
	if (f.status !== 'all') p.status = f.status;
	if (f.source) p.source = f.source;
	if (f.addedFrom) p.added_from = f.addedFrom;
	if (f.addedTo) p.added_to = f.addedTo;
	if (f.inGroup) p.in = String(f.inGroup);
	if (f.notInGroup) p.notin = String(f.notInGroup);
	if (f.hasCompany) p.has_company = f.hasCompany;
	if (f.metrics.length) p.cm = serializeMetricConditions(f.metrics);
	if (f.form) p.form = String(f.form);
	if (f.form && f.formDays) p.form_days = String(f.formDays);
	if (f.sort !== DEFAULT_SORT) p.sort = f.sort;
	if (f.dir !== DEFAULT_DIR) p.dir = f.dir;
	return p;
}

/** `%term%` with LIKE wildcards in the user's text escaped (paired with ESCAPE '\'). */
function like(term: string): string {
	return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const ORDER_EXPR: Record<SortKey, string> = {
	added: 'lm.added_at',
	email: 'c.email',
	name: "COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(c.first_name || ' ' || COALESCE(c.last_name, '')), ''), c.email)",
	created: 'c.created_at',
	status: 'c.subscribed'
};

/**
 * SQL fragments for `FROM list_members lm JOIN contacts c ON c.id = lm.contact_id`.
 * `where` always starts with the list itself, so it's safe to interpolate directly.
 */
export function memberQuery(
	listId: number,
	f: MemberFilter
): { where: string; params: (string | number)[]; orderBy: string } {
	// #280 / #705: archived and unsubscribed contacts are hidden from member tables (and bulk
	// "all matching") — the active-audience rule.
	const clauses = ['lm.list_id = ?', activeContactSql('c')];
	const params: (string | number)[] = [listId];

	if (f.q) {
		clauses.push(
			`(c.email LIKE ? ESCAPE '\\' OR COALESCE(c.name, '') LIKE ? ESCAPE '\\'
			  OR COALESCE(c.first_name, '') LIKE ? ESCAPE '\\'
			  OR COALESCE(c.last_name, '') LIKE ? ESCAPE '\\'
			  OR COALESCE(c.company, '') LIKE ? ESCAPE '\\'
			  OR COALESCE((SELECT co.name FROM companies co WHERE co.id = c.company_id), '') LIKE ? ESCAPE '\\')`
		);
		// #583: the search also matches the company text and the linked company's name.
		const term = like(f.q);
		params.push(term, term, term, term, term, term);
	}
	if (f.status === 'subscribed') clauses.push('c.subscribed = 1');
	if (f.status === 'pending') clauses.push('c.subscribed = 0 AND c.confirm_pending = 1');
	if (f.source) {
		clauses.push(`COALESCE(c.source, '') LIKE ? ESCAPE '\\'`);
		params.push(like(f.source));
	}
	if (f.addedFrom) {
		clauses.push('date(lm.added_at) >= ?');
		params.push(f.addedFrom);
	}
	if (f.addedTo) {
		clauses.push('date(lm.added_at) <= ?');
		params.push(f.addedTo);
	}
	if (f.inGroup) {
		clauses.push('EXISTS (SELECT 1 FROM list_members x WHERE x.contact_id = c.id AND x.list_id = ?)');
		params.push(f.inGroup);
	}
	if (f.notInGroup) {
		clauses.push(
			'NOT EXISTS (SELECT 1 FROM list_members x WHERE x.contact_id = c.id AND x.list_id = ?)'
		);
		params.push(f.notInGroup);
	}
	if (f.hasCompany === 'yes') clauses.push('c.company_id IS NOT NULL');
	if (f.hasCompany === 'no') clauses.push('c.company_id IS NULL');
	for (const cond of f.metrics) {
		const m = metricClause(cond, 'c.company_id');
		if (m) {
			clauses.push(m.clause);
			params.push(...m.binds);
		}
	}

	// #516: the same clause as the `form_submitted` segment rule.
	if (f.form) {
		const fc = formSubmittedClause('c.id', f.form === 'any' ? null : f.form, f.formDays);
		clauses.push(fc.clause);
		params.push(...fc.binds);
	}

	const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
	return {
		where: clauses.join(' AND '),
		params,
		orderBy: `${ORDER_EXPR[f.sort]} ${dir}, c.id DESC`
	};
}
