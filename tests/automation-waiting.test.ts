import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { GET as waiting } from '../src/routes/automations/[id]/waiting/+server';

// #124: the step card's "N waiting here" pill opens a popover listing the contacts
// currently parked at that step. This covers the session gate + the query (ordering,
// status filter, paging, bad input, cross-automation isolation).
const db = (env as any).DB as D1Database;

const jsonOf = async (res: Response): Promise<any> => JSON.parse(await res.text());

const PREFIX = 'waiting-test-';

async function cleanup() {
	await db.batch([
		db.prepare(`DELETE FROM automation_enrollments WHERE contact_id IN (SELECT id FROM contacts WHERE email LIKE ?)`).bind(`${PREFIX}%`),
		db.prepare(`DELETE FROM automation_steps WHERE automation_id IN (SELECT id FROM automations WHERE name LIKE ?)`).bind(`${PREFIX}%`),
		db.prepare(`DELETE FROM automations WHERE name LIKE ?`).bind(`${PREFIX}%`),
		db.prepare(`DELETE FROM contacts WHERE email LIKE ?`).bind(`${PREFIX}%`)
	]);
}

function ev(automationId: number, params: Record<string, string>, user: { id: number } | null = { id: 1 }) {
	const url = new URL(`https://app.test/automations/${automationId}/waiting`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return {
		request: new Request(url),
		platform: { env },
		url,
		params: { id: String(automationId) },
		locals: { user, authed: !!user }
	} as any;
}

async function makeAutomation(name: string): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status) VALUES (?, 'active') RETURNING id")
		.bind(name)
		.first<{ id: number }>();
	return a!.id;
}

async function addStep(aid: number, position: number): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email)
			 VALUES (?, ?, 0, 'email', 'Subj', 'Body', 'f@x.example.net') RETURNING id`
		)
		.bind(aid, position)
		.first<{ id: number }>();
	return s!.id;
}

async function makeContact(email: string): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>();
	return c!.id;
}

async function enroll(
	automationId: number,
	contactId: number,
	stepId: number | null,
	opts: { status?: string; nextRunAt?: string | null; attempts?: number; lastError?: string | null } = {}
) {
	const { status = 'active', nextRunAt = null, attempts = 0, lastError = null } = opts;
	await db
		.prepare(
			`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, next_run_at, attempts, last_error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(automationId, contactId, stepId, status, nextRunAt, attempts, lastError)
		.run();
}

describe('GET /automations/[id]/waiting (#124)', () => {
	beforeEach(cleanup);

	it('401s with no session user', async () => {
		const aid = await makeAutomation(`${PREFIX}auth`);
		const res = await waiting(ev(aid, { step: '1' }, null));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
	});

	it('400s on a bad step param', async () => {
		const aid = await makeAutomation(`${PREFIX}badstep`);
		expect((await waiting(ev(aid, { step: 'abc' }))).status).toBe(400);
		expect((await waiting(ev(aid, {}))).status).toBe(400);
		expect((await waiting(ev(aid, { step: '0' }))).status).toBe(400);
	});

	it('returns active enrollments at a step, ordered by next_run_at, excluding other statuses/steps', async () => {
		const aid = await makeAutomation(`${PREFIX}flow`);
		const step1 = await addStep(aid, 0);
		const step2 = await addStep(aid, 1);

		const c1 = await makeContact(`${PREFIX}c1@qa.test`);
		const c2 = await makeContact(`${PREFIX}c2@qa.test`);
		const c3 = await makeContact(`${PREFIX}c3@qa.test`);
		const c4 = await makeContact(`${PREFIX}c4@qa.test`); // at step 2
		const c5 = await makeContact(`${PREFIX}c5@qa.test`); // completed at step 1 — excluded

		// Deliberately out of insertion order so we can assert sort-by-next_run_at.
		await enroll(aid, c1, step1, { nextRunAt: '2026-01-03 00:00:00' });
		await enroll(aid, c2, step1, { nextRunAt: '2026-01-01 00:00:00' });
		await enroll(aid, c3, step1, { nextRunAt: '2026-01-02 00:00:00' });
		await enroll(aid, c4, step2, { nextRunAt: '2026-01-01 00:00:00' });
		await enroll(aid, c5, step1, { status: 'completed', nextRunAt: null });

		const res1 = await waiting(ev(aid, { step: String(step1) }));
		expect(res1.status).toBe(200);
		const body1 = await jsonOf(res1);
		expect(body1.total).toBe(3);
		expect(body1.rows.map((r: any) => r.contact_id)).toEqual([c2, c3, c1]);
		expect(body1.rows.every((r: any) => r.email)).toBe(true);
		expect(typeof body1.now).toBe('string');

		const res2 = await waiting(ev(aid, { step: String(step2) }));
		const body2 = await jsonOf(res2);
		expect(body2.total).toBe(1);
		expect(body2.rows[0].contact_id).toBe(c4);
	});

	it('pages with limit/offset', async () => {
		const aid = await makeAutomation(`${PREFIX}paged`);
		const step1 = await addStep(aid, 0);
		const c1 = await makeContact(`${PREFIX}p1@qa.test`);
		const c2 = await makeContact(`${PREFIX}p2@qa.test`);
		const c3 = await makeContact(`${PREFIX}p3@qa.test`);
		await enroll(aid, c1, step1, { nextRunAt: '2026-01-01 00:00:00' });
		await enroll(aid, c2, step1, { nextRunAt: '2026-01-02 00:00:00' });
		await enroll(aid, c3, step1, { nextRunAt: '2026-01-03 00:00:00' });

		const res = await waiting(ev(aid, { step: String(step1), limit: '2', offset: '2' }));
		const body = await jsonOf(res);
		expect(body.total).toBe(3);
		expect(body.rows).toHaveLength(1);
		expect(body.rows[0].contact_id).toBe(c3);
		expect(body.limit).toBe(2);
		expect(body.offset).toBe(2);
	});

	it('returns 0 total for a step id that belongs to a different automation', async () => {
		const aid1 = await makeAutomation(`${PREFIX}own`);
		const aid2 = await makeAutomation(`${PREFIX}other`);
		const step1 = await addStep(aid1, 0);
		const c1 = await makeContact(`${PREFIX}cross@qa.test`);
		await enroll(aid1, c1, step1, { nextRunAt: '2026-01-01 00:00:00' });

		const res = await waiting(ev(aid2, { step: String(step1) }));
		const body = await jsonOf(res);
		expect(body.total).toBe(0);
		expect(body.rows).toEqual([]);
	});

	it('surfaces attempts + last_error for a retrying enrollment', async () => {
		const aid = await makeAutomation(`${PREFIX}retry`);
		const step1 = await addStep(aid, 0);
		const c1 = await makeContact(`${PREFIX}retrying@qa.test`);
		await enroll(aid, c1, step1, { nextRunAt: '2026-01-01 00:00:00', attempts: 2, lastError: 'Postmark 406' });

		const res = await waiting(ev(aid, { step: String(step1) }));
		const body = await jsonOf(res);
		expect(body.rows[0]).toMatchObject({ contact_id: c1, attempts: 2, last_error: 'Postmark 406' });
	});
});
