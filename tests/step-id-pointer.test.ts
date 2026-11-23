import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick } from '../src/lib/server/automations';
import { actions } from '../src/routes/automations/[id]/+page.server';

// #74: the enrollment pointer is a step ID — structural edits are safe mid-flight.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeAutomation(): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status) VALUES ('A', 'active') RETURNING id")
		.first<{ id: number }>();
	return a!.id;
}

/** Tag step (no send path) at a position; returns step id. */
async function tagStep(aid: number, position: number, tag: string, delay = 0): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
			 VALUES (?, ?, ?, '', '', '', 'tag', 'add', ?) RETURNING id`
		)
		.bind(aid, position, delay, tag)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>();
	return c!.id;
}

async function pointerOf(contactId: number): Promise<number | null> {
	const r = await db
		.prepare('SELECT current_step_id FROM automation_enrollments WHERE contact_id = ?')
		.bind(contactId)
		.first<{ current_step_id: number | null }>();
	return r?.current_step_id ?? null;
}

async function tagsOf(contactId: number): Promise<string[]> {
	const rows = await db
		.prepare(
			`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id
			 WHERE lm.contact_id = ? AND l.kind = 'tag' ORDER BY l.name`
		)
		.bind(contactId)
		.all<{ name: string }>();
	return rows.results.map((r) => r.name);
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

describe('step-id pointer (#74)', () => {
	it('enroll seeds the pointer with the first step ID (lowest position, not insert order)', async () => {
		const aid = await makeAutomation();
		const second = await tagStep(aid, 1, 'later'); // inserted first, but position 1
		const first = await tagStep(aid, 0, 'now');
		const c = await makeContact('p@x.example.net');
		await enroll(db, aid, [c]);
		expect(await pointerOf(c)).toBe(first);
		expect(second).not.toBe(first);
	});

	it('reordering mid-flight is safe: the contact keeps its step and follows the NEW order after it', async () => {
		const aid = await makeAutomation();
		const s0 = await tagStep(aid, 0, 'step-a');
		const s1 = await tagStep(aid, 1, 'step-b', 3600); // waits an hour → contact parks here
		const s2 = await tagStep(aid, 2, 'step-c');
		const c = await makeContact('r@x.example.net');
		await enroll(db, aid, [c]);

		await tick(db, cfg); // runs s0, advances to s1 (parked: +1h)
		expect(await pointerOf(c)).toBe(s1);
		expect(await tagsOf(c)).toEqual(['step-a']);

		// Reorder while parked: s2 now comes BEFORE s1 → after s1 runs there is no
		// following step, so the flow completes without running s2 again.
		await actions.reorderSteps(actionEvent(aid, { order: `${s0},${s2},${s1}` }));
		// Make the parked step due now.
		await db.prepare("UPDATE automation_enrollments SET next_run_at = datetime('now') WHERE contact_id = ?").bind(c).run();

		const summary = await tick(db, cfg);
		expect(summary.tagged).toBe(1); // s1 ran (pointer survived the reorder)
		expect(await tagsOf(c)).toEqual(['step-a', 'step-b']); // s2 NOT run — it's before s1 now
		const st = await db.prepare('SELECT status FROM automation_enrollments WHERE contact_id = ?').bind(c).first<{ status: string }>();
		expect(st!.status).toBe('completed');
	});

	it('a step added after the parked step mid-flight is picked up on advance', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 'first', 0);
		const c = await makeContact('i@x.example.net');
		await enroll(db, aid, [c]);
		await tick(db, cfg); // runs first step; no next → completed... unless we add one first?
		// Re-enroll pattern instead: park on a delayed step, then append a new one.
		const c2 = await makeContact('i2@x.example.net');
		const aid2 = await makeAutomation();
		await tagStep(aid2, 0, 'one');
		const parked = await tagStep(aid2, 1, 'two', 3600);
		await enroll(db, aid2, [c2]);
		await tick(db, cfg); // ran 'one', parked on 'two'
		expect(await pointerOf(c2)).toBe(parked);

		const appended = await tagStep(aid2, 2, 'three'); // structural add mid-flight
		await db.prepare("UPDATE automation_enrollments SET next_run_at = datetime('now') WHERE contact_id = ?").bind(c2).run();
		await tick(db, cfg); // runs 'two', advances to 'three' (due immediately, delay 0)
		expect(await pointerOf(c2)).toBe(appended);
		await tick(db, cfg); // runs 'three', completes
		expect(await tagsOf(c2)).toEqual(['one', 'three', 'two']);
	});

	it('deleteStep re-points waiting contacts to the following step', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 'start');
		const doomed = await tagStep(aid, 1, 'doomed', 3600);
		const after = await tagStep(aid, 2, 'after', 1800);
		const c = await makeContact('d@x.example.net');
		await enroll(db, aid, [c]);
		await tick(db, cfg); // parked on 'doomed'
		expect(await pointerOf(c)).toBe(doomed);

		await actions.deleteStep(actionEvent(aid, { step_id: String(doomed) }));
		expect(await pointerOf(c)).toBe(after); // re-pointed, scheduled with after's delay

		await db.prepare("UPDATE automation_enrollments SET next_run_at = datetime('now') WHERE contact_id = ?").bind(c).run();
		await tick(db, cfg);
		expect(await tagsOf(c)).toEqual(['after', 'start']); // 'doomed' never applied
	});

	it('deleting the last remaining downstream step completes its waiting contacts', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 'go');
		const last = await tagStep(aid, 1, 'final', 3600);
		const c = await makeContact('l@x.example.net');
		await enroll(db, aid, [c]);
		await tick(db, cfg); // parked on 'final'

		await actions.deleteStep(actionEvent(aid, { step_id: String(last) }));
		const st = await db
			.prepare('SELECT status, current_step_id, next_run_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(c)
			.first<{ status: string; current_step_id: number | null; next_run_at: string | null }>();
		expect(st!.status).toBe('completed');
		expect(st!.current_step_id).toBeNull();
		expect(st!.next_run_at).toBeNull();
	});

	it('a NULL pointer on an active enrollment closes out instead of looping as lost', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 'x');
		const c = await makeContact('n@x.example.net');
		await db
			.prepare(
				`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, next_run_at, status)
				 VALUES (?, ?, NULL, datetime('now'), 'active')`
			)
			.bind(aid, c)
			.run();
		const summary = await tick(db, cfg);
		expect(summary.completed).toBe(1);
		expect(summary.lost).toBe(0);
	});
});
