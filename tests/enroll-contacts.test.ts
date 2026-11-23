import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enrollContactsInAutomation, listActiveAutomations } from '../src/lib/server/automations';

// Hand-picked contact enrollment (#97): the /contacts and /lists/[id] bulk bars'
// "add to automation" action shares this helper. Covers the validation the manual
// /automations/[id] enrollList action already does (active status, >=1 step) plus
// dedupe/skip-count behavior.
const db = (env as any).DB as D1Database;

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

async function makeAutomation(
	name: string,
	status: 'draft' | 'active' | 'paused' = 'active',
	reentry: 'once' | 'multiple' = 'once'
): Promise<number> {
	const a = await db
		.prepare('INSERT INTO automations (name, status, reentry) VALUES (?, ?, ?) RETURNING id')
		.bind(name, status, reentry)
		.first<{ id: number }>();
	return a!.id;
}

/** One tag step — enough for enroll() to have a trunk entry point. */
async function step(aid: number, position = 0, tagName = 'enrolled'): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
			 VALUES (?, ?, 0, '', '', '', 'tag', 'add', ?) RETURNING id`
		)
		.bind(aid, position, tagName)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string, subscribed = 1): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id')
		.bind(email, subscribed)
		.first<{ id: number }>();
	return c!.id;
}

async function enrollmentCount(aid: number): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?')
		.bind(aid)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe('enrollContactsInAutomation', () => {
	it('rejects a missing automation', async () => {
		const cid = await makeContact('nowhere@x.example.net');
		const res = await enrollContactsInAutomation(db, 999999, [cid]);
		expect(res).toEqual({ ok: false, error: 'That automation no longer exists.' });
	});

	it('rejects an empty/invalid id list', async () => {
		const aid = await makeAutomation('Draft one', 'active');
		await step(aid);
		expect(await enrollContactsInAutomation(db, aid, [])).toEqual({
			ok: false,
			error: 'Select at least one contact.'
		});
		expect(await enrollContactsInAutomation(db, aid, [0, -5])).toEqual({
			ok: false,
			error: 'Select at least one contact.'
		});
	});

	it('rejects a draft automation, naming the status', async () => {
		const aid = await makeAutomation('Draft Flow', 'draft');
		await step(aid);
		const cid = await makeContact('draft@x.example.net');
		const res = await enrollContactsInAutomation(db, aid, [cid]);
		expect(res.ok).toBe(false);
		expect((res as any).error).toBe('“Draft Flow” is draft. Activate it before enrolling contacts.');
	});

	it('rejects a paused automation, naming the status', async () => {
		const aid = await makeAutomation('Paused Flow', 'paused');
		await step(aid);
		const cid = await makeContact('paused@x.example.net');
		const res = await enrollContactsInAutomation(db, aid, [cid]);
		expect(res.ok).toBe(false);
		expect((res as any).error).toBe('“Paused Flow” is paused. Activate it before enrolling contacts.');
	});

	it('rejects an active automation with no steps', async () => {
		const aid = await makeAutomation('Empty Flow', 'active');
		const cid = await makeContact('empty@x.example.net');
		const res = await enrollContactsInAutomation(db, aid, [cid]);
		expect(res).toEqual({
			ok: false,
			error: 'Add at least one step to “Empty Flow” before enrolling contacts.'
		});
	});

	it('enrolls subscribed contacts, skips unsubscribed, and dedupes input ids', async () => {
		const aid = await makeAutomation('Live Flow', 'active');
		await step(aid);
		const c1 = await makeContact('a@x.example.net', 1);
		const c2 = await makeContact('b@x.example.net', 1);
		const c3 = await makeContact('c@x.example.net', 0); // unsubscribed

		// Duplicate ids in the input must not double-count.
		const res = await enrollContactsInAutomation(db, aid, [c1, c1, c2, c3]);
		expect(res).toMatchObject({ ok: true, enrolled: 2, skipped: 1, automationName: 'Live Flow' });
		expect(await enrollmentCount(aid)).toBe(2);

		// Repeat: all three are now "skipped" — two already active, one still unsubscribed.
		const again = await enrollContactsInAutomation(db, aid, [c1, c2, c3]);
		expect(again).toMatchObject({ ok: true, enrolled: 0, skipped: 3, automationName: 'Live Flow' });
		expect(await enrollmentCount(aid)).toBe(2);
	});

	it("reentry='multiple': enrolls again once the prior pass has ended", async () => {
		const aid = await makeAutomation('Loop Flow', 'active', 'multiple');
		await step(aid);
		const cid = await makeContact('loop@x.example.net');

		const first = await enrollContactsInAutomation(db, aid, [cid]);
		expect(first).toMatchObject({ ok: true, enrolled: 1, skipped: 0, automationName: 'Loop Flow' });

		// Still active → a second attempt is skipped (partial unique index).
		const whileActive = await enrollContactsInAutomation(db, aid, [cid]);
		expect(whileActive).toMatchObject({ ok: true, enrolled: 0, skipped: 1, automationName: 'Loop Flow' });

		// Complete the pass out from under the engine, then enroll again.
		await db
			.prepare(
				`UPDATE automation_enrollments SET status = 'completed', ended_at = datetime('now')
				 WHERE automation_id = ? AND contact_id = ?`
			)
			.bind(aid, cid)
			.run();

		const again = await enrollContactsInAutomation(db, aid, [cid]);
		expect(again).toMatchObject({ ok: true, enrolled: 1, skipped: 0, automationName: 'Loop Flow' });
		expect(await enrollmentCount(aid)).toBe(2);
	});
});

describe('listActiveAutomations', () => {
	it('returns only active automations, ordered by name', async () => {
		await makeAutomation('Zeta', 'active');
		await makeAutomation('Alpha', 'active');
		await makeAutomation('Draft Only', 'draft');
		await makeAutomation('Paused Only', 'paused');

		const rows = await listActiveAutomations(db);
		expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zeta']);
	});

	it('returns an empty list when nothing is active', async () => {
		await makeAutomation('Draft Only', 'draft');
		await makeAutomation('Paused Only', 'paused');
		expect(await listActiveAutomations(db)).toEqual([]);
	});
});
