// Forms (#508): conditional logic. Universal. Phase 1 (#509) shipped the rule types, their
// evaluation and `visibleFields`; phase 2 (#514) adds page jumps (`formPath`) and the
// contact-aware rule fields the Logic tab's outcome rules offer.
//
// A rule reads an answer by its key, or a contact value as `contact:<key>` (`email`,
// `first_name`, `last_name`, `company`, `subscribed`, `tags`, or a custom field). #514's
// "Known contact" fields: `contact.has_tag` (eq / neq a tag name), `contact.in_list` (eq / neq a
// list id) and `contact.field:<key>` (a custom field's value). Every contact rule is false when no
// contact is known (unknown address, anonymous submission, the browser).
import type { AnswerValue, FormField } from '$lib/forms';

// `gte` / `lte` (#589): "rating is at most 3". A rating answer is a number, so these and gt / lt
// compare it numerically (eq / neq compare its text, which is the same digits).
export const RULE_OPS = ['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty', 'checked', 'unchecked'] as const;
export type FormRuleOp = (typeof RULE_OPS)[number];

export const RULE_OP_LABELS: Record<FormRuleOp, string> = {
	eq: 'is',
	neq: 'is not',
	in: 'is one of',
	contains: 'contains',
	gt: 'is more than',
	gte: 'is at least',
	lt: 'is less than',
	lte: 'is at most',
	empty: 'is empty',
	not_empty: 'is answered',
	checked: 'is ticked',
	unchecked: 'is not ticked'
};

/** Ops that take no value. */
export const UNARY_OPS: FormRuleOp[] = ['empty', 'not_empty', 'checked', 'unchecked'];

export type FormRule = { field: string; op: FormRuleOp; value?: string | number | string[] };
export type FormRuleSet = { match: 'all' | 'any'; rules: FormRule[] };

/** What a rule may read about the contact (when one is known, e.g. a signed prefill). */
export type RuleContact = Record<string, unknown> & { tags?: string[] };

export const MAX_RULES = 20;

/** #514: the "Known contact" rule fields (outcome rules only; the browser never knows the contact). */
export const CONTACT_TAG_FIELD = 'contact.has_tag';
export const CONTACT_LIST_FIELD = 'contact.in_list';
export const CONTACT_META_PREFIX = 'contact.field:';
export const isContactRuleField = (field: string) => field.startsWith('contact.') || field.startsWith('contact:');

/** A page's jump rule (#514): after the page, go to `goto` (a page id, or 'end' = submit) when `when` holds. */
export type PageJump = { when: FormRuleSet | null; goto: string };
export const MAX_JUMPS = 5;
export const JUMP_END = 'end';

const isOp = (v: unknown): v is FormRuleOp => (RULE_OPS as readonly unknown[]).includes(v);

/** Lenient read: junk → null (no condition), bad rules dropped. */
export function normalizeRuleSet(raw: unknown): FormRuleSet | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.rules)) return null;
	const rules: FormRule[] = [];
	for (const x of r.rules.slice(0, MAX_RULES)) {
		if (!x || typeof x !== 'object') continue;
		const o = x as Record<string, unknown>;
		const field = typeof o.field === 'string' ? o.field.trim().slice(0, 80) : '';
		if (!field || !isOp(o.op)) continue;
		const rule: FormRule = { field, op: o.op };
		if (!UNARY_OPS.includes(o.op)) {
			if (Array.isArray(o.value)) rule.value = o.value.map((v) => String(v).slice(0, 200)).slice(0, 50);
			else if (typeof o.value === 'number' && Number.isFinite(o.value)) rule.value = o.value;
			else if (typeof o.value === 'string') rule.value = o.value.slice(0, 200);
			else rule.value = '';
		}
		rules.push(rule);
	}
	if (!rules.length) return null;
	return { match: r.match === 'any' ? 'any' : 'all', rules };
}

type Val = AnswerValue | null | undefined | unknown;

