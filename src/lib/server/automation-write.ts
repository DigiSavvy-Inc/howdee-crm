// #345: the automation builder's write layer — one function per edit, shared by the builder's
// form actions (/automations/[id]), and next the assistant, the Data API and an MCP server.
// No SvelteKit imports. Every function takes `(db, automationId, input, actor, opts)` (create
// takes no id) and returns `{ ok: true, data } | { ok: false, error }`; nothing throws for a
// user mistake. Types and the whole-flow `AutomationSpec` live in `$lib/automation-spec`.
//
// Out of scope on purpose: status changes and enrollment. Activate / pause / enroll stay in
// the route and automation-bulk.ts — this module never imports the engine (automations.ts),
// `enroll`, `sendCampaignEmail` or `activationProblem` (tests/automation-write.test.ts). The
// step-tree helpers it needs (nextStep, weekdayDueUtc) come from automation-tree.ts.
//
// `opts.draftOnly` (assistant / API callers): refuse unless the automation is draft or
// paused; a paused one with contacts mid-flow comes back as `needsApproval: true` (nothing
// written) until the caller repeats the call with `opts.approved`. The builder passes
// `draftOnly: false` — it edits live flows (the pointer is a step id, #74).
//
// `actor` says who made the edit (the builder passes the signed-in user). Nothing records it
// yet; it is in the signatures so the audit trail can be added without changing callers.

import { customFieldByKey } from './custom-fields';
import { fromAllowed, getSettings } from './settings';
import { MAX_LABELS_PER_AUTOMATION, addLabel as insertLabel, copyLabels, listLabels, normalizeLabel, removeLabel as deleteLabel } from './automation-labels';
import { TRIGGER_METRICS, decodeCondition, normalizeCondition } from '$lib/company-metrics';
import { DEFAULT_COOLDOWN_HOURS, MAX_COOLDOWN_HOURS, PATTERN_MAX, decodeVisited, isPathOp, normalizeVisited } from '$lib/site-trigger';
import { normalizeRuleSet, parseGateRules, type ConditionRuleSet } from '$lib/condition-rules';
import { conditionRulesProblem } from './condition-eval';
import { bodyBlocksColumn, bodyIsEmpty, composeBodyFrom, renderBody, storedBlocks } from './compose-body';
import { getSignature } from './email-signature';
import { STEP_NOT_FINISHED } from '$lib/automation-action-labels';
import { normalizeTierOverride } from '$lib/tier-override';
import { STEP_COLS, nextStep, weekdayDueUtc, type StepRow } from './automation-tree';
import {
	DEFAULT_WAIT,
	NO_PREVIOUS_EMAIL,
	normalizeExitRules,
	normalizeWait,
	parseWait,
	previousEmailStep,
	stepHasLanes,
	waitModeHasLanes,
	waitNeedsEmail,
	type FlowStepRef
} from '$lib/automation-flow';
import {
	ACTION_KINDS,
	specHasLanes,
	GATE_KINDS,
	NAMED_GATE_KINDS,
	STEP_TYPES,
	TAG_MAX,
	TRIGGER_TYPES,
	VALUE_GATE_KINDS,
	specRefs,
	specStructureProblems,
	walkSpec,
	type ActionKind,
	type ActionSpec,
	type AutomationSpec,
	type BranchCondition,
	type SpecProblem,
	type StepFields,
	type StepSpec,
	type StepType,
	type TriggerSpec
} from '$lib/automation-spec';
import {
	configEmailIds,
	isEngagementKind,
	normalizeEngagementConfig,
	parseEngagementConfig,
	type EmailRef,
	type EngagementTriggerConfig,
	type ExcludeEntry
} from '$lib/engagement-trigger';
import { isSiteActivityKind, normalizeSiteActivityConfig, parseSiteActivityConfig } from '$lib/site-activity-trigger';
import { isSubscriptionKind, normalizeSubscriptionConfig, parseSubscriptionConfig } from '$lib/subscription-trigger';
import { isFormTriggerKind, normalizeFormTriggerConfig, parseFormTriggerConfig } from '$lib/form-trigger';
import { isScoreTriggerKind, normalizeAdjustScore, normalizeScoreTriggerConfig, parseAdjustScore, parseScoreTriggerConfig } from '$lib/score-trigger';
import { parseBands } from '$lib/scoring';

/** Who made an edit. `id` = users.id / api_keys.id / … for the kind. */
export type Actor = { kind: 'user' | 'assistant' | 'api' | 'mcp' | 'system'; id?: number | null };

export type WriteOpts = {
	/** Refuse unless the automation is draft or paused (assistant / API). Default false. */
	draftOnly?: boolean;
	/** With draftOnly: the user approved editing a paused automation that has contacts mid-flow. */
	approved?: boolean;
};

export type WriteFailure = {
	ok: false;
	error: string;
	/** 404 = the automation / step doesn't exist; 409 = draftOnly and it isn't draft or paused. */
	status?: 400 | 404 | 409;
	/** draftOnly: paused with active enrollments — nothing written; repeat with `approved`. */
	needsApproval?: true;
	activeEnrollments?: number;
	/** createFromSpec: every problem found by validateSpec. */
	problems?: SpecProblem[];
};

export type WriteResult<T = null> = { ok: true; data: T } | WriteFailure;

const fail = (error: string, status?: 400 | 404 | 409): WriteFailure => (status ? { ok: false, error, status } : { ok: false, error });

type AutomationRow = { id: number; name: string; status: string };

/** The automation, or a failure: missing (404), or — with draftOnly — not editable. */
async function guard(db: D1Database, automationId: number, opts: WriteOpts): Promise<{ ok: true; automation: AutomationRow } | WriteFailure> {
	const a = await db.prepare('SELECT id, name, status FROM automations WHERE id = ?').bind(automationId).first<AutomationRow>();
	if (!a) return fail('Automation not found.', 404);
	if (!opts.draftOnly) return { ok: true, automation: a };
	if (a.status !== 'draft' && a.status !== 'paused') {
		return fail(`“${a.name}” is ${a.status}. Only draft or paused automations can be edited this way — pause it first.`, 409);
	}
	if (a.status === 'paused' && !opts.approved) {
		const n = await db
			.prepare("SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND status = 'active'")
			.bind(automationId)
			.first<{ n: number }>();
		if ((n?.n ?? 0) > 0) {
			return {
				ok: false,
				needsApproval: true,
				activeEnrollments: n!.n,
				error: `“${a.name}” is paused with ${n!.n} contact${n!.n === 1 ? '' : 's'} mid-flow — approve the edit first.`
			};
		}
	}
	return { ok: true, automation: a };
}

// ── Automation-level edits ───────────────────────────────────────────────────────────────

type TriggerCols = {
	trigger_type: string;
	trigger_list_id: number | null;
	trigger_metric: string | null;
	trigger_direction: string | null;
	trigger_threshold: number | null;
	trigger_site_id: number | null;
	trigger_path_op: string | null;
	trigger_path: string | null;
	trigger_cooldown_hours: number | null;
	trigger_stage_id: number | null;
	/** #412: JSON config of the newer kinds (email_opened / email_clicked, #434 site_activity, #444 subscription_changed); NULL for the rest. */
	trigger_config: string | null;
};

/** #412: an engagement trigger's config → its stored JSON, after checking every campaign /
 *  email step / list it names still exists. `refs` (whole-flow specs) lets `step_ref` name
 *  one of the spec's own email steps; it is stored as-is and swapped for the real id by
 *  `resolveConfigRefs` once the steps exist. */
async function engagementConfigColumn(
	db: D1Database,
	t: TriggerSpec,
	refs?: Map<string, StepType>
): Promise<{ ok: true; json: string } | WriteFailure> {
	const kind = t.type as 'email_opened' | 'email_clicked';
	const r = normalizeEngagementConfig(kind, t as unknown as Record<string, unknown>, { allowRefs: !!refs });
	if (!r.ok) return fail(r.error);
	const cfg = r.config;
	const checkEmail = async (ref: EmailRef | ExcludeEntry, where: string): Promise<string | null> => {
		if (ref === 'any' || 'link' in ref) return null;
		if ('campaign_id' in ref) {
			const c = await db
				.prepare('SELECT id FROM campaigns WHERE id = ? AND automation_step_id IS NULL')
				.bind(ref.campaign_id)
				.first();
			return c ? null : `${where}: that campaign no longer exists.`;
		}
		if ('step_id' in ref) {
			const s = await db.prepare("SELECT id FROM automation_steps WHERE id = ? AND type = 'email'").bind(ref.step_id).first();
			return s ? null : `${where}: that email step no longer exists.`;
		}
		if ('step_ref' in ref) return refs?.get(ref.step_ref) === 'email' ? null : `${where}: no email step has the ref “${ref.step_ref}”.`;
		return null;
	};
	const e = await checkEmail(cfg.email, 'Trigger email');
	if (e) return fail(e);
	for (const [i, x] of cfg.exclude.entries()) {
		const p = await checkEmail(x, `Condition ${i + 1}`);
		if (p) return fail(p);
	}
	if (cfg.list_id && !(await db.prepare('SELECT id FROM lists WHERE id = ?').bind(cfg.list_id).first())) {
		return fail('The trigger’s list, segment or tag no longer exists.');
	}
	return { ok: true, json: JSON.stringify(cfg) };
}

/** #412: swap the `step_ref` entries of a stored engagement config for real step ids
 *  (whole-flow create / replace). An unknown ref is left out of the excludes; as the main
 *  email it falls back to 'any' (validation already refused that case). */
function resolveConfigRefs(json: string | null, ids: Map<string, number>): string | null {
	if (!json) return json;
	let cfg: EngagementTriggerConfig;
	try {
		cfg = JSON.parse(json);
	} catch {
		return json;
	}
	const fix = <T extends EmailRef | ExcludeEntry>(r: T): T | null => {
		if (r && typeof r === 'object' && 'step_ref' in r) {
			const id = ids.get(r.step_ref);
			return id ? ({ step_id: id } as T) : null;
		}
		return r;
	};
	cfg.email = fix(cfg.email) ?? 'any';
	cfg.exclude = (cfg.exclude ?? []).map(fix).filter((x): x is ExcludeEntry => x !== null);
	return JSON.stringify(cfg);
}

/** #412: rewrite every `{ step_id }` of a stored config through `map` (duplicate → the copies,
 *  readSpec → refs). Unparseable JSON comes back unchanged. */
function remapConfigSteps(
	json: string,
	map: (stepId: number) => number | { step_ref: string }
): string {
	let cfg: EngagementTriggerConfig;
	try {
		cfg = JSON.parse(json);
	} catch {
		return json;
	}
	const fix = <T extends EmailRef | ExcludeEntry>(r: T): T => {
		if (r && typeof r === 'object' && 'step_id' in r) {
			const to = map(r.step_id);
			return (typeof to === 'number' ? { step_id: to } : to) as T;
		}
		return r;
	};
	const out = { ...cfg, email: fix(cfg.email), exclude: (cfg.exclude ?? []).map(fix) };
	const s = JSON.stringify(out);
	return s === JSON.stringify(cfg) ? json : s;
}

