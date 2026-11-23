// #207: pipeline in automations — the pipeline_move / pipeline_remove action steps (actor
// automation:<id>), the "enters a pipeline stage" trigger (fires once, never for the
// automation's own moves), the pipeline-stage branch condition, plus the dashboard feed
// rows and tile that surface it. No sends, so cfg.token is a dummy (like action-steps.test.ts).
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick } from '../src/lib/server/automations';
import { addToPipeline, moveCard, removeFromPipeline, type Actor } from '../src/lib/server/pipeline';
import { recentActivity } from '../src/lib/server/activity';
import { loadPipelineTile } from '../src/lib/server/dashboard';
import { historyByText, historyMoveText } from '../src/lib/pipeline';
import { pipelineActionTitle } from '../src/lib/automation-action-labels';
import { actions } from '../src/routes/automations/[id]/+page.server';

const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };
const user: Actor = { kind: 'user', id: 1 };

let S: Record<string, number> = {};

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('UPDATE automation_steps SET target_automation_id = NULL, target_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM pipeline_stages'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(
			`INSERT INTO pipeline_stages (name, color, position, kind) VALUES
			 ('Lead','muted',0,'open'),('Qualified','viz-3',1,'open'),('Proposal','viz-2',2,'open'),
			 ('Negotiation','viz-1',3,'open'),('Won','success',4,'won'),('Lost','danger',5,'lost')`
		)
	]);
	const rows = await db.prepare('SELECT id, name FROM pipeline_stages').all<{ id: number; name: string }>();
	S = Object.fromEntries(rows.results.map((r) => [r.name, r.id]));
});

async function makeAutomation(
	name: string,
	opts: { status?: string; reentry?: string; triggerStage?: number | null } = {}
): Promise<number> {
	const { status = 'active', reentry = 'once', triggerStage = null } = opts;
	const a = await db
		.prepare(
			`INSERT INTO automations (name, status, reentry, trigger_type, trigger_stage_id)
			 VALUES (?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(name, status, reentry, triggerStage ? 'pipeline_stage_entered' : 'manual', triggerStage)
		.first<{ id: number }>();
	return a!.id;
}

async function pipelineStep(
	aid: number,
	position: number,
	kind: 'pipeline_move' | 'pipeline_remove',
	stageId: number | null,
	opts: { onlyFrom?: number | null; delay?: number } = {}
): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, action_kind, target_stage_id, only_from_stage_id)
			 VALUES (?, ?, ?, '', '', '', 'action', ?, ?, ?) RETURNING id`
		)
		.bind(aid, position, opts.delay ?? 0, kind, stageId, opts.onlyFrom ?? null)
		.first<{ id: number }>();
	return s!.id;
}

