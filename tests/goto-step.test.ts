import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { enroll, tick } from '../src/lib/server/automations';
import { actions } from '../src/routes/automations/[id]/+page.server';
import { stepNumbers } from '../src/lib/automation-action-labels';

// #146: "Go to a step" — action_kind 'goto_step' moves the contact to another step in the
// same automation. No sends are involved, so cfg.token can be a dummy value.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key = 'timezone'`)
	]);
});

afterEach(() => {
	vi.useRealTimers();
});

async function makeAutomation(name = 'A'): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status, reentry) VALUES (?, 'active', 'once') RETURNING id")
		.bind(name)
		.first<{ id: number }>();
	return a!.id;
}

async function tagStep(
	aid: number,
	position: number,
	opts: { delay?: number; weekdayOnly?: boolean; parent?: number; label?: string } = {}
): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name,
			    weekday_only, parent_step_id, branch_label)
			 VALUES (?, ?, ?, '', '', '', 'tag', 'add', ?, ?, ?, ?) RETURNING id`
		)
		.bind(aid, position, opts.delay ?? 0, `t${position}`, opts.weekdayOnly ? 1 : 0, opts.parent ?? null, opts.label ?? null)
		.first<{ id: number }>();
	return s!.id;
}

async function gotoStep(aid: number, position: number, target: number | null, delay = 0): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, action_kind, target_step_id)
			 VALUES (?, ?, ?, '', '', '', 'action', 'goto_step', ?) RETURNING id`
		)
		.bind(aid, position, delay, target)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email = 'a@example.com'): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>();
	return c!.id;
}

async function enrollment(aid: number, cid: number) {
	return db
		.prepare(
			`SELECT id, status, current_step_id, next_run_at, jump_count,
			        (strftime('%s', next_run_at) - strftime('%s', 'now')) AS due_in
			 FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?`
		)
		.bind(aid, cid)
		.first<{ id: number; status: string; current_step_id: number | null; next_run_at: string | null; jump_count: number; due_in: number }>();
}

/** Make the enrollment due now (skips waiting out a delay in tests). */
async function makeDue(aid: number, cid: number) {
	await db
		.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 seconds') WHERE automation_id = ? AND contact_id = ?`)
		.bind(aid, cid)
		.run();
}