function readValue(field: string, answers: Record<string, AnswerValue>, contact?: RuleContact | null): Val {
	if (isContactRuleField(field)) {
		if (!contact) return undefined;
		return contact[field.slice(8)];
	}
	return answers[field];
}

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();
const listOf = (v: Val): string[] => (Array.isArray(v) ? v.map(lower) : v === undefined || v === null || v === '' ? [] : [lower(v)]);
const isEmpty = (v: Val) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
const num = (v: unknown): number | null => {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
};
const truthy = (v: Val) => v === true || v === 1 || ['on', '1', 'true', 'yes'].includes(lower(v)) || (Array.isArray(v) && v.length > 0);

/** One rule against the answers (and the contact, for `contact:` fields). */
export function evaluateRule(rule: FormRule, answers: Record<string, AnswerValue>, contact?: RuleContact | null): boolean {
	// #514: no contact → every contact rule is false ("doesn't have tag X" included).
	if (isContactRuleField(rule.field) && !contact) return false;
	const v = readValue(rule.field, answers, contact);
	const want = rule.value;
	switch (rule.op) {
		case 'eq':
			return listOf(v).includes(lower(want));
		case 'neq':
			return !listOf(v).includes(lower(want));
		case 'in': {
			const set = new Set((Array.isArray(want) ? want : String(want ?? '').split(',')).map(lower).filter(Boolean));
			return listOf(v).some((x) => set.has(x));
		}
		case 'contains': {
			const w = lower(want);
			if (!w) return false;
			return Array.isArray(v) ? listOf(v).includes(w) : lower(v).includes(w);
		}
		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte': {
			const a = num(v);
			const b = num(want);
			if (a === null || b === null) return false;
			if (rule.op === 'gt') return a > b;
			if (rule.op === 'gte') return a >= b;
			if (rule.op === 'lt') return a < b;
			return a <= b;
		}
		case 'empty':
			return isEmpty(v);
		case 'not_empty':
			return !isEmpty(v);
		case 'checked':
			return truthy(v);
		case 'unchecked':
			return !truthy(v);
	}
}

/** A rule set: null / no rules = true; `all` = every rule, `any` = at least one. */
export function evaluateRuleSet(
	set: FormRuleSet | null | undefined,
	answers: Record<string, AnswerValue>,
	contact?: RuleContact | null
): boolean {
	if (!set || !set.rules.length) return true;
	return set.match === 'any'
		? set.rules.some((r) => evaluateRule(r, answers, contact))
		: set.rules.every((r) => evaluateRule(r, answers, contact));
}

/**
 * The fields shown for these answers, in order. A rule only sees answers to questions that
 * are themselves shown and come before it — so hiding a question also hides what depends on
 * it, and a hidden question's stale answer can't keep another one visible.
 */
export function visibleFields<F extends Pick<FormField, 'key' | 'show_when'>>(
	spec: { fields: F[] },
	answers: Record<string, AnswerValue>,
	contact?: RuleContact | null
): F[] {
	const seen: Record<string, AnswerValue> = {};
	const out: F[] = [];
	for (const f of spec.fields) {
		if (evaluateRuleSet(f.show_when, seen, contact)) {
			out.push(f);
			if (f.key && answers[f.key] !== undefined) seen[f.key] = answers[f.key];
		}
	}
	return out;
}

/** #514: what kind of value a rule field holds — picks the Logic tab's ops and value input. */
export type RuleFieldKind = 'tick' | 'number' | 'choice' | 'multi' | 'text' | 'tag' | 'list' | 'contact_field';

export function ruleFieldKind(field: string, question?: Pick<FormField, 'type'> | null): RuleFieldKind {
	if (field === CONTACT_TAG_FIELD) return 'tag';
	if (field === CONTACT_LIST_FIELD) return 'list';
	if (isContactRuleField(field)) return 'contact_field';
	switch (question?.type) {
		case 'checkbox':
		case 'consent':
			return 'tick';
		case 'number':
		case 'rating':
			return 'number';
		case 'select':
		case 'radio':
			return 'choice';
		case 'checkboxes':
		case 'topics':
			return 'multi';
		default:
			return 'text';
	}
}

