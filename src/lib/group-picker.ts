/**
 * #583: the /contacts toolbar's Lists · Segments · Tags picker — pure helpers (search,
 * sections, links), so the component stays presentational and the links are testable.
 */

export type PickerGroup = { id: number; name: string; count: number; dynamic?: boolean };
export type PickerKind = 'list' | 'segment' | 'tag';
export type PickerSection = { kind: PickerKind; title: string; allLabel: string; allHref: string; items: PickerGroup[] };

export const PICKER_KINDS: { kind: PickerKind; title: string; allLabel: string }[] = [
	{ kind: 'list', title: 'Lists', allLabel: 'All lists' },
	{ kind: 'segment', title: 'Segments', allLabel: 'All segments' },
	{ kind: 'tag', title: 'Tags', allLabel: 'All tags' }
];

/** The group's own member page. */
export function groupPageHref(id: number): string {
	return `/lists/${id}`;
}

/** The management page for a kind (`/groups/list`, …). */
export function allGroupsHref(kind: PickerKind): string {
	return `/groups/${kind}`;
}

/** Sections in fixed order, each filtered by a case-insensitive name match. Empty sections are kept
 *  (they still offer their "All …" link) unless a query is typed. */
export function pickerSections(groups: Record<PickerKind, PickerGroup[]>, query = ''): PickerSection[] {
	const q = query.trim().toLowerCase();
	return PICKER_KINDS.map(({ kind, title, allLabel }) => ({
		kind,
		title,
		allLabel,
		allHref: allGroupsHref(kind),
		items: (groups[kind] ?? []).filter((g) => !q || g.name.toLowerCase().includes(q))
	})).filter((s) => !q || s.items.length > 0);
}

/** The picked group's name for the button (null = none / not a list, segment or tag). */
export function pickedGroup(groups: Record<PickerKind, PickerGroup[]>, id: number | null): { kind: PickerKind; group: PickerGroup } | null {
	if (!id) return null;
	for (const { kind } of PICKER_KINDS) {
		const g = (groups[kind] ?? []).find((x) => x.id === id);
		if (g) return { kind, group: g };
	}
	return null;
}
