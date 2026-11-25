// Automation drafting tools (#309, Phase 3 of #71; #346: whole flows). The assistant builds a
// draft automation — every step type, branch lanes, every trigger — and edits the steps of a
// draft or paused one, all through the builder's write layer (automation-write.ts, #345).
// It NEVER activates an automation or enrolls anyone: the only automation it creates is a
// 'draft' (createAutomation / createFromSpec), there is no status write, and nothing here
// imports the engine (automations.ts) or an enroll helper (tests/ai-no-send.test.ts). Every
// write passes `draftOnly`, so an active automation is refused; editing a paused automation
// that still has contacts mid-flow waits for the user's Approve.
//
// build_automation (tier approve) takes a whole AutomationSpec and shows the flow as an outline
// on the card before anything is stored; create_automation_draft takes the same input and
// applies at once. Lists, tags, segments, stages, sites and other automations may be named
// (./automation-input.ts). Undo replays the earlier state while the automation is still as the
// assistant left it.

import { addStep, createFromSpec, deleteStep, readSpec, reorderSteps, updateStep, validateSpec, type Actor, type WriteOpts } from '../../automation-write';
import { parseGateRules } from '$lib/condition-rules';
import { blocksToMarkdown } from '$lib/blocks-markdown';
import { walkSpec, type AutomationSpec, type StepFields, type StepSpec } from '$lib/automation-spec';
import type { Block } from '$lib/blocks';
import type { FieldChange } from '$lib/assistant-actions';
import { BODY_PROPS, blocksArg, bodyOf } from './draft-body';
import { AutomationInput, defaultFrom, outlineLines, prepareSpec, problemLines, stepCountText, waitArg, waitText } from './automation-input';
import { ToolInputError, UndoRefused, intArg, type Tool, type ToolContext, type WriteOutcome, type WritePlan, type WriteTool } from './types';
import { containsSql } from '../../sql-match';

const LANE_MAX = 100;
const REVIEW_NOTE = 'Review and activate it in Automations.';

type Automation = { id: number; name: string; status: string };

async function automationRow(db: D1Database, id: number): Promise<Automation | null> {
	return db.prepare('SELECT id, name, status FROM automations WHERE id = ?').bind(id).first<Automation>();
}

async function activeEnrollments(db: D1Database, id: number): Promise<number> {
	const r = await db.prepare("SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND status = 'active'").bind(id).first<{ n: number }>();
	return r?.n ?? 0;
}

const NOT_EDITABLE = (a: Automation) =>
	`“${a.name}” is ${a.status}. The assistant only edits draft or paused automations — pause it in the app first (it never activates one).`;

/** A draft or paused automation, plus how many contacts are mid-flow in it. */
async function requireEditable(db: D1Database, id: number): Promise<{ a: Automation; active: number }> {
	const a = await automationRow(db, id);
	if (!a) throw new ToolInputError(`No automation with id ${id}.`);
	if (a.status !== 'draft' && a.status !== 'paused') throw new ToolInputError(NOT_EDITABLE(a));
	return { a, active: await activeEnrollments(db, id) };
}

/** Undo also refuses on an active automation (it would edit a live flow). */
async function requireEditableForUndo(db: D1Database, id: number): Promise<Automation> {
	const a = await automationRow(db, id);
	if (!a) throw new UndoRefused('That automation no longer exists.');
	if (a.status !== 'draft' && a.status !== 'paused') throw new UndoRefused(`“${a.name}” is ${a.status} now — nothing was undone.`);
	return a;
}

/** The plan of a step edit: approval when a paused automation still has contacts in it. */
function editPlan(a: Automation, active: number, summary: string): WritePlan {
	const approve = a.status === 'paused' && active > 0;
	return { count: approve ? active : 0, sample: [], summary, approve };
}

const actorOf = (ctx: ToolContext): Actor => ({ kind: 'assistant', id: ctx.user.id });
/** The plan already asked for approval when a paused automation has contacts in it. */
const WRITE_OPTS: WriteOpts = { draftOnly: true, approved: true };

function url(ctx: ToolContext, id: number): string {
	return `${ctx.baseUrl}/automations/${id}`;
}

function refused(r: { error: string }): never {
	throw new ToolInputError(r.error);
}

// ── Step snapshots (what Undo compares and replays) ──────────────────────────────────────

const CONTENT_COLS = [
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
	'action_config'
] as const;
type Cols = Record<(typeof CONTENT_COLS)[number], string | number | null>;

type StepSnap = { step_id: number; type: string; parent_step_id: number | null; branch_label: string | null; position: number; cols: Cols };

type SnapRow = Cols & { id: number; type: string; parent_step_id: number | null; branch_label: string | null; position: number };
const SNAP_SELECT = `id, type, parent_step_id, branch_label, position, ${CONTENT_COLS.join(', ')}`;

function snapOf(r: SnapRow): StepSnap {
	const cols = {} as Cols;
	for (const k of CONTENT_COLS) cols[k] = r[k] ?? null;
	return { step_id: r.id, type: r.type, parent_step_id: r.parent_step_id, branch_label: r.branch_label, position: r.position, cols };
}

async function snap(db: D1Database, automationId: number, stepId: number): Promise<StepSnap | null> {
	const r = await db.prepare(`SELECT ${SNAP_SELECT} FROM automation_steps WHERE id = ? AND automation_id = ?`).bind(stepId, automationId).first<SnapRow>();
	return r ? snapOf(r) : null;
}

