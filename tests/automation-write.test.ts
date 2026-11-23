import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	addLabel,
	addStep,
	createAutomation,
	createFromSpec,
	deleteStep,
	duplicateStep,
	moveStep,
	readSpec,
	removeLabel,
	renameAutomation,
	reorderSteps,
	setReentry,
	setTrigger,
	updateStep,
	validateSpec,
	type Actor
} from '../src/lib/server/automation-write';
import { specStructureProblems, walkSpec, type AutomationSpec, type StepSpec } from '../src/lib/automation-spec';

// #345: the shared automation write layer — every operation, every step type, the whole-flow
// spec (validate / create / read round-trip), the draftOnly guard, and the structural rule
// that it never reaches the engine, a send or an activation check.
const db = (env as any).DB as D1Database;
const actor: Actor = { kind: 'system' };

let STAGES: number[] = [];
let LIST = 0;
let OTHER = 0;
let SITE = 0;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare("DELETE FROM app_state WHERE key IN ('approved_senders', 'default_from')")
	]);
	let stages = await db.prepare('SELECT id FROM pipeline_stages ORDER BY position, id').all<{ id: number }>();
	if (stages.results.length < 2) {
		await db.prepare(`INSERT INTO pipeline_stages (name, color, position, kind) VALUES ('W1','muted',90,'open'),('W2','viz-1',91,'open')`).run();
		stages = await db.prepare('SELECT id FROM pipeline_stages ORDER BY position, id').all<{ id: number }>();
	}
	STAGES = stages.results.map((r) => r.id);
	LIST = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Newsletter', 'list') RETURNING id").first<{ id: number }>())!.id;
	OTHER = (await db.prepare("INSERT INTO automations (name, status) VALUES ('Other', 'active') RETURNING id").first<{ id: number }>())!.id;
	SITE = (await db.prepare(`INSERT INTO tracking_sites (name, domain, site_key) VALUES ('DS', 'ourco.example', 'sk_w') RETURNING id`).first<{ id: number }>())!
		.id;
});

const email = (subject: string, extra: Partial<StepSpec> = {}): StepSpec => ({
	type: 'email',
	wait_seconds: 0,
	weekday_only: false,
	subject,
	from_email: 'alan@ourco.example',
	preheader: null,
	body_md: `Hello from ${subject}`,
	tag_on_open: null,
	tag_on_click: null,
	...extra
});

/** A spec with every step type, a nested branch and local refs — in readSpec's canonical form. */
function fullSpec(): AutomationSpec {
	return {
		name: 'Everything',
		trigger: { type: 'list_added', list_id: LIST },
		reentry: 'multiple',
		labels: ['nurture', 'onboarding'],
		steps: [
			{ ...email('Welcome'), ref: 's1', tag_on_open: 'opened-welcome' },
			{ type: 'tag', wait_seconds: 3600, weekday_only: true, tag_action: 'add', tag_name: 'warm' },
			{
				type: 'branch',
				wait_seconds: 86400,
				weekday_only: false,
				condition: { kind: 'opened', step_ref: 's1' },
				yes: [
					{
						type: 'branch',
						wait_seconds: 0,
						weekday_only: false,
						condition: {
							kind: 'rules',
							match: 'any',
							rules: [
								{ field: 'tag', op: 'has', value: 'vip' },
								{ field: 'step_clicked', op: 'yes', value: 's1' }
							]
						},
						yes: [{ type: 'action', wait_seconds: 0, weekday_only: false, action: { kind: 'pipeline_move', stage_id: STAGES[1], only_from_stage_id: STAGES[0] } }],
						no: [{ type: 'action', wait_seconds: 0, weekday_only: false, action: { kind: 'enroll_automation', automation_id: OTHER } }]
					},
					{ type: 'branch', wait_seconds: 0, weekday_only: false, condition: { kind: 'split', pct: 30 }, yes: [], no: [] }
				],
				no: [
					{ type: 'tag', wait_seconds: 0, weekday_only: false, tag_action: 'remove', tag_name: 'warm' },
					{ type: 'action', wait_seconds: 0, weekday_only: false, action: { kind: 'goto_step', step_ref: 's10' } }
				]
			},
			// s10 = the 10th step in depth-first order (readSpec's ref numbering).
			{ type: 'action', ref: 's10', wait_seconds: 0, weekday_only: false, action: { kind: 'end_all_automations' } },
			{
				type: 'branch',
				wait_seconds: 0,
				weekday_only: false,
				condition: { kind: 'field-eq', name: 'plan', value: 'pro' },
				yes: [{ type: 'action', wait_seconds: 0, weekday_only: false, action: { kind: 'pipeline_remove' } }],
				no: [{ type: 'end', wait_seconds: 0, weekday_only: false }]
			},
			{
				type: 'branch',
				wait_seconds: 0,
				weekday_only: false,
				condition: { kind: 'pipeline-stage', mode: 'in', stage_id: STAGES[0] },
				yes: [],
				no: []
			}
		]
	};
}