/** A trigger → the automations.trigger_* columns, with the builder's validation. */
async function triggerColumns(
	db: D1Database,
	t: TriggerSpec,
	opts: { refs?: Map<string, StepType> } = {}
): Promise<{ ok: true; cols: TriggerCols } | WriteFailure> {
	const type = String(t?.type ?? 'manual');
	if (!(TRIGGER_TYPES as readonly string[]).includes(type)) return fail('Invalid trigger type.');
	const cols: TriggerCols = {
		trigger_type: type,
		trigger_list_id: null,
		trigger_metric: null,
		trigger_direction: null,
		trigger_threshold: null,
		trigger_site_id: null,
		trigger_path_op: null,
		trigger_path: null,
		trigger_cooldown_hours: null,
		trigger_stage_id: null,
		trigger_config: null
	};
	// #412: "Opens an email" / "Clicks a link in an email" — fired by the Postmark webhook.
	if (isEngagementKind(type)) {
		const c = await engagementConfigColumn(db, t, opts.refs);
		if (!c.ok) return c;
		cols.trigger_config = c.json;
	}
	// #434: "Visits the site often" — counted at ingest (/api/track); the other kinds' columns stay NULL.
	if (isSiteActivityKind(type)) {
		const r = normalizeSiteActivityConfig(t as unknown as Record<string, unknown>);
		if (!r.ok) return fail(r.error);
		if (r.config.site_id !== null && !(await db.prepare('SELECT id FROM tracking_sites WHERE id = ?').bind(r.config.site_id).first())) {
			return fail('That tracking site no longer exists.');
		}
		cols.trigger_config = JSON.stringify(r.config);
	}
	// #444: "Subscription changes" — fired by the unsubscribe / resubscribe / bounce / topic writes.
	if (isSubscriptionKind(type)) {
		const r = normalizeSubscriptionConfig(t as unknown as Record<string, unknown>);
		if (!r.ok) return fail(r.error);
		if (
			r.config.topic_list_id !== null &&
			!(await db.prepare("SELECT id FROM lists WHERE id = ? AND kind = 'list'").bind(r.config.topic_list_id).first())
		) {
			return fail('That topic list no longer exists.');
		}
		cols.trigger_config = JSON.stringify(r.config);
	}
	// #467: "Score changes" — fired from the changes the scoring engine records.
	if (isScoreTriggerKind(type)) {
		const r = normalizeScoreTriggerConfig(t as unknown as Record<string, unknown>);
		if (!r.ok) return fail(r.error);
		const score = await db.prepare('SELECT bands FROM score_defs WHERE id = ?').bind(r.config.score_id).first<{ bands: string | null }>();
		if (!score) return fail('That score no longer exists.');
		if (r.config.mode === 'enters_band') {
			const band = parseBands(score.bands).find((b) => b.label.toLowerCase() === (r.config.band ?? '').toLowerCase());
			if (!band) return fail('That band is not one of the score’s bands.');
			r.config.band = band.label;
		}
		cols.trigger_config = JSON.stringify(r.config);
	}
	// #516: "Form submitted" — fired by handleSubmission (form-submit.ts) after the contact write.
	if (isFormTriggerKind(type)) {
		const r = normalizeFormTriggerConfig(t as unknown as Record<string, unknown>);
		if (!r.ok) return fail(r.error);
		if (r.config.form_id !== null && !(await db.prepare('SELECT id FROM forms WHERE id = ?').bind(r.config.form_id).first())) {
			return fail('That form no longer exists.');
		}
		cols.trigger_config = JSON.stringify(r.config);
	}
	if (type === 'list_added') {
		cols.trigger_list_id = Number(t.list_id) || null;
		if (!cols.trigger_list_id) return fail('Choose a list/segment for the “added to list” trigger.');
	}
	// #170: "Company metric crossed" — evaluated after each integration sync.
	if (type === 'company_metric') {
		const metric = String(t.metric ?? '');
		if (!TRIGGER_METRICS.some((m) => m.key === metric)) return fail('Choose a company metric for the trigger.');
		cols.trigger_metric = metric;
		cols.trigger_direction = t.direction === 'below' ? 'below' : 'above';
		const threshold = t.threshold === null || t.threshold === undefined ? NaN : Number(t.threshold);
		if (!Number.isFinite(threshold)) return fail('Set a numeric threshold for the trigger.');
		cols.trigger_threshold = threshold;
	}
	// #154: "Visits a page" — evaluated at ingest (/api/track), per-contact cooldown.
	if (type === 'site_visit') {
		if (t.site_id !== null && t.site_id !== undefined) {
			const siteId = Number(t.site_id);
			const site = Number.isInteger(siteId)
				? await db.prepare('SELECT id FROM tracking_sites WHERE id = ?').bind(siteId).first<{ id: number }>()
				: null;
			if (!site) return fail('That tracking site no longer exists.');
			cols.trigger_site_id = siteId;
		}
		const pathOp = String(t.path_op ?? 'contains');
		if (!isPathOp(pathOp)) return fail('Choose how the page path is matched.');
		cols.trigger_path_op = pathOp;
		cols.trigger_path = String(t.path ?? '').trim().slice(0, PATTERN_MAX);
		if (!cols.trigger_path) return fail('Set the page path for the “visits a page” trigger.');
		const cooldown = t.cooldown_hours === null || t.cooldown_hours === undefined ? DEFAULT_COOLDOWN_HOURS : Number(t.cooldown_hours);
		if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > MAX_COOLDOWN_HOURS) {
			return fail('Cooldown must be a whole number of hours (0 or more).');
		}
		cols.trigger_cooldown_hours = cooldown;
	}
	// #207: "Enters a pipeline stage" — fired by pipeline.ts on every add/move into the stage.
	if (type === 'pipeline_stage_entered') {
		cols.trigger_stage_id = Number(t.stage_id) || null;
		const stage = cols.trigger_stage_id
			? await db.prepare('SELECT id FROM pipeline_stages WHERE id = ?').bind(cols.trigger_stage_id).first<{ id: number }>()
			: null;
		if (!stage) return fail('Choose a pipeline stage for the trigger.');
	}
	return { ok: true, cols };
}

