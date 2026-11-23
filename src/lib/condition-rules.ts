// #221: compound Condition steps — a branch step's condition as a rule set. Universal
// (no server imports) so the engine, the server actions and the builder UI share the
// shape, the automation-only rule kinds and the legacy single-gate → rule-set mapping.
//
// A rule is the segment RuleBuilder's shape (`field`, `op`, `value`, `value2` — see
// segment-query.ts) plus the automation-only kinds below. Stored as JSON in
// `automation_steps.gate_rules`; NULL there = the legacy gate_* columns.

import { RULE_OPS as FORM_RULE_OPS, RULE_OP_LABELS as FORM_RULE_OP_LABELS, UNARY_OPS as FORM_UNARY_OPS, type FormRuleOp } from './form-logic';

// `invalid` (#228): set on a `list` rule whose group was deleted (`DELETED_LIST`). Such a
// rule is never compiled — a segment ignores it, a Condition step counts it false — and
// the builders show it with a "Deleted list" chip until another list is picked.
export type ConditionRule = { field: string; op: string; value?: string; value2?: string; invalid?: string };
export type ConditionRuleSet = { match: 'all' | 'any'; rules: ConditionRule[] };

/** `invalid` marker for a `list` rule whose group was deleted (#228). */
export const DELETED_LIST = 'deleted_list';

/** True for a `list` rule marked as pointing at a deleted group (#228). */
export function isDeletedListRule(r: { field: string; invalid?: string }): boolean {
	return r.field === 'list' && r.invalid === DELETED_LIST;
}

export const MAX_CONDITION_RULES = 10;
const MAX_RULE_VALUE = 300;

/** Kinds only a Condition step offers (the segment builder doesn't). */
export const AUTOMATION_RULE_FIELDS: { field: string; label: string }[] = [
	{ field: 'list', label: 'List / segment' },
	{ field: 'email', label: 'Email address' },
	{ field: 'field_contains', label: 'Custom field text' },
	{ field: 'step_opened', label: 'Opened email step' },
	{ field: 'step_clicked', label: 'Clicked email step' },
	{ field: 'form_answer', label: 'Answer to a form question' }
];

/** #516: a `form_answer` rule's `value2` = "<form id>:<answer key>". */
export function formAnswerRef(value2: string | undefined): { formId: number; key: string } | null {
	const m = /^(\d+):(.+)$/.exec((value2 ?? '').trim());
	if (!m) return null;
	const formId = Number(m[1]);
	return formId > 0 ? { formId, key: m[2] } : null;
}

/** #516: the form-logic comparison a `form_answer` rule uses (`op`), or null. */
export function formAnswerOp(op: string): FormRuleOp | null {
	return (FORM_RULE_OPS as readonly string[]).includes(op) ? (op as FormRuleOp) : null;
}

export const AUTOMATION_RULE_OPS: Record<string, { op: string; label: string }[]> = {
	list: [{ op: 'in', label: 'contact is in' }, { op: 'not', label: 'contact is NOT in' }],
	email: [
		{ op: 'contains', label: 'contains' },
		{ op: 'not_contains', label: 'does NOT contain' },
		{ op: 'ends', label: 'ends with' }
	],
	field_contains: [{ op: 'contains', label: 'contains' }, { op: 'not', label: 'does NOT contain' }],
	// #448: a preference-page topic (value = the topic list id).
	topic: [{ op: 'out', label: 'opted out of' }, { op: 'in', label: 'opted in to' }],
	step_opened: [{ op: 'yes', label: 'yes' }, { op: 'no', label: 'no' }],
	// #467: value2 = the score id; `between` takes value = "lo:hi" (inclusive).
	score_value: [
		{ op: 'gte', label: '≥' },
		{ op: 'gt', label: '>' },
		{ op: 'lte', label: '≤' },
		{ op: 'lt', label: '<' },
		{ op: 'eq', label: '=' },
		{ op: 'between', label: 'between' }
	],
	score_band: [{ op: 'is', label: 'is' }, { op: 'not', label: 'is not' }],
	step_clicked: [{ op: 'yes', label: 'yes' }, { op: 'no', label: 'no' }],
	// #516: the form-logic comparisons (`$lib/form-logic`), against the pass's submission.
	form_answer: FORM_RULE_OPS.map((op) => ({ op, label: FORM_RULE_OP_LABELS[op] })),
	// #516: value = a form id (blank = any form), value2 = the window in days (blank = ever).
	form_submitted: [{ op: 'yes', label: 'submitted' }, { op: 'no', label: 'did NOT submit' }]
};

