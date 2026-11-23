// Step-tree helpers shared by the engine (automations.ts) and the builder's write layer
// (automation-write.ts, #345). No engine, send or enroll imports here on purpose, so the
// write layer can be used by callers that must never reach the engine (assistant, API, MCP).

import { DEFAULT_TIMEZONE, getTimezone } from './settings';
import { applyWeekdayOnly, sqliteUtc } from './businessdays';

export type StepRow = {
	id: number;
	position: number;
	delay_before_seconds: number;
	type: string; // 'email' | 'tag' | 'branch' (#75) | 'end' | 'action' (#128, #146) | 'wait' (#397)
	subject: string;
	body_md: string;
	/** #250: visual-editor blocks (JSON); when set they render instead of body_md. */
	body_blocks?: string | null;
	preheader: string | null;
	from_email: string;
	tag_action: string | null; // 'add' | 'remove' (tag steps)
	tag_name: string | null;
	gate_kind: string | null; // branch conditions (#75; unified with gates #13/0029):
	//                           tag | no-tag | field-exists | field-not-exists | field-eq |
	//                           field-contains | field-not-contains | list-member | opened | clicked | split |
	//                           company-metric (#170: gate_name = metric, gate_value = 'op:value') |
	//                           visited (#154: gate_name = path text / event name, gate_value = 'page|event:<days>')
	gate_name: string | null;
	gate_value: string | null;
	gate_rules: string | null; // #221: rule-set JSON ({ match, rules }); when set it replaces the gate_* test (split aside)
	parent_step_id: number | null; // branch step this step belongs under (NULL = trunk)
	branch_label: string | null; // 'yes' | 'no' under a branch parent
	gate_ref_id: number | null; // list id (list-member) or email step id (opened/clicked)
	split_pct: number | null; // % routed to YES for split
	weekday_only: number; // #119: a Sat/Sun due time (operator tz) moves to Monday, same local time
	action_kind: string | null; // #128: 'enroll_automation' | 'end_automation' | 'end_all_automations';
	//                            #146: 'goto_step'; #207: 'pipeline_move' | 'pipeline_remove' (action steps)
	target_automation_id: number | null; // #128: the OTHER automation an action step acts on
	target_step_id: number | null; // #146: goto_step's target — a step in the SAME automation
	target_stage_id: number | null; // #207: pipeline_move's destination stage
	only_from_stage_id: number | null; // #207: pipeline_move only when the card is in this stage (NULL = any)
	target_tier?: string | null; // #460: set_tier's tier, or 'clear' (back to automatic)
	tier_days?: number | null; // #460: set_tier's override length in days (NULL = until cleared)
	action_config?: string | null; // #467: adjust_score's JSON { score_id, points, expires_days }
	ready?: number; // #395: 0 = added in the builder, never saved valid — the engine holds contacts here
	wait_config?: string | null; // #397: a 'wait' step's config (JSON, $lib/automation-flow WaitSpec)
	ab_enabled?: number; // #398: 1 = an A/B test runs on this email step (variant B below)
	ab_subject?: string | null;
	ab_preheader?: string | null; // NULL = same as A
	ab_body_md?: string | null; // NULL = same body as A
};

export const STEP_COLS = `id, position, delay_before_seconds, type, subject, body_md, body_blocks, preheader, from_email,
	tag_action, tag_name, gate_kind, gate_name, gate_value, gate_rules, parent_step_id, branch_label, gate_ref_id, split_pct, weekday_only,
	action_kind, target_automation_id, target_step_id, target_stage_id, only_from_stage_id, ready, wait_config, target_tier, tier_days, action_config,
	ab_enabled, ab_subject, ab_preheader, ab_body_md`;

// Traversal depth cap: parent chains are builder-controlled and shallow; this only
// defends against a corrupted/cyclic chain so a tick can never loop forever.
export const MAX_TREE_DEPTH = 20;

/**
 * Due instant for a `weekday_only` step, as a sqlite UTC string. Returns null when
 * the flag is off so the caller keeps `datetime('now', '+N seconds')`. The timezone
 * is read only in the flagged case. `getTimezone` swallows a failed read.
 */
export async function weekdayDueUtc(
	db: D1Database,
	delaySeconds: number,
	weekdayOnly: number,
	now: Date = new Date(),
	tzOverride?: string
): Promise<string | null> {
	if (!weekdayOnly) return null;
	const tz = tzOverride || (await getTimezone(db)) || DEFAULT_TIMEZONE;
	const due = applyWeekdayOnly(new Date(now.getTime() + Math.max(0, delaySeconds) * 1000), tz);
	return sqliteUtc(due);
}

/**
 * The step that follows `fromStep` in the tree (#75): the next sibling in its
 * (parent, label) group, else — for a branch child — the continuation AFTER its parent
 * branch step (re-join), recursively. Null = end of the flow. `IS ?` makes the NULL
 * parent/label comparisons match trunk rows. Exported for the builder's deleteStep
 * (re-pointing waiting enrollments follows the same traversal the engine uses).
 */
export async function nextStep(db: D1Database, fromStep: StepRow, depth = 0): Promise<StepRow | null> {
	if (depth > MAX_TREE_DEPTH) return null; // corrupted/cyclic parent chain — end safely

	const sibling = await db
		.prepare(
			`SELECT ${STEP_COLS} FROM automation_steps
			 WHERE automation_id = (SELECT automation_id FROM automation_steps WHERE id = ?)
			   AND parent_step_id IS ? AND branch_label IS ? AND position > ?
			 ORDER BY position LIMIT 1`
		)
		.bind(fromStep.id, fromStep.parent_step_id, fromStep.branch_label, fromStep.position)
		.first<StepRow>();
	if (sibling) return sibling;

	if (fromStep.parent_step_id === null) return null; // end of the trunk

	// Path exhausted → re-join: continue after the parent branch step in ITS context.
	const parent = await db
		.prepare(`SELECT ${STEP_COLS} FROM automation_steps WHERE id = ?`)
		.bind(fromStep.parent_step_id)
		.first<StepRow>();
	if (!parent) return null; // orphaned child — end safely
	return nextStep(db, parent, depth + 1);
}