async function tagStep(aid: number, position: number, tagName: string, parent: number | null = null, label: string | null = null) {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name, parent_step_id, branch_label)
			 VALUES (?, ?, 0, '', '', '', 'tag', 'add', ?, ?, ?) RETURNING id`
		)
		.bind(aid, position, tagName, parent, label)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string, name: string | null = null): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email, name) VALUES (?, ?) RETURNING id').bind(email, name).first<{ id: number }>();
	return c!.id;
}

async function stageOf(contactId: number): Promise<number | null> {
	const r = await db.prepare('SELECT stage_id FROM pipeline_cards WHERE contact_id = ?').bind(contactId).first<{ stage_id: number }>();
	return r?.stage_id ?? null;
}

async function lastHistory(contactId: number) {
	return db
		.prepare('SELECT from_stage_id, to_stage_id, actor_kind, actor_id FROM pipeline_history WHERE contact_id = ? ORDER BY id DESC LIMIT 1')
		.bind(contactId)
		.first<{ from_stage_id: number | null; to_stage_id: number | null; actor_kind: string; actor_id: number | null }>();
}

async function label(stepId: number): Promise<string | undefined> {
	return (await db.prepare('SELECT label FROM automation_branch_hits WHERE step_id = ?').bind(stepId).first<{ label: string }>())?.label;
}

async function passes(aid: number, cid: number): Promise<{ id: number; status: string; next_run_at: string | null }[]> {
	const r = await db
		.prepare('SELECT id, status, next_run_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id')
		.bind(aid, cid)
		.all<{ id: number; status: string; next_run_at: string | null }>();
	return r.results;
}

function actionEvent(automationId: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env },
		params: { id: String(automationId) },
		request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
	} as any;
}

describe('pipeline action steps (#207)', () => {
	it('pipeline_move adds a contact who is not on the board, as automation:<id>', async () => {
		const A = await makeAutomation('Nurture');
		const step = await pipelineStep(A, 0, 'pipeline_move', S.Proposal);
		const c = await makeContact('add@x.example.net');
		await enroll(db, A, [c]);

		const summary = await tick(db, cfg);
		expect(summary.actions.pipeline).toBe(1);
		expect(await stageOf(c)).toBe(S.Proposal);
		expect(await lastHistory(c)).toEqual({ from_stage_id: null, to_stage_id: S.Proposal, actor_kind: 'automation', actor_id: A });
		expect(await label(step)).toBe('added to «Proposal»');
		expect((await passes(A, c))[0].status).toBe('completed');
	});

	it('pipeline_move moves an existing card and writes history with the automation as actor', async () => {
		const A = await makeAutomation('Mover');
		const step = await pipelineStep(A, 0, 'pipeline_move', S.Proposal);
		const c = await makeContact('move@x.example.net');
		await addToPipeline(db, c, S.Lead, user);
		await enroll(db, A, [c]);
		await tick(db, cfg);

		expect(await stageOf(c)).toBe(S.Proposal);
		expect(await lastHistory(c)).toEqual({ from_stage_id: S.Lead, to_stage_id: S.Proposal, actor_kind: 'automation', actor_id: A });
		expect(await label(step)).toBe('moved to «Proposal»');
	});

	it('only_from skips a card in another stage (or off the board); already-there and deleted stages skip too', async () => {
		const A = await makeAutomation('Guarded');
		const guarded = await pipelineStep(A, 0, 'pipeline_move', S.Proposal, { onlyFrom: S.Qualified });
		const inLead = await makeContact('lead@x.example.net');
		const offBoard = await makeContact('off@x.example.net');
		const inQualified = await makeContact('q@x.example.net');
		await addToPipeline(db, inLead, S.Lead, user);
		await addToPipeline(db, inQualified, S.Qualified, user);
		await enroll(db, A, [inLead, offBoard, inQualified]);
		const summary = await tick(db, cfg);

		expect(await stageOf(inLead)).toBe(S.Lead);
		expect(await stageOf(offBoard)).toBeNull();
		expect(await stageOf(inQualified)).toBe(S.Proposal);
		expect(summary.actions.pipeline).toBe(1);
		expect(summary.actions.skipped).toBe(2);
		const labels = await db
			.prepare('SELECT label FROM automation_branch_hits WHERE step_id = ? ORDER BY label')
			.bind(guarded)
			.all<{ label: string }>();
		expect(labels.results.map((r) => r.label)).toEqual(['moved to «Proposal»', 'skipped: not in «Qualified»', 'skipped: not in «Qualified»']);

		const B = await makeAutomation('Already');
		const already = await pipelineStep(B, 0, 'pipeline_move', S.Proposal);
		const C = await makeAutomation('Gone');
		const gone = await pipelineStep(C, 0, 'pipeline_move', 999999);
		await enroll(db, B, [inQualified]);
		await enroll(db, C, [inQualified]);
		await tick(db, cfg);
		expect(await label(already)).toBe('skipped: already in «Proposal»');
		expect(await label(gone)).toBe('skipped: deleted stage');
		expect(await stageOf(inQualified)).toBe(S.Proposal);
	});

	it('pipeline_remove takes the card off the board; a contact not on it is skipped', async () => {
		const A = await makeAutomation('Remover');
		const step = await pipelineStep(A, 0, 'pipeline_remove', null);
		const on = await makeContact('on@x.example.net');
		await addToPipeline(db, on, S.Negotiation, user);
		await enroll(db, A, [on]);
		await tick(db, cfg);
		expect(await stageOf(on)).toBeNull();
		expect(await lastHistory(on)).toEqual({ from_stage_id: S.Negotiation, to_stage_id: null, actor_kind: 'automation', actor_id: A });
		expect(await label(step)).toBe('removed from pipeline');

		const B = await makeAutomation('Remover2');
		const step2 = await pipelineStep(B, 0, 'pipeline_remove', null);
		const off = await makeContact('off2@x.example.net');
		await enroll(db, B, [off]);
		await tick(db, cfg);
		expect(await label(step2)).toBe('skipped: not in pipeline');
	});
});

describe('pipeline_stage_entered trigger (#207)', () => {
	it('fires on add and on a move into the stage — once, honouring re-entry', async () => {
		const T = await makeAutomation('Qualified flow', { triggerStage: S.Qualified });
		await tagStep(T, 0, 'qualified');
		const a = await makeContact('t1@x.example.net');
		const b = await makeContact('t2@x.example.net');

		await addToPipeline(db, a, S.Qualified, user); // add straight into the stage
		await addToPipeline(db, b, S.Lead, user); // another stage — nothing
		expect(await passes(T, a)).toHaveLength(1);
		expect(await passes(T, b)).toHaveLength(0);

		await moveCard(db, b, S.Qualified, user);
		expect(await passes(T, b)).toHaveLength(1);

		// A same-column reorder isn't an entry; leaving and re-entering is blocked by 'once'.
		await moveCard(db, b, S.Qualified, user, { position: 0 });
		await tick(db, cfg); // completes both passes
		await moveCard(db, b, S.Lead, user);
		await moveCard(db, b, S.Qualified, user);
		expect(await passes(T, b)).toHaveLength(1);
	});

	it('re-entry multiple lets a later entry start a new pass; paused automations never fire', async () => {
		const T = await makeAutomation('Multi', { triggerStage: S.Qualified, reentry: 'multiple' });
		await tagStep(T, 0, 'multi');
		const P = await makeAutomation('Paused', { triggerStage: S.Qualified, status: 'paused' });
		await tagStep(P, 0, 'paused');
		const c = await makeContact('multi@x.example.net');

		await addToPipeline(db, c, S.Qualified, user);
		await tick(db, cfg);
		await moveCard(db, c, S.Lead, user);
		await moveCard(db, c, S.Qualified, user);
		expect(await passes(T, c)).toHaveLength(2);
		expect(await passes(P, c)).toHaveLength(0);
	});

	it("never fires for the automation's own moves, but does for other actors", async () => {
		const T = await makeAutomation('Self', { triggerStage: S.Proposal, reentry: 'multiple' });
		await tagStep(T, 0, 'self');
		const c = await makeContact('self@x.example.net');
		await addToPipeline(db, c, S.Lead, user);

		await moveCard(db, c, S.Proposal, { kind: 'automation', id: T });
		expect(await passes(T, c)).toHaveLength(0);

		await moveCard(db, c, S.Lead, user);
		await moveCard(db, c, S.Proposal, { kind: 'api', id: 7 });
		expect(await passes(T, c)).toHaveLength(1);
	});

	it('a move by another automation triggers this one (picked up on the next tick)', async () => {
		const T = await makeAutomation('Watcher', { triggerStage: S.Proposal });
		await tagStep(T, 0, 'watched');
		const M = await makeAutomation('Mover');
		await pipelineStep(M, 0, 'pipeline_move', S.Proposal);
		const c = await makeContact('chain@x.example.net');
		await enroll(db, M, [c]);
		await tick(db, cfg);
		expect(await stageOf(c)).toBe(S.Proposal);
		expect((await passes(T, c)).map((p) => p.status)).toEqual(['active']);
	});

	it('acceptance: enters Qualified → wait 1 day → move to Proposal; the tick moves the dragged card', async () => {
		const T = await makeAutomation('Nurture', { triggerStage: S.Qualified });
		await pipelineStep(T, 0, 'pipeline_move', S.Proposal, { delay: 86400 });
		const c = await makeContact('ann@x.example.net', 'Ann Lee');
		await addToPipeline(db, c, S.Lead, user);
		await moveCard(db, c, S.Qualified, user); // the drag

		const [pass] = await passes(T, c);
		expect(pass.status).toBe('active');
		await tick(db, cfg);
		expect(await stageOf(c)).toBe(S.Qualified); // not due for a day

		await db.prepare("UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE id = ?").bind(pass.id).run();
		await tick(db, cfg);
		expect(await stageOf(c)).toBe(S.Proposal);
		expect((await passes(T, c)).map((p) => p.status)).toEqual(['completed']);

		// Dashboard feed: newest first — the automation's move, then the drag, then the add.
		const feed = await recentActivity(db, { types: ['pipeline'], limit: 10 });
		expect(feed.map((f) => [f.pipeline_action, f.detail, f.actor_kind])).toEqual([
			['moved', 'Proposal', 'automation'],
			['moved', 'Qualified', 'user'],
			['added', 'Lead', 'user']
		]);
		expect(feed[0]).toMatchObject({ type: 'pipeline', contact_id: c, name: 'Ann Lee', automation_id: T, automation_name: 'Nurture', pipeline_from: 'Qualified' });

		const tile = await loadPipelineTile(db);
		expect(tile.open_count).toBe(1);
	});
});

describe('pipeline-stage branch condition (#207)', () => {
	async function branchFlow(name: string, mode: string, ref: number | null) {
		const A = await makeAutomation(name);
		const br = await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, gate_kind, gate_value, gate_ref_id)
				 VALUES (?, 0, 0, '', '', '', 'branch', 'pipeline-stage', ?, ?) RETURNING id`
			)
			.bind(A, mode, ref)
			.first<{ id: number }>();
		await tagStep(A, 0, `${name}-yes`, br!.id, 'yes');
		await tagStep(A, 0, `${name}-no`, br!.id, 'no');
		return { A, branch: br!.id };
	}
	async function decision(branch: number, cid: number, A: number) {
		const [p] = await passes(A, cid);
		return (
			await db.prepare('SELECT label FROM automation_branch_hits WHERE step_id = ? AND enrollment_id = ?').bind(branch, p.id).first<{ label: string }>()
		)?.label;
	}

	it('routes "is in stage", "any stage" and "not in pipeline"; misconfigured goes NO (#395)', async () => {
		const inProp = await makeContact('in@x.example.net');
		const inLead = await makeContact('lead2@x.example.net');
		const off = await makeContact('off3@x.example.net');
		await addToPipeline(db, inProp, S.Proposal, user);
		await addToPipeline(db, inLead, S.Lead, user);

		const isIn = await branchFlow('isin', 'in', S.Proposal);
		const any = await branchFlow('any', 'any', null);
		const none = await branchFlow('none', 'none', null);
		const bad = await branchFlow('bad', 'in', null);
		for (const f of [isIn, any, none, bad]) await enroll(db, f.A, [inProp, inLead, off]);
		await tick(db, cfg);

		expect([await decision(isIn.branch, inProp, isIn.A), await decision(isIn.branch, inLead, isIn.A), await decision(isIn.branch, off, isIn.A)]).toEqual(['yes', 'no', 'no']);
		expect([await decision(any.branch, inProp, any.A), await decision(any.branch, inLead, any.A), await decision(any.branch, off, any.A)]).toEqual(['yes', 'yes', 'no']);
		expect([await decision(none.branch, inProp, none.A), await decision(none.branch, inLead, none.A), await decision(none.branch, off, none.A)]).toEqual(['no', 'no', 'yes']);
		expect(await decision(bad.branch, off, bad.A)).toBe('no');
		// #288: four flows × three contacts in one tick; went past 30s under a loaded parallel run.
	}, 60_000);
});