describe('whole-flow spec (#345)', () => {
	it('createFromSpec → readSpec gives back the same spec (every step type, nested branches, refs)', async () => {
		const spec = fullSpec();
		expect(walkSpec(spec.steps)[9].step.ref).toBe('s10');
		expect(walkSpec(spec.steps)[0].step.ref).toBe('s1');
		const r = await createFromSpec(db, spec, actor);
		expect(r).toMatchObject({ ok: true });
		if (!r.ok) return;
		const a = await db.prepare('SELECT status, trigger_type, trigger_list_id, reentry FROM automations WHERE id = ?').bind(r.data.automation_id).first();
		expect(a).toEqual({ status: 'draft', trigger_type: 'list_added', trigger_list_id: LIST, reentry: 'multiple' });

		const back = await readSpec(db, r.data.automation_id);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.data).toEqual(spec);

		// The refs resolved to real ids.
		const goto = await db.prepare("SELECT target_step_id FROM automation_steps WHERE action_kind = 'goto_step' AND automation_id = ?").bind(r.data.automation_id).first<{ target_step_id: number }>();
		expect(goto!.target_step_id).toBe(r.data.step_ids.s10);
		const opened = await db.prepare("SELECT gate_ref_id FROM automation_steps WHERE gate_kind = 'opened' AND automation_id = ?").bind(r.data.automation_id).first<{ gate_ref_id: number }>();
		expect(opened!.gate_ref_id).toBe(r.data.step_ids.s1);
		const rules = await db.prepare('SELECT gate_rules FROM automation_steps WHERE gate_rules IS NOT NULL AND automation_id = ?').bind(r.data.automation_id).first<{ gate_rules: string }>();
		expect(JSON.parse(rules!.gate_rules).rules[1]).toEqual({ field: 'step_clicked', op: 'yes', value: String(r.data.step_ids.s1) });

		// Export → re-import → export is stable.
		const again = await createFromSpec(db, back.data, actor);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		const third = await readSpec(db, again.data.automation_id);
		expect(third.ok && third.data).toEqual(back.data);
	});

	it('round-trips every trigger type and a blocks body', async () => {
		const blocks = [{ id: 'p1', type: 'paragraph', content: [{ type: 'text', text: 'Hi there' }] }];
		const triggers = [
			{ type: 'manual' as const },
			{ type: 'company_metric' as const, metric: 'issues_open', direction: 'below' as const, threshold: 3 },
			{ type: 'site_visit' as const, site_id: SITE, path_op: 'equals', path: '/pricing', cooldown_hours: 0 },
			{ type: 'pipeline_stage_entered' as const, stage_id: STAGES[0] }
		];
		for (const trigger of triggers) {
			const r = await createFromSpec(db, { name: trigger.type, trigger, steps: [email('B', { body_md: undefined, body_blocks: blocks })] }, actor);
			expect(r.ok).toBe(true);
			if (!r.ok) continue;
			const back = await readSpec(db, r.data.automation_id);
			if (!back.ok) throw new Error(back.error);
			expect(back.data.trigger).toEqual(trigger);
			expect(back.data.reentry).toBe('once');
			expect(back.data.labels).toEqual([]);
			expect(back.data.steps[0].body_md).toBeUndefined();
			expect(Array.isArray(back.data.steps[0].body_blocks)).toBe(true);
			const row = await db.prepare('SELECT body_md, body_blocks FROM automation_steps WHERE automation_id = ?').bind(r.data.automation_id).first<{ body_md: string; body_blocks: string }>();
			expect(row!.body_md).toContain('Hi there');
			expect(row!.body_blocks).toBeTruthy();
		}
	});

	it('the other legacy conditions read back as written (company-metric, visited, list-member, pipeline any)', async () => {
		const conds = [
			{ kind: 'company-metric' as const, metric: 'hours_30d', op: 'gt', value: 5 },
			{ kind: 'visited' as const, mode: 'event', name: 'booked_call', days: 7 },
			{ kind: 'list-member' as const, list_id: LIST },
			{ kind: 'pipeline-stage' as const, mode: 'none' },
			{ kind: 'no-tag' as const, name: 'cold' },
			{ kind: 'field-contains' as const, name: 'title', value: 'cto' }
		];
		const spec: AutomationSpec = {
			name: 'Conds',
			trigger: { type: 'manual' },
			steps: conds.map((condition) => ({ type: 'branch' as const, wait_seconds: 0, weekday_only: false, condition, yes: [], no: [] }))
		};
		const r = await createFromSpec(db, spec, actor);
		if (!r.ok) throw new Error(r.error);
		const back = await readSpec(db, r.data.automation_id);
		if (!back.ok) throw new Error(back.error);
		expect(back.data.steps.map((s) => s.condition)).toEqual(conds);
	});

	it('validateSpec reports every problem at once, with paths', async () => {
		const spec: AutomationSpec = {
			name: '',
			trigger: { type: 'list_added' },
			labels: ['ok', ''],
			steps: [
				{ type: 'email', subject: '', from_email: 'alan@ourco.example', body_md: 'x' },
				{
					type: 'branch',
					condition: { kind: 'opened', step_ref: 'nope' },
					yes: [{ type: 'tag', tag_name: '' }],
					no: [{ type: 'action', action: { kind: 'goto_step', step_ref: 'missing' } }, { type: 'bogus' as never }]
				},
				{ type: 'tag', tag_name: 'x', yes: [] },
				{ type: 'action', action: { kind: 'enroll_automation', automation_id: 999999 } },
				{ type: 'branch', condition: { kind: 'rules', match: 'all', rules: [] } }
			]
		};
		const problems = await validateSpec(db, spec);
		const at = (path: string) => problems.filter((p) => p.path === path).map((p) => p.message);
		expect(at('name')).toEqual(['Give the automation a name.']);
		expect(at('trigger')).toEqual(['Choose a list/segment for the “added to list” trigger.']);
		expect(at('labels[1]')).toEqual(['Labels are 1–30 characters.']);
		expect(at('steps[0]')).toEqual(['Step subject is required.']);
		expect(at('steps[1]')[0]).toMatch(/No email step has the ref “nope”/);
		expect(at('steps[1].yes[0]')).toEqual(['Choose a tag for this step.']);
		expect(at('steps[1].no[0]')[0]).toMatch(/No step has the ref “missing”/);
		expect(at('steps[1].no[1]')[0]).toMatch(/Unknown step type/);
		expect(at('steps[2]')).toEqual(['Only a branch step or an event / rules wait has yes / no lanes.']);
		expect(at('steps[3]')).toEqual(['That automation no longer exists.']);
		expect(at('steps[4]')).toEqual(['Add at least one rule.']);

		// createFromSpec refuses with the same problems and writes nothing.
		const before = await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>();
		const r = await createFromSpec(db, spec, actor);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.problems).toEqual(problems);
		expect(r.error).toMatch(/^name: Give the automation a name\. \(\+\d+ more\)$/);
		const after = await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>();
		expect(after!.n).toBe(before!.n);
	});

	it('structure checks need no database: duplicate refs, bad refs, nesting', () => {
		const problems = specStructureProblems({
			name: 'x',
			trigger: { type: 'manual' },
			steps: [
				{ type: 'tag', tag_name: 'a', ref: 'r' },
				{ type: 'tag', tag_name: 'b', ref: 'r' },
				{ type: 'tag', tag_name: 'c', ref: 'has space' }
			]
		});
		expect(problems).toEqual([
			{ path: 'steps[1].ref', message: 'The ref “r” is used twice.' },
			{ path: 'steps[2].ref', message: 'A ref is 1–40 letters, digits, - or _.' }
		]);
	});

	it('an email step without from_email takes opts.defaultFrom; an unapproved sender is refused', async () => {
		const ok = await createFromSpec(db, { name: 'F', trigger: { type: 'manual' }, steps: [{ type: 'email', subject: 'S', body_md: 'b' }] }, actor, {
			defaultFrom: 'alan@ourco.example'
		});
		if (!ok.ok) throw new Error(ok.error);
		const row = await db.prepare('SELECT from_email FROM automation_steps WHERE automation_id = ?').bind(ok.data.automation_id).first<{ from_email: string }>();
		expect(row!.from_email).toBe('alan@ourco.example');

		await db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('approved_senders', 'ourco.example')").run();
		const bad = await validateSpec(db, { name: 'G', trigger: { type: 'manual' }, steps: [email('S', { from_email: 'x@evil.test' })] });
		expect(bad).toEqual([{ path: 'steps[0]', message: 'From “x@evil.test” isn\'t an approved Postmark sender (Settings → Approved senders).' }]);
	});
});

