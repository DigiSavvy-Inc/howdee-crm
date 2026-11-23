// #431: pure matching for SearchSelect.svelte — filter, group, "Any/None" row and "Create …"
// row. Universal (no DOM), so the component's behaviour is testable on its own.

export type SearchOptionValue = string | number;

export type SearchOption = {
	value: SearchOptionValue;
	label: string;
	detail?: string;
	group?: string;
	/** #688: shown but not pickable (put the reason in `detail`); ↑/↓ skip it. */
	disabled?: boolean;
};

/** One pickable row. `empty` = the explicit "Any"/"None" row (value ''), `create` = posts the typed text. */
export type SearchRow =
	| { kind: 'empty'; value: ''; label: string }
	| { kind: 'option'; value: SearchOptionValue; label: string; detail?: string; group?: string; disabled?: boolean }
	| { kind: 'create'; value: string; label: string };

export type SearchRows = {
	/** Rows in display order — what ↑/↓ walk. */
	flat: SearchRow[];
	/** Display sections; `title` '' = no heading (the empty / create rows, ungrouped options). */
	groups: { title: string; rows: SearchRow[] }[];
};

/** Case-insensitive substring match on label + detail. A blank query matches everything. */
export function matchesQuery(o: SearchOption, q: string): boolean {
	const needle = q.trim().toLowerCase();
	if (!needle) return true;
	return o.label.toLowerCase().includes(needle) || (o.detail ?? '').toLowerCase().includes(needle);
}

export function filterOptions(options: SearchOption[], q: string): SearchOption[] {
	return options.filter((o) => matchesQuery(o, q));
}

/** Groups in order of first appearance; options keep their order inside a group. */
export function groupOptions(options: SearchOption[]): { title: string; items: SearchOption[] }[] {
	const out: { title: string; items: SearchOption[] }[] = [];
	const at = new Map<string, number>();
	for (const o of options) {
		const title = o.group ?? '';
		let i = at.get(title);
		if (i === undefined) {
			i = out.length;
			at.set(title, i);
			out.push({ title, items: [] });
		}
		out[i].items.push(o);
	}
	return out;
}

/** "Create" is offered for typed text that isn't already an option's label (case-insensitive). */
export function createCandidate(options: SearchOption[], q: string): string | null {
	const typed = q.trim();
	if (!typed) return null;
	const lower = typed.toLowerCase();
	return options.some((o) => o.label.trim().toLowerCase() === lower) ? null : typed;
}

export function searchRows(
	options: SearchOption[],
	q: string,
	opts: { allowEmpty?: { label: string; always?: boolean } | null; allowCreate?: boolean } = {}
): SearchRows {
	const groups: SearchRows['groups'] = [];
	// `always` (#688): keep the empty row first while typing too (e.g. "New segment…").
	if (opts.allowEmpty && (opts.allowEmpty.always || !q.trim())) groups.push({ title: '', rows: [{ kind: 'empty', value: '', label: opts.allowEmpty.label }] });
	for (const g of groupOptions(filterOptions(options, q))) {
		groups.push({ title: g.title, rows: g.items.map((o) => ({ kind: 'option', ...o })) });
	}
	const created = opts.allowCreate ? createCandidate(options, q) : null;
	if (created !== null) groups.push({ title: '', rows: [{ kind: 'create', value: created, label: `Create “${created}”` }] });
	return { groups, flat: groups.flatMap((g) => g.rows) };
}

/** #688: a disabled option row can't be picked or landed on. */
export function rowEnabled(r: SearchRow | undefined): boolean {
	return !!r && !(r.kind === 'option' && r.disabled);
}

/** First pickable row, or 0 when there is none (nothing to land on). */
export function firstEnabled(flat: SearchRow[]): number {
	const i = flat.findIndex(rowEnabled);
	return i < 0 ? 0 : i;
}

/** ↑/↓: the next pickable row from `from` in `dir`, wrapping; `from` when none is pickable. */
export function stepEnabled(flat: SearchRow[], from: number, dir: 1 | -1): number {
	const n = flat.length;
	for (let k = 1; k <= n; k++) {
		const i = (((from + dir * k) % n) + n) % n;
		if (rowEnabled(flat[i])) return i;
	}
	return from;
}

/** The closed field's text: the option's label, else (free text) the value itself, else ''. */
export function labelFor(options: SearchOption[], value: SearchOptionValue | null | undefined): string {
	if (value === null || value === undefined || value === '') return '';
	const hit = options.find((o) => String(o.value) === String(value));
	return hit ? hit.label : String(value);
}

const KIND_GROUPS: [string, string][] = [
	['list', 'Lists'],
	['segment', 'Segments'],
	['tag', 'Tags'],
	['company', 'Companies']
];

/** Lists / segments / tags / companies (`lists` rows) as options grouped by kind, in that order. */
export function groupOptionsFromLists(
	lists: { id: number; name: string; kind: string }[],
	value: (id: number) => SearchOptionValue = (id) => id
): SearchOption[] {
	const out: SearchOption[] = [];
	for (const [kind, title] of KIND_GROUPS) {
		for (const l of lists) if (l.kind === kind) out.push({ value: value(l.id), label: l.name, group: title });
	}
	return out;
}
