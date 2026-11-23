// #345: the automation write vocabulary, shared by the builder, the assistant, the API and an
// MCP server. Universal (no server imports): types for one step / trigger / whole flow, the
// kind lists, and the structural checks of a whole-flow spec that need no database. The DB
// checks and every write live in `src/lib/server/automation-write.ts`.
//
// Step references: a direct write (`updateStep` …) names other steps by their real id
// (`step_id`); inside an `AutomationSpec` they are local `ref` names (`step_ref`), so a flow
// can be exported (`readSpec`) and re-imported (`createFromSpec`) anywhere.

import type { ConditionRule, ConditionRuleSet } from './condition-rules';
import { NO_PREVIOUS_EMAIL, previousEmailStep, waitModeHasLanes, waitNeedsEmail, type FlowStepRef, type WaitSpec } from './automation-flow';
import type { EmailRef, ExcludeEntry, LinkPattern } from './engagement-trigger';
import type { SubscriptionEvent, SubscriptionSource } from './subscription-trigger';
import type { FormRuleSet } from './form-logic';

export const TRIGGER_TYPES = [
	'manual',
	'list_added',
	'company_metric',
	'site_visit',
	'pipeline_stage_entered',
	'email_opened',
	'email_clicked',
	'site_activity',
	'subscription_changed',
	'score_changed',
	'form_submitted'
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/**
 * A trigger. Only the fields of `type` are read:
 * - `list_added`: `list_id` (a list, segment or tag)
 * - `company_metric`: `metric` (a `TRIGGER_METRICS` key), `direction` above|below, `threshold`
 * - `site_visit`: `site_id` (null = any site), `path_op` contains|equals|wildcard, `path`,
 *   `cooldown_hours` (null = 24, 0 = none)
 * - `pipeline_stage_entered`: `stage_id`
 * - `email_opened` / `email_clicked` (#412, stored as JSON in `trigger_config`): `email`
 *   ('any' | { campaign_id } | { step_id } | in a spec { step_ref }), `list_id` (null = any
 *   list), `link` (clicks only: 'any' | { op contains|equals|starts_with, value }), `exclude`
 *   (≤ 10 emails / links that don't count), `ignore_proxy_opens` (opens; default true),
 *   `once_per_email` (default true). See `$lib/engagement-trigger`.
 * - `site_activity` (#434, stored as JSON in `trigger_config`): `measure` pages|visits,
 *   `threshold` 1–1000, `days` 1–180, `site_id` (null = any), `path_op` + `path` (blank = every
 *   page), `cooldown_hours` 0–8760 (default 168). See `$lib/site-activity-trigger`.
 * - `subscription_changed` (#444, stored as JSON in `trigger_config`): `events` (non-empty subset
 *   of unsubscribed|resubscribed|bounced|complained|topic_optout|topic_optin, default
 *   ['unsubscribed']), `topic_list_id` (topic events; null = any topic), `sources` (unsubscribed
 *   only: link|preference_center|manual|api|postmark; [] = any). Runs for unsubscribed contacts
 *   but never emails them. See `$lib/subscription-trigger`.
 * - `score_changed` (#467, stored as JSON in `trigger_config`): `score_id`, `mode`
 *   crosses_above | crosses_below (`threshold`) | enters_band (`band`) | any_change. See
 *   `$lib/score-trigger`.
 * - `form_submitted` (#516, stored as JSON in `trigger_config`): `form_id` (null = any form),
 *   `filter` (optional FormRuleSet over the answers, `$lib/form-logic`). Fires only for forms
 *   whose `settings.enroll` is on. See `$lib/form-trigger`.
 */
export type TriggerSpec = {
	type: TriggerType;
	list_id?: number | null;
	metric?: string | null;
	direction?: 'above' | 'below' | null;
	threshold?: number | null;
	site_id?: number | null;
	path_op?: string | null;
	path?: string | null;
	cooldown_hours?: number | null;
	stage_id?: number | null;
	email?: EmailRef;
	link?: 'any' | LinkPattern;
	exclude?: ExcludeEntry[];
	ignore_proxy_opens?: boolean;
	once_per_email?: boolean;
	measure?: 'pages' | 'visits';
	days?: number | null;
	events?: SubscriptionEvent[];
	topic_list_id?: number | null;
	sources?: SubscriptionSource[];
	score_id?: number | null;
	mode?: string | null;
	band?: string | null;
	form_id?: number | null;
	filter?: FormRuleSet | null;
};

export const STEP_TYPES = ['email', 'tag', 'branch', 'action', 'end', 'wait'] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Legacy single-gate condition kinds (`automation_steps.gate_kind`). */
export const GATE_KINDS = [
	'tag',
	'no-tag',
	'field-exists',
	'field-not-exists',
	'field-eq',
	'field-contains',
	'field-not-contains',
	'list-member',
	'opened',
	'clicked',
	'split',
	'company-metric',
	'visited',
	'pipeline-stage'
] as const;
/** Kinds that test a tag / field name (`name`; the field-eq/contains ones also `value`). */
export const NAMED_GATE_KINDS = ['tag', 'no-tag', 'field-exists', 'field-not-exists', 'field-eq', 'field-contains', 'field-not-contains'];
export const VALUE_GATE_KINDS = ['field-eq', 'field-contains', 'field-not-contains'];

/**
 * A branch step's condition. `kind: 'rules'` = a #221 rule set (`match` + `rules`, the
 * RuleBuilder shape; `step_opened`/`step_clicked` rule values are a step id, or a `ref` in a
 * spec). Otherwise a legacy gate, reading only its own fields:
 * - tag / no-tag / field-exists / field-not-exists: `name`
 * - field-eq / field-contains / field-not-contains: `name`, `value`
 * - list-member: `list_id`
 * - opened / clicked: `step_id` (direct writes) or `step_ref` (specs) — an email step
 * - split: `pct` (0–100 to YES, default 50)
 * - company-metric: `metric`, `op`, `value` (number)
 * - visited: `mode` page|event, `name` (path text / event name), `days` (0 = ever)
 * - pipeline-stage: `mode` in|any|none, `stage_id` (for `in`)
 */
export type BranchCondition = {
	kind: 'rules' | (typeof GATE_KINDS)[number];
	match?: 'all' | 'any';
	rules?: ConditionRule[];
	name?: string;
	value?: string | number | null;
	list_id?: number | null;
	step_id?: number | null;
	step_ref?: string | null;
	pct?: number;
	metric?: string;
	op?: string;
	mode?: string;
	days?: number | string;
	stage_id?: number | null;
};

export const ACTION_KINDS = [
	'enroll_automation',
	'end_automation',
	'end_all_automations',
	'goto_step',
	'pipeline_move',
	'pipeline_remove',
	'set_tier',
	'adjust_score'
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * An action step. Only the fields of `kind` are read:
 * - enroll_automation / end_automation: `automation_id` (another automation)
 * - end_all_automations: none (a target is refused)
 * - goto_step: `step_id` (direct writes) or `step_ref` (specs) — a step of this automation
 * - pipeline_move: `stage_id`, optional `only_from_stage_id`
 * - pipeline_remove: none
 * - set_tier (#460): `tier` (hot | warm | cool | cold | never | new, or 'clear' = back to
 *   automatic) and optional `days` (1–365; omitted = until cleared)
 * - adjust_score (#467): `score_id`, `points` (± whole number, not 0) and optional
 *   `expires_days` (omitted = never) — a ledger row `source_type='automation'`
 */
export type ActionSpec = {
	kind: ActionKind;
	automation_id?: number | null;
	step_id?: number | null;
	step_ref?: string | null;
	stage_id?: number | null;
	only_from_stage_id?: number | null;
	tier?: string | null;
	days?: number | null;
	score_id?: number | null;
	points?: number | null;
	expires_days?: number | null;
};

/**
 * One step's configuration. Common: `wait_seconds` (before the step, default 0) and
 * `weekday_only` (#119). Then, by type:
 * - email: `subject`, `from_email` (approved sender; a spec may omit it for the default
 *   From), `body_blocks` (visual-editor blocks, sanitised — wins) or `body_md`, `preheader`,
 *   `tag_on_open` / `tag_on_click` (null = off)
 * - tag: `tag_action` add|remove, `tag_name`
 * - branch: `condition`
 * - action: `action`
 * - end: nothing
 * - wait (#397): `wait` (a `WaitSpec`: a set delay `{ mode: 'delay', seconds, weekdays_only? }`
 *   (#625), event + timeout, a date / time, a send window, (#627) a contact's date custom field
 *   `{ mode: 'field_date', field, relation, offset?, unit?, time?, if_passed? }`, or (#626)
 *   `{ mode: 'rules', rules, timeout_seconds? }`). An event / rules wait has lanes like a branch:
 *   `yes` = the event happened / the contact matched, `no` = timed out. An opened / clicked wait needs an
 *   email step before it. A wait step's own `wait_seconds` is an extra delay before it starts.
 */
export type StepFields = {
	wait_seconds?: number;
	weekday_only?: boolean;
	subject?: string;
	from_email?: string | null;
	preheader?: string | null;
	body_md?: string | null;
	body_blocks?: unknown;
	tag_on_open?: string | null;
	tag_on_click?: string | null;
	tag_action?: 'add' | 'remove';
	tag_name?: string;
	condition?: BranchCondition;
	action?: ActionSpec;
	wait?: WaitSpec;
};

/** Does this spec step carry YES / NO lanes? A branch, or an event / rules wait (#397, #626). */
export function specHasLanes(step: { type?: unknown; wait?: { mode?: unknown } | null }): boolean {
	return step.type === 'branch' || (step.type === 'wait' && waitModeHasLanes(step.wait?.mode));
}

/** A step inside a whole-flow spec: its type + fields, an optional local `ref` (what
 *  go-to / opened / clicked conditions point at) and, for a branch, its two lanes. */
export type StepSpec = StepFields & {
	type: StepType;
	ref?: string;
	yes?: StepSpec[];
	no?: StepSpec[];
};

export type AutomationSpec = {
	name: string;
	trigger: TriggerSpec;
	reentry?: 'once' | 'multiple';
	labels?: string[];
	/** #412: entry conditions — a contact who doesn't match is not enrolled (null = none). */
	entry_rules?: ConditionRuleSet | null;
	steps: StepSpec[];
};

/** One problem in a spec; `path` is like `steps[2].yes[0]` or `trigger`. */
export type SpecProblem = { path: string; message: string };

export const SPEC_MAX_STEPS = 200;
export const SPEC_MAX_DEPTH = 10;
export const NAME_MAX = 200;
export const TAG_MAX = 60;
export const REF_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The drawer's wait (value + unit) in seconds; negative / junk = 0. */
export function toSeconds(value: number, unit: string): number {
	const v = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
	if (unit === 'weeks') return v * 604800; // #625: the wait step's delay
	if (unit === 'days') return v * 86400;
	if (unit === 'hours') return v * 3600;
	return v * 60; // minutes
}

/** Every step of a spec, depth-first (a branch, then its YES lane, then its NO lane), with
 *  its path and depth (0 = trunk). The order `readSpec` numbers refs in. */
export function walkSpec(steps: StepSpec[], base = 'steps', depth = 0): { step: StepSpec; path: string; depth: number }[] {
	const out: { step: StepSpec; path: string; depth: number }[] = [];
	if (!Array.isArray(steps)) return out;
	steps.forEach((step, i) => {
		const path = `${base}[${i}]`;
		out.push({ step, path, depth });
		if (step && typeof step === 'object' && specHasLanes(step)) {
			out.push(...walkSpec(step.yes ?? [], `${path}.yes`, depth + 1));
			out.push(...walkSpec(step.no ?? [], `${path}.no`, depth + 1));
		}
	});
	return out;
}

/** Structural problems of a spec — no database needed: name, step list, known types, lanes
 *  only on branches, refs well-formed and unique, size and nesting caps. The server's
 *  `validateSpec` adds the per-step checks (incl. that each `step_ref` resolves) and the DB
 *  ones. */
export function specStructureProblems(spec: AutomationSpec): SpecProblem[] {
	const out: SpecProblem[] = [];
	if (!spec || typeof spec !== 'object') return [{ path: '', message: 'The spec must be an object.' }];
	const name = typeof spec.name === 'string' ? spec.name.trim() : '';
	if (!name) out.push({ path: 'name', message: 'Give the automation a name.' });
	else if (name.length > NAME_MAX) out.push({ path: 'name', message: `A name can be at most ${NAME_MAX} characters.` });
	if (!spec.trigger || typeof spec.trigger !== 'object') out.push({ path: 'trigger', message: 'Set a trigger.' });
	if (spec.reentry !== undefined && spec.reentry !== 'once' && spec.reentry !== 'multiple') {
		out.push({ path: 'reentry', message: 'Invalid re-entry policy.' });
	}
	if (spec.labels !== undefined && !Array.isArray(spec.labels)) out.push({ path: 'labels', message: 'Labels must be a list.' });
	if (!Array.isArray(spec.steps)) {
		out.push({ path: 'steps', message: 'Steps must be a list.' });
		return out;
	}
	const all = walkSpec(spec.steps);
	if (all.length > SPEC_MAX_STEPS) out.push({ path: 'steps', message: `At most ${SPEC_MAX_STEPS} steps.` });
	const refs = new Map<string, StepType>();
	for (const { step, path, depth } of all) {
		if (!step || typeof step !== 'object') {
			out.push({ path, message: 'Each step must be an object.' });
			continue;
		}
		if (!(STEP_TYPES as readonly string[]).includes(step.type)) {
			out.push({ path, message: `Unknown step type “${String(step.type)}” (${STEP_TYPES.join(', ')}).` });
		}
		if (depth > SPEC_MAX_DEPTH) out.push({ path, message: `Branches nest at most ${SPEC_MAX_DEPTH} deep.` });
		if (specHasLanes(step)) {
			for (const lane of ['yes', 'no'] as const) {
				if (step[lane] !== undefined && !Array.isArray(step[lane])) out.push({ path: `${path}.${lane}`, message: 'A lane must be a list of steps.' });
			}
		} else if (step.yes !== undefined || step.no !== undefined) {
			out.push({ path, message: 'Only a branch step or an event / rules wait has yes / no lanes.' });
		}
		if (step.ref !== undefined) {
			if (typeof step.ref !== 'string' || !REF_RE.test(step.ref)) {
				out.push({ path: `${path}.ref`, message: 'A ref is 1–40 letters, digits, - or _.' });
			} else if (refs.has(step.ref)) {
				out.push({ path: `${path}.ref`, message: `The ref “${step.ref}” is used twice.` });
			} else refs.set(step.ref, step.type);
		}
	}
	out.push(...specWaitEmailProblems(spec.steps));
	return out;
}

/** #625: an opened / clicked wait needs an email step before it in its path. */
export function specWaitEmailProblems(steps: StepSpec[]): SpecProblem[] {
	const nodes: (FlowStepRef & { path: string; step: StepSpec })[] = [];
	const flatten = (lane: StepSpec[], parent: number | null, label: string | null, base: string, depth: number) => {
		if (!Array.isArray(lane) || depth > SPEC_MAX_DEPTH + 1) return;
		lane.forEach((step, i) => {
			if (!step || typeof step !== 'object') return;
			const id = nodes.length + 1;
			const path = `${base}[${i}]`;
			nodes.push({ id, type: String(step.type), parent_step_id: parent, branch_label: label, position: i, path, step });
			if (specHasLanes(step)) {
				flatten(step.yes ?? [], id, 'yes', `${path}.yes`, depth + 1);
				flatten(step.no ?? [], id, 'no', `${path}.no`, depth + 1);
			}
		});
	};
	flatten(steps, null, null, 'steps', 0);
	return nodes
		.filter((n) => n.type === 'wait' && waitNeedsEmail(n.step.wait) && !previousEmailStep(nodes, n.id))
		.map((n) => ({ path: n.path, message: NO_PREVIOUS_EMAIL }));
}

/** The refs a spec defines → their step type. */
export function specRefs(spec: AutomationSpec): Map<string, StepType> {
	const refs = new Map<string, StepType>();
	for (const { step } of walkSpec(spec?.steps ?? [])) {
		if (step && typeof step.ref === 'string' && REF_RE.test(step.ref) && !refs.has(step.ref)) refs.set(step.ref, step.type);
	}
	return refs;
}