/** Create a draft automation (never active). Trigger defaults to manual, re-entry to once. */
export async function createAutomation(
	db: D1Database,
	input: { name: string; trigger?: TriggerSpec; reentry?: 'once' | 'multiple' },
	actor: Actor,
	opts: { refs?: Map<string, StepType> } = {}
): Promise<WriteResult<{ automation_id: number }>> {
	void actor;
	const name = String(input.name ?? '').trim();
	if (!name) return fail('Give the automation a name.');
	if (input.reentry !== undefined && input.reentry !== 'once' && input.reentry !== 'multiple') return fail('Invalid re-entry policy.');
	const t = await triggerColumns(db, input.trigger ?? { type: 'manual' }, opts);
	if (!t.ok) return t;
	const c = t.cols;
	const row = await db
		.prepare(
			`INSERT INTO automations (name, status, trigger_type, trigger_list_id, trigger_metric, trigger_direction, trigger_threshold,
			                          trigger_site_id, trigger_path_op, trigger_path, trigger_cooldown_hours, trigger_stage_id, trigger_config, reentry)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			name,
			c.trigger_type,
			c.trigger_list_id,
			c.trigger_metric,
			c.trigger_direction,
			c.trigger_threshold,
			c.trigger_site_id,
			c.trigger_path_op,
			c.trigger_path,
			c.trigger_cooldown_hours,
			c.trigger_stage_id,
			c.trigger_config,
			input.reentry ?? 'once'
		)
		.first<{ id: number }>();
	return { ok: true, data: { automation_id: row!.id } };
}

export async function renameAutomation(
	db: D1Database,
	automationId: number,
	input: { name: string },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const name = String(input.name ?? '').trim();
	if (!name) return fail('Name cannot be empty.');
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	await db.prepare('UPDATE automations SET name = ? WHERE id = ?').bind(name, automationId).run();
	return { ok: true, data: null };
}

/** Set the trigger (every type, with its fields; the other types' columns are cleared). */
export async function setTrigger(
	db: D1Database,
	automationId: number,
	input: TriggerSpec,
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const t = await triggerColumns(db, input);
	if (!t.ok) return t;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const c = t.cols;
	await db
		.prepare(
			`UPDATE automations SET trigger_type = ?, trigger_list_id = ?, trigger_metric = ?, trigger_direction = ?, trigger_threshold = ?,
			        trigger_site_id = ?, trigger_path_op = ?, trigger_path = ?, trigger_cooldown_hours = ?, trigger_stage_id = ?,
			        trigger_config = ? WHERE id = ?`
		)
		.bind(
			c.trigger_type,
			c.trigger_list_id,
			c.trigger_metric,
			c.trigger_direction,
			c.trigger_threshold,
			c.trigger_site_id,
			c.trigger_path_op,
			c.trigger_path,
			c.trigger_cooldown_hours,
			c.trigger_stage_id,
			c.trigger_config,
			automationId
		)
		.run();
	return { ok: true, data: null };
}

/** #412: why an entry-condition rule set can't be stored, or null. Same checks as a
 *  Condition step's rules, except email-step rules (an entry check runs before the contact
 *  has received anything from this automation). */
export async function entryRulesProblem(db: D1Database, automationId: number, set: ConditionRuleSet | null): Promise<string | null> {
	if (!set) return null;
	if (set.rules.some((r) => r.field === 'step_opened' || r.field === 'step_clicked')) {
		return 'Entry conditions can’t use “opened / clicked email step” rules.';
	}
	// #516: a form answer is read from the pass's submission, which doesn't exist before entry.
	if (set.rules.some((r) => r.field === 'form_answer')) {
		return 'Entry conditions can’t use “answer to a form question” rules — use the trigger’s answer filter.';
	}
	const p = await conditionRulesProblem(db, automationId, set);
	return p ? `Entry conditions: ${p}` : null;
}

/** #412: entry conditions for every trigger kind — the whole rule set, replaced (null or no
 *  rules = none). enroll() skips a contact who doesn't match. */
export async function setEntryRules(
	db: D1Database,
	automationId: number,
	input: { rules: unknown },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ count: number }>> {
	void actor;
	const raw = input.rules;
	const set = raw === null || raw === undefined || raw === '' ? null : normalizeRuleSet(raw);
	if (raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules) && (raw as { rules: unknown[] }).rules.length > 0 && !set) {
		return fail('Entry conditions: invalid rules.');
	}
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const problem = await entryRulesProblem(db, automationId, set);
	if (problem) return fail(problem);
	await db
		.prepare('UPDATE automations SET entry_rules = ? WHERE id = ?')
		.bind(set ? JSON.stringify(set) : null, automationId)
		.run();
	return { ok: true, data: { count: set?.rules.length ?? 0 } };
}

/** Re-entry policy: 'once' (any prior pass blocks re-enrollment — the default) or
 *  'multiple' (a contact can re-enter after a pass ends; one active pass at a time). */
export async function setReentry(
	db: D1Database,
	automationId: number,
	input: { reentry: string },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	if (input.reentry !== 'once' && input.reentry !== 'multiple') return fail('Invalid re-entry policy.');
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	await db.prepare('UPDATE automations SET reentry = ? WHERE id = ?').bind(input.reentry, automationId).run();
	return { ok: true, data: null };
}

/** #397: exit conditions (goals) — the whole list, replaced (empty = none). A list / segment
 *  and a stage must exist when saved; the engine checks them before every step. */
export async function setExitRules(
	db: D1Database,
	automationId: number,
	input: { rules: unknown },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ count: number }>> {
	void actor;
	const r = normalizeExitRules(input.rules);
	if (!r.ok) return fail(r.error);
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	for (const rule of r.rules) {
		if (rule.kind === 'segment' && !(await db.prepare('SELECT id FROM lists WHERE id = ?').bind(rule.list_id).first())) {
			return fail('That list or segment no longer exists.');
		}
		if (rule.kind === 'stage' && !(await db.prepare('SELECT id FROM pipeline_stages WHERE id = ?').bind(rule.stage_id).first())) {
			return fail('That pipeline stage no longer exists.');
		}
	}
	await db
		.prepare('UPDATE automations SET exit_rules = ? WHERE id = ?')
		.bind(r.rules.length ? JSON.stringify(r.rules) : null, automationId)
		.run();
	return { ok: true, data: { count: r.rules.length } };
}

/** Free-form label (#74); a case-insensitive duplicate is a no-op success. */
export async function addLabel(
	db: D1Database,
	automationId: number,
	input: { label: string },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ label: string }>> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const r = await insertLabel(db, automationId, String(input.label ?? ''));
	return r.ok ? { ok: true, data: { label: r.label } } : fail(r.error);
}

export async function removeLabel(
	db: D1Database,
	automationId: number,
	input: { label: string },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	await deleteLabel(db, automationId, String(input.label ?? ''));
	return { ok: true, data: null };
}

// ── Step configuration ───────────────────────────────────────────────────────────────────

/** Where a step's references resolve: real ids in this automation (direct writes), or a
 *  spec's local refs (`refs` set — then the ids are filled in by `fixups` after insert). */
type StepCtx = {
	automationId: number;
	stepId: number | null;
	refs?: Map<string, StepType>;
	selfRef?: string;
	defaultFrom?: string;
};

type Cols = Record<string, string | number | null>;
type Fixup = (ids: Map<string, number>) => Cols;
type StepColsResult = { ok: true; cols: Cols; fixups: Fixup[] } | WriteFailure;

// #128: `enroll_automation` / `end_automation` need a target that exists and isn't this
// automation (the engine re-checks at run time — the FK nulls on delete, and status can
// change). `end_all_automations` must NOT carry a target.
async function validateActionTarget(
	db: D1Database,
	automationId: number,
	kind: Exclude<ActionKind, 'goto_step' | 'pipeline_move' | 'pipeline_remove' | 'set_tier'>,
	targetId: number | null
): Promise<string | null> {
	if (kind === 'end_all_automations') {
		return targetId !== null ? "End all other automations can't also target a specific automation." : null;
	}
	if (!targetId) return 'Choose a target automation for this action.';
	if (targetId === automationId) return "An action can't target its own automation.";
	const target = await db.prepare('SELECT id FROM automations WHERE id = ?').bind(targetId).first<{ id: number }>();
	return target ? null : 'That automation no longer exists.';
}

// #146: a goto_step target must be another step of the SAME automation (trunk or a branch
// lane) — never the goto step itself. The FK nulls it if the target is deleted later.
async function validateGotoTarget(db: D1Database, automationId: number, stepId: number | null, targetStepId: number | null): Promise<string | null> {
	if (!targetStepId) return 'Choose a step to go to.';
	if (targetStepId === stepId) return "A step can't go to itself.";
	const target = await db
		.prepare('SELECT id FROM automation_steps WHERE id = ? AND automation_id = ?')
		.bind(targetStepId, automationId)
		.first<{ id: number }>();
	return target ? null : 'That step is not in this automation.';
}

// #207: pipeline_move needs an existing destination stage; the optional only-from stage must
// exist and differ from it. pipeline_remove takes no stage.
async function validatePipelineStages(db: D1Database, kind: string, stageId: number | null, onlyFromId: number | null): Promise<string | null> {
	if (kind === 'pipeline_remove') return null;
	const exists = async (sid: number) => !!(await db.prepare('SELECT id FROM pipeline_stages WHERE id = ?').bind(sid).first<{ id: number }>());
	if (!stageId || !(await exists(stageId))) return 'Choose the pipeline stage to move the contact to.';
	if (onlyFromId !== null) {
		if (onlyFromId === stageId) return '“Only from” must be a different stage.';
		if (!(await exists(onlyFromId))) return 'That “only from” stage no longer exists.';
	}
	return null;
}

const posId = (v: unknown): number | null => Number(v) || null;

// #467: adjust_score stores `action_config` JSON { score_id, points, expires_days }.
async function scoreActionColumns(db: D1Database, a: ActionSpec): Promise<{ ok: true; cols: Cols } | { ok: false; error: string }> {
	const n = normalizeAdjustScore({ score_id: a.score_id, points: a.points, expires_days: a.expires_days });
	if (!n.ok) return n;
	if (!(await db.prepare('SELECT id FROM score_defs WHERE id = ?').bind(n.value.score_id).first())) return { ok: false, error: 'That score no longer exists.' };
	return { ok: true, cols: { action_config: JSON.stringify(n.value) } };
}

// #460: set_tier stores `target_tier` (a tier, or 'clear') and `tier_days` (1–365, NULL =
// until cleared; always NULL for a clear).
function tierActionColumns(a: ActionSpec): { ok: true; cols: Cols } | { ok: false; error: string } {
	if (a.tier === null || a.tier === undefined || a.tier === '') return { ok: false, error: 'Choose the tier to set, or Clear.' };
	const n = normalizeTierOverride({ tier: a.tier, days: a.days });
	if (!n.ok) return n;
	return { ok: true, cols: { target_tier: n.value.tier ?? 'clear', tier_days: n.value.days } };
}

/** One step's fields → the columns its type stores (only those; the rest of the row is left
 *  alone), validated the way the builder's drawer is. */
async function stepColumns(db: D1Database, type: string, f: StepFields, ctx: StepCtx): Promise<StepColsResult> {
	const timing: Cols = {
		delay_before_seconds: Math.max(0, Math.floor(Number(f.wait_seconds) || 0)),
		// #119: opt-in "weekdays only" on this step's wait.
		weekday_only: f.weekday_only ? 1 : 0
	};
	const spec = !!ctx.refs;

	if (type === 'end') return { ok: true, cols: timing, fixups: [] };

	// #397: wait-until step. Only event / rules waits (#626) have lanes, so switching a wait whose lanes hold
	// steps to another mode is refused (the steps would be stranded).
	if (type === 'wait') {
		const w = normalizeWait(f.wait);
		if (!w.ok) return fail(w.error);
		// #627: the field must be a defined custom field of type date.
		if (w.wait.mode === 'field_date') {
			const cf = await customFieldByKey(db, w.wait.field ?? '');
			if (!cf) return fail('That custom field no longer exists. Choose another date field.');
			if (cf.type !== 'date') return fail(`“${cf.label}” is not a date field. Choose a custom field of type Date.`);
			if (cf.archived_at) return fail(`“${cf.label}” is archived. Choose an active date field.`);
		}
		if (!waitModeHasLanes(w.wait.mode) && ctx.stepId) {
			const child = await db.prepare('SELECT 1 FROM automation_steps WHERE parent_step_id = ? LIMIT 1').bind(ctx.stepId).first();
			if (child) {
				return fail(
					'Only “Until they do something” and “Until specific conditions are met” have “Did it” and “Timed out” paths, and this wait has steps in them. Empty both paths before changing the kind of wait.'
				);
			}
		}
		// #626: the rules are checked like a Condition step's (complete, lists / forms exist,
		// compilable). Email-step rules were already refused by normalizeWait.
		if (w.wait.mode === 'rules') {
			const problem = await conditionRulesProblem(db, ctx.automationId, w.wait.rules ?? null);
			if (problem) return fail(`Wait conditions: ${problem}`);
		}
		// #625: opens / clicks "the previous email" needs an email step before this one. A spec's
		// tree is checked as a whole in specStructureProblems (no ids yet).
		if (waitNeedsEmail(w.wait) && ctx.stepId && !ctx.refs) {
			const rows = await db
				.prepare('SELECT id, type, parent_step_id, branch_label, position FROM automation_steps WHERE automation_id = ?')
				.bind(ctx.automationId)
				.all<FlowStepRef>();
			if (!previousEmailStep(rows.results, ctx.stepId)) return fail(NO_PREVIOUS_EMAIL);
		}
		return { ok: true, cols: { wait_config: JSON.stringify(w.wait), ...timing }, fixups: [] };
	}

	if (type === 'tag') {
		const tagName = String(f.tag_name ?? '').trim();
		if (!tagName) return fail('Choose a tag for this step.');
		if (tagName.length > TAG_MAX) return fail('Tag is too long (60 chars max).');
		return { ok: true, cols: { tag_action: f.tag_action === 'remove' ? 'remove' : 'add', tag_name: tagName, ...timing }, fixups: [] };
	}

	// Action step (#128): act on the contact's membership in ANOTHER automation; #146: or
	// move the contact to another step in THIS one; #207: or act on the pipeline card. Only
	// the target column the kind uses is stored; the others are nulled.
	if (type === 'action') {
		const a: ActionSpec = f.action ?? { kind: 'enroll_automation' };
		if (!(ACTION_KINDS as readonly string[]).includes(a.kind)) return fail('Unknown action kind.');
		const noTier: Cols = { target_tier: null, tier_days: null, action_config: null };
		// #460: set (or clear) the contact's engagement tier override.
		if (a.kind === 'set_tier') {
			const t = tierActionColumns(a);
			if (!t.ok) return fail(t.error);
			return {
				ok: true,
				cols: { action_kind: a.kind, target_automation_id: null, target_step_id: null, target_stage_id: null, only_from_stage_id: null, action_config: null, ...t.cols, ...timing },
				fixups: []
			};
		}
		// #467: add (or take away) points on one of the contact's scores.
		if (a.kind === 'adjust_score') {
			const t = await scoreActionColumns(db, a);
			if (!t.ok) return fail(t.error);
			return {
				ok: true,
				cols: { action_kind: a.kind, target_automation_id: null, target_step_id: null, target_stage_id: null, only_from_stage_id: null, target_tier: null, tier_days: null, ...t.cols, ...timing },
				fixups: []
			};
		}
		if (a.kind === 'pipeline_move' || a.kind === 'pipeline_remove') {
			const stageId = posId(a.stage_id);
			const onlyFrom = posId(a.only_from_stage_id);
			const problem = await validatePipelineStages(db, a.kind, stageId, onlyFrom);
			if (problem) return fail(problem);
			const move = a.kind === 'pipeline_move';
			return {
				ok: true,
				cols: {
					action_kind: a.kind,
					target_automation_id: null,
					target_step_id: null,
					target_stage_id: move ? stageId : null,
					only_from_stage_id: move ? onlyFrom : null,
					...noTier,
					...timing
				},
				fixups: []
			};
		}
		const base: Cols = { action_kind: a.kind, target_automation_id: null, target_step_id: null, target_stage_id: null, only_from_stage_id: null, ...noTier, ...timing };
		if (a.kind === 'goto_step') {
			if (spec) {
				const ref = String(a.step_ref ?? '');
				if (a.step_id != null) return fail('Inside a spec, a go-to names its target by step_ref.');
				if (!ref) return fail('Choose a step to go to.');
				if (!ctx.refs!.has(ref)) return fail(`No step has the ref “${ref}”.`);
				if (ref === ctx.selfRef) return fail("A step can't go to itself.");
				return { ok: true, cols: base, fixups: [(ids) => ({ target_step_id: ids.get(ref) ?? null })] };
			}
			const target = posId(a.step_id);
			const problem = await validateGotoTarget(db, ctx.automationId, ctx.stepId, target);
			if (problem) return fail(problem);
			return { ok: true, cols: { ...base, target_step_id: target }, fixups: [] };
		}
		const targetId = a.automation_id === null || a.automation_id === undefined ? null : posId(a.automation_id);
		const problem = await validateActionTarget(db, ctx.automationId, a.kind, targetId);
		if (problem) return fail(problem);
		return { ok: true, cols: { ...base, target_automation_id: targetId }, fixups: [] };
	}

	// Branch condition (#75/#76; unified with gates #13/0029): a #221 rule set, or one legacy
	// gate. Only the fields the kind uses are stored; the rest are nulled.
	if (type === 'branch') {
		const c: BranchCondition = f.condition ?? { kind: 'tag' };
		if (c.kind === 'rules') {
			const set = normalizeRuleSet({ match: c.match, rules: c.rules });
			const refs = ctx.refs;
			const problem = await conditionRulesProblem(
				db,
				ctx.automationId,
				set,
				refs ? { emailStepRef: (v) => refs.get(v) === 'email' } : {}
			);
			if (problem || !set) return fail(problem ?? 'Add at least one rule.');
			const cols: Cols = { gate_rules: JSON.stringify(set), gate_kind: null, gate_name: null, gate_value: null, gate_ref_id: null, split_pct: null, ...timing };
			const stepRule = (field: string) => field === 'step_opened' || field === 'step_clicked';
			const fixups: Fixup[] =
				refs && set.rules.some((r) => stepRule(r.field))
					? [
							(ids) => ({
								gate_rules: JSON.stringify({
									...set,
									rules: set.rules.map((r) => (stepRule(r.field) ? { ...r, value: String(ids.get((r.value ?? '').trim()) ?? '') } : r))
								})
							})
						]
					: [];
			return { ok: true, cols, fixups };
		}

		const kind = String(c.kind ?? '');
		if (!(GATE_KINDS as readonly string[]).includes(kind)) return fail('Unknown condition kind.');
		let gateName: string | null = null;
		let gateValue: string | null = null;
		let refId: number | null = null;
		let splitPct: number | null = null;
		const fixups: Fixup[] = [];

		if (NAMED_GATE_KINDS.includes(kind)) {
			gateName = String(c.name ?? '').trim().slice(0, 60) || null;
			if (!gateName) return fail('Set the tag/field name for this branch.');
			if (VALUE_GATE_KINDS.includes(kind)) gateValue = String(c.value ?? '').trim().slice(0, 120) || null;
			if ((kind === 'field-contains' || kind === 'field-not-contains') && !gateValue) return fail('Set the text to look for in the field.');
		} else if (kind === 'list-member') {
			refId = posId(c.list_id);
			if (!refId) return fail('Choose a list or segment for this branch.');
		} else if (kind === 'opened' || kind === 'clicked') {
			if (spec) {
				const ref = String(c.step_ref ?? '');
				if (c.step_id != null) return fail('Inside a spec, an opened / clicked condition names its email step by step_ref.');
				if (!ref) return fail('Choose which email step this branch checks.');
				if (ctx.refs!.get(ref) !== 'email') return fail(`No email step has the ref “${ref}”.`);
				fixups.push((ids) => ({ gate_ref_id: ids.get(ref) ?? null }));
			} else {
				refId = posId(c.step_id);
				if (!refId) return fail('Choose which email step this branch checks.');
				const ref = await db
					.prepare("SELECT id FROM automation_steps WHERE id = ? AND automation_id = ? AND type = 'email'")
					.bind(refId, ctx.automationId)
					.first<{ id: number }>();
				if (!ref) return fail('That email step no longer exists.');
			}
		} else if (kind === 'company-metric') {
			// #170: gate_name = metric key, gate_value = 'op:value' (same operators as the filter).
			const cond = normalizeCondition(String(c.metric ?? ''), String(c.op ?? ''), String(c.value ?? ''));
			if (!cond) return fail('Choose a company metric, operator and number for this condition.');
			gateName = cond.metric;
			gateValue = `${cond.op}:${cond.value}`;
		} else if (kind === 'visited') {
			// #154: gate_name = path text (contains) / event name, gate_value = 'page|event:<days>'.
			const cond = normalizeVisited(String(c.mode ?? ''), String(c.name ?? ''), c.days ?? '');
			if (!cond) return fail('Set the page path or event name (and a whole number of days) for this condition.');
			gateName = cond.match;
			gateValue = `${cond.mode}:${cond.days}`;
		} else if (kind === 'pipeline-stage') {
			// #207: gate_value 'in' (gate_ref_id = stage id) | 'any' (on the board) | 'none' (not on it).
			const mode = String(c.mode ?? 'in');
			gateValue = mode === 'any' || mode === 'none' ? mode : 'in';
			if (gateValue === 'in') {
				refId = posId(c.stage_id);
				const stage = refId ? await db.prepare('SELECT id FROM pipeline_stages WHERE id = ?').bind(refId).first<{ id: number }>() : null;
				if (!stage) return fail('Choose a pipeline stage for this condition.');
			}
		} else if (kind === 'split') {
			splitPct = Math.min(100, Math.max(0, Math.floor(Number(c.pct) || 50)));
		}
		return {
			ok: true,
			cols: { gate_kind: kind, gate_name: gateName, gate_value: gateValue, gate_ref_id: refId, split_pct: splitPct, gate_rules: null, ...timing },
			fixups
		};
	}

	if (type !== 'email') return fail('Unknown step type.');
	const subject = String(f.subject ?? '').trim();
	const from = String(f.from_email ?? ctx.defaultFrom ?? '').trim();
	// #254: visual-editor blocks (sanitised) win; `body_md` keeps their markdown export.
	const body = composeBodyFrom(f.body_blocks ?? '', f.body_md);
	const preheader = String(f.preheader ?? '').trim();
	if (!subject) return fail('Step subject is required.');
	if (!from) return fail('Step from address is required.');
	if (bodyIsEmpty(body)) return fail('Step body is empty.');
	const settings = await getSettings(db);
	if (!fromAllowed(from, settings.approved_senders)) {
		return fail(`From “${from}” isn't an approved Postmark sender (Settings → Approved senders).`);
	}
	// Engagement auto-tags (#42): applied at webhook time when Postmark reports the open/click.
	const tagOnOpen = f.tag_on_open ? String(f.tag_on_open).trim() || null : null;
	const tagOnClick = f.tag_on_click ? String(f.tag_on_click).trim() || null : null;
	if ((tagOnOpen && tagOnOpen.length > TAG_MAX) || (tagOnClick && tagOnClick.length > TAG_MAX)) return fail('Tag is too long (60 chars max).');
	return {
		ok: true,
		cols: {
			subject,
			from_email: from,
			body_md: body.md,
			body_blocks: bodyBlocksColumn(body),
			preheader: preheader || null,
			tag_on_open: tagOnOpen,
			tag_on_click: tagOnClick,
			...timing
		},
		fixups: []
	};
}