/** #514: the ops the Logic tab offers for a field kind (first = the default). */
export function opsForKind(kind: RuleFieldKind): FormRuleOp[] {
	switch (kind) {
		case 'tick':
			return ['checked', 'unchecked'];
		case 'number':
			return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'];
		case 'choice':
			return ['eq', 'neq', 'in', 'empty', 'not_empty'];
		case 'multi':
			return ['eq', 'neq', 'in', 'empty', 'not_empty'];
		case 'tag':
		case 'list':
			return ['eq', 'neq'];
		case 'contact_field':
			return ['eq', 'neq', 'contains', 'gt', 'lt', 'empty', 'not_empty'];
		default:
			return ['eq', 'neq', 'contains', 'empty', 'not_empty'];
	}
}

/** #514: an op's words for a field kind ("has" / "doesn't have" for a tag, "includes" for a multi answer). */
export function opLabel(op: FormRuleOp, kind: RuleFieldKind): string {
	if (kind === 'tag') return op === 'eq' ? 'has' : 'doesn’t have';
	if (kind === 'list') return op === 'eq' ? 'is in' : 'isn’t in';
	if (kind === 'multi' && op === 'eq') return 'includes';
	if (kind === 'multi' && op === 'neq') return 'doesn’t include';
	if (kind === 'multi' && op === 'in') return 'includes any of';
	return RULE_OP_LABELS[op];
}

/**
 * #514: a rule set in words ("Role is Manager and Budget is at least 500"), for the builder's
 * "Why hidden?" hint. `label` names a rule field (a question's label, "has tag", …).
 */
export function ruleSetText(set: FormRuleSet | null | undefined, label: (field: string) => string): string {
	if (!set || !set.rules.length) return 'always';
	const parts = set.rules.map((r) => {
		const v = UNARY_OPS.includes(r.op) ? '' : ` “${Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? '')}”`;
		return `${label(r.field)} ${RULE_OP_LABELS[r.op]}${v}`;
	});
	return parts.join(set.match === 'any' ? ' or ' : ' and ');
}

/** #514: lenient read of a page's jump rules (junk dropped). */
export function normalizeJumps(raw: unknown): PageJump[] {
	if (!Array.isArray(raw)) return [];
	const out: PageJump[] = [];
	for (const x of raw) {
		if (!x || typeof x !== 'object') continue;
		const o = x as Record<string, unknown>;
		const goto = typeof o.goto === 'string' ? o.goto.trim().slice(0, 40) : '';
		if (!goto) continue;
		out.push({ when: normalizeRuleSet(o.when), goto });
		if (out.length >= MAX_JUMPS * 2) break;
	}
	return out;
}

type PathField = Pick<FormField, 'id' | 'type' | 'key' | 'show_when'>;

/**
 * #514: the pages a respondent reaches (indexes into `fieldsByPage`) and the fields shown on them,
 * in order. Walks from page 1: shows a page's fields (`show_when` sees only answers to shown
 * questions before it), then follows that page's first jump whose rules hold (`'end'` = straight
 * to submit; a missing or earlier page = the next page), else the next page. Answers on pages it
 * skips never count — the renderer disables them and the submit path drops them. A jump only
 * moves forward, so the walk always ends.
 */
export function formPath<F extends PathField>(
	spec: { fields: F[]; pages?: { id: string; next?: PageJump[] }[] },
	answers: Record<string, AnswerValue>,
	contact?: RuleContact | null
): { pages: number[]; fields: F[] } {
	const split: F[][] = [[]];
	for (const f of spec.fields) {
		if (f.type === 'page_break') split.push([f]);
		else split[split.length - 1].push(f);
	}
	const ids = ['start', ...spec.fields.filter((f) => f.type === 'page_break').map((f) => f.id)];
	const seen: Record<string, AnswerValue> = {};
	const pages: number[] = [];
	const fields: F[] = [];
	let i = 0;
	while (i < split.length) {
		pages.push(i);
		for (const f of split[i]) {
			if (!evaluateRuleSet(f.show_when, seen, contact)) continue;
			fields.push(f);
			if (f.key && answers[f.key] !== undefined) seen[f.key] = answers[f.key];
		}
		let to = i + 1;
		const jumps = spec.pages?.find((p) => p.id === ids[i])?.next ?? [];
		for (const j of jumps) {
			if (!evaluateRuleSet(j.when, seen, contact)) continue;
			const target = j.goto === JUMP_END ? split.length : ids.indexOf(j.goto);
			if (target > i) to = target;
			break;
		}
		i = to;
	}
	return { pages, fields };
}
