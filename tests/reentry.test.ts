import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick } from '../src/lib/server/automations';
import { actions } from '../src/routes/automations/[id]/+page.server';

// Re-entry policy (automations.reentry) + completion timestamps (enrollments.ended_at):
// 'once' (default) — any prior pass blocks re-enrollment; 'multiple' — a contact can go
// through again after a pass ends, with only one ACTIVE pass at a time (partial unique
// index ux_enrollments_active).
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
		// Null self-referencing parents next — a bulk DELETE trips the FK otherwise.
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeAutomation(reentry: 'once' | 'multiple' = 'once'): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status, reentry) VALUES ('R', 'active', ?) RETURNING id")
		.bind(reentry)
		.first<{ id: number }>();
	return a!.id;
}

/** One tag step — completes the enrollment in a single tick (no Postmark involved). */
async function step(aid: number, position: number, tagName: string, delay = 0): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
			 VALUES (?, ?, ?, '', '', '', 'tag', 'add', ?) RETURNING id`
		)
		.bind(aid, position, delay, tagName)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id')
		.bind(email)
		.first<{ id: number }>();
	return c!.id;
}

type EnrRow = { id: number; status: string; ended_at: string | null };

async function rowsFor(aid: number, cid: number): Promise<EnrRow[]> {
	const rows = await db
		.prepare(
			'SELECT id, status, ended_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id'
		)
		.bind(aid, cid)
		.all<EnrRow>();
	return rows.results;
}

/** Tick until nothing is due (delays are 0 in these tests) — cap guards runaway loops. */
async function drain(maxTicks = 10): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		const s = await tick(db, cfg);
		if (s.processed === 0) return;
	}
}

function actionEvent(aid: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env },
		params: { id: String(aid) },
		request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
	} as any;
}

describe('re-entry policy', () => {
	it("default 'once': a completed pass blocks re-enrollment", async () => {
		const aid = await makeAutomation(); // reentry defaults to 'once'
		await step(aid, 0, 'welcomed');
		const cid = await makeContact('once@x.example.net');

		const first = await enroll(db, aid, [cid]);
		expect(first).toMatchObject({ enrolled: 1, skipped: 0 });
		await drain();

		const done = await rowsFor(aid, cid);
		expect(done).toHaveLength(1);
		expect(done[0].status).toBe('completed');

		const again = await enroll(db, aid, [cid]);
		expect(again).toMatchObject({ enrolled: 0, skipped: 1 });
		expect(await rowsFor(aid, cid)).toHaveLength(1); // no second row
	});

	it("'multiple': re-enters after completion, but never two ACTIVE passes", async () => {
		const aid = await makeAutomation('multiple');
		await step(aid, 0, 'looped');
		const cid = await makeContact('multi@x.example.net');

		await enroll(db, aid, [cid]);
		await drain(); // pass 1 completes

		const again = await enroll(db, aid, [cid]);
		expect(again).toMatchObject({ enrolled: 1, skipped: 0 });

		const rows = await rowsFor(aid, cid);
		expect(rows).toHaveLength(2);
		expect(rows[0].status).toBe('completed');
		expect(rows[0].ended_at).not.toBeNull();
		expect(rows[1].status).toBe('active');
		expect(rows[1].ended_at).toBeNull();

		// While a pass is ACTIVE, another enroll is skipped (partial index + ON CONFLICT).
		const whileActive = await enroll(db, aid, [cid]);
		expect(whileActive).toMatchObject({ enrolled: 0, skipped: 1 });
		expect(await rowsFor(aid, cid)).toHaveLength(2);
	});

	it('skips unsubscribed contacts under both policies', async () => {
		for (const policy of ['once', 'multiple'] as const) {
			const aid = await makeAutomation(policy);
			await step(aid, 0, 'never');
			const cid = await makeContact(`un-${policy}@x.example.net`);
			await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(cid).run();
			const res = await enroll(db, aid, [cid]);
			expect(res).toMatchObject({ enrolled: 0, skipped: 1 });
		}
	});
});

describe('ended_at', () => {
	it('is stamped when the engine completes the last step', async () => {
		const aid = await makeAutomation();
		await step(aid, 0, 'done');
		const cid = await makeContact('end@x.example.net');
		await enroll(db, aid, [cid]);

		expect((await rowsFor(aid, cid))[0].ended_at).toBeNull(); // active → not yet ended
		await drain();

		const [row] = await rowsFor(aid, cid);
		expect(row.status).toBe('completed');
		expect(row.ended_at).not.toBeNull();
	});

	it('is stamped by cancelEnrollment', async () => {
		const aid = await makeAutomation();
		await step(aid, 0, 'parked', 3600); // long delay keeps the pass active
		const cid = await makeContact('cancel@x.example.net');
		await enroll(db, aid, [cid]);
		const [active] = await rowsFor(aid, cid);
		expect(active.status).toBe('active');

		await actions.cancelEnrollment(actionEvent(aid, { enrollment_id: String(active.id) }));

		const [row] = await rowsFor(aid, cid);
		expect(row.status).toBe('cancelled');
		expect(row.ended_at).not.toBeNull();
	});

	it('is set on failure and cleared by retryEnrollment', async () => {
		const aid = await makeAutomation();
		const sid = await step(aid, 0, 'retry', 3600);
		const cid = await makeContact('retry@x.example.net');
		await enroll(db, aid, [cid]);
		// Simulate a hard failure (the engine stamps ended_at on its failure paths).
		await db
			.prepare(
				`UPDATE automation_enrollments SET status='failed', next_run_at=NULL, ended_at=datetime('now')
				 WHERE automation_id = ? AND contact_id = ?`
			)
			.bind(aid, cid)
			.run();
		const [failed] = await rowsFor(aid, cid);
		expect(failed.ended_at).not.toBeNull();
		expect(sid).toBeGreaterThan(0);

		await actions.retryEnrollment(actionEvent(aid, { enrollment_id: String(failed.id) }));

		const [row] = await rowsFor(aid, cid);
		expect(row.status).toBe('active');
		expect(row.ended_at).toBeNull();
	});

	it('retryEnrollment refuses when a newer pass is already active', async () => {
		const aid = await makeAutomation('multiple');
		await step(aid, 0, 'again', 3600);
		const cid = await makeContact('twopasses@x.example.net');

		// Pass 1 fails…
		await enroll(db, aid, [cid]);
		await db
			.prepare(
				`UPDATE automation_enrollments SET status='failed', next_run_at=NULL, ended_at=datetime('now')
				 WHERE automation_id = ? AND contact_id = ?`
			)
			.bind(aid, cid)
			.run();
		const [failed] = await rowsFor(aid, cid);

		// …then re-entry starts pass 2, which is still active.
		await enroll(db, aid, [cid]);

		const res = (await actions.retryEnrollment(
			actionEvent(aid, { enrollment_id: String(failed.id) })
		)) as any;
		expect(res?.status).toBe(400);

		// Pass 1 stays failed; exactly one active row exists.
		const rows = await rowsFor(aid, cid);
		expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
		expect(rows.find((r) => r.id === failed.id)!.status).toBe('failed');
	});
});

describe('setReentry action', () => {
	it('whitelists once/multiple and persists the choice', async () => {
		const aid = await makeAutomation();

		await actions.setReentry(actionEvent(aid, { reentry: 'multiple' }));
		let a = await db.prepare('SELECT reentry FROM automations WHERE id = ?').bind(aid).first<{ reentry: string }>();
		expect(a!.reentry).toBe('multiple');

		const bad = (await actions.setReentry(actionEvent(aid, { reentry: 'forever' }))) as any;
		expect(bad?.status).toBe(400);
		a = await db.prepare('SELECT reentry FROM automations WHERE id = ?').bind(aid).first<{ reentry: string }>();
		expect(a!.reentry).toBe('multiple'); // unchanged
	});
});