/** Columns this module may write (the keys of `Cols` objects — never user input). */
const WRITABLE = new Set([
	'delay_before_seconds',
	'weekday_only',
	'subject',
	'from_email',
	'body_md',
	'body_blocks',
	'preheader',
	'tag_on_open',
	'tag_on_click',
	'tag_action',
	'tag_name',
	'gate_kind',
	'gate_name',
	'gate_value',
	'gate_ref_id',
	'split_pct',
	'gate_rules',
	'action_kind',
	'target_automation_id',
	'target_step_id',
	'target_stage_id',
	'only_from_stage_id',
	'target_tier',
	'tier_days',
	'action_config',
	'wait_config'
]);

async function writeCols(db: D1Database, automationId: number, stepId: number, cols: Cols): Promise<void> {
	const keys = Object.keys(cols).filter((k) => WRITABLE.has(k));
	if (!keys.length) return;
	await db
		.prepare(`UPDATE automation_steps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND automation_id = ?`)
		.bind(...keys.map((k) => cols[k]), stepId, automationId)
		.run();
}

// ── Step edits ───────────────────────────────────────────────────────────────────────────
// The engine pointer is a step ID (#74), so add / duplicate / move / reorder are safe while
// enrollments are active: an in-flight contact keeps pointing at its step, and "next"
// resolves from the new order at advance time. Deleting a step is the one structural edit
// that touches in-flight state — deleteStep re-points its enrollments.

export type AddStepInput = {
	type: StepType;
	/** A branch step of this automation + its lane; omitted = the trunk. */
	parent_step_id?: number | null;
	branch_label?: 'yes' | 'no' | null;
	/** Index within the lane (0 = first); omitted = last. */
	position?: number | null;
	/** The From a bare email step starts with (the builder passes POSTMARK_FROM). */
	from_email?: string;
	/** A bare action step's kind (+ target, validated when one is given). Default enroll_automation. */
	action?: ActionSpec;
	/** Full configuration, validated and saved like `updateStep`; omitted = a bare step the
	 *  drawer configures (email: empty, tag: add '', branch: has-tag '', action: `action`). */
	fields?: StepFields;
};

export async function addStep(
	db: D1Database,
	automationId: number,
	input: AddStepInput,
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ step_id: number }>> {
	const type = input.type;
	if (!(STEP_TYPES as readonly string[]).includes(type)) return fail('Unknown step type.');
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;

	// Target sibling group (#76): trunk by default, or inside a branch path.
	let parentId: number | null = null;
	let label: string | null = null;
	if (input.parent_step_id) {
		parentId = Number(input.parent_step_id);
		label = input.branch_label === 'no' ? 'no' : 'yes';
		const parent = await db
			.prepare("SELECT id, type, wait_config FROM automation_steps WHERE id = ? AND automation_id = ? AND type IN ('branch', 'wait')")
			.bind(parentId, automationId)
			.first<{ id: number; type: string; wait_config: string | null }>();
		// #397: an event wait has lanes too ("Did it" / "Timed out").
		if (!parent || !stepHasLanes(parent)) return fail('Branch not found.');
	}

	// Action steps (#128): a bare step seeded with its kind; a posted target is validated the
	// same way as updateStep's.
	let actionKind: string | null = null;
	let targetAutomationId: number | null = null;
	let targetStepId: number | null = null;
	let targetStageId: number | null = null;
	let onlyFromStageId: number | null = null;
	let tierCols: Cols | null = null;
	if (type === 'action') {
		const a: ActionSpec = input.action ?? { kind: 'enroll_automation' };
		if (!(ACTION_KINDS as readonly string[]).includes(a.kind)) return fail('Unknown action kind.');
		actionKind = a.kind;
		if (a.kind === 'pipeline_move' || a.kind === 'pipeline_remove') {
			// #207: a stage given here is validated like updateStep's; none = configure later.
			if (a.kind === 'pipeline_move' && posId(a.stage_id)) {
				const problem = await validatePipelineStages(db, a.kind, posId(a.stage_id), posId(a.only_from_stage_id));
				if (problem) return fail(problem);
				targetStageId = posId(a.stage_id);
				onlyFromStageId = posId(a.only_from_stage_id);
			}
		} else if (a.kind === 'goto_step') {
			// #146: the new step can't be its own target — it has no id yet.
			if (posId(a.step_id)) {
				const problem = await validateGotoTarget(db, automationId, null, posId(a.step_id));
				if (problem) return fail(problem);
				targetStepId = posId(a.step_id);
			}
		} else if (a.kind === 'set_tier') {
			// #460: a tier given here is validated like updateStep's; none = configure later.
			if (a.tier) {
				const t = tierActionColumns(a);
				if (!t.ok) return fail(t.error);
				tierCols = t.cols;
			}
		} else if (a.kind === 'adjust_score') {
			// #467: a score given here is validated like updateStep's; none = configure later.
			if (a.score_id) {
				const t = await scoreActionColumns(db, a);
				if (!t.ok) return fail(t.error);
				tierCols = t.cols;
			}
		} else {
			const targetId = a.automation_id === null || a.automation_id === undefined ? null : posId(a.automation_id);
			if (targetId || a.kind === 'end_all_automations') {
				const problem = await validateActionTarget(db, automationId, a.kind, targetId);
				if (problem) return fail(problem);
				targetAutomationId = targetId;
			}
		}
	}

	const max = await db
		.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM automation_steps WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ?')
		.bind(automationId, parentId, label)
		.first<{ m: number }>();
	const end = (max?.m ?? -1) + 1;
	let position = end;
	if (input.position !== null && input.position !== undefined) {
		const p = Math.floor(Number(input.position));
		if (!Number.isFinite(p) || p < 0 || p > end) return fail(`Position must be between 0 and ${end}.`);
		position = p;
		if (position < end) {
			await db
				.prepare('UPDATE automation_steps SET position = position + 1 WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ? AND position >= ?')
				.bind(automationId, parentId, label, position)
				.run();
		}
	}
	const created = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, type, tag_action, tag_name, gate_kind,
			    subject, body_md, preheader, from_email, parent_step_id, branch_label, action_kind, target_automation_id, target_step_id,
			    target_stage_id, only_from_stage_id, ready, wait_config)
			 VALUES (?, ?, 0, ?, ?, '', ?, '', '', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		// #395: a bare step isn't ready (the engine holds contacts there) until a save passes
		// validation — `configure` below, or the drawer's updateStep. An end step has nothing to set.
		.bind(
			automationId,
			position,
			type,
			type === 'tag' ? 'add' : null,
			type === 'branch' ? 'tag' : null, // branches seed with a has-tag condition
			input.from_email ?? '',
			parentId,
			label,
			actionKind,
			targetAutomationId,
			targetStepId,
			targetStageId,
			onlyFromStageId,
			type === 'end' ? 1 : 0,
			// #625: a bare wait starts as "A set period of time", 1 day.
			type === 'wait' ? JSON.stringify(DEFAULT_WAIT) : null
		)
		.first<{ id: number }>();
	const stepId = created!.id;
	if (tierCols) await writeCols(db, automationId, stepId, tierCols);

	if (input.fields) {
		const r = await configure(db, automationId, stepId, type, input.fields);
		if (!r.ok) {
			await db.prepare('DELETE FROM automation_steps WHERE id = ? AND automation_id = ?').bind(stepId, automationId).run();
			await compactPositions(db, automationId);
			return r;
		}
	}
	void actor;
	return { ok: true, data: { step_id: stepId } };
}

async function configure(db: D1Database, automationId: number, stepId: number, type: string, fields: StepFields): Promise<WriteResult> {
	const r = await stepColumns(db, type, fields, { automationId, stepId });
	if (!r.ok) return r;
	await writeCols(db, automationId, stepId, r.cols);
	await markReady(db, automationId, stepId);
	if (type === 'email') await syncStepCampaign(db, stepId, r.cols);
	return { ok: true, data: null };
}

/** #395: a step saved with a valid configuration is ready; contacts held there (the engine's
 *  STEP_NOT_FINISHED) are released to run on the next tick. */
async function markReady(db: D1Database, automationId: number, stepId: number): Promise<void> {
	await db.batch([
		db.prepare('UPDATE automation_steps SET ready = 1 WHERE id = ? AND automation_id = ? AND ready = 0').bind(stepId, automationId),
		db
			.prepare(
				`UPDATE automation_enrollments SET next_run_at = datetime('now'), last_error = NULL
				 WHERE automation_id = ? AND current_step_id = ? AND status = 'active' AND last_error = ?`
			)
			.bind(automationId, stepId, STEP_NOT_FINISHED)
	]);
}

/** #395: the step's campaign row (created on its first send) keeps the archive copy —
 *  re-render it on every save so the campaign page shows what is sent now. */
async function syncStepCampaign(db: D1Database, stepId: number, cols: Cols): Promise<void> {
	const md = String(cols.body_md ?? '');
	const { html } = renderBody(
		{ blocks: storedBlocks(cols.body_blocks === null ? null : String(cols.body_blocks ?? '')), md },
		{ preheader: cols.preheader ? String(cols.preheader) : undefined, signature: await getSignature(db) }
	);
	await db
		.prepare('UPDATE campaigns SET subject = ?, body_md = ?, body_html = ?, from_email = ? WHERE automation_step_id = ?')
		.bind(cols.subject, md, html, cols.from_email, stepId)
		.run();
}

/** Replace a step's configuration (its type's fields + the wait). Not a patch: an omitted
 *  field takes its default (read the step with `readSpec` first to patch). The type can't
 *  change; end steps have nothing to edit. Step references are real ids. */
export async function updateStep(
	db: D1Database,
	automationId: number,
	input: { step_id: number; fields: StepFields },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const step = await db
		.prepare('SELECT id, type FROM automation_steps WHERE id = ? AND automation_id = ?')
		.bind(input.step_id, automationId)
		.first<{ id: number; type: string }>();
	if (!step) return fail('Step not found.', 404);
	if (step.type === 'end') return fail('End steps have nothing to edit.');
	return configure(db, automationId, step.id, step.type, input.fields ?? {});
}

/** #398: the A/B test's variant B on an email step. */
export type VariantInput = { subject: string; preheader?: string | null; body_md?: string | null };
export const AB_SUBJECT_MAX = 300;

/**
 * #398: start (or edit) an A/B test on an email step — variant B's subject (required), and
 * optionally its own preheader / markdown body (blank = same as A). `variant: null` stops the
 * test without a winner. Starting or editing clears an earlier winner.
 */
export async function setStepVariant(
	db: D1Database,
	automationId: number,
	input: { step_id: number; variant: VariantInput | null },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const step = await db
		.prepare('SELECT id, type, subject FROM automation_steps WHERE id = ? AND automation_id = ?')
		.bind(input.step_id, automationId)
		.first<{ id: number; type: string; subject: string }>();
	if (!step) return fail('Step not found.', 404);
	if (step.type !== 'email') return fail('Only email steps can be A/B tested.');
	if (!input.variant) {
		await db.prepare('UPDATE automation_steps SET ab_enabled = 0 WHERE id = ?').bind(step.id).run();
		return { ok: true, data: null };
	}
	const subject = String(input.variant.subject ?? '').trim();
	if (!subject) return fail('Variant B needs a subject.');
	if (subject.length > AB_SUBJECT_MAX) return fail(`A subject can be at most ${AB_SUBJECT_MAX} characters.`);
	const preheader = String(input.variant.preheader ?? '').trim() || null;
	const body = String(input.variant.body_md ?? '').trim() || null;
	if (subject === step.subject.trim() && !preheader && !body) return fail('Variant B is the same as A — change its subject or content.');
	await db
		.prepare(
			`UPDATE automation_steps SET ab_enabled = 1, ab_subject = ?, ab_preheader = ?, ab_body_md = ?, ab_winner = NULL, ab_decided_at = NULL
			 WHERE id = ?`
		)
		.bind(subject, preheader, body, step.id)
		.run();
	return { ok: true, data: null };
}

/**
 * #398: end a running A/B test with the operator's pick. B winning copies its subject (and
 * its preheader / body when it has its own) into the step and re-renders the step's campaign
 * row; A winning keeps the step as it is. Either way the test stops and the winner is kept.
 */
export async function pickVariantWinner(
	db: D1Database,
	automationId: number,
	input: { step_id: number; winner: 'a' | 'b' },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	if (input.winner !== 'a' && input.winner !== 'b') return fail('Pick variant A or B.');
	const s = await db
		.prepare(
			`SELECT id, type, subject, preheader, body_md, body_blocks, from_email, ab_enabled, ab_subject, ab_preheader, ab_body_md
			 FROM automation_steps WHERE id = ? AND automation_id = ?`
		)
		.bind(input.step_id, automationId)
		.first<{
			id: number;
			type: string;
			subject: string;
			preheader: string | null;
			body_md: string;
			body_blocks: string | null;
			from_email: string;
			ab_enabled: number;
			ab_subject: string | null;
			ab_preheader: string | null;
			ab_body_md: string | null;
		}>();
	if (!s) return fail('Step not found.', 404);
	if (s.type !== 'email' || !s.ab_enabled || !s.ab_subject) return fail('This step has no A/B test running.');
	if (input.winner === 'b') {
		const cols: Cols = {
			subject: s.ab_subject,
			preheader: s.ab_preheader ?? s.preheader,
			body_md: s.ab_body_md ?? s.body_md,
			body_blocks: s.ab_body_md ? null : s.body_blocks,
			from_email: s.from_email
		};
		await db
			.prepare('UPDATE automation_steps SET subject = ?, preheader = ?, body_md = ?, body_blocks = ? WHERE id = ?')
			.bind(cols.subject, cols.preheader, cols.body_md, cols.body_blocks, s.id)
			.run();
		await syncStepCampaign(db, s.id, cols);
	}
	await db
		.prepare("UPDATE automation_steps SET ab_enabled = 0, ab_winner = ?, ab_decided_at = datetime('now') WHERE id = ?")
		.bind(input.winner, s.id)
		.run();
	return { ok: true, data: null };
}

