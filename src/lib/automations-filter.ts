// `/automations` filter URLs (#74/#200) — universal so the page and tests share it.
// #432: automation labels are shown as "tags"; `?tag=` is the canonical param (`?label=` still
// read by the page load, see `tagParam`). The table stays `automation_labels`.

export type AutomationsFilter = { status: string | null; tag: string | null };

/** Above this many distinct tags the index swaps its chip row for a searchable picker (#432). */
export const TAG_CHIP_LIMIT = 8;

/** The tag filter from a query string: `?tag=` wins, an old `?label=` link still works. */
export function tagParam(params: URLSearchParams): string {
	return params.get('tag') ?? params.get('label') ?? '';
}

/** The status filter's segmented buttons, in display order. */
export const STATUS_OPTIONS = [
	{ value: 'all', label: 'All' },
	{ value: 'active', label: 'Active' },
	{ value: 'paused', label: 'Paused' },
	{ value: 'draft', label: 'Draft' }
] as const;

/** Query string for the current filter with `overrides` applied (null/'' drops a key). Starts
 *  from the *effective* filter — a cookie-applied status (#200) is carried along too. Pass
 *  `status: 'all'` to clear the status explicitly (a clean URL would re-apply the cookie). */
export function automationsFilterUrl(
	filter: AutomationsFilter,
	overrides: Record<string, string | null> = {}
): string {
	const p = new URLSearchParams();
	if (filter.status) p.set('status', filter.status);
	if (filter.tag) p.set('tag', filter.tag);
	for (const [k, v] of Object.entries(overrides)) {
		if (v === null || v === '') p.delete(k);
		else p.set(k, v);
	}
	const s = p.toString();
	return s ? `?${s}` : '?';
}