describe('builder actions (#207)', () => {
	it('setTrigger needs a real stage for pipeline_stage_entered', async () => {
		const A = await makeAutomation('Trig');
		const bad: any = await actions.setTrigger(actionEvent(A, { trigger_type: 'pipeline_stage_entered', trigger_stage_id: '' }));
		expect(bad?.status).toBe(400);
		await actions.setTrigger(actionEvent(A, { trigger_type: 'pipeline_stage_entered', trigger_stage_id: String(S.Won) }));
		const row = await db.prepare('SELECT trigger_type, trigger_stage_id FROM automations WHERE id = ?').bind(A).first();
		expect(row).toEqual({ trigger_type: 'pipeline_stage_entered', trigger_stage_id: S.Won });
		// Switching to another trigger clears the stage.
		await actions.setTrigger(actionEvent(A, { trigger_type: 'manual' }));
		expect((await db.prepare('SELECT trigger_stage_id FROM automations WHERE id = ?').bind(A).first())?.trigger_stage_id).toBeNull();
	});

	it('updateStep saves a pipeline move (validating the stages) and a pipeline-stage condition', async () => {
		const A = await makeAutomation('Steps');
		const step = await pipelineStep(A, 0, 'pipeline_remove', null);
		const base = { step_id: String(step), delay_value: '1', delay_unit: 'days' };

		const noStage: any = await actions.updateStep(actionEvent(A, { ...base, action_kind: 'pipeline_move', target_stage_id: '' }));
		expect(noStage?.status).toBe(400);
		const same: any = await actions.updateStep(
			actionEvent(A, { ...base, action_kind: 'pipeline_move', target_stage_id: String(S.Proposal), only_from_stage_id: String(S.Proposal) })
		);
		expect(same?.status).toBe(400);
		await actions.updateStep(
			actionEvent(A, { ...base, action_kind: 'pipeline_move', target_stage_id: String(S.Proposal), only_from_stage_id: String(S.Qualified) })
		);
		const saved = await db
			.prepare('SELECT action_kind, target_stage_id, only_from_stage_id, delay_before_seconds FROM automation_steps WHERE id = ?')
			.bind(step)
			.first();
		expect(saved).toEqual({ action_kind: 'pipeline_move', target_stage_id: S.Proposal, only_from_stage_id: S.Qualified, delay_before_seconds: 86400 });

		const br = await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, gate_kind)
				 VALUES (?, 1, 0, '', '', '', 'branch', 'tag') RETURNING id`
			)
			.bind(A)
			.first<{ id: number }>();
		const cond = { step_id: String(br!.id), delay_value: '0', delay_unit: 'days', gate_kind: 'pipeline-stage' };
		const missing: any = await actions.updateStep(actionEvent(A, { ...cond, pipeline_mode: 'in', gate_ref_id: '' }));
		expect(missing?.status).toBe(400);
		await actions.updateStep(actionEvent(A, { ...cond, pipeline_mode: 'none' }));
		expect(await db.prepare('SELECT gate_kind, gate_value, gate_ref_id FROM automation_steps WHERE id = ?').bind(br!.id).first()).toEqual({
			gate_kind: 'pipeline-stage',
			gate_value: 'none',
			gate_ref_id: null
		});
	});
});

describe('history wording (#207)', () => {
	it('labels moves, a stage-deletion system row, and actors', () => {
		const h = (o: Partial<Parameters<typeof historyMoveText>[0]>) => ({
			from_stage_id: 1,
			to_stage_id: 2,
			from_name: 'Lead',
			to_name: 'Qualified',
			actor_kind: 'user',
			actor_label: '@alan',
			...o
		});
		expect(historyMoveText(h({}))).toBe('Lead → Qualified');
		expect(historyMoveText(h({ from_stage_id: null, from_name: null }))).toBe('Added to Qualified');
		expect(historyMoveText(h({ to_stage_id: null, to_name: null }))).toBe('Removed from Lead');
		expect(historyMoveText(h({ from_stage_id: 2, from_name: 'Qualified' }))).toBe('Moved to Qualified');
		expect(historyByText(h({}))).toBe('by @alan');
		expect(historyByText(h({ actor_kind: 'automation', actor_label: 'Nurture' }))).toBe('by automation “Nurture”');
		expect(historyByText(h({ actor_kind: 'system', actor_label: null }))).toBe('system');
		expect(pipelineActionTitle('pipeline_move', 'Proposal')).toBe('Move to pipeline stage: Proposal');
		expect(pipelineActionTitle('pipeline_move', 'Proposal', 'Qualified', true)).toBe('Move to pipeline stage: Proposal · only from Qualified');
		expect(pipelineActionTitle('pipeline_remove', null)).toBe('Remove from pipeline');
	});

	it('removeFromPipeline + feed: a removal reads as removed, from the old stage', async () => {
		const c = await makeContact('rm@x.example.net');
		await addToPipeline(db, c, S.Won, user);
		await removeFromPipeline(db, c, user);
		const [row] = await recentActivity(db, { types: ['pipeline'], limit: 1 });
		expect(row).toMatchObject({ pipeline_action: 'removed', pipeline_from: 'Won', detail: null });
	});
});