/** Change only a step's wait (and its weekdays-only flag), leaving its configuration alone —
 *  the canvas's inline wait node (#396). Any step type, end steps included. */
export async function setStepWait(
	db: D1Database,
	automationId: number,
	input: { step_id: number; wait_seconds: number; weekday_only: boolean },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const r = await db
		.prepare('UPDATE automation_steps SET delay_before_seconds = ?, weekday_only = ? WHERE id = ? AND automation_id = ?')
		.bind(Math.max(0, Math.floor(Number(input.wait_seconds) || 0)), input.weekday_only ? 1 : 0, input.step_id, automationId)
		.run();
	if (!r.meta.changes) return fail('Step not found.', 404);
	return { ok: true, data: null };
}

/** Copy a step right after itself in its lane. A branch is copied with both of its lanes
 *  (#396); references inside the copied subtree point at the copies. */
export async function duplicateStep(
	db: D1Database,
	automationId: number,
	input: { step_id: number },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ step_id: number }>> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const src = await db
		.prepare(`SELECT ${STEP_COLS}, tag_on_open, tag_on_click FROM automation_steps WHERE id = ? AND automation_id = ?`)
		.bind(input.step_id, automationId)
		.first<StepRow & { tag_on_open: string | null; tag_on_click: string | null }>();
	if (!src) return fail('Step not found.', 404);

	// Open a gap after the source WITHIN its sibling group, then insert the copy.
	await db
		.prepare('UPDATE automation_steps SET position = position + 1 WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ? AND position > ?')
		.bind(automationId, src.parent_step_id, src.branch_label, src.position)
		.run();
	if (src.type === 'branch' || src.type === 'wait') {
		const rows = await subtreeRows(db, automationId, src.id);
		const ids = await insertSubtree(db, automationId, rows, { parentId: src.parent_step_id, label: src.branch_label, position: src.position + 1 });
		return { ok: true, data: { step_id: ids.get(src.id)! } };
	}
	const row = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, type, tag_action, tag_name, tag_on_open, tag_on_click, gate_kind, gate_name, gate_value, subject, body_md, preheader, from_email, parent_step_id, branch_label, gate_ref_id, split_pct, weekday_only, action_kind, target_automation_id, target_step_id,
			    target_stage_id, only_from_stage_id, gate_rules, body_blocks, ready, target_tier, tier_days, action_config)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		// #146: a copied goto keeps the same target step (same automation, still valid).
		.bind(automationId, src.position + 1, src.delay_before_seconds, src.type, src.tag_action, src.tag_name, src.tag_on_open, src.tag_on_click, src.gate_kind, src.gate_name, src.gate_value, src.subject, src.body_md, src.preheader, src.from_email, src.parent_step_id, src.branch_label, src.gate_ref_id, src.split_pct, src.weekday_only, src.action_kind, src.target_automation_id, src.target_step_id, src.target_stage_id, src.only_from_stage_id, src.gate_rules, src.body_blocks ?? null, src.ready ?? 1, src.target_tier ?? null, src.tier_days ?? null, src.action_config ?? null)
		.first<{ id: number }>();
	return { ok: true, data: { step_id: row!.id } };
}

/** Delete a step — a branch takes its whole subtree (#75). Contacts waiting anywhere in it
 *  move to the step that follows (the engine's traversal) or complete at the end of the
 *  flow; sent steps' campaigns are detached, keeping their stats. */
export async function deleteStep(
	db: D1Database,
	automationId: number,
	input: { step_id: number },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ deleted: number[] }>> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const step = await db
		.prepare(`SELECT ${STEP_COLS} FROM automation_steps WHERE id = ? AND automation_id = ?`)
		.bind(input.step_id, automationId)
		.first<StepRow>();
	if (!step) return fail('Step not found.', 404);

	// Collect the subtree depth-first (deepest first) so children go before their parents.
	const subtree = await db
		.prepare(
			`WITH RECURSIVE sub(id, depth) AS (
			   SELECT id, 0 FROM automation_steps WHERE id = ?
			   UNION ALL
			   SELECT s.id, sub.depth + 1 FROM automation_steps s JOIN sub ON s.parent_step_id = sub.id
			 )
			 SELECT id FROM sub ORDER BY depth DESC`
		)
		.bind(step.id)
		.all<{ id: number }>();
	const doomedIds = subtree.results.map((r) => r.id);
	const ph = doomedIds.map(() => '?').join(', ');

	// Re-point in-flight enrollments waiting anywhere IN the subtree (#74) to the step that
	// follows the deleted step in the tree, or complete them at the end of the flow.
	// #395: contacts held at an unfinished step in the subtree are freed along with them.
	await db
		.prepare(
			`UPDATE automation_enrollments SET last_error = NULL
			 WHERE automation_id = ? AND current_step_id IN (${ph}) AND status = 'active' AND last_error = ?`
		)
		.bind(automationId, ...doomedIds, STEP_NOT_FINISHED)
		.run();
	const next = await nextStep(db, step);
	if (next) {
		const dueLiteral = await weekdayDueUtc(db, next.delay_before_seconds, next.weekday_only);
		if (dueLiteral) {
			await db
				.prepare(
					`UPDATE automation_enrollments
					 SET current_step_id = ?, next_run_at = ?, attempts = 0, wait_started_at = NULL
					 WHERE automation_id = ? AND current_step_id IN (${ph}) AND status = 'active'`
				)
				.bind(next.id, dueLiteral, automationId, ...doomedIds)
				.run();
		} else {
			await db
				.prepare(
					`UPDATE automation_enrollments
					 SET current_step_id = ?, next_run_at = datetime('now', ?), attempts = 0, wait_started_at = NULL
					 WHERE automation_id = ? AND current_step_id IN (${ph}) AND status = 'active'`
				)
				.bind(next.id, `+${Math.max(0, next.delay_before_seconds)} seconds`, automationId, ...doomedIds)
				.run();
		}
	} else {
		await db
			.prepare(
				`UPDATE automation_enrollments
				 SET status = 'completed', next_run_at = NULL, current_step_id = NULL, ended_at = datetime('now')
				 WHERE automation_id = ? AND current_step_id IN (${ph}) AND status = 'active'`
			)
			.bind(automationId, ...doomedIds)
			.run();
	}
	// Non-active enrollments may still reference subtree steps (FK) — null them out.
	await db.prepare(`UPDATE automation_enrollments SET current_step_id = NULL WHERE current_step_id IN (${ph})`).bind(...doomedIds).run();
	// Steps that already sent have campaign rows referencing them (FK, no cascade).
	await db.prepare(`UPDATE campaigns SET automation_step_id = NULL WHERE automation_step_id IN (${ph})`).bind(...doomedIds).run();

	// Deepest-first (FK: children reference parents via parent_step_id).
	for (const doomed of doomedIds) {
		await db.prepare('DELETE FROM automation_steps WHERE id = ? AND automation_id = ?').bind(doomed, automationId).run();
	}
	await compactPositions(db, automationId);
	return { ok: true, data: { deleted: doomedIds } };
}

// ── Subtree copies: branch duplicate + delete undo (#396) ─────────────────────────────────

/** A step and everything under it, parents before children (root first). */
async function subtreeRows(db: D1Database, automationId: number, stepId: number): Promise<SpecRow[]> {
	const rows = await db
		.prepare(
			`WITH RECURSIVE sub(id, depth) AS (
			   SELECT id, 0 FROM automation_steps WHERE id = ? AND automation_id = ?
			   UNION ALL
			   SELECT s.id, sub.depth + 1 FROM automation_steps s JOIN sub ON s.parent_step_id = sub.id
			 )
			 SELECT ${STEP_COLS.replace(/(^|,\s*)(\w+)/g, '$1s.$2')}, s.tag_on_open, s.tag_on_click
			 FROM sub JOIN automation_steps s ON s.id = sub.id
			 ORDER BY sub.depth, s.parent_step_id, s.branch_label, s.position`
		)
		.bind(stepId, automationId)
		.all<SpecRow>();
	return rows.results;
}

const SUBTREE_COPY_COLS = [
	'delay_before_seconds', 'type', 'subject', 'body_md', 'body_blocks', 'preheader', 'from_email', 'tag_action', 'tag_name',
	'tag_on_open', 'tag_on_click', 'gate_kind', 'gate_name', 'gate_value', 'gate_rules', 'gate_ref_id', 'split_pct', 'weekday_only',
	'action_kind', 'target_automation_id', 'target_step_id', 'target_stage_id', 'only_from_stage_id', 'wait_config', 'target_tier', 'tier_days',
	'action_config'
] as const;

/**
 * Insert copies of `rows` (root first, parents before children). The root lands in
 * `place` (the caller opened the gap); the rest keep their lane and order under the copied
 * parent. Step references inside the set point at the copies; references outside it are
 * kept when that step (or target automation) still exists, else cleared. Returns old → new ids.
 */