/** #448: the rule-kind picker's headings, in order. */
export const RULE_KIND_GROUPS = ['Subscription', 'Engagement', 'Scores', 'Groups', 'Fields', 'Forms', 'Company', 'Pipeline', 'Contact'] as const;
export type RuleKindGroup = (typeof RULE_KIND_GROUPS)[number];

/** One pickable rule kind. `only` = offered by just the segment builder or just automations
 *  (Condition steps + trigger contact conditions); `step` = an email-step kind, left out of
 *  trigger contact conditions (`noStepRules`). */
export type RuleKind = { field: string; label: string; group: RuleKindGroup; only?: 'segment' | 'automation'; step?: true };

/** Every rule kind the builders offer (#448), grouped. Compiled by segment-query.ts `compileRule`
 *  (+ condition-eval.ts for `list` / `email` / step kinds in automations). */
export const RULE_KINDS: RuleKind[] = [
	{ field: 'subscribed', label: 'Subscription status', group: 'Subscription' },
	{ field: 'topic', label: 'Topic preference', group: 'Subscription' },
	{ field: 'bounced', label: 'Has bounced', group: 'Subscription' },
	{ field: 'spam_complaint', label: 'Has complained (marked as spam)', group: 'Subscription' },
	{ field: 'engagement_tier', label: 'Engagement tier', group: 'Engagement' },
	{ field: 'last_open_within_days', label: 'Opened in the last N days', group: 'Engagement' },
	{ field: 'never_opened', label: 'Never opened', group: 'Engagement' },
	{ field: 'opened', label: 'Opened any email', group: 'Engagement' },
	{ field: 'clicked', label: 'Clicked any email', group: 'Engagement' },
	{ field: 'opens_last_90d', label: 'Opens (last 90 days)', group: 'Engagement' },
	{ field: 'step_opened', label: 'Opened email step', group: 'Engagement', only: 'automation', step: true },
	{ field: 'step_clicked', label: 'Clicked email step', group: 'Engagement', only: 'automation', step: true },
	{ field: 'visited', label: 'Visited page', group: 'Engagement' },
	{ field: 'event', label: 'Site event', group: 'Engagement' },
	// #467: a named score (value2 = score id) — its cached value, or its band label.
	{ field: 'score_value', label: 'Score value', group: 'Scores' },
	{ field: 'score_band', label: 'Score band', group: 'Scores' },
	{ field: 'tag', label: 'Tag', group: 'Groups' },
	{ field: 'list', label: 'List / group', group: 'Groups', only: 'segment' },
	{ field: 'list', label: 'List / segment', group: 'Groups', only: 'automation' },
	{ field: 'field', label: 'Custom field', group: 'Fields' },
	{ field: 'field_contains', label: 'Custom field text', group: 'Fields' },
	// #516: a form submission (any form / one form, optional window); a Condition step can also
	// read one answer — of the submission that started the pass, else the contact's latest one
	// to that form (`step: true` keeps it out of trigger contact conditions).
	{ field: 'form_submitted', label: 'Submitted form', group: 'Forms' },
	{ field: 'form_answer', label: 'Answer to a form question', group: 'Forms', only: 'automation', step: true },
	{ field: 'company_id', label: 'Company', group: 'Company' },
	{ field: 'company_metric', label: 'Company metric', group: 'Company' },
	{ field: 'company', label: 'Company name (text)', group: 'Company' },
	{ field: 'pipeline_stage', label: 'Pipeline stage', group: 'Pipeline' },
	{ field: 'created', label: 'Contact created', group: 'Contact' },
	{ field: 'source', label: 'Source', group: 'Contact' },
	{ field: 'email', label: 'Email address', group: 'Contact', only: 'automation' }
];

