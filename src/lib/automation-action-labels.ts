// #128: Action-step decision labels, shared between the engine (server-only
// automations.ts) and the automation detail UI (+page.svelte, which can't import
// $lib/server/* — hence this tiny universal module).
//
// Stored labels (automation_branch_hits.label) are written once and never rewritten for
// history's sake, so they stay as `enrolled` / `ended` / `ended N automations` /
// `no active pass` / `skipped: <reason>` (+ #146's `jumped to «n. title»`). Only the UI wording changed (ActiveCampaign
// copy: "Start"/"End" instead of "Enroll"/"End their pass") — `actionDecisionLabel` is
// the one place that maps a stored label to its display text.

import { conditionLabel as metricLabel, normalizeCondition } from './company-metrics';
import { formAnswerOp, formAnswerRef, parseGateRules, type ConditionRule, type ConditionRuleSet } from './condition-rules';
import { RULE_OP_LABELS as FORM_RULE_OP_LABELS, UNARY_OPS as FORM_UNARY_OPS } from './form-logic';
import { TIER_LABELS, isTier } from './engagement-view';
import { tierActionTitle } from './tier-override';
import { parseAdjustScore } from './score-trigger';
import { pointsText } from './scoring';
import { FREQUENCY_CAP_PREFIX, parseWait, waitText } from './automation-flow';

/** #395: `automation_enrollments.last_error` for a contact held at a step that isn't
 *  finished (`automation_steps.ready = 0`). Cleared when the step is saved or deleted. */
export const STEP_NOT_FINISHED = 'Step not finished';
/** #395: `last_error` when a legacy single branch condition is misconfigured (it goes NO). */
export const BRANCH_NOT_CONFIGURED = 'Branch condition is not configured';
/** #414: `last_error` when an email step was skipped because the contact opted out of the
 *  automation's topic on the preference page (the flow continues). */
export const TOPIC_OPTED_OUT = 'Email skipped: opted out of this topic';

/** Inspector wording for an enrollment's `last_error` (#395: the hold reads as a to-do). */
export function enrollmentErrorText(lastError: string): string {
	if (lastError.startsWith(FREQUENCY_CAP_PREFIX)) return `Held: ${lastError}`; // #397
	return lastError === STEP_NOT_FINISHED ? 'Waiting for you to finish this step' : lastError;
}

/** Maps a stored action-step decision label to its display text. `enrolled` reads as
 *  `started`; every other label (`ended`, `ended N automations`, `no active pass`,
 *  `skipped: <reason>`) is already display-ready and passes through unchanged. */
export function actionDecisionLabel(label: string): string {
	return label === 'enrolled' ? 'started' : label;
}

/** Parses an `end_all_automations` decision label ("ended N automations") back to its
 *  count. Returns null for any other label — including `no active pass`, which is its
 *  own distinct string (not "ended 0 automations"). */
export function endAllAutomationsCount(label: string): number | null {
	const m = /^ended (\d+) automations$/.exec(label);
	return m ? Number(m[1]) : null;
}

// #146: "Go to a step" references steps by number + title (`3. Welcome email`), both in
// the stored decision label (`jumped to «3. Welcome email»`) and in the builder UI, so the
// numbering and the short title live here where the engine and the page can share them.

type NumberableStep = {
	id: number;
	position: number;
	type: string;
	parent_step_id: number | null;
	branch_label: string | null;
};

/** 1-based step numbers in canvas order: trunk by position, and a branch's YES lane then
 *  NO lane right after the branch step itself (depth-first, the order the canvas draws). */
export function stepNumbers(steps: NumberableStep[]): Map<number, number> {
	const out = new Map<number, number>();
	const group = (parent: number | null, label: string | null) =>
		steps
			.filter((s) => s.parent_step_id === parent && (parent === null || s.branch_label === label))
			.sort((a, b) => a.position - b.position);
	const walk = (parent: number | null, label: string | null, depth: number) => {
		if (depth > 20) return; // corrupted/cyclic tree — stop numbering
		for (const s of group(parent, label)) {
			if (out.has(s.id)) continue;
			out.set(s.id, out.size + 1);
			if (s.type === 'branch' || s.type === 'wait') {
				// #397: an event wait's "Did it" / "Timed out" lanes number like a branch's.
				walk(s.id, 'yes', depth + 1);
				walk(s.id, 'no', depth + 1);
			}
		}
	};
	walk(null, null, 0);
	return out;
}