async function insertSubtree(
	db: D1Database,
	automationId: number,
	rows: SpecRow[],
	place: { parentId: number | null; label: string | null; position: number }
): Promise<Map<number, number>> {
	const inSet = new Set(rows.map((r) => r.id));
	const outsideIds = [...new Set(rows.flatMap((r) => [r.target_step_id, stepGateRef(r)].filter((x): x is number => !!x && !inSet.has(x))))];
	const liveSteps = new Set<number>();
	for (const id of outsideIds) {
		const hit = await db.prepare('SELECT id FROM automation_steps WHERE id = ? AND automation_id = ?').bind(id, automationId).first<{ id: number }>();
		if (hit) liveSteps.add(id);
	}
	const liveAutomations = new Set<number>();
	for (const id of new Set(rows.map((r) => r.target_automation_id).filter((x): x is number => !!x))) {
		if (await db.prepare('SELECT id FROM automations WHERE id = ?').bind(id).first()) liveAutomations.add(id);
	}

	const idMap = new Map<number, number>();
	const root = rows[0]?.id;
	for (const r of rows) {
		const isRoot = r.id === root;
		const parentId = isRoot ? place.parentId : (idMap.get(r.parent_step_id ?? -1) ?? null);
		if (!isRoot && parentId === null) continue; // orphan (shouldn't happen)
		const vals: Record<string, unknown> = {};
		for (const c of SUBTREE_COPY_COLS) vals[c] = (r as Record<string, unknown>)[c] ?? null;
		// Refs inside the set are fixed up below; outside ones only while they still exist.
		vals.target_step_id = r.target_step_id && !inSet.has(r.target_step_id) && liveSteps.has(r.target_step_id) ? r.target_step_id : null;
		const gref = stepGateRef(r);
		if (gref) vals.gate_ref_id = !inSet.has(gref) && liveSteps.has(gref) ? gref : null;
		if (r.target_automation_id && !liveAutomations.has(r.target_automation_id)) vals.target_automation_id = null;
		vals.gate_rules = remapRuleSteps(r.gate_rules, (id) => (inSet.has(id) ? null : id));
		const cols = ['automation_id', 'position', 'parent_step_id', 'branch_label', ...SUBTREE_COPY_COLS];
		const ins = await db
			.prepare(`INSERT INTO automation_steps (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`)
			.bind(automationId, isRoot ? place.position : r.position, parentId, isRoot ? place.label : r.branch_label, ...SUBTREE_COPY_COLS.map((c) => vals[c]))
			.first<{ id: number }>();
		idMap.set(r.id, ins!.id);
	}

	// Internal references → the copies.
	for (const r of rows) {
		const copy = idMap.get(r.id);
		if (!copy) continue;
		const sets: string[] = [];
		const binds: unknown[] = [];
		if (r.target_step_id && inSet.has(r.target_step_id)) {
			sets.push('target_step_id = ?');
			binds.push(idMap.get(r.target_step_id) ?? null);
		}
		const gref = stepGateRef(r);
		if (gref && inSet.has(gref)) {
			sets.push('gate_ref_id = ?');
			binds.push(idMap.get(gref) ?? null);
		}
		const set = parseGateRules(r.gate_rules);
		if (set?.rules.some((x) => (x.field === 'step_opened' || x.field === 'step_clicked') && inSet.has(Number(x.value)))) {
			sets.push('gate_rules = ?');
			binds.push(remapRuleSteps(r.gate_rules, (id) => (inSet.has(id) ? (idMap.get(id) ?? null) : id)));
		}
		if (sets.length) await db.prepare(`UPDATE automation_steps SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, copy).run();
	}
	return idMap;
}

/** An opened / clicked condition's email-step id (gate_ref_id is a list id for list-member). */
function stepGateRef(r: { gate_kind: string | null; gate_ref_id: number | null }): number | null {
	return (r.gate_kind === 'opened' || r.gate_kind === 'clicked') && r.gate_ref_id ? r.gate_ref_id : null;
}

/** Rewrite the email-step ids inside a rule set (step_opened / step_clicked); null → ''. */
function remapRuleSteps(raw: string | null, map: (id: number) => number | null): string | null {
	const set = parseGateRules(raw);
	if (!set || !set.rules.some((x) => x.field === 'step_opened' || x.field === 'step_clicked')) return raw;
	const rules = set.rules.map((x) =>
		x.field === 'step_opened' || x.field === 'step_clicked' ? { ...x, value: String(map(Number(x.value)) ?? '') } : x
	);
	return JSON.stringify({ ...set, rules });
}

/** What deleting a step removes, kept so the delete can be undone (#396). */
export type StepSnapshot = {
	v: 1;
	automation_id: number;
	parent_step_id: number | null;
	branch_label: string | null;
	position: number;
	rows: SpecRow[];
	/** Steps outside the subtree that pointed into it (go-to targets, opened / clicked refs). */
	referrers: { id: number; field: 'target_step_id' | 'gate_ref_id'; old: number }[];
};

/** Read a step's subtree before it is deleted; null when the step doesn't exist. */
export async function stepSnapshot(db: D1Database, automationId: number, stepId: number): Promise<StepSnapshot | null> {
	const rows = await subtreeRows(db, automationId, stepId);
	if (!rows.length) return null;
	const ids = new Set(rows.map((r) => r.id));
	const others = await db
		.prepare('SELECT id, gate_kind, gate_ref_id, target_step_id FROM automation_steps WHERE automation_id = ?')
		.bind(automationId)
		.all<{ id: number; gate_kind: string | null; gate_ref_id: number | null; target_step_id: number | null }>();
	const referrers: StepSnapshot['referrers'] = [];
	for (const o of others.results) {
		if (ids.has(o.id)) continue;
		if (o.target_step_id && ids.has(o.target_step_id)) referrers.push({ id: o.id, field: 'target_step_id', old: o.target_step_id });
		const g = stepGateRef(o);
		if (g && ids.has(g)) referrers.push({ id: o.id, field: 'gate_ref_id', old: g });
	}
	const root = rows[0];
	return { v: 1, automation_id: automationId, parent_step_id: root.parent_step_id, branch_label: root.branch_label, position: root.position, rows, referrers };
}

/**
 * Put a deleted step (and its subtree) back where it was (#396 undo). The rows get new ids;
 * go-to / opened / clicked references that pointed at them are re-pointed when they are
 * still empty or still name the old id. Contacts that deleteStep moved on stay where they are.
 */
export async function restoreStepSnapshot(
	db: D1Database,
	automationId: number,
	snap: StepSnapshot,
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult<{ step_id: number }>> {
	void actor;
	if (!snap || snap.v !== 1 || snap.automation_id !== automationId || !Array.isArray(snap.rows) || !snap.rows.length) {
		return fail('Nothing to restore.');
	}
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	let parentId = snap.parent_step_id;
	let label = snap.branch_label;
	if (parentId !== null) {
		const parent = await db
			.prepare("SELECT id, type, wait_config FROM automation_steps WHERE id = ? AND automation_id = ? AND type IN ('branch', 'wait')")
			.bind(parentId, automationId)
			.first<{ id: number; type: string; wait_config: string | null }>();
		if (!parent || !stepHasLanes(parent)) return fail('The condition this step was in no longer exists.');
	} else label = null;
	const lane = await laneIds(db, automationId, parentId, label);
	const position = Math.max(0, Math.min(Number(snap.position) || 0, lane.length));
	await db
		.prepare('UPDATE automation_steps SET position = position + 1 WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ? AND position >= ?')
		.bind(automationId, parentId, label, position)
		.run();
	const ids = await insertSubtree(db, automationId, snap.rows, { parentId, label, position });
	for (const r of snap.referrers ?? []) {
		const now = ids.get(r.old);
		if (!now || (r.field !== 'target_step_id' && r.field !== 'gate_ref_id')) continue;
		await db
			.prepare(`UPDATE automation_steps SET ${r.field} = ? WHERE id = ? AND automation_id = ? AND (${r.field} IS NULL OR ${r.field} = ?)`)
			.bind(now, r.id, automationId, r.old)
			.run();
	}
	await compactPositions(db, automationId);
	return { ok: true, data: { step_id: ids.get(snap.rows[0].id)! } };
}

/** Swap a step with its neighbour in its own lane; a no-op at either end. */
export async function moveStep(
	db: D1Database,
	automationId: number,
	input: { step_id: number; dir: 'up' | 'down' },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const me = await db
		.prepare('SELECT parent_step_id, branch_label FROM automation_steps WHERE id = ? AND automation_id = ?')
		.bind(input.step_id, automationId)
		.first<{ parent_step_id: number | null; branch_label: string | null }>();
	if (!me) return fail('Step not found.', 404);
	const ids = await laneIds(db, automationId, me.parent_step_id, me.branch_label);
	const i = ids.indexOf(input.step_id);
	const j = input.dir === 'up' ? i - 1 : i + 1;
	if (i < 0 || j < 0 || j >= ids.length) return { ok: true, data: null };
	[ids[i], ids[j]] = [ids[j], ids[i]];
	await writeOrder(db, automationId, ids);
	return { ok: true, data: null };
}

/** Reorder one lane (default: the trunk): `order` must be exactly that lane's step ids. */
export async function reorderSteps(
	db: D1Database,
	automationId: number,
	input: { order: number[]; parent_step_id?: number | null; branch_label?: 'yes' | 'no' | null },
	actor: Actor,
	opts: WriteOpts = {}
): Promise<WriteResult> {
	void actor;
	const g = await guard(db, automationId, opts);
	if (!g.ok) return g;
	const parent = input.parent_step_id ? Number(input.parent_step_id) : null;
	const label = parent ? (input.branch_label === 'no' ? 'no' : 'yes') : null;
	const current = new Set(await laneIds(db, automationId, parent, label));
	const proposed = (input.order ?? []).map(Number);
	const proposedSet = new Set(proposed);
	const valid = proposed.length === current.size && proposedSet.size === proposed.length && [...current].every((x) => proposedSet.has(x));
	if (!valid) return fail('Invalid step order.');
	await writeOrder(db, automationId, proposed);
	return { ok: true, data: null };
}

async function laneIds(db: D1Database, automationId: number, parentId: number | null, label: string | null): Promise<number[]> {
	const rows = await db
		.prepare('SELECT id FROM automation_steps WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ? ORDER BY position')
		.bind(automationId, parentId, label)
		.all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

/** Rewrite positions to 0..n-1 in the given id order (ids assumed to be this automation's). */
async function writeOrder(db: D1Database, automationId: number, ids: number[]): Promise<void> {
	if (ids.length === 0) return;
	const stmt = db.prepare('UPDATE automation_steps SET position = ? WHERE id = ? AND automation_id = ?');
	await db.batch(ids.map((sid, idx) => stmt.bind(idx, sid, automationId)));
}

/** Renumber steps to 0..n-1 WITHIN each (parent_step_id, branch_label) sibling group —
 *  positions are sibling order in the tree (#75), never global. */
async function compactPositions(db: D1Database, automationId: number): Promise<void> {
	const rows = await db
		.prepare(
			`SELECT id, parent_step_id, branch_label FROM automation_steps
			 WHERE automation_id = ? ORDER BY parent_step_id, branch_label, position`
		)
		.bind(automationId)
		.all<{ id: number; parent_step_id: number | null; branch_label: string | null }>();
	const groups = new Map<string, number[]>();
	for (const r of rows.results) {
		const key = `${r.parent_step_id ?? 'trunk'}:${r.branch_label ?? ''}`;
		const grp = groups.get(key) ?? [];
		grp.push(r.id);
		groups.set(key, grp);
	}
	for (const ids of groups.values()) await writeOrder(db, automationId, ids);
}

// ── Whole-flow spec ──────────────────────────────────────────────────────────────────────

export type SpecOpts = {
	/** The From for email steps that omit `from_email` (Settings default From, else POSTMARK_FROM). */
	defaultFrom?: string;
};

/** Every problem in a spec at once (empty = valid), each with a path like `steps[2].yes[0]`. */
export async function validateSpec(db: D1Database, spec: AutomationSpec, opts: SpecOpts = {}): Promise<SpecProblem[]> {
	const problems = specStructureProblems(spec);
	if (!spec || typeof spec !== 'object') return problems;
	if (spec.trigger && typeof spec.trigger === 'object') {
		const t = await triggerColumns(db, spec.trigger, { refs: specRefs(spec) });
		if (!t.ok) problems.push({ path: 'trigger', message: t.error });
		else if (t.cols.trigger_list_id) {
			const l = await db.prepare('SELECT id FROM lists WHERE id = ?').bind(t.cols.trigger_list_id).first();
			if (!l) problems.push({ path: 'trigger', message: 'That list, segment or tag no longer exists.' });
		}
	}
	// #412: entry conditions.
	if (spec.entry_rules !== undefined && spec.entry_rules !== null) {
		const set = normalizeRuleSet(spec.entry_rules);
		if (!set) problems.push({ path: 'entry_rules', message: 'Entry conditions need at least one valid rule (or null for none).' });
		else {
			const p = await entryRulesProblem(db, 0, set);
			if (p) problems.push({ path: 'entry_rules', message: p });
		}
	}
	if (Array.isArray(spec.labels)) {
		const seen = new Set<string>();
		spec.labels.forEach((raw, i) => {
			const l = normalizeLabel(String(raw ?? ''));
			if (!l) problems.push({ path: `labels[${i}]`, message: 'Labels are 1–30 characters.' });
			else seen.add(l.toLowerCase());
		});
		if (seen.size > MAX_LABELS_PER_AUTOMATION) problems.push({ path: 'labels', message: `An automation can have up to ${MAX_LABELS_PER_AUTOMATION} labels.` });
	}
	if (!Array.isArray(spec.steps)) return problems;
	const refs = specRefs(spec);
	const settled = new Set(problems.map((p) => p.path));
	for (const { step, path } of walkSpec(spec.steps)) {
		if (!step || typeof step !== 'object' || !(STEP_TYPES as readonly string[]).includes(step.type) || settled.has(path)) continue;
		const r = await stepColumns(db, step.type, step, { automationId: 0, stepId: null, refs, selfRef: step.ref, defaultFrom: opts.defaultFrom });
		if (!r.ok) problems.push({ path, message: r.error });
	}
	return problems;
}

/**
 * Create a draft automation from a whole-flow spec: validate everything first, then insert
 * the automation, every step (lane by lane), the ref fix-ups (go-to targets, opened / clicked
 * refs) and the labels. If anything fails part-way the rows written so far are deleted.
 */
export async function createFromSpec(
	db: D1Database,
	spec: AutomationSpec,
	actor: Actor,
	opts: SpecOpts = {}
): Promise<WriteResult<{ automation_id: number; step_ids: Record<string, number> }>> {
	const problems = await validateSpec(db, spec, opts);
	if (problems.length) {
		const first = problems[0];
		return { ok: false, error: `${first.path ? `${first.path}: ` : ''}${first.message}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`, problems };
	}
	const created = await createAutomation(db, { name: spec.name, trigger: spec.trigger, reentry: spec.reentry }, actor, { refs: specRefs(spec) });
	if (!created.ok) return created;
	const id = created.data.automation_id;
	let ids = new Map<string, number>();
	try {
		const inserted = await insertSpecSteps(db, id, spec, opts);
		if (!inserted.ok) {
			await discardAutomation(db, id);
			return fail(inserted.error);
		}
		ids = inserted.ids;
		await writeSpecTriggerExtras(db, id, spec, ids);
		for (const label of spec.labels ?? []) {
			const r = await insertLabel(db, id, String(label));
			if (!r.ok) {
				await discardAutomation(db, id);
				return fail(r.error);
			}
		}
	} catch (e) {
		await discardAutomation(db, id);
		return fail(`Couldn't create the automation: ${e instanceof Error ? e.message : String(e)}`);
	}
	return { ok: true, data: { automation_id: id, step_ids: Object.fromEntries(ids) } };
}

/** #412: after a spec's steps exist — the trigger config's own-step refs → real ids, and the
 *  entry conditions (validated already). */
async function writeSpecTriggerExtras(db: D1Database, automationId: number, spec: AutomationSpec, ids: Map<string, number>): Promise<void> {
	const row = await db.prepare('SELECT trigger_config FROM automations WHERE id = ?').bind(automationId).first<{ trigger_config: string | null }>();
	const set = spec.entry_rules ? normalizeRuleSet(spec.entry_rules) : null;
	await db
		.prepare('UPDATE automations SET trigger_config = ?, entry_rules = ? WHERE id = ?')
		.bind(resolveConfigRefs(row?.trigger_config ?? null, ids), set ? JSON.stringify(set) : null, automationId)
		.run();
}

/** Insert every step of a (validated) spec into an automation, lane by lane, then apply the
 *  ref fix-ups. On failure, `inserted` lists the rows written so far (for the caller to drop). */
async function insertSpecSteps(
	db: D1Database,
	automationId: number,
	spec: AutomationSpec,
	opts: SpecOpts
): Promise<{ ok: true; ids: Map<string, number>; inserted: number[] } | { ok: false; error: string; inserted: number[] }> {
	const refs = specRefs(spec);
	const ids = new Map<string, number>();
	const inserted: number[] = [];
	const pending: { stepId: number; fixups: Fixup[] }[] = [];
	const insertLane = async (steps: StepSpec[], parentId: number | null, label: string | null): Promise<string | null> => {
		for (let i = 0; i < steps.length; i++) {
			const s = steps[i];
			const r = await stepColumns(db, s.type, s, { automationId, stepId: null, refs, selfRef: s.ref, defaultFrom: opts.defaultFrom });
			if (!r.ok) return r.error;
			const row: Cols = {
				automation_id: automationId,
				position: i,
				type: s.type,
				parent_step_id: parentId,
				branch_label: label,
				subject: '',
				body_md: '',
				from_email: '',
				...r.cols
			};
			const keys = Object.keys(row).filter((k) => WRITABLE.has(k) || ['automation_id', 'position', 'type', 'parent_step_id', 'branch_label'].includes(k));
			const ins = await db
				.prepare(`INSERT INTO automation_steps (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`)
				.bind(...keys.map((k) => row[k]))
				.first<{ id: number }>();
			const stepId = ins!.id;
			inserted.push(stepId);
			if (s.ref) ids.set(s.ref, stepId);
			if (r.fixups.length) pending.push({ stepId, fixups: r.fixups });
			if (specHasLanes(s)) {
				const yes = await insertLane(s.yes ?? [], stepId, 'yes');
				if (yes) return yes;
				const no = await insertLane(s.no ?? [], stepId, 'no');
				if (no) return no;
			}
		}
		return null;
	};
	const problem = await insertLane(spec.steps, null, null);
	if (problem) return { ok: false, error: problem, inserted };
	for (const p of pending) {
		for (const fix of p.fixups) await writeCols(db, automationId, p.stepId, fix(ids));
	}
	return { ok: true, ids, inserted };
}

/** Delete a set of this automation's step rows, whatever points at them (parents, go-to
 *  targets, enrollment pointers, sent campaigns) cleared first. */
async function deleteStepRows(db: D1Database, automationId: number, stepIds: number[]): Promise<void> {
	for (let i = 0; i < stepIds.length; i += 40) {
		const part = stepIds.slice(i, i + 40);
		const ph = part.map(() => '?').join(', ');
		await db.batch([
			db.prepare(`UPDATE automation_enrollments SET current_step_id = NULL WHERE current_step_id IN (${ph})`).bind(...part),
			db.prepare(`UPDATE campaigns SET automation_step_id = NULL WHERE automation_step_id IN (${ph})`).bind(...part),
			db
				.prepare(`UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL WHERE automation_id = ? AND id IN (${ph})`)
				.bind(automationId, ...part)
		]);
	}
	for (let i = 0; i < stepIds.length; i += 40) {
		const part = stepIds.slice(i, i + 40);
		await db
			.prepare(`DELETE FROM automation_steps WHERE automation_id = ? AND id IN (${part.map(() => '?').join(', ')})`)
			.bind(automationId, ...part)
			.run();
	}
}

/** Enrollment passes of any status (a replace / delete needs none at all). */
async function enrollmentTotal(db: D1Database, automationId: number): Promise<number> {
	const n = await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?').bind(automationId).first<{ n: number }>();
	return n?.n ?? 0;
}

/**
 * #347: replace a DRAFT's whole flow with a spec — name, trigger, re-entry, every step and
 * (when the spec has `labels`) the labels. Refused (409) unless the automation is a draft
 * with no enrollments at all. The new steps are written before the old ones are dropped, so
 * a failure part-way leaves the old flow as it was.
 */
export async function replaceSpec(
	db: D1Database,
	automationId: number,
	spec: AutomationSpec,
	actor: Actor,
	opts: SpecOpts = {}
): Promise<WriteResult<{ step_ids: Record<string, number> }>> {
	void actor;
	const a = await db.prepare('SELECT id, name, status FROM automations WHERE id = ?').bind(automationId).first<AutomationRow>();
	if (!a) return fail('Automation not found.', 404);
	if (a.status !== 'draft') return fail(`“${a.name}” is ${a.status}. Only a draft's whole flow can be replaced.`, 409);
	const enrolled = await enrollmentTotal(db, automationId);
	if (enrolled > 0) return fail(`“${a.name}” has ${enrolled} enrollment${enrolled === 1 ? '' : 's'}; its flow can't be replaced.`, 409);

	const problems = await validateSpec(db, spec, opts);
	if (problems.length) {
		const first = problems[0];
		return { ok: false, error: `${first.path ? `${first.path}: ` : ''}${first.message}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`, problems };
	}
	const old = (await db.prepare('SELECT id FROM automation_steps WHERE automation_id = ?').bind(automationId).all<{ id: number }>()).results.map((r) => r.id);
	const inserted = await insertSpecSteps(db, automationId, spec, opts);
	if (!inserted.ok) {
		await deleteStepRows(db, automationId, inserted.inserted);
		return fail(inserted.error);
	}
	await deleteStepRows(db, automationId, old);

	const t = await triggerColumns(db, spec.trigger, { refs: specRefs(spec) });
	if (!t.ok) return t; // validated above
	const c = t.cols;
	await db
		.prepare(
			`UPDATE automations SET name = ?, reentry = ?, trigger_type = ?, trigger_list_id = ?, trigger_metric = ?, trigger_direction = ?,
			        trigger_threshold = ?, trigger_site_id = ?, trigger_path_op = ?, trigger_path = ?, trigger_cooldown_hours = ?, trigger_stage_id = ?,
			        trigger_config = ?
			 WHERE id = ?`
		)
		.bind(
			spec.name.trim(),
			spec.reentry ?? 'once',
			c.trigger_type,
			c.trigger_list_id,
			c.trigger_metric,
			c.trigger_direction,
			c.trigger_threshold,
			c.trigger_site_id,
			c.trigger_path_op,
			c.trigger_path,
			c.trigger_cooldown_hours,
			c.trigger_stage_id,
			resolveConfigRefs(c.trigger_config, inserted.ids),
			automationId
		)
		.run();
	// #412: entry conditions only when the spec has the key (null clears them).
	if (spec.entry_rules !== undefined) {
		const set = spec.entry_rules ? normalizeRuleSet(spec.entry_rules) : null;
		await db.prepare('UPDATE automations SET entry_rules = ? WHERE id = ?').bind(set ? JSON.stringify(set) : null, automationId).run();
	}
	if (Array.isArray(spec.labels)) {
		await db.prepare('DELETE FROM automation_labels WHERE automation_id = ?').bind(automationId).run();
		for (const label of spec.labels) {
			const r = await insertLabel(db, automationId, String(label));
			if (!r.ok) return fail(r.error);
		}
	}
	return { ok: true, data: { step_ids: Object.fromEntries(inserted.ids) } };
}

/**
 * Duplicate a whole automation as a draft copy (#77) — steps, tree structure, branch
 * conditions and labels. Parent / step refs are remapped to the copies; list, stage and
 * other-automation ids are copied as-is. (Moved here from the builder's `duplicate` action
 * for #347, unchanged.)
 */
export async function duplicateAutomation(db: D1Database, automationId: number, actor: Actor): Promise<WriteResult<{ automation_id: number }>> {
	void actor;
	const src = await db
		.prepare(
			`SELECT name, trigger_type, trigger_list_id, trigger_metric, trigger_direction, trigger_threshold, trigger_site_id,
			        trigger_path_op, trigger_path, trigger_cooldown_hours, trigger_stage_id, exit_rules, trigger_config, entry_rules
			 FROM automations WHERE id = ?`
		)
		.bind(automationId)
		.first<TriggerCols & { name: string; exit_rules: string | null; entry_rules: string | null }>();
	if (!src) return fail('Automation not found.', 404);

	const created = await db
		.prepare(
			`INSERT INTO automations (name, status, trigger_type, trigger_list_id, trigger_metric, trigger_direction, trigger_threshold,
			                          trigger_site_id, trigger_path_op, trigger_path, trigger_cooldown_hours, trigger_stage_id, exit_rules,
			                          trigger_config, entry_rules)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			`${src.name} (copy)`,
			src.trigger_type,
			src.trigger_list_id,
			src.trigger_metric,
			src.trigger_direction,
			src.trigger_threshold,
			src.trigger_site_id,
			src.trigger_path_op,
			src.trigger_path,
			src.trigger_cooldown_hours,
			src.trigger_stage_id,
			src.exit_rules, // #397: exit goals hold list / stage / tag names, never step ids — copied as-is
			src.trigger_config, // #412: own email-step ids remapped below once the copies exist
			src.entry_rules // #412: no step refs (refused on save) — copied as-is
		)
		.first<{ id: number }>();
	const newId = created!.id;

	const steps = await db
		.prepare(`SELECT ${STEP_COLS}, tag_on_open, tag_on_click FROM automation_steps WHERE automation_id = ? ORDER BY position`)
		.bind(automationId)
		.all<SpecRow>();

	// Parents before children: insert in passes, mapping old→new ids as we go.
	const idMap = new Map<number, number>();
	let remaining = [...steps.results];
	while (remaining.length) {
		const ready = remaining.filter((s) => s.parent_step_id === null || idMap.has(s.parent_step_id));
		if (ready.length === 0) break; // orphaned rows (shouldn't happen) — skip them
		for (const s of ready) {
			const row = await db
				.prepare(
					`INSERT INTO automation_steps
					   (automation_id, position, delay_before_seconds, type, tag_action, tag_name, tag_on_open, tag_on_click,
					    gate_kind, gate_name, gate_value, subject, body_md, preheader, from_email,
					    parent_step_id, branch_label, gate_ref_id, split_pct, weekday_only, action_kind, target_automation_id,
					    target_stage_id, only_from_stage_id, gate_rules, body_blocks, ready, wait_config, target_tier, tier_days, action_config)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
				)
				.bind(
					newId, s.position, s.delay_before_seconds, s.type, s.tag_action, s.tag_name,
					s.tag_on_open, s.tag_on_click, s.gate_kind, s.gate_name, s.gate_value,
					s.subject, s.body_md, s.preheader, s.from_email,
					s.parent_step_id === null ? null : idMap.get(s.parent_step_id)!,
					s.branch_label,
					s.gate_ref_id, // remapped below once every step id is known
					s.split_pct,
					s.weekday_only,
					// #128: target_automation_id points at a DIFFERENT automation entirely
					// (not a step in this tree) — copied as-is, never remapped.
					s.action_kind,
					s.target_automation_id,
					// #207: stage ids are global (not steps in this tree) — copied as-is.
					s.target_stage_id,
					s.only_from_stage_id,
					s.gate_rules, // #221: email-step refs inside are remapped below
					s.body_blocks ?? null,
					s.ready ?? 1,
					s.wait_config ?? null, // #397
					s.target_tier ?? null, // #460
					s.tier_days ?? null,
					s.action_config ?? null // #467
				)
				.first<{ id: number }>();
			idMap.set(s.id, row!.id);
		}
		remaining = remaining.filter((s) => !idMap.has(s.id));
	}

	// Remap opened/clicked email-step refs to the copies (list-member refs are list
	// ids — left as-is). A ref outside the copy (deleted step) nulls out.
	for (const s of steps.results) {
		if ((s.gate_kind === 'opened' || s.gate_kind === 'clicked') && s.gate_ref_id) {
			await db
				.prepare('UPDATE automation_steps SET gate_ref_id = ? WHERE id = ?')
				.bind(idMap.get(s.gate_ref_id) ?? null, idMap.get(s.id)!)
				.run();
		}
		// #221: rule-set email-step refs (step_opened/step_clicked) → the copies; list ids stay.
		const set = parseGateRules(s.gate_rules);
		if (set && idMap.has(s.id) && set.rules.some((r) => r.field === 'step_opened' || r.field === 'step_clicked')) {
			const rules = set.rules.map((r) =>
				r.field === 'step_opened' || r.field === 'step_clicked' ? { ...r, value: String(idMap.get(Number(r.value)) ?? '') } : r
			);
			await db
				.prepare('UPDATE automation_steps SET gate_rules = ? WHERE id = ?')
				.bind(JSON.stringify({ ...set, rules }), idMap.get(s.id)!)
				.run();
		}
		// #146: goto_step targets are steps in this tree — point them at the copies.
		if (s.target_step_id && idMap.has(s.id)) {
			await db
				.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?')
				.bind(idMap.get(s.target_step_id) ?? null, idMap.get(s.id)!)
				.run();
		}
	}

	// #412: an engagement trigger on one of this automation's own email steps → the copy's step
	// (another automation's step stays as-is).
	if (src.trigger_config) {
		const cfg = remapConfigSteps(src.trigger_config, (id) => idMap.get(id) ?? id);
		if (cfg !== src.trigger_config) await db.prepare('UPDATE automations SET trigger_config = ? WHERE id = ?').bind(cfg, newId).run();
	}

	await copyLabels(db, automationId, newId);
	return { ok: true, data: { automation_id: newId } };
}