/** The picker's sections for one builder: the segment builder, a Condition step, or a
 *  trigger's contact conditions (`noStepRules`). Empty groups are dropped. */
export function ruleKindGroups(opts: { automation: boolean; noStepRules?: boolean }): { group: RuleKindGroup; kinds: RuleKind[] }[] {
	const mode = opts.automation ? 'automation' : 'segment';
	const kinds = RULE_KINDS.filter((k) => (!k.only || k.only === mode) && !(k.step && opts.noStepRules));
	return RULE_KIND_GROUPS.map((group) => ({ group, kinds: kinds.filter((k) => k.group === group) })).filter((g) => g.kinds.length);
}

function str(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== 'string' && typeof v !== 'number') return undefined;
	return String(v).slice(0, MAX_RULE_VALUE);
}

/** Untrusted input (form JSON, stored column) → a clean rule set, or null when it isn't
 *  one (not an object, no rules array, or zero rules). Extra keys are dropped. */
export function normalizeRuleSet(raw: unknown): ConditionRuleSet | null {
	if (!raw || typeof raw !== 'object') return null;
	const v = raw as { match?: unknown; rules?: unknown };
	if (!Array.isArray(v.rules) || v.rules.length === 0) return null;
	const rules: ConditionRule[] = [];
	for (const r of v.rules.slice(0, MAX_CONDITION_RULES)) {
		if (!r || typeof r !== 'object') continue;
		const o = r as Record<string, unknown>;
		const field = str(o.field);
		const op = str(o.op);
		if (!field || op === undefined) continue;
		const rule: ConditionRule = { field, op };
		const value = str(o.value);
		const value2 = str(o.value2);
		if (value !== undefined) rule.value = value;
		if (value2 !== undefined) rule.value2 = value2;
		if (o.invalid === DELETED_LIST) rule.invalid = DELETED_LIST;
		rules.push(rule);
	}
	if (rules.length === 0) return null;
	return { match: v.match === 'any' ? 'any' : 'all', rules };
}

/** `automation_steps.gate_rules` → rule set, or null (legacy single gate / malformed). */
export function parseGateRules(json: string | null | undefined): ConditionRuleSet | null {
	if (!json) return null;
	try {
		return normalizeRuleSet(JSON.parse(json));
	} catch {
		return null;
	}
}

type LegacyGate = {
	gate_kind: string | null;
	gate_name: string | null;
	gate_value: string | null;
	gate_ref_id: number | null;
};

/** A legacy single gate as a one-rule set, for the editor (#221). Null for an A/B split
 *  or a kind with no rule equivalent. */