/** Short step title for goto references: email subject, condition text, action title, or
 *  the step type. Keeps to the step's own columns so the engine can compute it too. */
export function stepShortTitle(s: {
	type: string;
	subject?: string | null;
	tag_action?: string | null;
	tag_name?: string | null;
	gate_kind?: string | null;
	gate_name?: string | null;
	gate_rules?: string | null;
	split_pct?: number | null;
	action_kind?: string | null;
	target_stage_name?: string | null;
	wait_config?: string | null;
	target_tier?: string | null;
	tier_days?: number | null;
	action_config?: string | null;
}): string {
	if (s.type === 'wait') return waitText(parseWait(s.wait_config ?? null)); // #397
	if (s.type === 'tag') return `${s.tag_action === 'remove' ? 'Remove tag' : 'Add tag'}${s.tag_name ? ` “${s.tag_name}”` : ''}`;
	if (s.type === 'branch') {
		if (s.gate_kind === 'split') return `A/B split ${s.split_pct ?? 50}%`;
		// #221: a rule set (no names to resolve here — the engine has only the step's columns).
		const set = parseGateRules(s.gate_rules);
		if (set) return set.rules.length === 1 ? `Condition: ${ruleText(set.rules[0])}?` : `Condition: ${set.rules.length} rules`;
		if (s.gate_kind === 'list-member') return 'Condition: in list?';
		if (s.gate_kind === 'opened' || s.gate_kind === 'clicked') return `Condition: ${s.gate_kind} email?`;
		if (s.gate_kind === 'pipeline-stage') return 'Condition: pipeline stage?';
		if (!s.gate_name) return 'Condition';
		if (s.gate_kind === 'tag') return `Condition: has tag “${s.gate_name}”?`;
		if (s.gate_kind === 'no-tag') return `Condition: no tag “${s.gate_name}”?`;
		return `Condition: field “${s.gate_name}”?`;
	}
	if (s.type === 'end') return 'End automation';
	if (s.type === 'action') {
		if (s.action_kind === 'goto_step') return 'Go to a step';
		if (s.action_kind === 'set_tier') return tierActionTitle(s.target_tier, s.tier_days); // #460
		// #467: no score name to hand here (only the step's columns) — the points carry it.
		if (s.action_kind === 'adjust_score') {
			const c = parseAdjustScore(s.action_config ?? null);
			return c ? `Adjust score by ${pointsText(c.points)}` : 'Adjust a score';
		}
		if (s.action_kind === 'pipeline_move' || s.action_kind === 'pipeline_remove') {
			// The engine has no stage name to hand (only the step's own columns) — keep it generic.
			if (s.action_kind === 'pipeline_move' && s.target_stage_name === undefined) return 'Move to pipeline stage';
			return pipelineActionTitle(s.action_kind, s.target_stage_name ?? null);
		}
		if (s.action_kind === 'end_all_automations') return 'End all other automations';
		return s.action_kind === 'end_automation' ? 'End another automation' : 'Start an automation';
	}
	return s.subject || 'Untitled email';
}

/** `n. title`, or just the title when the step has no number (shouldn't happen). */
export function numberedStepTitle(n: number | undefined, title: string): string {
	return n ? `${n}. ${title}` : title;
}

/** True for a stored goto decision label (`jumped to «…»`). */
export function isJumpLabel(label: string): boolean {
	return label.startsWith('jumped to ');
}

// #207: pipeline action steps. Stored decision labels: `moved to «Stage»`, `added to «Stage»`,
// `removed from pipeline`, or `skipped: <reason>` (deleted stage / not in «Stage» /
// already in «Stage» / not in pipeline).

export const PIPELINE_REMOVED_LABEL = 'removed from pipeline';