/** #347: delete a DRAFT that never ran — no enrollments of any status and no campaign rows
 *  (else 409). Steps, labels and branch hits go with it. */
export async function deleteDraftAutomation(db: D1Database, automationId: number, actor: Actor): Promise<WriteResult> {
	void actor;
	const a = await db.prepare('SELECT id, name, status FROM automations WHERE id = ?').bind(automationId).first<AutomationRow>();
	if (!a) return fail('Automation not found.', 404);
	if (a.status !== 'draft') return fail(`“${a.name}” is ${a.status}. Only a draft can be deleted this way.`, 409);
	if ((await enrollmentTotal(db, automationId)) > 0) return fail(`“${a.name}” has enrollments and can't be deleted.`, 409);
	const sent = await db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE automation_id = ?').bind(automationId).first<{ n: number }>();
	if ((sent?.n ?? 0) > 0) return fail(`“${a.name}” has campaign rows and can't be deleted.`, 409);
	await db.batch([
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL WHERE automation_id = ?').bind(automationId),
		db.prepare("DELETE FROM automations WHERE id = ? AND status = 'draft'").bind(automationId)
	]);
	return { ok: true, data: null };
}

/** Delete a just-created automation and everything createFromSpec wrote for it. */
async function discardAutomation(db: D1Database, id: number): Promise<void> {
	// Leaves first: a step can only go once no step points at it as its parent.
	for (let guardN = 0; guardN < 50; guardN++) {
		const r = await db
			.prepare(
				`DELETE FROM automation_steps WHERE automation_id = ?
				   AND id NOT IN (SELECT parent_step_id FROM automation_steps WHERE automation_id = ? AND parent_step_id IS NOT NULL)`
			)
			.bind(id, id)
			.run();
		if (!r.meta.changes) break;
	}
	await db.prepare('DELETE FROM automation_labels WHERE automation_id = ?').bind(id).run();
	await db.prepare("DELETE FROM automations WHERE id = ? AND status = 'draft'").bind(id).run();
}

