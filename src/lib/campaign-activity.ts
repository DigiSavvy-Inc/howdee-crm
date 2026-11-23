// Campaign page Activity panel (#529): filter + row-count vocabulary, parsed from the URL.
// Universal (client- and server-safe). The SQL lives in $lib/server/campaign-activity.ts.

export const ACTIVITY_FILTERS = [
	{ key: 'all', label: 'All', empty: 'events' },
	{ key: 'opens', label: 'Opens', empty: 'opens' },
	{ key: 'clicks', label: 'Clicks', empty: 'clicks' },
	{ key: 'unsubscribes', label: 'Unsubscribes', empty: 'unsubscribes' },
	{ key: 'bounces', label: 'Bounces', empty: 'bounces' }
] as const;

export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]['key'];

/** Event types per filter; `null` = every type except scanner_click (#518). */
export const ACTIVITY_TYPES: Record<ActivityFilter, readonly string[] | null> = {
	all: null,
	opens: ['open'],
	clicks: ['click'],
	unsubscribes: ['unsubscribe', 'unsubscribe_click'],
	bounces: ['bounce', 'spam']
};

export const ACTIVITY_SIZES = [10, 25, 50] as const;
export const ACTIVITY_DEFAULT_SIZE = 10;
export const ACTIVITY_MAX_ROWS = 50;

/** `?activity=` → a known filter, else `all`. */
export function parseActivityFilter(v: string | null | undefined): ActivityFilter {
	const k = String(v ?? '').trim().toLowerCase();
	return (ACTIVITY_FILTERS.some((f) => f.key === k) ? k : 'all') as ActivityFilter;
}

/** `?rows=` → one of 10 / 25 / 50, else 10. */
export function parseActivityRows(v: string | null | undefined): number {
	const n = Number(String(v ?? '').trim());
	return (ACTIVITY_SIZES as readonly number[]).includes(n) ? n : ACTIVITY_DEFAULT_SIZE;
}

/** The size "Show more" steps to, or null at the largest. */
export function nextActivitySize(rows: number): number | null {
	return ACTIVITY_SIZES.find((n) => n > rows) ?? null;
}

/**
 * Query string for the panel with `activity` / `rows` set, keeping every other search
 * param. Defaults (all / 10) are dropped so a clean URL stays clean.
 */
export function activityQuery(params: URLSearchParams, set: { activity?: ActivityFilter; rows?: number }): string {
	const p = new URLSearchParams(params);
	if (set.activity !== undefined) {
		if (set.activity === 'all') p.delete('activity');
		else p.set('activity', set.activity);
	}
	if (set.rows !== undefined) {
		if (set.rows === ACTIVITY_DEFAULT_SIZE) p.delete('rows');
		else p.set('rows', String(set.rows));
	}
	const q = p.toString();
	return q ? `?${q}` : '?';
}

/** Event type → the label shown in the badge. */
export function activityLabel(type: string): string {
	return type === 'unsubscribe_click' ? 'unsubscribe page' : type;
}

/** Event type → the badge colour class (unchanged from the old Recent activity table). */
export function activityBadge(type: string): string {
	if (type === 'open' || type === 'click') return 'sent';
	if (type === 'unsubscribe' || type === 'bounce' || type === 'spam') return 'failed';
	return 'draft';
}