const sameCols = (a: Cols, b: Cols) => CONTENT_COLS.every((k) => (a[k] ?? null) === (b[k] ?? null));
const sameOrder = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function laneIds(db: D1Database, automationId: number, parent: number | null, label: string | null): Promise<number[]> {
	const rows = await db
		.prepare('SELECT id FROM automation_steps WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ? ORDER BY position, id')
		.bind(automationId, parent, label)
		.all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

/** A lane named by the model: the trunk, or a branch step of this automation + yes / no. */
async function laneArg(db: D1Database, automationId: number, input: Record<string, unknown>): Promise<{ parent: number | null; label: 'yes' | 'no' | null }> {
	const parent = intArg(input, 'parent_step_id', { min: 1 });
	if (!parent) {
		if (input.branch_label !== undefined && input.branch_label !== null) throw new ToolInputError('branch_label needs parent_step_id (the branch step).');
		return { parent: null, label: null };
	}
	const b = await db.prepare("SELECT id FROM automation_steps WHERE id = ? AND automation_id = ? AND type = 'branch'").bind(parent, automationId).first();
	if (!b) throw new ToolInputError(`Step ${parent} is not a branch of this automation.`);
	if (input.branch_label !== 'yes' && input.branch_label !== 'no') throw new ToolInputError('branch_label must be "yes" or "no".');
	return { parent, label: input.branch_label };
}

function stepTitle(type: string, c: Partial<Cols> & { subject?: unknown; tag_name?: unknown }): string {
	if (type === 'email') return `Email “${c.subject ?? ''}”`;
	if (type === 'tag') return `${c.tag_action === 'remove' ? 'Remove' : 'Add'} tag “${c.tag_name ?? ''}”`;
	if (type === 'branch') return 'Condition (yes / no)';
	if (type === 'action') return `Action (${String(c.action_kind ?? '').replace(/_/g, ' ') || 'not set'})`;
	if (type === 'wait') return 'Wait'; // #625
	return 'End';
}

function specStepTitle(s: StepSpec): string {
	return stepTitle(s.type, { subject: s.subject, tag_name: s.tag_name, tag_action: s.tag_action ?? null, action_kind: s.action?.kind ?? null });
}

const condCols = ['gate_kind', 'gate_name', 'gate_value', 'gate_ref_id', 'split_pct', 'gate_rules'] as const;
const actionCols = ['action_kind', 'target_automation_id', 'target_step_id', 'target_stage_id', 'only_from_stage_id', 'target_tier', 'tier_days', 'action_config'] as const;

function stepChanges(a: Cols, b: Cols, bodyGiven: boolean): FieldChange[] {
	const out: FieldChange[] = [];
	const s = (v: string | number | null) => (v === null ? null : String(v));
	if (a.delay_before_seconds !== b.delay_before_seconds) out.push({ field: 'wait', from: waitText(Number(a.delay_before_seconds)), to: waitText(Number(b.delay_before_seconds)) });
	for (const k of ['subject', 'preheader', 'from_email', 'tag_action', 'tag_name'] as const) {
		if ((a[k] ?? null) !== (b[k] ?? null)) out.push({ field: k, from: s(a[k]), to: s(b[k]) });
	}
	if (a.weekday_only !== b.weekday_only) out.push({ field: 'weekdays only', from: a.weekday_only ? 'yes' : 'no', to: b.weekday_only ? 'yes' : 'no' });
	if (bodyGiven && (a.body_md !== b.body_md || (a.body_blocks ?? null) !== (b.body_blocks ?? null))) out.push({ field: 'body', from: 'earlier text', to: 'new text' });
	for (const k of ['tag_on_open', 'tag_on_click'] as const) {
		if ((a[k] ?? null) !== (b[k] ?? null)) out.push({ field: k, from: s(a[k]), to: s(b[k]) });
	}
	if (condCols.some((k) => (a[k] ?? null) !== (b[k] ?? null))) out.push({ field: 'condition', from: 'earlier condition', to: 'new condition' });
	if (actionCols.some((k) => (a[k] ?? null) !== (b[k] ?? null))) out.push({ field: 'action', from: 'earlier action', to: 'new action' });
	return out;
}

async function writeCols(db: D1Database, automationId: number, stepId: number, cols: Cols): Promise<void> {
	await db
		.prepare(`UPDATE automation_steps SET ${CONTENT_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND automation_id = ?`)
		.bind(...CONTENT_COLS.map((k) => cols[k] ?? null), stepId, automationId)
		.run();
}

// ── An automation as a spec with real step ids ───────────────────────────────────────────

type SpecEntry = { path: string; step_id: number; depth: number; step: StepSpec };

/**
 * readSpec (refs `s<N>` = the N-th step depth-first) + each step's real id, found by walking
 * the rows in the same order. `direct` = the step with its references as real ids, ready for
 * updateStep.
 */
async function specWithIds(db: D1Database, automationId: number): Promise<{ spec: AutomationSpec; entries: SpecEntry[]; direct: (e: SpecEntry) => StepFields }> {
	const r = await readSpec(db, automationId);
	if (!r.ok) throw new ToolInputError(`No automation with id ${automationId}.`);
	const rows = (
		await db
			.prepare('SELECT id, type, parent_step_id, branch_label FROM automation_steps WHERE automation_id = ? ORDER BY position, id')
			.bind(automationId)
			.all<{ id: number; type: string; parent_step_id: number | null; branch_label: string | null }>()
	).results;
	const lanes = new Map<string, typeof rows>();
	for (const row of rows) {
		const key = `${row.parent_step_id ?? ''}:${row.branch_label ?? ''}`;
		lanes.set(key, [...(lanes.get(key) ?? []), row]);
	}
	const order: number[] = [];
	const walk = (parent: number | null, label: string | null, depth: number) => {
		for (const s of lanes.get(`${parent ?? ''}:${label ?? ''}`) ?? []) {
			order.push(s.id);
			if (s.type === 'branch' && depth < 20) {
				walk(s.id, 'yes', depth + 1);
				walk(s.id, 'no', depth + 1);
			}
		}
	};
	walk(null, null, 0);
	const entries = walkSpec(r.data.steps).map((w, i) => ({ path: w.path, step_id: order[i], depth: w.depth, step: w.step }));
	const idOfRef = (ref: string | null | undefined) => {
		const m = /^s(\d+)$/.exec(ref ?? '');
		return m ? (order[Number(m[1]) - 1] ?? null) : null;
	};
	const direct = (e: SpecEntry): StepFields => {
		const f: StepFields = { ...e.step };
		delete (f as StepSpec).yes;
		delete (f as StepSpec).no;
		delete (f as StepSpec).ref;
		delete (f as Partial<StepSpec>).type;
		const c = e.step.condition;
		if (c) {
			f.condition = { ...c };
			if (c.kind === 'opened' || c.kind === 'clicked') {
				f.condition.step_id = idOfRef(c.step_ref);
				delete f.condition.step_ref;
			}
			if (c.rules) {
				f.condition.rules = c.rules.map((rule) =>
					rule.field === 'step_opened' || rule.field === 'step_clicked' ? { ...rule, value: String(idOfRef(rule.value) ?? '') } : rule
				);
			}
		}
		const a = e.step.action;
		if (a?.kind === 'goto_step') {
			f.action = { kind: 'goto_step', step_id: idOfRef(a.step_ref) };
		}
		return f;
	};
	return { spec: r.data, entries, direct };
}

// ── Whole-flow creates (build_automation, create_automation_draft) ───────────────────────

const SPEC_DOC = [
	'Input = a whole flow: { name, trigger, reentry?: "once"|"multiple", labels?: string[], steps: Step[] }.',
	'trigger: { type: "manual" } | { type: "list_added", list } (a list, segment or tag — id or name) | { type: "pipeline_stage_entered", stage } (id or name) |',
	'{ type: "site_visit", site?: id/name/domain (omit = any site), path_op: contains|equals|wildcard, path, cooldown_hours? } |',
	'{ type: "company_metric", metric, direction: above|below, threshold } |',
	'{ type: "site_activity", measure: pages|visits (a visit = pageviews < 30 min apart), threshold (1–1000), days (1–180), site? (omit = any site), path_op?, path? (blank = every page), cooldown_hours? (default 168) } |',
	'{ type: "subscription_changed", events: [unsubscribed|resubscribed|bounced|complained|topic_optout|topic_optin] (default [unsubscribed]), topic? (topic events: a list id or name; omit = any topic), sources? (unsubscribed only: [link|preference_center|manual|api|postmark]; omit = any) — runs for unsubscribed contacts but email steps are skipped (the pass ends there), so use tag / pipeline / action steps } |',
	'{ type: "email_opened" | "email_clicked", email: "any" | { campaign_id } | { step_id } | { step_ref } (an email step of this flow), list? (id or name; the contact must be in it),',
	'link? (clicks only: "any" | { op: contains|equals|starts_with, value }), exclude?: [{ campaign_id } | { step_id } | { step_ref } | { link: { op, value } }] (max 10, "any email except …"),',
	'ignore_proxy_opens? (opens; default true), once_per_email? (default true) }. Optional entry_rules: { match: all|any, rules: [{ field, op, value?, value2? }] } — contacts that don\'t match are not enrolled.',
	'Step (every step): type email|tag|branch|action|end|wait, wait_days / wait_hours / wait_minutes before it (default 0), weekday_only?, ref? (a local name other steps point at).',
	'email: subject, body_markdown (or body_blocks), preheader?, from_email? (omit = default From), tag_on_open?, tag_on_click?.',
	'tag: tag_action add|remove, tag_name.',
	'branch: condition + yes: Step[] + no: Step[] (lanes re-join the flow after the branch when they run out). condition kinds: tag / no-tag (name);',
	'field-exists / field-not-exists (name); field-eq / field-contains / field-not-contains (name, value); list-member (list: id or name);',
	'opened / clicked (step_ref = the ref of an earlier email step — put a wait before the branch); split (pct to YES); visited (mode page|event, name, days);',
	'pipeline-stage (mode in|any|none, stage); company-metric (metric, op, value); or { kind: "rules", match: all|any, rules: [{ field, op, value?, value2? }] }.',
	'action: action = { kind: enroll_automation|end_automation (automation: id or name) | end_all_automations | goto_step (step_ref) | pipeline_move (stage, only_from_stage?) | pipeline_remove | set_tier (tier: hot|warm|cool|cold|never|new or clear, days? 1–365; omitted = until cleared) }.',
	'end: stops the flow for the contact.',
	'wait: wait = { mode: "delay", seconds (60–31536000), weekdays_only? } (the usual choice: a set period of time) | { mode: "event", event: opened|clicked (the previous email — needs an email step before it)|replied|visited, path? (visited), timeout_seconds (3600–7776000) } + yes: Step[] (did it) + no: Step[] (timed out) |',
	'{ mode: "date", at: "YYYY-MM-DDTHH:MM" } or { mode: "date", day: weekday|mon…sun, time: "HH:MM" } | { mode: "window", start, end ("HH:MM"), days: weekdays|every } | { mode: "field_date", field (key of a defined custom field of type date), relation: on|before|after, offset + unit (hours|days|weeks; before / after only), time ("HH:MM", default 09:00), if_passed: continue|exit } |',
	'{ mode: "rules", rules: { match: all|any, rules: [{ field, op, value?, value2? }] } (the Condition rule shape, no email-step rules), timeout_seconds? (3600–7776000; omit = no time limit, waits until they match) } + yes: Step[] (matched) + no: Step[] (timed out).'
].join(' ');

const SPEC_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		trigger: { type: 'object', description: 'See the tool description.' },
		reentry: { type: 'string', enum: ['once', 'multiple'] },
		labels: { type: 'array', items: { type: 'string' } },
		steps: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'Steps in order; a branch carries its yes / no lanes.' }
	},
	required: ['name', 'trigger', 'steps']
};