type SpecRow = StepRow & { tag_on_open: string | null; tag_on_click: string | null };

/**
 * An automation as a whole-flow spec, in canonical form (every field of the step's type
 * present, defaults included), so `createFromSpec(readSpec(x))` rebuilds the same flow.
 * Steps that other steps point at (go-to targets, opened / clicked email steps) get refs
 * `s<N>` — N = the step's place in depth-first order (branch, YES lane, NO lane). A
 * reference to a deleted step reads as `step_ref: null` (re-import then asks for one).
 */
export async function readSpec(db: D1Database, automationId: number): Promise<WriteResult<AutomationSpec>> {
	const a = await db
		.prepare(
			`SELECT name, reentry, trigger_type, trigger_list_id, trigger_metric, trigger_direction, trigger_threshold,
			        trigger_site_id, trigger_path_op, trigger_path, trigger_cooldown_hours, trigger_stage_id, trigger_config, entry_rules
			 FROM automations WHERE id = ?`
		)
		.bind(automationId)
		.first<TriggerCols & { name: string; reentry: string; entry_rules: string | null }>();
	if (!a) return fail('Automation not found.', 404);
	const rows = (
		await db
			.prepare(`SELECT ${STEP_COLS}, tag_on_open, tag_on_click FROM automation_steps WHERE automation_id = ? ORDER BY position, id`)
			.bind(automationId)
			.all<SpecRow>()
	).results;
	const lanes = new Map<string, SpecRow[]>();
	for (const r of rows) {
		const key = `${r.parent_step_id ?? ''}:${r.branch_label ?? ''}`;
		lanes.set(key, [...(lanes.get(key) ?? []), r]);
	}
	const lane = (parent: number | null, label: string | null) => lanes.get(`${parent ?? ''}:${label ?? ''}`) ?? [];

	// Depth-first order → ref names for the referenced steps.
	const order: SpecRow[] = [];
	const walk = (steps: SpecRow[], depth: number) => {
		for (const s of steps) {
			order.push(s);
			if (stepHasLanes(s) && depth < 20) {
				walk(lane(s.id, 'yes'), depth + 1);
				walk(lane(s.id, 'no'), depth + 1);
			}
		}
	};
	walk(lane(null, null), 0);
	const referenced = new Set<number>();
	for (const s of order) {
		if (s.action_kind === 'goto_step' && s.target_step_id) referenced.add(s.target_step_id);
		if (!s.gate_rules && (s.gate_kind === 'opened' || s.gate_kind === 'clicked') && s.gate_ref_id) referenced.add(s.gate_ref_id);
		for (const r of parseGateRules(s.gate_rules)?.rules ?? []) {
			if (r.field === 'step_opened' || r.field === 'step_clicked') referenced.add(Number(r.value));
		}
	}
	// #412: an engagement trigger on one of this automation's own email steps names it by ref.
	const own = new Set(rows.map((r) => r.id));
	if (isEngagementKind(a.trigger_type)) {
		for (const id of configEmailIds(parseEngagementConfig(a.trigger_type, a.trigger_config)).steps) if (own.has(id)) referenced.add(id);
	}
	const refOf = new Map<number, string>();
	order.forEach((s, i) => {
		if (referenced.has(s.id)) refOf.set(s.id, `s${i + 1}`);
	});
	const ref = (stepId: number | null | undefined) => (stepId ? (refOf.get(stepId) ?? null) : null);

	const toSpec = (s: SpecRow): StepSpec => {
		const out: StepSpec = { type: s.type as StepType };
		if (refOf.has(s.id)) out.ref = refOf.get(s.id);
		out.wait_seconds = s.delay_before_seconds ?? 0;
		out.weekday_only = !!s.weekday_only;
		if (s.type === 'email') {
			out.subject = s.subject;
			out.from_email = s.from_email;
			out.preheader = s.preheader ?? null;
			const blocks = storedBlocks(s.body_blocks);
			if (blocks) out.body_blocks = blocks;
			else out.body_md = s.body_md;
			out.tag_on_open = s.tag_on_open ?? null;
			out.tag_on_click = s.tag_on_click ?? null;
		} else if (s.type === 'tag') {
			out.tag_action = s.tag_action === 'remove' ? 'remove' : 'add';
			out.tag_name = s.tag_name ?? '';
		} else if (s.type === 'branch') {
			out.condition = conditionSpec(s, ref);
			out.yes = lane(s.id, 'yes').map(toSpec);
			out.no = lane(s.id, 'no').map(toSpec);
		} else if (s.type === 'action') {
			out.action = actionSpec(s, ref);
		} else if (s.type === 'wait') {
			// #397: an unreadable config reads as the bare default (re-import then validates it).
			out.wait = parseWait(s.wait_config) ?? { ...DEFAULT_WAIT };
			if (waitModeHasLanes(out.wait.mode)) {
				out.yes = lane(s.id, 'yes').map(toSpec);
				out.no = lane(s.id, 'no').map(toSpec);
			}
		}
		return out;
	};

	return {
		ok: true,
		data: {
			name: a.name,
			trigger: triggerSpec(a, (id) => (refOf.has(id) ? { step_ref: refOf.get(id)! } : id)),
			reentry: a.reentry === 'multiple' ? 'multiple' : 'once',
			labels: await listLabels(db, automationId),
			// #412: only when set, so a flow without entry conditions reads back unchanged.
			...(a.entry_rules && parseGateRules(a.entry_rules) ? { entry_rules: parseGateRules(a.entry_rules) } : {}),
			steps: lane(null, null).map(toSpec)
		}
	};
}

// ── Activation checks (#395) ─────────────────────────────────────────────────────────────
// The activate action (automation-bulk.ts `activationProblems`) re-runs the save validation
// on what is stored, so a flow can't go live with a step that was never finished or whose
// references (list, stage, step, automation, site) were deleted since it was saved.

export type StoredStep = SpecRow;

/** Why the stored trigger can't fire, or null. */
export async function storedTriggerProblem(db: D1Database, a: TriggerCols): Promise<string | null> {
	const t = await triggerColumns(db, triggerSpec(a));
	if (!t.ok) return t.error;
	if (t.cols.trigger_list_id) {
		const l = await db.prepare('SELECT id FROM lists WHERE id = ?').bind(t.cols.trigger_list_id).first();
		if (!l) return 'The trigger’s list, segment, tag or company no longer exists.';
	}
	return null;
}

/** Why one stored step isn't complete, or null. Real ids, not spec refs. */
export async function storedStepProblem(db: D1Database, automationId: number, s: StoredStep): Promise<string | null> {
	if (s.ready === 0) return 'This step isn’t finished — open it and save it.';
	if (s.type === 'end') return null;
	const fields: StepFields = { wait_seconds: s.delay_before_seconds ?? 0, weekday_only: !!s.weekday_only };
	if (s.type === 'email') {
		if (s.ab_enabled && !(s.ab_subject ?? '').trim()) return 'Its A/B test has no variant B subject.';
		Object.assign(fields, {
			subject: s.subject,
			from_email: s.from_email,
			body_blocks: storedBlocks(s.body_blocks) ?? '',
			body_md: s.body_md,
			preheader: s.preheader,
			tag_on_open: s.tag_on_open,
			tag_on_click: s.tag_on_click
		});
	} else if (s.type === 'tag') {
		fields.tag_action = s.tag_action === 'remove' ? 'remove' : 'add';
		fields.tag_name = s.tag_name ?? '';
	} else if (s.type === 'branch') {
		// Email-step refs stay real ids (the "ref" is the id itself).
		const c = conditionSpec(s, (id) => (id ? String(id) : null));
		fields.condition = c.kind === 'opened' || c.kind === 'clicked' ? { kind: c.kind, step_id: s.gate_ref_id } : c;
		if (!s.gate_rules && s.gate_kind === 'list-member' && s.gate_ref_id) {
			const l = await db.prepare('SELECT id FROM lists WHERE id = ?').bind(s.gate_ref_id).first();
			if (!l) return 'Its list or segment no longer exists.';
		}
	} else if (s.type === 'action') {
		const a = actionSpec(s, () => null);
		fields.action = a.kind === 'goto_step' ? { kind: 'goto_step', step_id: s.target_step_id } : a;
	} else if (s.type === 'wait') {
		// #397: the stored JSON as-is, so an invalid config reports its own problem.
		try {
			fields.wait = s.wait_config ? JSON.parse(s.wait_config) : undefined;
		} catch {
			fields.wait = undefined;
		}
	} else {
		return 'Unknown step type.';
	}
	const r = await stepColumns(db, s.type, fields, { automationId, stepId: s.id });
	return r.ok ? null : r.error;
}

function triggerSpec(a: TriggerCols, stepRef?: (stepId: number) => number | { step_ref: string }): TriggerSpec {
	switch (a.trigger_type) {
		case 'email_opened':
		case 'email_clicked': {
			// #412: the stored config as-is (an unreadable one reads as the defaults).
			const json = a.trigger_config && stepRef ? remapConfigSteps(a.trigger_config, stepRef) : a.trigger_config;
			const cfg = parseEngagementConfig(a.trigger_type, json, { allowRefs: true });
			const out: TriggerSpec = {
				type: a.trigger_type,
				email: cfg.email,
				list_id: cfg.list_id,
				exclude: cfg.exclude,
				once_per_email: cfg.once_per_email
			};
			if (a.trigger_type === 'email_clicked') out.link = cfg.link;
			else out.ignore_proxy_opens = cfg.ignore_proxy_opens;
			return out;
		}
		case 'site_activity':
			return { type: 'site_activity', ...parseSiteActivityConfig(a.trigger_config) };
		case 'subscription_changed':
			return { type: 'subscription_changed', ...parseSubscriptionConfig(a.trigger_config) };
		case 'score_changed':
			return { type: 'score_changed', ...parseScoreTriggerConfig(a.trigger_config) };
		case 'form_submitted':
			return { type: 'form_submitted', ...parseFormTriggerConfig(a.trigger_config) };
		case 'list_added':
			return { type: 'list_added', list_id: a.trigger_list_id };
		case 'company_metric':
			return { type: 'company_metric', metric: a.trigger_metric, direction: a.trigger_direction === 'below' ? 'below' : 'above', threshold: a.trigger_threshold };
		case 'site_visit':
			return { type: 'site_visit', site_id: a.trigger_site_id, path_op: a.trigger_path_op, path: a.trigger_path, cooldown_hours: a.trigger_cooldown_hours };
		case 'pipeline_stage_entered':
			return { type: 'pipeline_stage_entered', stage_id: a.trigger_stage_id };
		default:
			return { type: 'manual' };
	}
}

function conditionSpec(s: SpecRow, ref: (id: number | null) => string | null): BranchCondition {
	const set: ConditionRuleSet | null = parseGateRules(s.gate_rules);
	if (set) {
		return {
			kind: 'rules',
			match: set.match,
			rules: set.rules.map((r) => (r.field === 'step_opened' || r.field === 'step_clicked' ? { ...r, value: ref(Number(r.value)) ?? '' } : r))
		};
	}
	const kind = s.gate_kind ?? 'tag';
	if (NAMED_GATE_KINDS.includes(kind)) {
		const c: BranchCondition = { kind: kind as BranchCondition['kind'], name: s.gate_name ?? '' };
		if (VALUE_GATE_KINDS.includes(kind) && s.gate_value !== null) c.value = s.gate_value;
		return c;
	}
	switch (kind) {
		case 'list-member':
			return { kind, list_id: s.gate_ref_id };
		case 'opened':
		case 'clicked':
			return { kind, step_ref: ref(s.gate_ref_id) };
		case 'split':
			return { kind, pct: s.split_pct ?? 50 };
		case 'company-metric': {
			const c = decodeCondition(`${s.gate_name ?? ''}:${s.gate_value ?? ''}`);
			return { kind, metric: c?.metric ?? s.gate_name ?? '', op: c?.op ?? '', value: c?.value ?? null };
		}
		case 'visited': {
			const v = decodeVisited(s.gate_name, s.gate_value);
			return { kind, mode: v?.mode ?? 'page', name: v?.match ?? s.gate_name ?? '', days: v?.days ?? 0 };
		}
		case 'pipeline-stage':
			return s.gate_value === 'any' || s.gate_value === 'none' ? { kind, mode: s.gate_value } : { kind, mode: 'in', stage_id: s.gate_ref_id };
		default:
			return { kind: kind as BranchCondition['kind'], name: s.gate_name ?? '' };
	}
}

function actionSpec(s: SpecRow, ref: (id: number | null) => string | null): ActionSpec {
	switch (s.action_kind) {
		case 'end_automation':
			return { kind: 'end_automation', automation_id: s.target_automation_id };
		case 'end_all_automations':
			return { kind: 'end_all_automations' };
		case 'goto_step':
			return { kind: 'goto_step', step_ref: ref(s.target_step_id) };
		case 'pipeline_move':
			return { kind: 'pipeline_move', stage_id: s.target_stage_id, only_from_stage_id: s.only_from_stage_id };
		case 'pipeline_remove':
			return { kind: 'pipeline_remove' };
		case 'set_tier':
			return { kind: 'set_tier', tier: s.target_tier ?? null, days: s.tier_days ?? null };
		case 'adjust_score': {
			const c = parseAdjustScore(s.action_config ?? null);
			return { kind: 'adjust_score', score_id: c?.score_id ?? null, points: c?.points ?? null, expires_days: c?.expires_days ?? null };
		}
		default:
			return { kind: 'enroll_automation', automation_id: s.target_automation_id };
	}
}