describe('single operations (#345)', () => {
	async function fresh(status = 'draft'): Promise<number> {
		const r = await createAutomation(db, { name: 'Ops' }, actor);
		if (!r.ok) throw new Error(r.error);
		if (status !== 'draft') await db.prepare('UPDATE automations SET status = ? WHERE id = ?').bind(status, r.data.automation_id).run();
		return r.data.automation_id;
	}

	it('create, rename, trigger, re-entry, labels', async () => {
		expect(await createAutomation(db, { name: '  ' }, actor)).toEqual({ ok: false, error: 'Give the automation a name.' });
		const id = await fresh();
		expect(await renameAutomation(db, id, { name: '' }, actor)).toEqual({ ok: false, error: 'Name cannot be empty.' });
		expect((await renameAutomation(db, id, { name: 'Renamed' }, actor)).ok).toBe(true);
		expect(await setTrigger(db, id, { type: 'nope' as never }, actor)).toEqual({ ok: false, error: 'Invalid trigger type.' });
		expect((await setTrigger(db, id, { type: 'site_visit', path: '' }, actor)).ok).toBe(false);
		expect((await setTrigger(db, id, { type: 'site_visit', path: '/blog', path_op: 'contains' }, actor)).ok).toBe(true);
		expect((await setReentry(db, id, { reentry: 'twice' }, actor)).ok).toBe(false);
		expect((await setReentry(db, id, { reentry: 'multiple' }, actor)).ok).toBe(true);
		expect(await addLabel(db, id, { label: 'Promo' }, actor)).toEqual({ ok: true, data: { label: 'Promo' } });
		expect((await addLabel(db, id, { label: 'x'.repeat(40) }, actor)).ok).toBe(false);
		const spec = await readSpec(db, id);
		expect(spec.ok && spec.data).toMatchObject({
			name: 'Renamed',
			reentry: 'multiple',
			labels: ['Promo'],
			trigger: { type: 'site_visit', site_id: null, path_op: 'contains', path: '/blog', cooldown_hours: 24 }
		});
		await removeLabel(db, id, { label: 'Promo' }, actor);
		const after = await readSpec(db, id);
		expect(after.ok && after.data.labels).toEqual([]);
		expect(await renameAutomation(db, 999999, { name: 'x' }, actor)).toMatchObject({ ok: false, status: 404 });
	});

	it('addStep at a position in a branch lane, update, move, reorder, duplicate, delete', async () => {
		const id = await fresh();
		const branch = await addStep(db, id, { type: 'branch', fields: { condition: { kind: 'tag', name: 'vip' } } }, actor);
		if (!branch.ok) throw new Error(branch.error);
		const b = branch.data.step_id;
		const t1 = await addStep(db, id, { type: 'tag', parent_step_id: b, branch_label: 'yes', fields: { tag_name: 'one' } }, actor);
		const t2 = await addStep(db, id, { type: 'tag', parent_step_id: b, branch_label: 'yes', position: 0, fields: { tag_name: 'zero' } }, actor);
		const no = await addStep(db, id, { type: 'end', parent_step_id: b, branch_label: 'no' }, actor);
		expect(t1.ok && t2.ok && no.ok).toBe(true);
		let spec = await readSpec(db, id);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps[0].yes!.map((s) => s.tag_name)).toEqual(['zero', 'one']);
		expect(spec.data.steps[0].no!.map((s) => s.type)).toEqual(['end']);

		// A bad configuration leaves no step behind.
		const bad = await addStep(db, id, { type: 'tag', parent_step_id: b, branch_label: 'yes', fields: { tag_name: '' } }, actor);
		expect(bad).toEqual({ ok: false, error: 'Choose a tag for this step.' });
		expect(await addStep(db, id, { type: 'tag', parent_step_id: 999999 }, actor)).toEqual({ ok: false, error: 'Branch not found.' });
		expect((await addStep(db, id, { type: 'tag', position: 5 }, actor)).ok).toBe(false);

		// Update replaces the step's configuration.
		const one = t1.ok ? t1.data.step_id : 0;
		expect((await updateStep(db, id, { step_id: one, fields: { tag_action: 'remove', tag_name: 'uno', wait_seconds: 120, weekday_only: true } }, actor)).ok).toBe(true);
		expect(await updateStep(db, id, { step_id: no.ok ? no.data.step_id : 0, fields: {} }, actor)).toEqual({ ok: false, error: 'End steps have nothing to edit.' });
		expect(await updateStep(db, id, { step_id: 999999, fields: {} }, actor)).toMatchObject({ ok: false, status: 404 });

		// Move within the lane, then reorder it back.
		expect((await moveStep(db, id, { step_id: one, dir: 'up' }, actor)).ok).toBe(true);
		spec = await readSpec(db, id);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps[0].yes!.map((s) => s.tag_name)).toEqual(['uno', 'zero']);
		expect(spec.data.steps[0].yes![0]).toMatchObject({ tag_action: 'remove', wait_seconds: 120, weekday_only: true });
		const zero = t2.ok ? t2.data.step_id : 0;
		expect(await reorderSteps(db, id, { order: [zero], parent_step_id: b, branch_label: 'yes' }, actor)).toEqual({ ok: false, error: 'Invalid step order.' });
		expect((await reorderSteps(db, id, { order: [zero, one], parent_step_id: b, branch_label: 'yes' }, actor)).ok).toBe(true);

		// Duplicate a step (a branch with its lanes is covered in automation-editor-396.test.ts).
		expect((await duplicateStep(db, id, { step_id: zero }, actor)).ok).toBe(true);
		spec = await readSpec(db, id);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps[0].yes!.map((s) => s.tag_name)).toEqual(['zero', 'zero', 'uno']);

		// Deleting the branch takes its subtree.
		const del = await deleteStep(db, id, { step_id: b }, actor);
		expect(del.ok && del.data.deleted.length).toBe(5);
		const left = await db.prepare('SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ?').bind(id).first<{ n: number }>();
		expect(left!.n).toBe(0);
	});

	it('action and condition steps validate targets by real id', async () => {
		const id = await fresh();
		const email1 = await addStep(db, id, { type: 'email', fields: email('Hi') }, actor);
		if (!email1.ok) throw new Error(email1.error);
		const act = await addStep(db, id, { type: 'action', action: { kind: 'enroll_automation', automation_id: id } }, actor);
		expect(act).toEqual({ ok: false, error: "An action can't target its own automation." });
		const go = await addStep(db, id, { type: 'action', fields: { action: { kind: 'goto_step', step_id: email1.data.step_id } } }, actor);
		expect(go.ok).toBe(true);
		if (!go.ok) return;
		expect(await updateStep(db, id, { step_id: go.data.step_id, fields: { action: { kind: 'goto_step', step_id: go.data.step_id } } }, actor)).toEqual({
			ok: false,
			error: "A step can't go to itself."
		});
		expect(await updateStep(db, id, { step_id: go.data.step_id, fields: { action: { kind: 'end_all_automations', automation_id: OTHER } } }, actor)).toEqual({
			ok: false,
			error: "End all other automations can't also target a specific automation."
		});
		expect(await updateStep(db, id, { step_id: go.data.step_id, fields: { action: { kind: 'pipeline_move', stage_id: STAGES[0], only_from_stage_id: STAGES[0] } } }, actor)).toEqual({
			ok: false,
			error: '“Only from” must be a different stage.'
		});
		const br = await addStep(db, id, { type: 'branch' }, actor);
		if (!br.ok) throw new Error(br.error);
		expect(await updateStep(db, id, { step_id: br.data.step_id, fields: { condition: { kind: 'clicked', step_id: 999999 } } }, actor)).toEqual({
			ok: false,
			error: 'That email step no longer exists.'
		});
		expect((await updateStep(db, id, { step_id: br.data.step_id, fields: { condition: { kind: 'clicked', step_id: email1.data.step_id } } }, actor)).ok).toBe(true);
		expect(
			(await updateStep(
				db,
				id,
				{ step_id: br.data.step_id, fields: { condition: { kind: 'rules', match: 'all', rules: [{ field: 'step_opened', op: 'yes', value: String(email1.data.step_id) }] } } },
				actor
			)).ok
		).toBe(true);
		const spec = await readSpec(db, id);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps[0].ref).toBe('s1');
		expect(spec.data.steps[1].action).toEqual({ kind: 'goto_step', step_ref: 's1' });
		expect(spec.data.steps[2].condition).toEqual({ kind: 'rules', match: 'all', rules: [{ field: 'step_opened', op: 'yes', value: 's1' }] });
	});

	it('draftOnly: active refused, paused with contacts mid-flow needs approval, draft and approved pass', async () => {
		const active = await fresh('active');
		const r1 = await renameAutomation(db, active, { name: 'x' }, actor, { draftOnly: true });
		expect(r1).toMatchObject({ ok: false, status: 409 });
		expect((await renameAutomation(db, active, { name: 'x' }, actor, { draftOnly: false })).ok).toBe(true);

		const paused = await fresh('paused');
		const step = await addStep(db, paused, { type: 'tag', fields: { tag_name: 't' } }, actor, { draftOnly: true });
		expect(step.ok).toBe(true); // nobody mid-flow
		if (!step.ok) return;
		const c = await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('mid@x.test', 1) RETURNING id").first<{ id: number }>();
		await db
			.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, next_run_at, status) VALUES (?, ?, ?, datetime('now'), 'active')")
			.bind(paused, c!.id, step.data.step_id)
			.run();
		const r2 = await updateStep(db, paused, { step_id: step.data.step_id, fields: { tag_name: 'changed' } }, actor, { draftOnly: true });
		expect(r2).toMatchObject({ ok: false, needsApproval: true, activeEnrollments: 1 });
		const unchanged = await db.prepare('SELECT tag_name FROM automation_steps WHERE id = ?').bind(step.data.step_id).first<{ tag_name: string }>();
		expect(unchanged!.tag_name).toBe('t');
		const r3 = await updateStep(db, paused, { step_id: step.data.step_id, fields: { tag_name: 'changed' } }, actor, { draftOnly: true, approved: true });
		expect(r3.ok).toBe(true);

		const draft = await fresh('draft');
		expect((await setTrigger(db, draft, { type: 'manual' }, actor, { draftOnly: true })).ok).toBe(true);
	});
});