type CreatedAfter = { automation_id: number; snapshot?: string; created_tags?: { id: number; name: string }[] };

/** Resolve + validate; a problem list goes back to the model and nothing is stored. */
async function preparedOrThrow(ctx: ToolContext, input: Record<string, unknown>, tool: string) {
	const p = await prepareSpec(ctx.db, input);
	if (p.problems.length) {
		throw new ToolInputError(
			`Nothing was saved — the automation has ${p.problems.length} problem${p.problems.length === 1 ? '' : 's'}. Fix them and call ${tool} again:\n${problemLines(p.problems)}`
		);
	}
	return p;
}

async function flowNotes(ctx: ToolContext, spec: AutomationSpec, newTags: string[], tagsDone: boolean): Promise<string[]> {
	const notes = await outlineLines(ctx.db, spec);
	if (newTags.length) notes.push(`${tagsDone ? 'New tags created' : 'New tags (created on Approve)'}: ${newTags.map((t) => `“${t}”`).join(', ')}`);
	notes.push(REVIEW_NOTE);
	return notes;
}

/** Create the missing tags, then the draft automation. */
async function createFlow(ctx: ToolContext, input: Record<string, unknown>, tool: string): Promise<WriteOutcome> {
	const p = await preparedOrThrow(ctx, input, tool);
	const tags: { id: number; name: string }[] = [];
	for (const name of p.newTags) {
		const exists = await ctx.db.prepare("SELECT id FROM lists WHERE kind = 'tag' AND name = ? COLLATE NOCASE").bind(name).first();
		if (exists) continue;
		const row = await ctx.db.prepare("INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id").bind(name).first<{ id: number }>();
		tags.push({ id: row!.id, name });
	}
	const r = await createFromSpec(ctx.db, p.spec, actorOf(ctx), { defaultFrom: await defaultFrom(ctx.db) });
	if (!r.ok) {
		for (const t of tags) await ctx.db.prepare("DELETE FROM lists WHERE id = ? AND kind = 'tag'").bind(t.id).run();
		refused(r);
	}
	const id = r.data.automation_id;
	const snapshot = await readSpec(ctx.db, id);
	const count = stepCountText(p.spec);
	return {
		summary: `Created draft automation “${p.spec.name}” · ${count}`,
		before: null,
		after: { automation_id: id, snapshot: snapshot.ok ? JSON.stringify(snapshot.data) : undefined, created_tags: tags } satisfies CreatedAfter,
		url: url(ctx, id),
		notes: await flowNotes(ctx, p.spec, tags.map((t) => t.name), true),
		result: {
			automation_id: id,
			status: 'draft',
			step_ids: Object.values(r.data.step_ids).length ? r.data.step_ids : undefined,
			steps: count,
			next: 'Tell the user to review and activate it in Automations (Open automation). You cannot activate it.'
		}
	};
}