/** True for a pipeline action step's "did something" label (not a skip). */
export function isPipelineLabel(label: string): boolean {
	return label.startsWith('moved to «') || label.startsWith('added to «') || label === PIPELINE_REMOVED_LABEL;
}

/** Canvas/step title: "Move to pipeline stage: Proposal" (+ " · only from Qualified"), or
 *  "Remove from pipeline". A missing stage name reads "(deleted stage)". */
export function pipelineActionTitle(
	kind: string | null | undefined,
	stageName: string | null,
	onlyFromName?: string | null,
	onlyFromSet = false
): string {
	if (kind === 'pipeline_remove') return 'Remove from pipeline';
	const base = `Move to pipeline stage: ${stageName ?? '(deleted stage)'}`;
	if (!onlyFromSet) return base;
	return `${base} · only from ${onlyFromName ?? '(deleted stage)'}`;
}

// #460: "Set engagement tier" action steps. Stored decision labels: `tier set to «Hot»`
// (+ ` (until 2026-11-23)`), `tier override cleared`, or `skipped: already Hot by override` /
// `skipped: no tier override`. The step title is `tierActionTitle` ("Set tier to Hot for 30
// days" / "Clear tier override").

export const TIER_CLEARED_LABEL = 'tier override cleared';

/** True for a set-tier step's "did something" label (not a skip). */
export function isTierLabel(label: string): boolean {
	return label.startsWith('tier set to «') || label === TIER_CLEARED_LABEL;
}

export { tierActionTitle };

// #221: compound Condition steps. One rule → a short phrase; a rule set → the canvas card's
// summary (first rule + "+N more") and its tooltip (every rule). Ids (lists, email steps,
// stages, companies) resolve through `names`; without one they read as "#id".

export type RuleNames = {
	list?: (id: number) => string | null | undefined;
	step?: (id: number) => string | null | undefined;
	stage?: (id: number) => string | null | undefined;
	company?: (id: number) => string | null | undefined;
	form?: (id: number) => string | null | undefined;
};

function named(fn: ((id: number) => string | null | undefined) | undefined, v: string, fallback: string): string {
	const id = Number(v);
	if (!v || !Number.isInteger(id) || id <= 0) return fallback;
	return fn?.(id) ?? `#${id}`;
}

const SYM: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

function days(n: string): string {
	return `${n} day${n === '1' ? '' : 's'}`;
}