async function decision(stepId: number): Promise<string | undefined> {
	const r = await db.prepare('SELECT label FROM automation_branch_hits WHERE step_id = ?').bind(stepId).first<{ label: string }>();
	return r?.label;
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

describe('goto_step action (#146)', () => {
	it('moves the pointer to the target and schedules it after the target delay; no send', async () => {
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const skipped = await tagStep(A, 1);
		const target = await tagStep(A, 2, { delay: 3600 });
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(target, go).run();
		const c = await makeContact();
		await enroll(db, A, [c]);

		const summary = await tick(db, cfg);
		expect(summary.actions.jumped).toBe(1);
		expect(summary.advanced).toBe(1);
		expect(summary.sent).toBe(0);

		const e = await enrollment(A, c);
		expect(e!.status).toBe('active');
		expect(e!.current_step_id).toBe(target);
		expect(e!.current_step_id).not.toBe(skipped);
		expect(Math.abs(e!.due_in - 3600)).toBeLessThan(10);
		expect(e!.jump_count).toBe(1);
		expect(await decision(go)).toBe('jumped to «3. Add tag “t2”»');
	});

	it('applies the target step’s weekday_only (Saturday → Monday, same local time)', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		// Saturday 2026-10-03 12:00 America/Los_Angeles (default timezone).
		vi.setSystemTime(new Date('2026-10-03T19:00:00Z'));
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const target = await tagStep(A, 1, { delay: 3600, weekdayOnly: true });
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(target, go).run();
		const c = await makeContact();
		await enroll(db, A, [c]);

		await tick(db, cfg);
		const e = await enrollment(A, c);
		expect(e!.current_step_id).toBe(target);
		// Sat 13:00 PT → Mon 2026-10-05 13:00 PT = 20:00 UTC.
		expect(e!.next_run_at).toBe('2026-10-05 20:00:00');
	});

	it('can target a step inside a branch lane', async () => {
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const branch = await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, gate_kind, split_pct)
				 VALUES (?, 1, 0, '', '', '', 'branch', 'split', 100) RETURNING id`
			)
			.bind(A)
			.first<{ id: number }>();
		const inLane = await tagStep(A, 0, { parent: branch!.id, label: 'no' });
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(inLane, go).run();
		const c = await makeContact();
		await enroll(db, A, [c]);

		await tick(db, cfg);
		expect((await enrollment(A, c))!.current_step_id).toBe(inLane);
		// The lane re-joins the trunk as usual: nothing after the branch → completes.
		await makeDue(A, c);
		await tick(db, cfg);
		expect((await enrollment(A, c))!.status).toBe('completed');
	});

	it('a deleted target (FK nulled) is skipped and the flow continues to the next step', async () => {
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const next = await tagStep(A, 1);
		const doomed = await tagStep(A, 2);
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(doomed, go).run();
		await db.prepare('DELETE FROM automation_steps WHERE id = ?').bind(doomed).run();
		const row = await db.prepare('SELECT target_step_id FROM automation_steps WHERE id = ?').bind(go).first<{ target_step_id: number | null }>();
		expect(row!.target_step_id).toBeNull();

		const c = await makeContact();
		await enroll(db, A, [c]);
		const summary = await tick(db, cfg);
		expect(summary.actions.skipped).toBe(1);
		expect(await decision(go)).toBe('skipped: deleted step');
		expect((await enrollment(A, c))!.current_step_id).toBe(next);
	});

	it('the per-tick guard caps jumps per enrollment within one tick', async () => {
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const next = await tagStep(A, 1);
		const target = await tagStep(A, 2);
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(target, go).run();
		const c = await makeContact();
		await enroll(db, A, [c]);
		const e = await enrollment(A, c);

		const jumpGuard = new Map<number, number>([[e!.id, 3]]);
		await tick(db, cfg, { jumpGuard });
		expect(await decision(go)).toBe('skipped: jump limit');
		expect((await enrollment(A, c))!.current_step_id).toBe(next);
	});

	it('A: goto→B, B: goto→A with zero delays stays bounded and the pass ends', async () => {
		const A = await makeAutomation();
		const stepA = await gotoStep(A, 0, null);
		const stepB = await gotoStep(A, 1, stepA);
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(stepB, stepA).run();
		const c = await makeContact();
		await enroll(db, A, [c]);

		let jumped = 0;
		let ticks = 0;
		while (ticks < 40) {
			const s = await tick(db, cfg);
			ticks++;
			expect(s.actions.jumped).toBeLessThanOrEqual(3); // per-tick bound
			jumped += s.actions.jumped;
			const e = await enrollment(A, c);
			if (e!.status !== 'active') break;
			await makeDue(A, c);
		}
		const e = await enrollment(A, c);
		expect(e!.status).toBe('completed');
		expect(e!.jump_count).toBe(25); // per-pass cap
		expect(jumped).toBe(25);
		expect(ticks).toBeLessThan(40);
	});

	it('same-step and other-automation targets are rejected at save', async () => {
		const A = await makeAutomation('A');
		const B = await makeAutomation('B');
		const go = await gotoStep(A, 0, null);
		const own = await tagStep(A, 1);
		const foreign = await tagStep(B, 0);

		const self: any = await actions.updateStep(
			actionEvent(A, { step_id: String(go), action_kind: 'goto_step', target_step_id: String(go), delay_value: '0', delay_unit: 'days' })
		);
		expect(self.status).toBe(400);
		expect(self.data.error).toMatch(/itself/);

		const other: any = await actions.updateStep(
			actionEvent(A, { step_id: String(go), action_kind: 'goto_step', target_step_id: String(foreign), delay_value: '0', delay_unit: 'days' })
		);
		expect(other.status).toBe(400);
		expect(other.data.error).toMatch(/not in this automation/);

		const none: any = await actions.updateStep(
			actionEvent(A, { step_id: String(go), action_kind: 'goto_step', target_step_id: '', delay_value: '0', delay_unit: 'days' })
		);
		expect(none.status).toBe(400);

		const ok: any = await actions.updateStep(
			actionEvent(A, { step_id: String(go), action_kind: 'goto_step', target_step_id: String(own), delay_value: '0', delay_unit: 'days' })
		);
		expect(ok.ok).toBe(true);
		const row = await db
			.prepare('SELECT action_kind, target_step_id, target_automation_id FROM automation_steps WHERE id = ?')
			.bind(go)
			.first<{ action_kind: string; target_step_id: number; target_automation_id: number | null }>();
		expect(row).toEqual({ action_kind: 'goto_step', target_step_id: own, target_automation_id: null });

		// Switching the same step to an automation action clears the step target.
		await actions.updateStep(
			actionEvent(A, { step_id: String(go), action_kind: 'enroll_automation', target_automation_id: String(B), delay_value: '0', delay_unit: 'days' })
		);
		const after = await db.prepare('SELECT target_step_id FROM automation_steps WHERE id = ?').bind(go).first<{ target_step_id: number | null }>();
		expect(after!.target_step_id).toBeNull();
	});

	it('duplicating the automation remaps target_step_id to the copied steps', async () => {
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const target = await tagStep(A, 1);
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(target, go).run();

		let newId = 0;
		try {
			await actions.duplicate(actionEvent(A, {}));
		} catch (err) {
			if (!isRedirect(err)) throw err;
			newId = Number(err.location.split('/').pop());
		}
		expect(newId).toBeGreaterThan(0);
		const copies = await db
			.prepare('SELECT id, type, target_step_id FROM automation_steps WHERE automation_id = ? ORDER BY position')
			.bind(newId)
			.all<{ id: number; type: string; target_step_id: number | null }>();
		const [copyGo, copyTarget] = copies.results;
		expect(copyGo.type).toBe('action');
		expect(copyGo.target_step_id).toBe(copyTarget.id);
		expect(copyGo.target_step_id).not.toBe(target);
	});

	it('duplicating the step keeps the same target', async () => {
		const A = await makeAutomation();
		const go = await gotoStep(A, 0, null);
		const target = await tagStep(A, 1);
		await db.prepare('UPDATE automation_steps SET target_step_id = ? WHERE id = ?').bind(target, go).run();
		await actions.duplicateStep(actionEvent(A, { step_id: String(go) }));
		const rows = await db
			.prepare("SELECT target_step_id FROM automation_steps WHERE automation_id = ? AND type = 'action'")
			.bind(A)
			.all<{ target_step_id: number }>();
		expect(rows.results.map((r) => r.target_step_id)).toEqual([target, target]);
	});

	it('stepNumbers numbers trunk and branch lanes in canvas order', () => {
		const steps = [
			{ id: 1, position: 0, type: 'email', parent_step_id: null, branch_label: null },
			{ id: 2, position: 1, type: 'branch', parent_step_id: null, branch_label: null },
			{ id: 3, position: 0, type: 'email', parent_step_id: 2, branch_label: 'no' },
			{ id: 4, position: 0, type: 'email', parent_step_id: 2, branch_label: 'yes' },
			{ id: 5, position: 2, type: 'email', parent_step_id: null, branch_label: null }
		];
		expect([...stepNumbers(steps).entries()]).toEqual([
			[1, 1],
			[2, 2],
			[4, 3],
			[3, 4],
			[5, 5]
		]);
	});
});
