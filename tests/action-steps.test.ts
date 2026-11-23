import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick } from '../src/lib/server/automations';
import { actions } from '../src/routes/automations/[id]/+page.server';
import { actionDecisionLabel } from '../src/lib/automation-action-labels';

// #128: "Action" steps — enroll the contact in ANOTHER automation, or end their active
// pass there. No sends are involved (enroll_automation/end_automation never call
// Postmark), so cfg.token can be a dummy value like the other non-email engine tests
// (branching.test.ts, reentry.test.ts, step-id-pointer.test.ts).
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		// Campaigns reference steps (automation_step_id) — clear them first.
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		// Null self-referencing parents + cross-automation targets next — bulk DELETEs trip
		// their own FKs otherwise.
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('UPDATE automation_steps SET target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeAutomation(name: string, opts: { status?: string; reentry?: string } = {}): Promise<number> {
	const { status = 'active', reentry = 'once' } = opts;
	const a = await db
		.prepare('INSERT INTO automations (name, status, reentry) VALUES (?, ?, ?) RETURNING id')
		.bind(name, status, reentry)
		.first<{ id: number }>();
	return a!.id;
}

/** A trivial tag step — just needs to exist so `enroll()` has a first step to seed. */
async function tagStep(aid: number, position: number, tagName = 'seeded', delay = 0): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
			 VALUES (?, ?, ?, '', '', '', 'tag', 'add', ?) RETURNING id`
		)
		.bind(aid, position, delay, tagName)
		.first<{ id: number }>();
	return s!.id;
}

async function actionStep(
	aid: number,
	position: number,
	kind: 'enroll_automation' | 'end_automation' | 'end_all_automations',
	targetId: number | null,
	delay = 0
): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, action_kind, target_automation_id)
			 VALUES (?, ?, ?, '', '', '', 'action', ?, ?) RETURNING id`
		)
		.bind(aid, position, delay, kind, targetId)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>();
	return c!.id;
}

async function enrollmentOf(automationId: number, contactId: number) {
	return db
		.prepare(
			`SELECT status, current_step_id, ended_at FROM automation_enrollments
			 WHERE automation_id = ? AND contact_id = ?`
		)
		.bind(automationId, contactId)
		.first<{ status: string; current_step_id: number | null; ended_at: string | null }>();
}

async function branchHitLabel(stepId: number, enrollmentId?: number): Promise<string | undefined> {
	const row = enrollmentId
		? await db
				.prepare('SELECT label FROM automation_branch_hits WHERE step_id = ? AND enrollment_id = ?')
				.bind(stepId, enrollmentId)
				.first<{ label: string }>()
		: await db.prepare('SELECT label FROM automation_branch_hits WHERE step_id = ?').bind(stepId).first<{ label: string }>();
	return row?.label;
}

