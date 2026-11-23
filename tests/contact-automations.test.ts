import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { load } from '../src/routes/contacts/[id]/+page.server';

// Contact page automation visibility: enrollment history (active + past passes)
// surfaced on /contacts/[id].
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
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

function loadEvent(contactId: number) {
	return {
		platform: { env },
		params: { id: String(contactId) },
		url: new URL(`https://app.test/contacts/${contactId}`)
	} as any;
}

async function makeContact(email: string): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id')
		.bind(email)
		.first<{ id: number }>();
	return c!.id;
}

async function makeAutomation(name: string): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status) VALUES (?, 'active') RETURNING id")
		.bind(name)
		.first<{ id: number }>();
	return a!.id;
}

async function makeEmailStep(aid: number, position: number, subject: string): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type)
			 VALUES (?, ?, ?, '', '', 'email') RETURNING id`
		)
		.bind(aid, position, subject)
		.first<{ id: number }>();
	return s!.id;
}

describe('contact page enrollments', () => {
	it('returns active + completed passes, active first, with name and step fields', async () => {
		const cid = await makeContact('drip@example.com');
		const welcomeId = await makeAutomation('Welcome flow');
		const stepId = await makeEmailStep(welcomeId, 0, 'Hi there');
		const oldId = await makeAutomation('Old flow');

		// Completed pass first (older), then the active one — order in the result must
		// come from the query, not insertion order.
		await db
			.prepare(
				`INSERT INTO automation_enrollments (automation_id, contact_id, status, enrolled_at, ended_at)
				 VALUES (?, ?, 'completed', '2026-01-01 00:00:00', '2026-01-02 00:00:00')`
			)
			.bind(oldId, cid)
			.run();
		await db
			.prepare(
				`INSERT INTO automation_enrollments
				   (automation_id, contact_id, status, current_step_id, next_run_at, enrolled_at)
				 VALUES (?, ?, 'active', ?, '2026-08-20 00:00:00', '2026-08-10 00:00:00')`
			)
			.bind(welcomeId, cid, stepId)
			.run();

		const data: any = await load(loadEvent(cid));
		expect(data.enrollments).toHaveLength(2);

		const [active, done] = data.enrollments;
		expect(active).toMatchObject({
			automation_id: welcomeId,
			automation_name: 'Welcome flow',
			status: 'active',
			next_run_at: '2026-08-20 00:00:00',
			step_type: 'email',
			step_subject: 'Hi there',
			step_position: 0
		});
		expect(done).toMatchObject({
			automation_id: oldId,
			automation_name: 'Old flow',
			status: 'completed',
			ended_at: '2026-01-02 00:00:00',
			step_type: null
		});
	});

	it('returns an empty array for a contact with no enrollments', async () => {
		const cid = await makeContact('quiet@example.com');
		const data: any = await load(loadEvent(cid));
		expect(data.enrollments).toEqual([]);
	});

	it('shows every pass of a re-entered automation, newest first', async () => {
		const cid = await makeContact('again@example.com');
		const aid = await makeAutomation('Re-entry flow');
		await db
			.prepare(
				`INSERT INTO automation_enrollments (automation_id, contact_id, status, enrolled_at, ended_at)
				 VALUES (?1, ?2, 'completed', '2026-02-01 00:00:00', '2026-02-05 00:00:00'),
				        (?1, ?2, 'cancelled', '2026-05-01 00:00:00', '2026-05-03 00:00:00')`
			)
			.bind(aid, cid)
			.run();

		const data: any = await load(loadEvent(cid));
		expect(data.enrollments).toHaveLength(2);
		expect(data.enrollments.map((e: any) => e.status)).toEqual(['cancelled', 'completed']);
		expect(data.enrollments.every((e: any) => e.automation_id === aid)).toBe(true);
	});
});