export function legacyGateToRules(s: LegacyGate): ConditionRuleSet | null {
	const name = (s.gate_name ?? '').trim();
	const value = s.gate_value ?? '';
	const ref = s.gate_ref_id ? String(s.gate_ref_id) : '';
	const one = (rule: ConditionRule): ConditionRuleSet => ({ match: 'all', rules: [rule] });
	switch (s.gate_kind) {
		case 'tag':
			return one({ field: 'tag', op: 'has', value: name });
		case 'no-tag':
			return one({ field: 'tag', op: 'not', value: name });
		case 'field-exists':
			return one({ field: 'field', op: 'exists', value2: name });
		case 'field-not-exists':
			return one({ field: 'field', op: 'missing', value2: name });
		case 'field-eq':
			return one({ field: 'field', op: 'eq', value2: name, value });
		case 'field-contains':
			return one({ field: 'field_contains', op: 'contains', value2: name, value });
		case 'field-not-contains':
			return one({ field: 'field_contains', op: 'not', value2: name, value });
		case 'list-member':
			return one({ field: 'list', op: 'in', value: ref });
		case 'opened':
			return one({ field: 'step_opened', op: 'yes', value: ref });
		case 'clicked':
			return one({ field: 'step_clicked', op: 'yes', value: ref });
		case 'company-metric': {
			// gate_name = metric, gate_value = 'op:value'
			const [op, v] = value.split(':');
			return one({ field: 'company_metric', op: op ?? '', value: v ?? '', value2: name });
		}
		case 'visited': {
			// gate_name = path text / event name, gate_value = 'page|event:<days>' (0 = ever)
			const [mode, days] = value.split(':');
			const n = Math.floor(Number(days) || 0);
			return one({ field: mode === 'event' ? 'event' : 'visited', op: 'in', value: name, value2: n > 0 ? String(n) : '' });
		}
		case 'pipeline-stage':
			if (value === 'any' || value === 'none') return one({ field: 'pipeline_stage', op: value });
			return one({ field: 'pipeline_stage', op: 'is', value: ref });
		default:
			return null;
	}
}

/** Fields a rule must fill before it can be saved (a structural check the builder runs
 *  inline; the server also compiles each rule). Null = complete. */
export function ruleIncomplete(r: ConditionRule): string | null {
	const v = (r.value ?? '').trim();
	const v2 = (r.value2 ?? '').trim();
	switch (r.field) {
		case 'subscribed':
		case 'never_opened':
		case 'bounced':
		case 'spam_complaint':
			return null;
		case 'form_submitted':
			return v2 && !(Number.isInteger(Number(v2)) && Number(v2) > 0) ? 'a whole number of days' : null;
		case 'form_answer': {
			if (!formAnswerRef(r.value2)) return 'a form and a question';
			const op = formAnswerOp(r.op);
			if (!op) return 'a comparison';
			return FORM_UNARY_OPS.includes(op) || v ? null : 'a value';
		}
		case 'field':
			if (!v2) return 'a field name';
			return r.op === 'exists' || r.op === 'missing' || v ? null : 'a value';
		case 'field_contains':
			if (!v2) return 'a field name';
			return v ? null : 'the text to look for';
		case 'company':
			return r.op === 'exists' || v ? null : 'a company name';
		case 'company_id':
			return r.op === 'is' && !v ? 'a company' : null;
		case 'pipeline_stage':
			return (r.op === 'is' || r.op === 'not') && !v ? 'a stage' : null;
		case 'engagement_tier':
			return v ? null : 'a tier';
		case 'list':
			return v ? null : 'a list or segment';
		case 'topic':
			return v ? null : 'a topic';
		case 'step_opened':
		case 'step_clicked':
			return v ? null : 'an email step';
		case 'score_value': {
			if (!v2) return 'a score';
			if (r.op === 'between') {
				const [lo, hi] = v.split(':');
				return lo?.trim() && hi?.trim() && Number.isFinite(Number(lo)) && Number.isFinite(Number(hi)) ? null : 'two numbers';
			}
			return v && Number.isFinite(Number(v)) ? null : 'a number';
		}
		case 'score_band':
			if (!v2) return 'a score';
			return v ? null : 'a band';
		case 'opened':
		case 'clicked':
		case 'last_open_within_days':
		case 'opens_last_90d':
			return v ? null : 'a number';
		default:
			return v ? null : 'a value';
	}
}

/** First problem with a rule set for the editor, or null. */
export function ruleSetProblem(set: ConditionRuleSet | null): string | null {
	if (!set || set.rules.length === 0) return 'Add at least one rule.';
	if (set.rules.length > MAX_CONDITION_RULES) return `At most ${MAX_CONDITION_RULES} rules per condition.`;
	for (const [i, r] of set.rules.entries()) {
		const missing = ruleIncomplete(r);
		if (missing) return `Rule ${i + 1} needs ${missing}.`;
	}
	return null;
}