async function enrollmentId(automationId: number, contactId: number): Promise<number> {
	const row = await db
		.prepare('SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?')
		.bind(automationId, contactId)
		.first<{ id: number }>();
	return row!.id;
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

describe('action steps (#128)', () => {
	it('enroll_automation creates an active pass in the target and completes this flow; decision "enrolled"', async () => {
		const A = await makeAutomation('A');
		const B = await makeAutomation('B');
		const bFirst = await tagStep(B, 0, 'in-b');
		const aAction = await actionStep(A, 0, 'enroll_automation', B);

		const c = await makeContact('enroll-ok@x.example.net');
		await enroll(db, A, [c]);
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.enrolled).toBe(1);
		expect(await branchHitLabel(aAction, eidA)).toBe('enrolled');

		const aPass = await enrollmentOf(A, c);
		expect(aPass?.status).toBe('completed');

		const bPass = await enrollmentOf(B, c);
		expect(bPass?.status).toBe('active');
		expect(bPass?.current_step_id).toBe(bFirst);
	});

	it('enroll_automation into a paused target is a no-op; decision "skipped: paused"; this flow still advances', async () => {
		const A = await makeAutomation('A2');
		const B = await makeAutomation('B2', { status: 'paused' });
		await tagStep(B, 0, 'in-b2');
		const aAction = await actionStep(A, 0, 'enroll_automation', B);

		const c = await makeContact('paused-target@x.example.net');
		await enroll(db, A, [c]);
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.skipped).toBe(1);
		expect(await branchHitLabel(aAction, eidA)).toBe('skipped: paused');

		expect((await enrollmentOf(A, c))?.status).toBe('completed'); // A still advances
		expect(await enrollmentOf(B, c)).toBeNull(); // never enrolled
	});

	it('enroll_automation with a deleted target (FK nulled) is a no-op; decision "skipped: deleted"', async () => {
		const A = await makeAutomation('A3');
		const B = await makeAutomation('B3');
		await tagStep(B, 0, 'in-b3');
		const aAction = await actionStep(A, 0, 'enroll_automation', B);
		// Simulate the target having been deleted: the FK (ON DELETE SET NULL) leaves the
		// step pointing at nothing.
		await db.prepare('UPDATE automation_steps SET target_automation_id = NULL WHERE id = ?').bind(aAction).run();

		const c = await makeContact('deleted-target@x.example.net');
		await enroll(db, A, [c]);
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.skipped).toBe(1);
		expect(await branchHitLabel(aAction, eidA)).toBe('skipped: deleted');
		expect((await enrollmentOf(A, c))?.status).toBe('completed');
	});

	it('end_automation cancels the contact\'s active pass in the target; decision "ended"', async () => {
		const C = await makeAutomation('C');
		await tagStep(C, 0, 'in-c', 3600); // not due this tick — stays 'active' until end_automation cancels it
		const A = await makeAutomation('A4');
		const aAction = await actionStep(A, 0, 'end_automation', C);

		const c = await makeContact('end-ok@x.example.net');
		await enroll(db, C, [c]); // give the contact an active pass in C first
		await enroll(db, A, [c]);
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.ended).toBe(1);
		expect(await branchHitLabel(aAction, eidA)).toBe('ended');

		const cPass = await enrollmentOf(C, c);
		expect(cPass?.status).toBe('cancelled');
		expect(cPass?.ended_at).toBeTruthy();
	});

	it('end_automation with no active pass in the target is a no-op; decision "no active pass"', async () => {
		const C = await makeAutomation('C2');
		await tagStep(C, 0, 'in-c2');
		const A = await makeAutomation('A5');
		const aAction = await actionStep(A, 0, 'end_automation', C);

		const c = await makeContact('end-nopass@x.example.net');
		await enroll(db, A, [c]); // never enrolled in C
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.skipped).toBe(1); // bucketed as skipped (neither enrolled nor ended)
		expect(await branchHitLabel(aAction, eidA)).toBe('no active pass');
	});

	it('loop guard: caps enroll_automation at 5 fresh enrollments per contact within one tick', async () => {
		// Six independent "pump" automations, each with a single enroll_automation action
		// step targeting its own distinct, never-before-enrolled automation — so each
		// WOULD succeed on its own merits. All six are seeded directly as already-due
		// active enrollments for the SAME contact (the realistic trigger: a backlog of
		// several action-driven passes landing in the same tick), so the per-tick,
		// per-contact guard (cap 5) is exercised deterministically in a single tick() call
		// rather than relying on a multi-tick ping-pong that — by design ("picked up next
		// tick") — never actually produces more than one action-step hit per contact per
		// tick on its own.
		const c = await makeContact('loop-guard@x.example.net');
		const pumpSteps: number[] = [];
		for (let i = 0; i < 6; i++) {
			const target = await makeAutomation(`Z${i}`);
			await tagStep(target, 0, `z${i}`);
			const pump = await makeAutomation(`P${i}`, { reentry: 'multiple' });
			const step = await actionStep(pump, 0, 'enroll_automation', target);
			pumpSteps.push(step);
			// Seed an already-due active enrollment directly (bypassing enroll()'s own
			// pacing) with distinct, strictly increasing next_run_at so processing order
			// is deterministic: P0 first .. P5 last.
			await db
				.prepare(
					`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, next_run_at)
					 VALUES (?, ?, ?, 'active', datetime('now', ?))`
				)
				.bind(pump, c, step, `-${60 - i} seconds`)
				.run();
		}

		const summary = await tick(db, cfg, { batchSize: 10 });
		expect(summary.processed).toBe(6);
		expect(summary.actions.enrolled).toBe(5); // capped
		expect(summary.actions.skipped).toBe(1); // the 6th hits the guard

		const labels: string[] = [];
		for (const step of pumpSteps) {
			const label = await branchHitLabel(step);
			if (label) labels.push(label);
		}
		expect(labels.filter((l) => l === 'enrolled').length).toBe(5);
		expect(labels.filter((l) => l === 'skipped: loop guard').length).toBe(1);
		// The guard's own last pump (P5) is the one that should have been refused.
		expect(await branchHitLabel(pumpSteps[5])).toBe('skipped: loop guard');
	});

	it('addStep refuses an action step that targets its own automation', async () => {
		const A = await makeAutomation('SelfTarget');
		const result: any = await actions.addStep(
			actionEvent(A, { type: 'action', action_kind: 'enroll_automation', target_automation_id: String(A) })
		);
		expect(result?.status).toBe(400);
		expect(result?.data?.error).toBe("An action can't target its own automation.");

		const count = await db
			.prepare("SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ? AND type = 'action'")
			.bind(A)
			.first<{ n: number }>();
		expect(count?.n ?? 0).toBe(0); // nothing was inserted
	});

	it('updateStep refuses re-pointing an existing action step at its own automation', async () => {
		const A = await makeAutomation('SelfTarget2');
		const B = await makeAutomation('OtherTarget2');
		const step = await actionStep(A, 0, 'enroll_automation', B);

		const result: any = await actions.updateStep(
			actionEvent(A, {
				step_id: String(step),
				action_kind: 'enroll_automation',
				target_automation_id: String(A),
				delay_value: '0',
				delay_unit: 'days'
			})
		);
		expect(result?.status).toBe(400);
		expect(result?.data?.error).toBe("An action can't target its own automation.");

		// Unchanged — still points at B, not A.
		const row = await db
			.prepare('SELECT target_automation_id FROM automation_steps WHERE id = ?')
			.bind(step)
			.first<{ target_automation_id: number }>();
		expect(row?.target_automation_id).toBe(B);
	});

	it('duplicateStep and duplicate (whole automation) copy action_kind + target_automation_id', async () => {
		const A = await makeAutomation('DupSrc');
		const B = await makeAutomation('DupTarget');
		const step = await actionStep(A, 0, 'end_automation', B);

		await actions.duplicateStep(actionEvent(A, { step_id: String(step) }));
		const copies = await db
			.prepare("SELECT action_kind, target_automation_id FROM automation_steps WHERE automation_id = ? AND type = 'action' ORDER BY position")
			.bind(A)
			.all<{ action_kind: string; target_automation_id: number }>();
		expect(copies.results).toHaveLength(2);
		for (const row of copies.results) {
			expect(row.action_kind).toBe('end_automation');
			expect(row.target_automation_id).toBe(B);
		}

		// Duplicate the whole automation (#77) — both action steps carry over, target
		// untouched (it points at a DIFFERENT automation, not a step in this tree).
		let location = '';
		try {
			await actions.duplicate(actionEvent(A, {}));
		} catch (r: any) {
			location = r?.location ?? '';
		}
		const newId = Number(location.split('/').pop());
		expect(newId).toBeGreaterThan(0);
		const newSteps = await db
			.prepare("SELECT action_kind, target_automation_id FROM automation_steps WHERE automation_id = ? AND type = 'action'")
			.bind(newId)
			.all<{ action_kind: string; target_automation_id: number }>();
		expect(newSteps.results).toHaveLength(2);
		for (const row of newSteps.results) {
			expect(row.action_kind).toBe('end_automation');
			expect(row.target_automation_id).toBe(B);
		}
	});

	// #128 addendum: "End another automation" can target ALL other automations.
	it('end_all_automations cancels every other active pass; decision "ended N automations"', async () => {
		const B = await makeAutomation('EndAllB');
		const C = await makeAutomation('EndAllC');
		await tagStep(B, 0, 'in-eab', 3600); // not due — stays active until end_all_automations cancels it
		await tagStep(C, 0, 'in-eac', 3600);
		const A = await makeAutomation('EndAllA');
		const aAction = await actionStep(A, 0, 'end_all_automations', null);

		const c = await makeContact('end-all-ok@x.example.net');
		await enroll(db, B, [c]);
		await enroll(db, C, [c]);
		await enroll(db, A, [c]);
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.ended).toBe(2); // N, not 1 — see processEnrollment's actionCount
		expect(await branchHitLabel(aAction, eidA)).toBe('ended 2 automations');

		expect((await enrollmentOf(B, c))?.status).toBe('cancelled');
		expect((await enrollmentOf(C, c))?.status).toBe('cancelled');
		expect((await enrollmentOf(A, c))?.status).toBe('completed'); // A's own pass is excluded, advances normally
	});

	it('end_all_automations with no other active passes is a no-op; decision "no active pass"', async () => {
		const A = await makeAutomation('EndAllNoneA');
		const aAction = await actionStep(A, 0, 'end_all_automations', null);

		const c = await makeContact('end-all-none@x.example.net');
		await enroll(db, A, [c]); // no other passes anywhere
		const eidA = await enrollmentId(A, c);

		const summary = await tick(db, cfg);
		expect(summary.actions.skipped).toBe(1);
		expect(await branchHitLabel(aAction, eidA)).toBe('no active pass');
	});

	it('validateActionTarget: end_all_automations rejects a target; enroll/end_automation require one', async () => {
		const A = await makeAutomation('ValidateA');
		const B = await makeAutomation('ValidateB');

		// end_all_automations posted with a target_automation_id is rejected.
		const badAdd: any = await actions.addStep(
			actionEvent(A, { type: 'action', action_kind: 'end_all_automations', target_automation_id: String(B) })
		);
		expect(badAdd?.status).toBe(400);
		expect(badAdd?.data?.error).toBe("End all other automations can't also target a specific automation.");

		const step = await actionStep(A, 0, 'enroll_automation', B);

		// enroll_automation / end_automation with no target are both rejected.
		const badEnroll: any = await actions.updateStep(
			actionEvent(A, { step_id: String(step), action_kind: 'enroll_automation', target_automation_id: '', delay_value: '0', delay_unit: 'days' })
		);
		expect(badEnroll?.status).toBe(400);
		expect(badEnroll?.data?.error).toBe('Choose a target automation for this action.');

		const badEnd: any = await actions.updateStep(
			actionEvent(A, { step_id: String(step), action_kind: 'end_automation', target_automation_id: '', delay_value: '0', delay_unit: 'days' })
		);
		expect(badEnd?.status).toBe(400);
		expect(badEnd?.data?.error).toBe('Choose a target automation for this action.');

		// The drawer's "All other automations" select option (`__all__`) resolves to
		// end_all_automations with a null target, and saves cleanly.
		const good: any = await actions.updateStep(
			actionEvent(A, { step_id: String(step), action_kind: 'end_automation', target_automation_id: '__all__', delay_value: '0', delay_unit: 'days' })
		);
		expect(good?.ok).toBe(true);
		const row = await db
			.prepare('SELECT action_kind, target_automation_id FROM automation_steps WHERE id = ?')
			.bind(step)
			.first<{ action_kind: string; target_automation_id: number | null }>();
		expect(row?.action_kind).toBe('end_all_automations');
		expect(row?.target_automation_id).toBeNull();
	});

	it('duplicateStep and duplicate (whole automation) copy end_all_automations with a null target', async () => {
		const A = await makeAutomation('DupAllSrc');
		const step = await actionStep(A, 0, 'end_all_automations', null);

		await actions.duplicateStep(actionEvent(A, { step_id: String(step) }));
		const copies = await db
			.prepare("SELECT action_kind, target_automation_id FROM automation_steps WHERE automation_id = ? AND type = 'action' ORDER BY position")
			.bind(A)
			.all<{ action_kind: string; target_automation_id: number | null }>();
		expect(copies.results).toHaveLength(2);
		for (const row of copies.results) {
			expect(row.action_kind).toBe('end_all_automations');
			expect(row.target_automation_id).toBeNull();
		}

		let location = '';
		try {
			await actions.duplicate(actionEvent(A, {}));
		} catch (r: any) {
			location = r?.location ?? '';
		}
		const newId = Number(location.split('/').pop());
		expect(newId).toBeGreaterThan(0);
		const newSteps = await db
			.prepare("SELECT action_kind, target_automation_id FROM automation_steps WHERE automation_id = ? AND type = 'action'")
			.bind(newId)
			.all<{ action_kind: string; target_automation_id: number | null }>();
		expect(newSteps.results).toHaveLength(2);
		for (const row of newSteps.results) {
			expect(row.action_kind).toBe('end_all_automations');
			expect(row.target_automation_id).toBeNull();
		}
	});
});

describe('actionDecisionLabel (#128 display mapping)', () => {
	it('maps the stored "enrolled" label to "started"', () => {
		expect(actionDecisionLabel('enrolled')).toBe('started');
	});

	it('passes every other stored label through unchanged', () => {
		expect(actionDecisionLabel('ended')).toBe('ended');
		expect(actionDecisionLabel('ended 2 automations')).toBe('ended 2 automations');
		expect(actionDecisionLabel('no active pass')).toBe('no active pass');
		expect(actionDecisionLabel('skipped: paused')).toBe('skipped: paused');
		expect(actionDecisionLabel('skipped: loop guard')).toBe('skipped: loop guard');
	});
});