// Structural (in the style of tests/ai-no-send.test.ts): the write layer never reaches the
// engine, a send or an activation check — not even through what it imports.
const sources = import.meta.glob('../src/lib/server/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('structural: automation-write.ts never enrolls, sends or activates', () => {
	const entry = '../src/lib/server/automation-write.ts';
	const BANNED_MODULES = ['automations', 'send', 'postmark', 'scheduled', 'resend', 'automation-bulk', 'best-time'];
	const BANNED_NAMES = /\b(enroll\w*|autoEnroll\w*|addTagAndEnroll|sendCampaignEmail|sendBatch|activationProblem|tick)\b/;

	function serverModule(from: string, spec: string): string {
		let path: string;
		if (spec.startsWith('$lib/')) path = `../src/lib/${spec.slice(5)}`;
		else if (spec.startsWith('.')) {
			const parts = from.split('/').slice(0, -1);
			for (const seg of spec.split('/')) {
				if (seg === '..') parts.pop();
				else if (seg !== '.') parts.push(seg);
			}
			path = parts.join('/');
		} else return '';
		path = path.replace(/\.ts$/, '');
		return path.startsWith('../src/lib/server/') ? path.slice('../src/lib/server/'.length) : '';
	}

	it('imports none of them, directly or transitively', () => {
		expect(Object.keys(sources)).toContain(entry);
		const seen = new Set<string>();
		const offenders: string[] = [];
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			const text = sources[file] ?? '';
			for (const m of text.matchAll(/(?:import|export)\s([^;]*?)\sfrom\s+['"]([^'"]+)['"]/g)) {
				const [, names, spec] = m;
				const mod = serverModule(file, spec);
				if (/^type\s/.test(names.trim())) continue;
				if (file === entry && BANNED_NAMES.test(names)) offenders.push(`${file} imports { ${names.trim()} }`);
				if (!mod) continue;
				if (BANNED_MODULES.includes(mod)) offenders.push(`${file} → ${mod}`);
				if (sources[`../src/lib/server/${mod}.ts`]) walk(`../src/lib/server/${mod}.ts`);
			}
		};
		walk(entry);
		expect(offenders).toEqual([]);
		expect(seen.has('../src/lib/server/automation-tree.ts')).toBe(true); // not vacuous
		// And it never writes a status or creates an enrollment.
		const text = sources[entry];
		expect(text).not.toMatch(/SET\s+status\s*=\s*'active'|INSERT INTO automation_enrollments/);
		for (const m of text.matchAll(/INSERT INTO automations\b[\s\S]*?`/g)) expect(m[0]).toMatch(/'draft'/);
	});

	it('the checker catches a banned import (sanity)', () => {
		expect(serverModule(entry, './automations')).toBe('automations');
		expect(BANNED_NAMES.test('{ enroll, nextStep }')).toBe(true);
		expect(BANNED_NAMES.test('{ activationProblem }')).toBe(true);
		expect(BANNED_NAMES.test('{ nextStep, weekdayDueUtc }')).toBe(false);
	});
});
