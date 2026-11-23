// #688: the contacts bulk bar's list / segment targets as SearchSelect options. Universal
// (no DOM), so the ordering and the "rules segment can't be picked" rule are testable.
import type { SearchOption } from '$lib/search-select';

export type BulkTarget = {
	id: number;
	name: string;
	kind: string;
	/** A rules (dynamic) segment: no stored rows, so nobody can be added by hand. */
	dynamic?: boolean | number | null;
	/** #472: an archived group kept in a picker ("<name> (archived)"). */
	archived?: boolean;
	/** Contacts in it (add targets) or in the selection (remove targets); null = unknown. */
	count?: number | null;
};

export const RULES_SEGMENT_REASON = 'Built from rules. Contacts join by matching them.';

const KIND_TITLES: [string, string][] = [
	['list', 'Lists'],
	['segment', 'Segments'],
	['company', 'Companies']
];

/** Archived by flag, or by the hand-typed naming operators use (`zz-archived · …`, "archived"). */
export function looksArchived(g: Pick<BulkTarget, 'name' | 'archived'>): boolean {
	if (g.archived) return true;
	const n = g.name.trim();
	return /^zz[\s\-_·.:]/i.test(n) || /\barchived\b/i.test(n);
}

/**
 * Options grouped Lists → Segments (→ Companies); inside a group the live ones first, then the
 * archived ones, each keeping the order given. A rules segment is listed but disabled with
 * {@link RULES_SEGMENT_REASON}; `countText` (default "N contacts") is the detail of the rest.
 */
export function bulkTargetOptions(
	groups: BulkTarget[],
	opts: { countText?: (n: number) => string; label?: (g: BulkTarget) => string } = {}
): SearchOption[] {
	const countText = opts.countText ?? ((n: number) => `${n.toLocaleString('en-US')} contact${n === 1 ? '' : 's'}`);
	const out: SearchOption[] = [];
	for (const [kind, title] of KIND_TITLES) {
		const ofKind = groups.filter((g) => g.kind === kind);
		const ordered = [...ofKind.filter((g) => !looksArchived(g)), ...ofKind.filter((g) => looksArchived(g))];
		for (const g of ordered) {
			const label = opts.label ? opts.label(g) : g.name;
			if (g.dynamic) out.push({ value: g.id, label, group: title, disabled: true, detail: RULES_SEGMENT_REASON });
			else out.push({ value: g.id, label, group: title, detail: typeof g.count === 'number' ? countText(g.count) : undefined });
		}
	}
	return out;
}

/** True when `value` is a target the server would take (not a rules segment, not unknown). */
export function pickableTarget(options: SearchOption[], value: string | number | ''): boolean {
	if (value === '') return false;
	const o = options.find((x) => String(x.value) === String(value));
	return !!o && !o.disabled;
}
