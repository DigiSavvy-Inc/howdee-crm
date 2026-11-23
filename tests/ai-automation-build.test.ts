import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, resolvePending, undoAction } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { listSkills } from '../src/lib/server/ai/skills';
import { modelInfo } from '../src/lib/ai-models';
import { humanPath } from '../src/lib/server/ai/tools/automation-input';

// #346: the assistant builds complete automations from a whole-flow spec (build_automation,
// Approve first, an outline on the card), and edits any step type / lane of a draft or
// paused one through the #345 write layer. Never activates, enrolls or sends.

const db = (env as any).DB as D1Database;
const T = `b${Date.now()}`;
const sonnet = modelInfo('claude-sonnet-5-5')!;
const FROM = 'alan@ourco.example';

type U = { id: number; github_login: string; role: 'admin' | 'member' };
let member: U;
let seq = 0;

function sessionUser(u: U) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}

async function newId(sql: string, ...binds: unknown[]): Promise<number> {
	return (await one<{ id: number }>(sql, ...binds)).id;
}

async function freshCtx(): Promise<ToolContext> {
	const threadId = await createThread(db, member.id, sonnet.id, 'medium', 'test');
	return { db, user: sessionUser(member), baseUrl: 'https://app.test', now: new Date(), threadId };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
	return runTool(ctx, name, input, TOOLS, `tu_${++seq}`);
}

async function undo(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return undoAction(ctx, row!, toolByName(row!.tool) as WriteTool);
}

async function approve(ctx: ToolContext, id: number) {
	const row = await actionForUser(db, id, ctx.user.id);
	return resolvePending(ctx, row!, 'approve', toolByName(row!.tool) as WriteTool);
}

type StepRow = { id: number; type: string; parent_step_id: number | null; branch_label: string | null; position: number; subject: string; tag_name: string | null; gate_kind: string | null; gate_ref_id: number | null; delay_before_seconds: number; weekday_only: number; action_kind: string | null; target_step_id: number | null; target_stage_id: number | null };

async function stepsOf(id: number): Promise<StepRow[]> {
	return (await db.prepare('SELECT * FROM automation_steps WHERE automation_id = ? ORDER BY parent_step_id IS NOT NULL, parent_step_id, branch_label, position').bind(id).all<StepRow>()).results;
}

const count = async (sql: string, ...binds: unknown[]) => (await one<{ n: number }>(sql, ...binds)).n;

let callBooked: number;
let stage: number;