/** A tag the build created is removed with it — only while nothing else uses it. */
async function tagUnused(db: D1Database, t: { id: number; name: string }): Promise<boolean> {
	// #485: instr, not LIKE — D1 caps LIKE patterns at 50 bytes and a tag name can be longer.
	const quoted = JSON.stringify(t.name);
	const r = await db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM list_members WHERE list_id = ?1)
			      + (SELECT COUNT(*) FROM automations WHERE trigger_list_id = ?1)
			      + (SELECT COUNT(*) FROM campaign_audiences WHERE list_id = ?1)
			      + (SELECT COUNT(*) FROM campaigns WHERE list_id = ?1 OR tag_on_open = ?2 COLLATE NOCASE OR tag_on_click = ?2 COLLATE NOCASE)
			      + (SELECT COUNT(*) FROM automation_steps
			          WHERE tag_name = ?2 COLLATE NOCASE OR gate_name = ?2 COLLATE NOCASE OR tag_on_open = ?2 COLLATE NOCASE
			             OR tag_on_click = ?2 COLLATE NOCASE OR gate_ref_id = ?1 OR ${containsSql('gate_rules', '?3')})
			      + (SELECT COUNT(*) FROM lists WHERE ${containsSql('rules', '?3')}) AS n`
		)
		.bind(t.id, t.name, quoted)
		.first<{ n: number }>();
	return !r?.n;
}

/** Undo of a create: delete the automation while it is an untouched draft (no enrollments, no
 *  campaign rows, not edited since), and the tags it created that nothing uses. */
async function undoCreated(ctx: ToolContext, after: unknown): Promise<void> {
	const a = after as CreatedAfter | null;
	if (!a?.automation_id) return;
	const row = await automationRow(ctx.db, a.automation_id);
	if (row) {
		if (row.status !== 'draft') throw new UndoRefused(`“${row.name}” was kept: it is ${row.status} now.`);
		const used = await ctx.db
			.prepare(
				`SELECT (SELECT COUNT(*) FROM automation_enrollments WHERE automation_id = ?)
				      + (SELECT COUNT(*) FROM campaigns WHERE automation_id = ?) AS n`
			)
			.bind(row.id, row.id)
			.first<{ n: number }>();
		if (used?.n) throw new UndoRefused(`“${row.name}” was kept: it has been used.`);
		if (a.snapshot) {
			const now = await readSpec(ctx.db, row.id);
			if (!now.ok || JSON.stringify(now.data) !== a.snapshot) throw new UndoRefused(`“${row.name}” was kept: it was edited since.`);
		}
		// Leaves first: a step can only go once no step points at it as its parent.
		for (let n = 0; n < 50; n++) {
			const r = await ctx.db
				.prepare(
					`DELETE FROM automation_steps WHERE automation_id = ?
					   AND id NOT IN (SELECT parent_step_id FROM automation_steps WHERE automation_id = ? AND parent_step_id IS NOT NULL)`
				)
				.bind(row.id, row.id)
				.run();
			if (!r.meta.changes) break;
		}
		await ctx.db.batch([
			ctx.db.prepare('DELETE FROM automation_labels WHERE automation_id = ?').bind(row.id),
			ctx.db.prepare("DELETE FROM automations WHERE id = ? AND status = 'draft'").bind(row.id)
		]);
	}
	for (const t of a.created_tags ?? []) {
		if (await tagUnused(ctx.db, t)) await ctx.db.prepare("DELETE FROM lists WHERE id = ? AND kind = 'tag'").bind(t.id).run();
	}
}

// ── Single-step arguments ────────────────────────────────────────────────────────────────

const STEP_PROPS = {
	type: { type: 'string', enum: ['email', 'tag', 'branch', 'action', 'end', 'wait'] },
	wait_days: { type: 'integer', minimum: 0, description: 'Wait before this step (days + hours + minutes; 0 = right away).' },
	wait_hours: { type: 'integer', minimum: 0 },
	wait_minutes: { type: 'integer', minimum: 0 },
	weekday_only: { type: 'boolean', description: 'Move a Saturday/Sunday due time to Monday.' },
	subject: { type: 'string', description: 'Email steps.' },
	preheader: { type: ['string', 'null'], description: 'Email steps: inbox preview text.' },
	from_email: { type: 'string', description: 'Email steps: an approved sender. Omit for the default From.' },
	...BODY_PROPS,
	tag_on_open: { type: ['string', 'null'], description: 'Email steps: tag added when opened.' },
	tag_on_click: { type: ['string', 'null'], description: 'Email steps: tag added when clicked.' },
	tag_action: { type: 'string', enum: ['add', 'remove'], description: 'Tag steps.' },
	tag_name: { type: 'string', description: 'Tag steps: the tag.' },
	condition: {
		type: 'object',
		description:
			'Branch steps: the condition (same kinds as build_automation; lists / stages by id or name). opened / clicked name the email step by step_id; rules step_opened / step_clicked take the step id as value.'
	},
	action: {
		type: 'object',
		description: 'Action steps: { kind, automation (id or name) | stage / only_from_stage (id or name) | step_id (goto_step) }.'
	},
	wait: {
		type: 'object',
		description:
			'Wait steps (#625): { mode: "delay", seconds, weekdays_only? } | { mode: "event", event, path?, timeout_seconds } | { mode: "date", at | day + time } | { mode: "window", start, end, days } | { mode: "rules", rules: { match, rules }, timeout_seconds? } (#626: until they match; no timeout = no time limit).'
	}
};

/** True when the step points at another step by id (no dry run possible outside a spec). */
function hasStepRef(s: StepSpec): boolean {
	const c = s.condition;
	return (
		(s.type === 'action' && s.action?.kind === 'goto_step') ||
		(s.type === 'branch' && !!c && (c.kind === 'opened' || c.kind === 'clicked' || (c.rules ?? []).some((r) => r?.field === 'step_opened' || r?.field === 'step_clicked')))
	);
}

/** The model's new step → StepSpec, with names resolved and the From defaulted; checked
 *  without writing when it has no step references. */
async function newStepArg(ctx: ToolContext, raw: unknown): Promise<StepSpec> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('"step" must be an object.');
	const r = new AutomationInput(ctx.db);
	const step = await r.step(raw, 'step', false);
	if (r.problems.length) throw new ToolInputError(`Nothing was changed:\n${problemLines(r.problems)}`);
	if (step.type === 'email' && !step.from_email) step.from_email = await defaultFrom(ctx.db);
	delete step.ref;
	if (!hasStepRef(step)) {
		const problems = await validateSpec(ctx.db, { name: 'step', trigger: { type: 'manual' }, steps: [step] });
		if (problems.length) throw new ToolInputError(`Nothing was changed:\n${problems.map((p) => `- ${p.message}`).join('\n')}`);
	}
	return step;
}

type StepAfter = { automation_id: number; step: StepSnap; order: number[] };
type OrderState = { automation_id: number; parent: number | null; label: string | null; order: number[] };
type DeletedBefore = { automation_id: number; rows: StepSnap[]; campaigns: { id: number; step_id: number }[] };

const AUTOMATION_ID = { automation_id: { type: 'integer', description: 'Automation id (draft or paused).' } };
const LANE_PROPS = {
	parent_step_id: { type: 'integer', description: 'A branch step id: work in one of its lanes. Omit for the main path.' },
	branch_label: { type: 'string', enum: ['yes', 'no'], description: 'With parent_step_id: the YES or NO lane.' }
};

export const automationDraftTools: Tool[] = [
	{
		name: 'get_automation_spec',
		tier: 'read',
		description:
			'An automation as a whole-flow spec (the build_automation input format: trigger, re-entry, labels, steps with branch lanes) plus `steps` = every step\'s path, real step_id and title — read it before editing a flow, or pass the spec (renamed) to build_automation to copy it. Email bodies come as body_md unless include_blocks is true.',
		input_schema: {
			type: 'object',
			properties: { ...AUTOMATION_ID, include_blocks: { type: 'boolean', description: 'Return email bodies as body_blocks (larger).' } },
			required: ['automation_id']
		},
		summarize: (input) => `automation #${input.automation_id}`,
		handler: async (ctx, input) => {
			const id = intArg(input, 'automation_id', { required: true, min: 1 })!;
			const a = await automationRow(ctx.db, id);
			if (!a) throw new ToolInputError(`No automation with id ${id}.`);
			const { spec, entries } = await specWithIds(ctx.db, id);
			if (input.include_blocks !== true) {
				for (const { step } of walkSpec(spec.steps)) {
					if (step.type === 'email' && Array.isArray(step.body_blocks)) {
						step.body_md = blocksToMarkdown(step.body_blocks as Block[]);
						delete step.body_blocks;
					}
				}
			}
			return {
				automation_id: a.id,
				status: a.status,
				editable: a.status === 'draft' || a.status === 'paused',
				url: url(ctx, a.id),
				spec,
				steps: entries.map((e) => ({ path: e.path, step_id: e.step_id, depth: e.depth, type: e.step.type, title: specStepTitle(e.step) }))
			};
		}
	},
	{
		name: 'build_automation',
		tier: 'approve',
		description:
			'Build a complete DRAFT automation from a description, as one whole-flow spec. Propose the outline to the user first. The spec is checked first: on problems nothing is stored and they come back so you can fix the spec and call again. When valid, the user sees the outline on a card and approves; it is then created as a draft — never activated, nobody enrolled, nothing sent. Missing tags are created on Approve. ' +
			SPEC_DOC,
		input_schema: SPEC_SCHEMA,
		summarize: (input) => String(input.name ?? ''),
		plan: async (ctx, input) => {
			const p = await preparedOrThrow(ctx, input, 'build_automation');
			return {
				count: 0,
				sample: [],
				summary: `Build draft automation “${p.spec.name}” · ${stepCountText(p.spec)}`,
				notes: await flowNotes(ctx, p.spec, p.newTags, false)
			};
		},
		apply: (ctx, input) => createFlow(ctx, input, 'build_automation'),
		undo: (ctx, _before, after) => undoCreated(ctx, after)
	},
	{
		name: 'create_automation_draft',
		tier: 'write',
		description:
			'Create a small DRAFT automation at once (no approval card) — same input as build_automation; prefer build_automation for anything with branches or more than a few steps. Never activated, nobody enrolled. ' +
			'Also accepts trigger_type + trigger_list_id instead of trigger.',
		input_schema: {
			...SPEC_SCHEMA,
			properties: { ...SPEC_SCHEMA.properties, trigger_type: { type: 'string' }, trigger_list_id: { type: ['integer', 'string'] } },
			required: ['name', 'steps']
		},
		summarize: (input) => String(input.name ?? ''),
		plan: async (ctx, input) => {
			const p = await preparedOrThrow(ctx, input, 'create_automation_draft');
			return { count: 0, sample: [], summary: `Create draft automation “${p.spec.name}” (${stepCountText(p.spec)})` };
		},
		apply: (ctx, input) => createFlow(ctx, input, 'create_automation_draft'),
		undo: (ctx, _before, after) => undoCreated(ctx, after)
	},
	{
		name: 'add_automation_step',
		tier: 'write',
		description:
			'Add one step (any type) to a draft or paused automation: on the main path, or in a branch lane (parent_step_id + branch_label), at `position` (0 = first; default = last). A new branch starts with empty lanes — add steps to them next. Other steps are referenced by real step_id (get_automation_spec). Never activates it. On a paused automation with contacts mid-flow, the user approves first.',
		input_schema: {
			type: 'object',
			properties: { ...AUTOMATION_ID, ...LANE_PROPS, position: { type: 'integer', minimum: 0 }, step: { type: 'object', properties: STEP_PROPS } },
			required: ['automation_id', 'step']
		},
		summarize: (input) => `automation #${input.automation_id}`,
		plan: async (ctx, input) => {
			const { a, active } = await requireEditable(ctx.db, intArg(input, 'automation_id', { required: true, min: 1 })!);
			const lane = await laneArg(ctx.db, a.id, input);
			await positionArg(ctx.db, a.id, lane, input);
			const s = await newStepArg(ctx, input.step);
			return editPlan(a, active, `Add a step to “${a.name}”: ${specStepTitle(s)}`);
		},
		apply: async (ctx, input) => {
			const { a } = await requireEditable(ctx.db, intArg(input, 'automation_id', { required: true, min: 1 })!);
			const lane = await laneArg(ctx.db, a.id, input);
			const { order, position } = await positionArg(ctx.db, a.id, lane, input);
			const s = await newStepArg(ctx, input.step);
			const r = await addStep(ctx.db, a.id, { type: s.type, parent_step_id: lane.parent, branch_label: lane.label, position, fields: s }, actorOf(ctx), WRITE_OPTS);
			if (!r.ok) refused(r);
			const step = (await snap(ctx.db, a.id, r.data.step_id))!;
			const next = await laneIds(ctx.db, a.id, lane.parent, lane.label);
			return {
				summary: `Added step ${position + 1}${lane.parent ? ` to the ${lane.label?.toUpperCase()} lane` : ''} of “${a.name}”: ${stepTitle(step.type, step.cols)}`,
				before: { automation_id: a.id, parent: lane.parent, label: lane.label, order } satisfies OrderState,
				after: { automation_id: a.id, step, order: next } satisfies StepAfter,
				url: url(ctx, a.id),
				result: { automation_id: a.id, step_id: r.data.step_id, position, status: a.status }
			};
		},
		undo: async (ctx, _before, after) => {
			const a = after as StepAfter;
			const auto = await requireEditableForUndo(ctx.db, a.automation_id);
			const now = await snap(ctx.db, a.automation_id, a.step.step_id);
			if (!now) return; // already gone
			if (!sameCols(now.cols, a.step.cols)) throw new UndoRefused(`The step in “${auto.name}” was edited since — it was kept.`);
			if (!sameOrder(await laneIds(ctx.db, a.automation_id, a.step.parent_step_id, a.step.branch_label), a.order)) {
				throw new UndoRefused(`The steps of “${auto.name}” changed since — nothing was undone.`);
			}
			const used = await ctx.db
				.prepare(
					`SELECT (SELECT COUNT(*) FROM automation_enrollments WHERE current_step_id = ?1)
					      + (SELECT COUNT(*) FROM campaigns WHERE automation_step_id = ?1)
					      + (SELECT COUNT(*) FROM automation_steps WHERE parent_step_id = ?1) AS n`
				)
				.bind(a.step.step_id)
				.first<{ n: number }>();
			if (used?.n) throw new UndoRefused('The step was kept: it has steps in its lanes or contacts have reached it.');
			const r = await deleteStep(ctx.db, a.automation_id, { step_id: a.step.step_id }, actorOf(ctx), WRITE_OPTS);
			if (!r.ok) throw new UndoRefused(r.error);
		}
	},
	{
		name: 'edit_automation_step',
		tier: 'write',
		description:
			'Edit one step of a draft or paused automation. Only the keys you pass change: wait, weekdays-only; email subject / preheader / from / body / tag_on_open / tag_on_click; tag action / name; a branch\'s whole condition; an action step\'s whole action (names allowed for lists, stages, automations). The type can\'t change. Never activates it. On a paused automation with contacts mid-flow, the user approves first.',
		input_schema: {
			type: 'object',
			properties: { ...AUTOMATION_ID, step_id: { type: 'integer' }, ...STEP_PROPS },
			required: ['automation_id', 'step_id']
		},
		summarize: (input) => `step #${input.step_id}`,
		plan: async (ctx, input) => {
			const { a, active, before } = await stepEdit(ctx, input);
			return editPlan(a, active, `Edit “${a.name}”: ${stepTitle(before.type, before.cols)}`);
		},
		apply: async (ctx, input) => {
			const { a, before, fields } = await stepEdit(ctx, input);
			const r = await updateStep(ctx.db, a.id, { step_id: before.step_id, fields }, actorOf(ctx), WRITE_OPTS);
			if (!r.ok) refused(r);
			const after = (await snap(ctx.db, a.id, before.step_id))!;
			const changes = stepChanges(before.cols, after.cols, ['body_markdown', 'body_blocks', 'body_md'].some((k) => k in input));
			return {
				summary: `Edited “${a.name}”: ${stepTitle(after.type, after.cols)} (${changes.map((c) => c.field).join(', ') || 'no change'})`,
				before,
				after: { automation_id: a.id, step: after },
				changes,
				url: url(ctx, a.id),
				result: { automation_id: a.id, step_id: after.step_id }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as StepSnap;
			const a = after as { automation_id: number; step: StepSnap };
			const auto = await requireEditableForUndo(ctx.db, a.automation_id);
			const now = await snap(ctx.db, a.automation_id, a.step.step_id);
			if (!now) throw new UndoRefused('That step no longer exists.');
			if (!sameCols(now.cols, a.step.cols)) throw new UndoRefused(`The step in “${auto.name}” was edited since — nothing was undone.`);
			await writeCols(ctx.db, a.automation_id, b.step_id, b.cols);
		}
	},
	{
		name: 'reorder_automation_steps',
		tier: 'write',
		description:
			'Reorder the steps of one lane of a draft or paused automation: the main path (default) or a branch lane (parent_step_id + branch_label). `order` = every step id of that lane, in the new order (get_automation_spec lists them). Never activates it. On a paused automation with contacts mid-flow, the user approves first.',
		input_schema: {
			type: 'object',
			properties: { ...AUTOMATION_ID, ...LANE_PROPS, order: { type: 'array', items: { type: 'integer' } } },
			required: ['automation_id', 'order']
		},
		summarize: (input) => `automation #${input.automation_id}`,
		plan: async (ctx, input) => {
			const { a, active, order } = await reorderArgs(ctx, input);
			return editPlan(a, active, `Reorder the steps of “${a.name}” (${order.length})`);
		},
		apply: async (ctx, input) => {
			const { a, lane, current, order } = await reorderArgs(ctx, input);
			const r = await reorderSteps(ctx.db, a.id, { order, parent_step_id: lane.parent, branch_label: lane.label }, actorOf(ctx), WRITE_OPTS);
			if (!r.ok) refused(r);
			return {
				summary: `Reordered the steps of “${a.name}”`,
				before: { automation_id: a.id, parent: lane.parent, label: lane.label, order: current } satisfies OrderState,
				after: { automation_id: a.id, parent: lane.parent, label: lane.label, order } satisfies OrderState,
				changes: [{ field: 'step order', from: current.join(', '), to: order.join(', ') }],
				url: url(ctx, a.id),
				result: { automation_id: a.id, order }
			};
		},
		undo: async (ctx, before, after) => {
			const b = before as OrderState;
			const a = after as OrderState;
			const auto = await requireEditableForUndo(ctx.db, a.automation_id);
			const parent = a.parent ?? null;
			const label = (a.label ?? null) as 'yes' | 'no' | null;
			if (!sameOrder(await laneIds(ctx.db, a.automation_id, parent, label), a.order)) throw new UndoRefused(`The steps of “${auto.name}” changed since — nothing was undone.`);
			const r = await reorderSteps(ctx.db, a.automation_id, { order: b.order, parent_step_id: parent, branch_label: label }, actorOf(ctx), WRITE_OPTS);
			if (!r.ok) throw new UndoRefused(r.error);
		}
	},
	{
		name: 'delete_automation_step',
		tier: 'write',
		description:
			'Delete one step of a draft or paused automation — a branch takes its whole YES / NO lanes with it. Refused while another step goes to it or checks it (opened / clicked). Undo re-creates it. Never activates the automation. On a paused automation with contacts mid-flow, the user approves first (they move on to the next step).',
		input_schema: { type: 'object', properties: { ...AUTOMATION_ID, step_id: { type: 'integer' } }, required: ['automation_id', 'step_id'] },
		summarize: (input) => `step #${input.step_id}`,
		plan: async (ctx, input) => {
			const { a, active, root, subtree } = await deleteArgs(ctx, input);
			const more = subtree.length - 1;
			return editPlan(a, active, `Delete from “${a.name}”: ${stepTitle(root.type, root.cols)}${more ? ` and the ${more} step${more === 1 ? '' : 's'} in its lanes` : ''}`);
		},
		apply: async (ctx, input) => {
			const { a, root, subtree } = await deleteArgs(ctx, input);
			const ids = subtree.map((s) => s.step_id);
			const campaigns = (
				await ctx.db
					.prepare('SELECT id, automation_step_id AS step_id FROM campaigns WHERE automation_step_id IN (SELECT value FROM json_each(?))')
					.bind(JSON.stringify(ids))
					.all<{ id: number; step_id: number }>()
			).results;
			const r = await deleteStep(ctx.db, a.id, { step_id: root.step_id }, actorOf(ctx), WRITE_OPTS);
			if (!r.ok) refused(r);
			return {
				summary: `Deleted from “${a.name}”: ${stepTitle(root.type, root.cols)}${ids.length > 1 ? ` (+${ids.length - 1} in its lanes)` : ''}`,
				before: { automation_id: a.id, rows: subtree, campaigns } satisfies DeletedBefore,
				after: { automation_id: a.id, deleted: r.data.deleted },
				url: url(ctx, a.id),
				result: { automation_id: a.id, deleted: r.data.deleted }
			};
		},
		undo: async (ctx, before) => {
			const b = before as DeletedBefore;
			await requireEditableForUndo(ctx.db, b.automation_id);
			await recreate(ctx.db, b);
		}
	}
];