/** "has tag “vip”", "email contains “@acme”", "is in “Newsletter”"… */
export function ruleText(r: ConditionRule, names: RuleNames = {}): string {
	const v = (r.value ?? '').trim();
	const v2 = (r.value2 ?? '').trim();
	const not = r.op === 'not';
	switch (r.field) {
		case 'tag':
			return `${not ? 'does not have' : 'has'} tag “${v}”`;
		case 'field':
			if (r.op === 'exists') return `field “${v2}” exists`;
			if (r.op === 'missing') return `field “${v2}” is empty`;
			return `field “${v2}” ${SYM[r.op] ?? r.op} “${v}”`;
		case 'field_contains':
			return `field “${v2}” ${not ? 'does not contain' : 'contains'} “${v}”`;
		case 'email': {
			const verb = r.op === 'ends' ? 'ends with' : r.op === 'not_contains' ? 'does not contain' : 'contains';
			return `email ${verb} “${v}”`;
		}
		case 'list':
			if (r.invalid) return `${not ? 'is not in' : 'is in'} (deleted list)`;
			return `${not ? 'is not in' : 'is in'} “${named(names.list, v, '(choose a list)')}”`;
		case 'step_opened':
		case 'step_clicked': {
			const verb = r.field === 'step_opened' ? 'opened' : 'clicked';
			const step = named(names.step, v, '(choose an email step)');
			return r.op === 'no' ? `did not ${verb === 'opened' ? 'open' : 'click'} «${step}»` : `${verb} «${step}»`;
		}
		// #516
		case 'form_submitted': {
			const form = v ? `form “${named(names.form, v, '(choose a form)')}”` : 'any form';
			const when = Number(v2) > 0 ? ` in the last ${days(v2)}` : '';
			return `${r.op === 'no' ? 'did not submit' : 'submitted'} ${form}${when}`;
		}
		case 'form_answer': {
			const ref = formAnswerRef(r.value2);
			const op = formAnswerOp(r.op);
			if (!ref || !op) return 'answer to a form question (choose one)';
			const val = FORM_UNARY_OPS.includes(op) ? '' : ` “${v}”`;
			return `answer “${ref.key}” on ${named(names.form, String(ref.formId), '(a form)')} ${FORM_RULE_OP_LABELS[op]}${val}`;
		}
		case 'subscribed':
			return r.op === 'no' ? 'is unsubscribed' : 'is subscribed';
		case 'topic':
			return `${r.op === 'out' ? 'opted out of' : 'opted in to'} topic “${named(names.list, v, '(choose a topic)')}”`;
		case 'opened':
		case 'clicked':
			return `${not ? `did not ${r.field === 'opened' ? 'open' : 'click'}` : r.field} an email in the last ${days(v)}`;
		case 'engagement_tier':
			return `engagement tier ${not ? 'is not' : 'is'} ${isTier(v) ? TIER_LABELS[v] : v}`;
		case 'last_open_within_days':
			return `${not ? 'no open' : 'opened'} within the last ${days(v)}`;
		case 'opens_last_90d':
			return `opens in the last 90 days ${SYM[r.op] ?? r.op} ${v}`;
		case 'bounced':
			return r.op === 'none' ? 'never bounced' : r.op === 'hard' ? 'hard bounced' : 'bounced';
		case 'spam_complaint':
			return r.op === 'no' ? 'never marked us as spam' : 'marked us as spam';
		case 'never_opened':
			return r.op === 'no' ? 'has opened an email' : 'never opened an email';
		case 'visited':
		case 'event': {
			const when = Number(v2) > 0 ? ` in the last ${days(v2)}` : '';
			const what = r.field === 'event' ? `did «${v}»` : `visited a page containing “${v}”`;
			return `${not ? 'NOT ' : ''}${what}${when}`;
		}
		case 'source':
			return `source ${r.op === 'contains' ? 'contains' : 'is'} “${v}”`;
		case 'company':
			return r.op === 'exists' ? 'company name is set' : `company name is “${v}”`;
		case 'company_id':
			if (r.op === 'exists') return 'is linked to a company';
			if (r.op === 'missing') return 'has no linked company';
			return `company is “${named(names.company, v, '(choose a company)')}”`;
		case 'company_metric': {
			const c = normalizeCondition(v2, r.op, v);
			return c ? `company ${metricLabel(c)}` : 'company metric (incomplete)';
		}
		case 'pipeline_stage':
			if (r.op === 'any') return 'is in the pipeline';
			if (r.op === 'none') return 'is not in the pipeline';
			return `pipeline stage ${not ? 'is not' : 'is'} “${named(names.stage, v, '(choose a stage)')}”`;
		case 'created':
			return r.op === 'within' ? `added in the last ${days(v)}` : `added ${r.op} ${v}`;
		default:
			return `${r.field} ${r.op} ${v}`.trim();
	}
}

/** Canvas card summary: "has tag “vip”?" or "is in “Newsletter” +2 more (all)". */
export function conditionLabel(set: ConditionRuleSet, names: RuleNames = {}): string {
	const first = ruleText(set.rules[0], names);
	const more = set.rules.length - 1;
	return more > 0 ? `${first} +${more} more (${set.match})` : `${first}?`;
}

/** #626: a "Until specific conditions are met" wait's rules in words (no trailing "?"):
 *  "has tag “customer”" or "has tag “customer” +1 more (any)". */
export function waitRulesText(set: ConditionRuleSet | null | undefined, names: RuleNames = {}): string {
	if (!set || !set.rules.length) return '';
	const first = ruleText(set.rules[0], names);
	const more = set.rules.length - 1;
	return more > 0 ? `${first} +${more} more (${set.match})` : first;
}

/** Card tooltip: the full list, one rule per line. */
export function conditionTitle(set: ConditionRuleSet, names: RuleNames = {}): string {
	return [`Match ${set.match} of:`, ...set.rules.map((r) => `• ${ruleText(r, names)}`)].join('\n');
}
