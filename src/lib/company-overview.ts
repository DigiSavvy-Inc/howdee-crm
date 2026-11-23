// /companies overview (#436) — filter vocabulary, sort defaults, tile visibility, currency and
// last-touch helpers. Pure (client- and server-safe); the SQL lives in
// $lib/server/company-read.ts (filters) and $lib/server/company-overview.ts (the strip).

export type CompanyFilterKey = 'all' | 'active' | 'quiet' | 'issues' | 'overdue' | 'unlinked';
export type CompanySortKey = 'name' | 'hours_30d' | 'open_issues' | 'outstanding' | 'last_touch';

/**
 * Which sources have ever synced for any company (a `*_synced_at` set), and whether this viewer
 * may see billing (`canSeeBilling`). Drives which tiles, chips and columns exist.
 */
export type SourceState = { timing: boolean; github: boolean; zoho: boolean; billing: boolean };

type Needs = 'none' | 'timing' | 'github' | 'billing';

export const COMPANY_FILTERS: { key: CompanyFilterKey; label: string; needs: Needs; sort: CompanySortKey }[] = [
	{ key: 'all', label: 'All', needs: 'none', sort: 'name' },
	{ key: 'active', label: 'Active 30d', needs: 'timing', sort: 'hours_30d' },
	{ key: 'quiet', label: 'Going quiet', needs: 'timing', sort: 'hours_30d' },
	{ key: 'issues', label: 'Open issues', needs: 'github', sort: 'open_issues' },
	{ key: 'overdue', label: 'Overdue', needs: 'billing', sort: 'outstanding' },
	{ key: 'unlinked', label: 'Not linked', needs: 'none', sort: 'name' }
];

/** Billing figures (tiles, the Outstanding column, the overdue filter, the outstanding sort). */
export function billingVisible(s: SourceState): boolean {
	return s.billing && s.zoho;
}

function allowed(needs: Needs, s: SourceState): boolean {
	if (needs === 'timing') return s.timing;
	if (needs === 'github') return s.github;
	if (needs === 'billing') return billingVisible(s);
	return true;
}

export function visibleFilters(s: SourceState) {
	return COMPANY_FILTERS.filter((f) => allowed(f.needs, s));
}

export function filterLabel(key: CompanyFilterKey): string {
	return COMPANY_FILTERS.find((f) => f.key === key)?.label ?? 'All';
}

/** `?filter=` → a whitelisted key; unknown or not permitted → 'all' (never an error). */
export function parseCompanyFilter(raw: string | null | undefined, s: SourceState): CompanyFilterKey {
	const f = COMPANY_FILTERS.find((x) => x.key === raw);
	return f && allowed(f.needs, s) ? f.key : 'all';
}

/** The sort a filter opens with when no `?sort=` is given. */
export function defaultSortFor(filter: CompanyFilterKey): CompanySortKey {
	return COMPANY_FILTERS.find((f) => f.key === filter)?.sort ?? 'name';
}

/** Name A→Z; every number / date most first. */
export function defaultDirFor(sort: CompanySortKey): 'asc' | 'desc' {
	return sort === 'name' ? 'asc' : 'desc';
}

const SORTS: CompanySortKey[] = ['name', 'hours_30d', 'open_issues', 'outstanding', 'last_touch'];

/** `?sort=` → a key, or null when absent/unknown. `outstanding` only with billing visible. */
export function parseCompanySort(raw: string | null | undefined, billing: boolean): CompanySortKey | null {
	const k = SORTS.find((x) => x === raw);
	if (!k) return null;
	if (k === 'outstanding' && !billing) return 'name';
	return k;
}

/** Which overview tiles exist for these sources (Companies is always shown). */
export function tileVisibility(s: SourceState) {
	return {
		active: s.timing,
		quiet: s.timing,
		issues: s.github,
		outstanding: billingVisible(s),
		invoiced: billingVisible(s)
	};
}

/**
 * The currency to sum billing in: the most common non-null one (ties → alphabetical).
 * `mixed` = more than one currency exists, so some amounts are left out of the sums.
 */
export function dominantCurrency(rows: { currency: string | null; n: number }[]): { currency: string | null; mixed: boolean } {
	const real = rows.filter((r) => r.currency && r.n > 0) as { currency: string; n: number }[];
	if (real.length === 0) return { currency: null, mixed: false };
	const top = [...real].sort((a, b) => b.n - a.n || a.currency.localeCompare(b.currency))[0];
	return { currency: top.currency, mixed: real.length > 1 };
}

/** A stored timestamp (SQLite 'YYYY-MM-DD HH:MM:SS' = UTC, or ISO with a zone) → ms, or null. */
function toMs(v: string | null | undefined): number | null {
	if (!v) return null;
	const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

export type LastTouchSource = 'mail' | 'timing' | 'github';

export const LAST_TOUCH_LABELS: Record<LastTouchSource, string> = {
	mail: 'Last email activity',
	timing: 'Last Timing entry',
	github: 'Last GitHub issue activity'
};

/** Which signal "Last touch" came from — the newest of email, Timing and GitHub (ties: that order). */
export function lastTouchSource(r: {
	last_activity_at: string | null;
	last_tracked_at: string | null;
	last_issue_at: string | null;
}): LastTouchSource | null {
	const cands: [LastTouchSource, number | null][] = [
		['mail', toMs(r.last_activity_at)],
		['timing', toMs(r.last_tracked_at)],
		['github', toMs(r.last_issue_at)]
	];
	let best: LastTouchSource | null = null;
	let bestT = -Infinity;
	for (const [k, t] of cands) {
		if (t !== null && t > bestT) {
			best = k;
			bestT = t;
		}
	}
	return best;
}