async function positionArg(db: D1Database, automationId: number, lane: { parent: number | null; label: string | null }, input: Record<string, unknown>) {
	const order = await laneIds(db, automationId, lane.parent, lane.label);
	if (order.length >= LANE_MAX) throw new ToolInputError('That lane has too many steps to add more here.');
	const position = intArg(input, 'position', { min: 0 }) ?? order.length;
	if (position > order.length) throw new ToolInputError(`"position" must be between 0 and ${order.length}.`);
	return { order, position };
}

async function stepEdit(ctx: ToolContext, input: Record<string, unknown>) {
	const { a, active } = await requireEditable(ctx.db, intArg(input, 'automation_id', { required: true, min: 1 })!);
	const stepId = intArg(input, 'step_id', { required: true, min: 1 })!;
	const before = await snap(ctx.db, a.id, stepId);
	if (!before) throw new ToolInputError(`“${a.name}” has no step ${stepId}.`);
	if (input.type !== undefined && input.type !== before.type) throw new ToolInputError("A step's type can't be changed — delete it and add a new one.");
	if (before.type === 'end') throw new ToolInputError('An End step has nothing to edit.');
	const { entries, direct } = await specWithIds(ctx.db, a.id);
	const entry = entries.find((e) => e.step_id === stepId);
	if (!entry) throw new ToolInputError(`Step ${stepId} isn't reachable in “${a.name}” — edit it in the builder.`);
	const fields = direct(entry);
	const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
	const r = new AutomationInput(ctx.db);
	let touched = false;
	const wait = waitArg(input);
	if (wait !== null) {
		fields.wait_seconds = wait;
		touched = true;
	}
	if (has('weekday_only')) {
		fields.weekday_only = input.weekday_only === true;
		touched = true;
	}
	const allowed: Record<string, string[]> = {
		email: ['subject', 'preheader', 'from_email', 'tag_on_open', 'tag_on_click', 'body_markdown', 'body_blocks', 'body_md'],
		tag: ['tag_action', 'tag_name'],
		branch: ['condition'],
		action: ['action']
	};
	const all = Object.values(allowed).flat();
	const wrong = all.filter((k) => has(k) && !allowed[before.type]?.includes(k));
	if (wrong.length) throw new ToolInputError(`A ${before.type} step has no ${wrong.join(', ')}.`);
	if (before.type === 'email') {
		for (const k of ['subject', 'preheader', 'from_email', 'tag_on_open', 'tag_on_click'] as const) {
			if (has(k)) {
				(fields as Record<string, unknown>)[k] = input[k] === null ? null : String(input[k] ?? '');
				touched = true;
			}
		}
		const blocks = blocksArg({ body_blocks: input.body_blocks, body_markdown: input.body_markdown ?? input.body_md });
		if (blocks) {
			const body = bodyOf(blocks);
			fields.body_blocks = body.blocks;
			fields.body_md = body.md;
			touched = true;
		}
	} else if (before.type === 'tag') {
		if (has('tag_action')) fields.tag_action = input.tag_action === 'remove' ? 'remove' : 'add';
		if (has('tag_name')) fields.tag_name = String(input.tag_name ?? '');
		touched ||= has('tag_action') || has('tag_name');
	} else if (before.type === 'branch' && has('condition')) {
		fields.condition = await r.condition(input.condition, 'condition');
		touched = true;
	} else if (before.type === 'action' && has('action')) {
		fields.action = await r.action(input.action, 'action');
		touched = true;
	}
	if (r.problems.length) throw new ToolInputError(`Nothing was changed:\n${problemLines(r.problems)}`);
	if (!touched) throw new ToolInputError('Nothing to change.');
	const asStep = { ...fields, type: before.type } as StepSpec;
	if (!hasStepRef(asStep)) {
		const problems = await validateSpec(ctx.db, { name: 'step', trigger: { type: 'manual' }, steps: [asStep] });
		if (problems.length) throw new ToolInputError(`Nothing was changed:\n${problems.map((p) => `- ${p.message}`).join('\n')}`);
	}
	return { a, active, before, fields };
}

