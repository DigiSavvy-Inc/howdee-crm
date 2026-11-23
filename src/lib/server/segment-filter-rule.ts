// #224: turn a dynamic segment's active "In group" / "Not in group" filter into a rule.
// "Exclude these from this segment" appends the filter condition negated; "Require this for
// this segment" appends the condition itself. A tag becomes the segment `tag` rule (by name),
// any other hand-picked group the `list` rule (by id). No SvelteKit imports (tests call it).

import { compileSegment, parseRules, type SegmentRule, type SegmentRules } from './segment-query';

export type FilterCond = 'in' | 'notin';
export type RuleMode = 'exclude' | 'require';
type GroupRef = { id: number; name: string; kind: string };

export type RuleOption = {
	cond: FilterCond;
	group: GroupRef;
	exclude: { rule: SegmentRule; text: string; count: number };
	require: { rule: SegmentRule; text: string; count: number };
};

/** The rule for "is (not) in this group". */
export function groupRule(g: GroupRef, member: boolean): SegmentRule {
	if (g.kind === 'tag') return { field: 'tag', op: member ? 'has' : 'not', value: g.name };
	return { field: 'list', op: member ? 'in' : 'not', value: String(g.id) };
}

/** Human wording of `groupRule`, for the confirm dialog. */
export function groupRuleText(g: GroupRef, member: boolean): string {
	if (g.kind === 'tag') return `Tag “${g.name}” is ${member ? 'present' : 'absent'}`;
	return `${member ? 'In' : 'Not in'} “${g.name}” (${g.kind})`;
}

/** Exclude = the filter condition negated; Require = the condition itself. */
export function ruleMember(cond: FilterCond, mode: RuleMode): boolean {
	const filterMember = cond === 'in';
	return mode === 'require' ? filterMember : !filterMember;
}

/**
 * Append one rule. A segment matching ANY of several rules can't take it — an extra OR'd rule
 * would widen it, not narrow it. With one rule, ANY and ALL are the same, so it becomes ALL.
 */
export function appendRule(rules: SegmentRules, rule: SegmentRule): { ok: true; rules: SegmentRules } | { ok: false; error: string } {
	if (rules.match === 'any' && rules.rules.length > 1) {
		return {
			ok: false,
			error: 'This segment matches ANY of its rules, so another rule would widen it. Edit the rules instead.'
		};
	}
	return { ok: true, rules: { match: 'all', rules: [...rules.rules, rule] } };
}

/** Every contact the rules match (subscribed or not) — the page header's count. */
export async function segmentCount(db: D1Database, rules: SegmentRules): Promise<number> {
	const c = compileSegment(rules);
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM (${c.sql})`).bind(...c.binds).first<{ n: number }>();
	return row?.n ?? 0;
}

/** The hand-picked group a filter condition points at (a dynamic segment has no rows → null). */
async function filterGroup(db: D1Database, id: number | null): Promise<GroupRef | null> {
	if (!id) return null;
	const g = await db
		.prepare("SELECT id, name, kind, rules FROM lists WHERE id = ? AND kind IN ('list', 'segment', 'tag', 'company')")
		.bind(id)
		.first<GroupRef & { rules: string | null }>();
	if (!g || (g.kind === 'segment' && parseRules(g.rules))) return null;
	return { id: g.id, name: g.name, kind: g.kind };
}

/**
 * The Exclude / Require choices for the filter's group conditions, each with the segment's
 * count after the rule is added. `blocked` = the segment can't take another rule (match ANY).
 */
export async function filterRuleOptions(
	db: D1Database,
	rules: SegmentRules,
	filter: { inGroup: number | null; notInGroup: number | null }
): Promise<{ options: RuleOption[]; blocked: string | null }> {
	const options: RuleOption[] = [];
	let blocked: string | null = null;
	const conds: [FilterCond, number | null][] = [
		['in', filter.inGroup],
		['notin', filter.notInGroup]
	];
	for (const [cond, id] of conds) {
		const group = await filterGroup(db, id);
		if (!group) continue;
		const choice = async (mode: RuleMode) => {
			const member = ruleMember(cond, mode);
			const rule = groupRule(group, member);
			const next = appendRule(rules, rule);
			if (!next.ok) {
				blocked = next.error;
				return null;
			}
			return { rule, text: groupRuleText(group, member), count: await segmentCount(db, next.rules) };
		};
		const exclude = await choice('exclude');
		const require = await choice('require');
		if (exclude && require) options.push({ cond, group, exclude, require });
	}
	return { options, blocked };
}

/** Append the Exclude / Require rule for one filter condition and save the segment. */
export async function applyFilterRule(
	db: D1Database,
	segmentId: number,
	input: { cond: string; groupId: number; mode: string }
): Promise<{ ok: true; before: number; after: number; rules: SegmentRules } | { ok: false; error: string }> {
	if (input.cond !== 'in' && input.cond !== 'notin') return { ok: false, error: 'Unknown filter condition.' };
	if (input.mode !== 'exclude' && input.mode !== 'require') return { ok: false, error: 'Unknown action.' };
	const seg = await db
		.prepare('SELECT kind, rules FROM lists WHERE id = ?')
		.bind(segmentId)
		.first<{ kind: string; rules: string | null }>();
	const rules = seg?.kind === 'segment' ? parseRules(seg.rules) : null;
	if (!rules) return { ok: false, error: 'Only a dynamic segment can take a rule from a filter.' };
	const group = await filterGroup(db, input.groupId);
	if (!group || group.id === segmentId) return { ok: false, error: 'That group no longer exists.' };
	const next = appendRule(rules, groupRule(group, ruleMember(input.cond, input.mode)));
	if (!next.ok) return next;
	const json = JSON.stringify(next.rules);
	if (json.length > 8000) return { ok: false, error: 'This segment has too many rules to add another.' };
	const before = await segmentCount(db, rules);
	await db.prepare('UPDATE lists SET rules = ? WHERE id = ?').bind(json, segmentId).run();
	return { ok: true, before, after: await segmentCount(db, next.rules), rules: next.rules };
}