beforeAll(async () => {
	member = { id: await newId(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-m`), github_login: `${T}-m`, role: 'member' };
	callBooked = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, `Booked call ${T}`);
	stage = await newId(`INSERT INTO pipeline_stages (name, color, position, kind) VALUES (?, 'viz-1', 90, 'open') RETURNING id`, `Discovery ${T}`);
});

/** "When someone books a call, wait a day, send X; if they opened it tag hot, else send Y after 3 days…" */
function bookedSpec(name: string) {
	return {
		name,
		trigger: { type: 'list_added', list: `booked call ${T}` }, // by name, any case
		reentry: 'once',
		labels: ['sales'],
		steps: [
			{ type: 'email', ref: 'confirm', wait_days: 1, weekday_only: true, subject: 'Before our call', body_markdown: 'Hi {{first_name}}, a few questions before we talk.', from_email: FROM },
			{
				type: 'branch',
				wait_days: 2,
				condition: { kind: 'opened', step_ref: 'confirm' },
				yes: [
					{ type: 'tag', tag_name: `hot-${T}` },
					{
						type: 'branch',
						condition: { kind: 'pipeline-stage', mode: 'in', stage: `discovery ${T}` },
						yes: [{ type: 'action', action: { kind: 'pipeline_move', stage: `Discovery ${T}` } }],
						no: [{ type: 'end' }]
					}
				],
				no: [{ type: 'email', wait_days: 3, subject: 'Still keen?', body_markdown: 'Just checking in.', from_email: FROM }]
			},
			{ type: 'tag', tag_name: `nurtured-${T}` }
		]
	};
}

describe('build_automation', () => {
	it('shows the outline and waits for Approve; nothing is stored until then', async () => {
		const ctx = await freshCtx();
		const before = await count('SELECT COUNT(*) AS n FROM automations');
		const r = await call(ctx, 'build_automation', bookedSpec(`Booked ${T} a`));
		expect(r.pending).toBe(true);
		expect(r.action).toMatchObject({ tool: 'build_automation', status: 'pending', icon: 'automations' });
		expect(r.action!.summary).toMatch(/Build draft automation “Booked .* a” · 8 steps · 2 emails/);
		const notes = r.action!.scope!.notes!;
		expect(notes[0]).toMatch(/^Trigger: When added to tag “Booked call/);
		expect(notes).toContain('1. Wait 1 day (weekdays) → Email “Before our call”');
		expect(notes.some((n) => /^2\. Wait 2 days → If opened «1\. Email “Before our call”»\?$/.test(n))).toBe(true);
		expect(notes).toContain('    3. Add tag “hot-' + T + '”');
		expect(notes.some((n) => /^ {8}5\. Move to pipeline stage “Discovery/.test(n))).toBe(true);
		expect(notes).toContain('    7. Wait 3 days → Email “Still keen?”'); // numbered depth-first: YES lane, then NO lane
		expect(notes.some((n) => /New tags \(created on Approve\): .*hot-/.test(n))).toBe(true);
		expect(notes[notes.length - 1]).toBe('Review and activate it in Automations.');
		expect(await count('SELECT COUNT(*) AS n FROM automations')).toBe(before);
		expect(await count("SELECT COUNT(*) AS n FROM lists WHERE kind = 'tag' AND name = ?", `hot-${T}`)).toBe(0);
	});

	it('Approve creates a draft with nested branches, refs fixed up, tags created; nobody enrolled', async () => {
		const ctx = await freshCtx();
		const r = await call(ctx, 'build_automation', bookedSpec(`Booked ${T} b`));
		const done = await approve(ctx, r.action!.id);
		expect(done).toMatchObject({ ok: true, card: { status: 'approved' } });
		if (!done.ok) return;
		expect(done.card.url).toMatch(/\/automations\/\d+$/);
		expect(done.card.notes!.at(-1)).toBe('Review and activate it in Automations.');
		const result = JSON.parse(done.result.content as string);
		const id = result.automation_id as number;
		expect(await one<any>('SELECT status, trigger_type, trigger_list_id, reentry FROM automations WHERE id = ?', id)).toMatchObject({
			status: 'draft',
			trigger_type: 'list_added',
			trigger_list_id: callBooked,
			reentry: 'once'
		});
		const steps = await stepsOf(id);
		expect(steps).toHaveLength(8);
		const trunk = steps.filter((s) => s.parent_step_id === null);
		expect(trunk.map((s) => s.type)).toEqual(['email', 'branch', 'tag']);
		expect(trunk[0]).toMatchObject({ delay_before_seconds: 86400, weekday_only: 1 });
		expect(trunk[1]).toMatchObject({ gate_kind: 'opened', gate_ref_id: trunk[0].id });
		const inner = steps.find((s) => s.type === 'branch' && s.parent_step_id === trunk[1].id)!;
		expect(inner).toMatchObject({ branch_label: 'yes', gate_kind: 'pipeline-stage', gate_ref_id: stage });
		expect(steps.find((s) => s.type === 'action')).toMatchObject({ parent_step_id: inner.id, branch_label: 'yes', action_kind: 'pipeline_move', target_stage_id: stage });
		expect(steps.find((s) => s.type === 'end')).toMatchObject({ parent_step_id: inner.id, branch_label: 'no' });
		expect(steps.find((s) => s.subject === 'Still keen?')).toMatchObject({ parent_step_id: trunk[1].id, branch_label: 'no', delay_before_seconds: 3 * 86400 });
		expect(await count("SELECT COUNT(*) AS n FROM lists WHERE kind = 'tag' AND name = ?", `hot-${T}`)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM automation_labels WHERE automation_id = ?', id)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', id)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM campaigns WHERE automation_id = ?', id)).toBe(0);

		// get_automation_spec reads it back in the same format, with every step's real id.
		const spec = await call(ctx, 'get_automation_spec', { automation_id: id });
		expect(spec.ok).toBe(true);
		const v = JSON.parse(spec.content);
		expect(v.spec.trigger).toEqual({ type: 'list_added', list_id: callBooked });
		expect(v.spec.steps[1].yes[1].yes[0].action).toMatchObject({ kind: 'pipeline_move', stage_id: stage });
		expect(v.spec.steps[0].body_md).toContain('a few questions');
		expect(v.steps.map((s: any) => s.step_id).sort()).toEqual(steps.map((s) => s.id).sort());
		expect(v.steps.find((s: any) => s.path === 'steps[1].no[0]').step_id).toBe(steps.find((s) => s.subject === 'Still keen?')!.id);
	});

	it('returns every problem so the model can fix the spec; nothing is stored', async () => {
		const ctx = await freshCtx();
		const before = await count('SELECT COUNT(*) AS n FROM automations');
		const r = await call(ctx, 'build_automation', {
			name: `Broken ${T}`,
			trigger: { type: 'list_added', list: `no such list ${T}` },
			steps: [
				{ type: 'email', subject: 'No body', from_email: FROM },
				{ type: 'branch', condition: { kind: 'clicked', step_ref: 'nope' }, yes: [{ type: 'tag' }] },
				{ type: 'action', action: { kind: 'enroll_automation', automation: `Missing ${T}` } }
			]
		});
		expect(r.ok).toBe(false);
		expect(r.pending).toBeUndefined();
		expect(r.action).toBeUndefined();
		expect(r.content).toMatch(/Nothing was saved/);
		expect(r.content).toMatch(/Trigger\.list: No list, segment or tag named “no such list/);
		expect(r.content).toMatch(/Step 1 \(steps\[0\]\): Step body is empty/);
		expect(r.content).toMatch(/Step 2 \(steps\[1\]\): No email step has the ref “nope”/);
		expect(r.content).toMatch(/Step 2 › YES step 1 \(steps\[1\]\.yes\[0\]\): Choose a tag/);
		expect(r.content).toMatch(/Step 3 .*No automation named “Missing/);
		expect(await count('SELECT COUNT(*) AS n FROM automations')).toBe(before);
		expect(humanPath('steps[2].no[1].condition')).toBe('Step 3 › NO step 2');
	});

	it('an ambiguous name returns the candidates', async () => {
		const ctx = await freshCtx();
		const a = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `Leads ${T}`);
		const b = await newId(`INSERT INTO lists (name, kind) VALUES (?, 'segment') RETURNING id`, `leads ${T}`);
		const r = await call(ctx, 'build_automation', {
			name: `Amb ${T}`,
			trigger: { type: 'list_added', list: `LEADS ${T}` },
			steps: [{ type: 'tag', tag_name: 'x' }]
		});
		expect(r.ok).toBe(false);
		expect(r.content).toMatch(/matches several/);
		expect(r.content).toContain(`(list #${a})`);
		expect(r.content).toContain(`(segment #${b})`);
		// The id settles it.
		const ok = await call(ctx, 'build_automation', { name: `Amb ${T}`, trigger: { type: 'list_added', list_id: b }, steps: [{ type: 'tag', tag_name: 'x' }] });
		expect(ok.pending).toBe(true);
	});

	it('Undo deletes the untouched draft (and the tags it created); refuses once used, edited or activated', async () => {
		const ctx = await freshCtx();
		const build = async (n: string) => {
			const r = await call(ctx, 'build_automation', bookedSpec(n));
			const done = await approve(ctx, r.action!.id);
			if (!done.ok) throw new Error('approve failed');
			return { actionId: r.action!.id, id: JSON.parse(done.result.content as string).automation_id as number };
		};
		const fresh = await build(`Undo ${T} 1`);
		expect(await undo(ctx, fresh.actionId)).toMatchObject({ ok: true });
		expect(await db.prepare('SELECT id FROM automations WHERE id = ?').bind(fresh.id).first()).toBeNull();
		expect(await stepsOf(fresh.id)).toEqual([]);

		const enrolled = await build(`Undo ${T} 2`);
		const contact = await newId('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', `u-${T}@x.example.net`);
		await db.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status) VALUES (?, ?, 'completed')").bind(enrolled.id, contact).run();
		expect(await undo(ctx, enrolled.actionId)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/has been used/) });

		const edited = await build(`Undo ${T} 3`);
		await db.prepare('UPDATE automation_steps SET subject = ? WHERE automation_id = ? AND subject = ?').bind('Changed', edited.id, 'Still keen?').run();
		expect(await undo(ctx, edited.actionId)).toMatchObject({ ok: false, error: expect.stringMatching(/edited since/) });

		const live = await build(`Undo ${T} 4`);
		await db.prepare("UPDATE automations SET status = 'active' WHERE id = ?").bind(live.id).run();
		expect(await undo(ctx, live.actionId)).toMatchObject({ ok: false, error: expect.stringMatching(/is active/) });
		expect(await one<any>('SELECT status FROM automations WHERE id = ?', live.id)).toMatchObject({ status: 'active' });
	});
});