async function reorderArgs(ctx: ToolContext, input: Record<string, unknown>) {
	const { a, active } = await requireEditable(ctx.db, intArg(input, 'automation_id', { required: true, min: 1 })!);
	const lane = await laneArg(ctx.db, a.id, input);
	const current = await laneIds(ctx.db, a.id, lane.parent, lane.label);
	const order = Array.isArray(input.order) ? input.order.map(Number) : [];
	const valid = order.length === current.length && new Set(order).size === order.length && current.every((id) => order.includes(id));
	if (!valid) throw new ToolInputError(`"order" must list every step id of that lane exactly once: ${current.join(', ')}.`);
	if (sameOrder(order, current)) throw new ToolInputError('That is already the order.');
	return { a, active, lane, current, order };
}

/** The step + its subtree (parent before children), refusing while a step outside it points in. */
async function deleteArgs(ctx: ToolContext, input: Record<string, unknown>) {
	const { a, active } = await requireEditable(ctx.db, intArg(input, 'automation_id', { required: true, min: 1 })!);
	const stepId = intArg(input, 'step_id', { required: true, min: 1 })!;
	const rows = (await ctx.db.prepare(`SELECT ${SNAP_SELECT} FROM automation_steps WHERE automation_id = ? ORDER BY position, id`).bind(a.id).all<SnapRow>()).results.map(snapOf);
	const root = rows.find((s) => s.step_id === stepId);
	if (!root) throw new ToolInputError(`“${a.name}” has no step ${stepId}.`);
	const subtree: StepSnap[] = [];
	const collect = (s: StepSnap, depth: number) => {
		subtree.push(s);
		if (depth < 20) for (const c of rows.filter((x) => x.parent_step_id === s.step_id)) collect(c, depth + 1);
	};
	collect(root, 0);
	const inside = new Set(subtree.map((s) => s.step_id));
	for (const s of rows) {
		if (inside.has(s.step_id)) continue;
		const c = s.cols;
		const points =
			(c.action_kind === 'goto_step' && inside.has(Number(c.target_step_id))) ||
			(!c.gate_rules && (c.gate_kind === 'opened' || c.gate_kind === 'clicked') && inside.has(Number(c.gate_ref_id))) ||
			(parseGateRules(c.gate_rules as string | null)?.rules ?? []).some((r) => (r.field === 'step_opened' || r.field === 'step_clicked') && inside.has(Number(r.value)));
		if (points) throw new ToolInputError(`Step ${s.step_id} goes to or checks the step being deleted — change or delete step ${s.step_id} first.`);
	}
	return { a, active, root, subtree };
}