describe('step tools on any step type and lane', () => {
	async function draft(ctx: ToolContext): Promise<number> {
		const r = await call(ctx, 'create_automation_draft', {
			name: `Steps ${T} ${++seq}`,
			trigger: { type: 'pipeline_stage_entered', stage: `Discovery ${T}` },
			steps: [
				{ type: 'email', ref: 'hello', subject: 'Hello', body_markdown: 'Hi there.', from_email: FROM },
				{ type: 'branch', wait_days: 1, condition: { kind: 'opened', step_ref: 'hello' }, yes: [{ type: 'tag', tag_name: `warm-${T}` }], no: [] }
			]
		});
		expect(r.ok).toBe(true);
		expect(r.action!.notes!.at(-1)).toBe('Review and activate it in Automations.');
		return JSON.parse(r.content).automation_id;
	}

	it('adds into a branch lane, edits a condition by name, deletes a step and Undo re-creates it', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const branch = (await stepsOf(id)).find((s) => s.type === 'branch')!;
		const hello = (await stepsOf(id)).find((s) => s.subject === 'Hello')!;

		const add = await call(ctx, 'add_automation_step', {
			automation_id: id,
			parent_step_id: branch.id,
			branch_label: 'no',
			step: { type: 'action', action: { kind: 'goto_step', step_id: hello.id } }
		});
		expect(add.action).toMatchObject({ status: 'applied' });
		const goto = (await stepsOf(id)).find((s) => s.type === 'action')!;
		expect(goto).toMatchObject({ parent_step_id: branch.id, branch_label: 'no', target_step_id: hello.id });

		const edit = await call(ctx, 'edit_automation_step', { automation_id: id, step_id: branch.id, condition: { kind: 'list-member', list: `Booked call ${T}` } });
		expect(edit.action!.changes.map((c) => c.field)).toEqual(['condition']);
		expect((await stepsOf(id)).find((s) => s.id === branch.id)).toMatchObject({ gate_kind: 'list-member', gate_ref_id: callBooked });
		expect((await call(ctx, 'edit_automation_step', { automation_id: id, step_id: branch.id, subject: 'x' })).content).toMatch(/branch step has no subject/);

		// The email is checked by nothing now (the condition changed) but the go-to still points at it.
		const refusedDel = await call(ctx, 'delete_automation_step', { automation_id: id, step_id: hello.id });
		expect(refusedDel.ok).toBe(false);
		expect(refusedDel.content).toMatch(/goes to or checks/);

		const del = await call(ctx, 'delete_automation_step', { automation_id: id, step_id: branch.id });
		expect(del.action).toMatchObject({ status: 'applied', tool: 'delete_automation_step', icon: 'delete' });
		expect((await stepsOf(id)).map((s) => s.type)).toEqual(['email']);
		expect(await undo(ctx, del.action!.id)).toMatchObject({ ok: true });
		const back = await stepsOf(id);
		expect(back.map((s) => s.type).sort()).toEqual(['action', 'branch', 'email', 'tag']);
		const nb = back.find((s) => s.type === 'branch')!;
		expect(nb).toMatchObject({ parent_step_id: null, position: 1, gate_kind: 'list-member', gate_ref_id: callBooked, delay_before_seconds: 86400 });
		expect(back.find((s) => s.type === 'action')).toMatchObject({ parent_step_id: nb.id, branch_label: 'no', target_step_id: hello.id });
		expect(back.find((s) => s.type === 'tag')).toMatchObject({ parent_step_id: nb.id, branch_label: 'yes' });
	});

	it('reorders a branch lane and Undo puts it back', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const branch = (await stepsOf(id)).find((s) => s.type === 'branch')!;
		const second = await call(ctx, 'add_automation_step', { automation_id: id, parent_step_id: branch.id, branch_label: 'yes', step: { type: 'end' } });
		const lane = async () => (await stepsOf(id)).filter((s) => s.parent_step_id === branch.id && s.branch_label === 'yes').map((s) => s.id);
		const [a, b] = await lane();
		expect(b).toBe(JSON.parse(second.content).step_id);
		const re = await call(ctx, 'reorder_automation_steps', { automation_id: id, parent_step_id: branch.id, branch_label: 'yes', order: [b, a] });
		expect(re.action).toMatchObject({ status: 'applied' });
		expect(await lane()).toEqual([b, a]);
		expect(await undo(ctx, re.action!.id)).toMatchObject({ ok: true });
		expect(await lane()).toEqual([a, b]);
	});

	it('refuses every write on an active automation, and never touches its status', async () => {
		const ctx = await freshCtx();
		const id = await draft(ctx);
		const [hello, branch] = (await stepsOf(id)).filter((s) => s.parent_step_id === null);
		await db.prepare("UPDATE automations SET status = 'active' WHERE id = ?").bind(id).run();
		for (const [tool, input] of [
			['add_automation_step', { automation_id: id, step: { type: 'end' } }],
			['edit_automation_step', { automation_id: id, step_id: hello.id, subject: 'Live' }],
			['reorder_automation_steps', { automation_id: id, order: [branch.id, hello.id] }],
			['delete_automation_step', { automation_id: id, step_id: branch.id }]
		] as const) {
			const r = await call(ctx, tool, input);
			expect(r.ok, tool).toBe(false);
			expect(r.pending, tool).toBeUndefined();
			expect(r.content, tool).toMatch(/is active/);
		}
		expect(await one<any>('SELECT status FROM automations WHERE id = ?', id)).toMatchObject({ status: 'active' });
		expect((await stepsOf(id)).length).toBe(3);
		expect(await count('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?', id)).toBe(0);
	});
});

describe('skill', () => {
	it('seeds the automation-building on-demand skill', async () => {
		const s = (await listSkills(db)).find((r) => r.name === 'automation-building');
		expect(s).toMatchObject({ mode: 'on_demand', enabled: 1 });
		expect(s!.body).toMatch(/build_automation/);
		expect(s!.body).toMatch(/weekday_only/);
		expect(s!.description.length).toBeLessThanOrEqual(200);
	});
});