/** Undo of a delete: insert the subtree again (new ids), remap its own references, put the
 *  detached campaigns back on the new steps. */
async function recreate(db: D1Database, b: DeletedBefore): Promise<void> {
	const root = b.rows[0];
	if (!root) return;
	if (root.parent_step_id) {
		const p = await db.prepare("SELECT id FROM automation_steps WHERE id = ? AND automation_id = ? AND type = 'branch'").bind(root.parent_step_id, b.automation_id).first();
		if (!p) throw new UndoRefused('The branch that step was in no longer exists — nothing was undone.');
	}
	const lane = await laneIds(db, b.automation_id, root.parent_step_id, root.branch_label);
	const position = Math.min(root.position, lane.length);
	await db
		.prepare('UPDATE automation_steps SET position = position + 1 WHERE automation_id = ? AND parent_step_id IS ? AND branch_label IS ? AND position >= ?')
		.bind(b.automation_id, root.parent_step_id, root.branch_label, position)
		.run();
	const ids = new Map<number, number>();
	const stepExists = async (id: number) => !!(await db.prepare('SELECT id FROM automation_steps WHERE id = ? AND automation_id = ?').bind(id, b.automation_id).first());
	for (const s of b.rows) {
		const cols = { ...s.cols };
		// References are set after every row exists (a target may be later in the subtree).
		cols.target_step_id = null;
		if (cols.target_automation_id && !(await db.prepare('SELECT id FROM automations WHERE id = ?').bind(cols.target_automation_id).first())) cols.target_automation_id = null;
		const parent = s === root ? root.parent_step_id : (ids.get(s.parent_step_id ?? 0) ?? null);
		const keys = ['automation_id', 'type', 'parent_step_id', 'branch_label', 'position', ...CONTENT_COLS];
		const values = [b.automation_id, s.type, parent, s.branch_label, s === root ? position : s.position, ...CONTENT_COLS.map((k) => cols[k] ?? null)];
		const row = await db
			.prepare(`INSERT INTO automation_steps (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`)
			.bind(...values)
			.first<{ id: number }>();
		ids.set(s.step_id, row!.id);
	}
	for (const s of b.rows) {
		const id = ids.get(s.step_id)!;
		const c = s.cols;
		const map = async (old: number) => ids.get(old) ?? ((await stepExists(old)) ? old : null);
		if (c.action_kind === 'goto_step' && c.target_step_id) {
			await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(await map(Number(c.target_step_id)), id).run();
		}
		if (!c.gate_rules && (c.gate_kind === 'opened' || c.gate_kind === 'clicked') && c.gate_ref_id && ids.has(Number(c.gate_ref_id))) {
			await db.prepare('UPDATE automation_steps SET gate_ref_id = ? WHERE id = ?').bind(ids.get(Number(c.gate_ref_id)), id).run();
		}
		const set = parseGateRules(c.gate_rules as string | null);
		if (set?.rules.some((r) => (r.field === 'step_opened' || r.field === 'step_clicked') && ids.has(Number(r.value)))) {
			const rules = set.rules.map((r) =>
				(r.field === 'step_opened' || r.field === 'step_clicked') && ids.has(Number(r.value)) ? { ...r, value: String(ids.get(Number(r.value))) } : r
			);
			await db.prepare('UPDATE automation_steps SET gate_rules = ? WHERE id = ?').bind(JSON.stringify({ ...set, rules }), id).run();
		}
	}
	for (const c of b.campaigns) {
		const to = ids.get(c.step_id);
		if (to) await db.prepare('UPDATE campaigns SET automation_step_id = ? WHERE id = ? AND automation_step_id IS NULL').bind(to, c.id).run();
	}
}
