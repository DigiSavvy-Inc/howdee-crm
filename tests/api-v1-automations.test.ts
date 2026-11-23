import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listAutomations } from '../src/routes/api/v1/automations/+server';
import { POST as enrollAutomation } from '../src/routes/api/v1/automations/[id]/enroll/+server';
import { GET as contactAutomations } from '../src/routes/api/v1/contacts/[id]/automations/+server';

// #99: automations over the Data API — list, hand-picked enroll (contact_ids/emails),
// and a contact's enrollment passes.
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
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

async function makeKey(scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`)
		.bind('t', k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function ev(path: string, method: string, token: string | undefined, body?: unknown, params: Record<string, string> = {}) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		platform: { env },
		url,
		params
	} as any;
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

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

describe('auth gating', () => {
	it('401 without a key on list', async () => {
		expect((await listAutomations(ev('/api/v1/automations', 'GET', undefined))).status).toBe(401);
	});

	it('403 for a read-scope key on POST enroll', async () => {
		const aid = await makeAutomation('Scope Flow', 'active');
		await step(aid);
		const token = await makeKey('read');
		const res = await enrollAutomation(
			ev(`/api/v1/automations/${aid}/enroll`, 'POST', token, { contact_ids: [1] }, { id: String(aid) })
		);
		expect(res.status).toBe(403);
	});
});

describe('GET /api/v1/automations', () => {
	it('lists seeded automations with status, step_count, active_enrollments; supports ?status=', async () => {
		const activeId = await makeAutomation('Active Flow', 'active');
		await step(activeId);
		const pausedId = await makeAutomation('Paused Flow', 'paused');
		await step(pausedId);
		const cid = await makeContact('seeded@qa.test');
		const token = await makeKey('read');

		const all = await jsonOf(await listAutomations(ev('/api/v1/automations', 'GET', token)));
		const active = all.data.find((a: any) => a.id === activeId);
		const paused = all.data.find((a: any) => a.id === pausedId);
		expect(active).toMatchObject({ name: 'Active Flow', status: 'active', step_count: 1, active_enrollments: 0 });
		expect(paused).toMatchObject({ name: 'Paused Flow', status: 'paused', step_count: 1 });

		await enrollAutomation(ev(`/api/v1/automations/${activeId}/enroll`, 'POST', await makeKey('read_write'), { contact_ids: [cid] }, { id: String(activeId) }));
		const afterEnroll = await jsonOf(await listAutomations(ev('/api/v1/automations', 'GET', token)));
		expect(afterEnroll.data.find((a: any) => a.id === activeId).active_enrollments).toBe(1);

		const filtered = await jsonOf(await listAutomations(ev('/api/v1/automations?status=active', 'GET', token)));
		expect(filtered.data.map((a: any) => a.id)).toContain(activeId);
		expect(filtered.data.map((a: any) => a.id)).not.toContain(pausedId);

		expect((await listAutomations(ev('/api/v1/automations?status=bogus', 'GET', token))).status).toBe(400);
	});
});

describe('POST /api/v1/automations/:id/enroll', () => {
	it('404 for an unknown automation id', async () => {
		const token = await makeKey('read_write');
		const res = await enrollAutomation(ev('/api/v1/automations/999999/enroll', 'POST', token, { contact_ids: [1] }, { id: '999999' }));
		expect(res.status).toBe(404);
	});

	it('409 for a paused automation, naming the status', async () => {
		const aid = await makeAutomation('Paused Here', 'paused');
		await step(aid);
		const cid = await makeContact('paused-target@qa.test');
		const token = await makeKey('read_write');
		const res = await enrollAutomation(ev(`/api/v1/automations/${aid}/enroll`, 'POST', token, { contact_ids: [cid] }, { id: String(aid) }));
		expect(res.status).toBe(409);
		expect((await jsonOf(res)).error).toMatch(/paused/);
	});

	it('400 on empty body, invalid JSON, and over-cap identifier counts', async () => {
		const aid = await makeAutomation('Validation Flow', 'active');
		await step(aid);
		const token = await makeKey('read_write');

		expect((await enrollAutomation(ev(`/api/v1/automations/${aid}/enroll`, 'POST', token, {}, { id: String(aid) }))).status).toBe(400);

		const badJson = ev(`/api/v1/automations/${aid}/enroll`, 'POST', token, undefined, { id: String(aid) });
		badJson.request = new Request(badJson.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: '{not json'
		});
		expect((await enrollAutomation(badJson)).status).toBe(400);

		const tooMany = Array.from({ length: 501 }, (_, i) => i + 1);
		const over = await enrollAutomation(ev(`/api/v1/automations/${aid}/enroll`, 'POST', token, { contact_ids: tooMany }, { id: String(aid) }));
		expect(over.status).toBe(400);
	});

	it('happy path: 2 contact_ids (1 unsubscribed) + 1 known email + 1 unknown email', async () => {
		const aid = await makeAutomation('Live Flow', 'active');
		await step(aid);
		const subId = await makeContact('sub@qa.test', 1);
		const unsubId = await makeContact('unsub@qa.test', 0);
		const emailOnlyId = await makeContact('emailonly@qa.test', 1);
		const token = await makeKey('read_write');

		const res = await enrollAutomation(
			ev(
				`/api/v1/automations/${aid}/enroll`,
				'POST',
				token,
				{ contact_ids: [subId, unsubId], emails: ['emailonly@qa.test', 'nobody@qa.test'] },
				{ id: String(aid) }
			)
		);
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(body.data).toMatchObject({
			automation: { id: aid, name: 'Live Flow' },
			enrolled: 2,
			skipped: 1,
			unknown_emails: ['nobody@qa.test']
		});
		void emailOnlyId;

		// Repeat: both already-enrolled contacts are now skipped (active pass + unsubscribed).
		const again = await enrollAutomation(
			ev(
				`/api/v1/automations/${aid}/enroll`,
				'POST',
				token,
				{ contact_ids: [subId, unsubId], emails: ['emailonly@qa.test', 'nobody@qa.test'] },
				{ id: String(aid) }
			)
		);
		const againBody = await jsonOf(again);
		expect(againBody.data.enrolled).toBe(0);
	});

	it('200 with enrolled:0 when every identifier is an unknown email', async () => {
		const aid = await makeAutomation('Unknown Only Flow', 'active');
		await step(aid);
		const token = await makeKey('read_write');
		const res = await enrollAutomation(
			ev(`/api/v1/automations/${aid}/enroll`, 'POST', token, { emails: ['ghost@qa.test'] }, { id: String(aid) })
		);
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(body.data).toMatchObject({ enrolled: 0, skipped: 0, unknown_emails: ['ghost@qa.test'] });
	});
});

describe('GET /api/v1/contacts/:id/automations', () => {
	it('shows an active pass, and 404s for a missing contact', async () => {
		const aid = await makeAutomation('Pass Flow', 'active');
		await step(aid);
		const cid = await makeContact('passholder@qa.test');
		const rwToken = await makeKey('read_write');
		await enrollAutomation(ev(`/api/v1/automations/${aid}/enroll`, 'POST', rwToken, { contact_ids: [cid] }, { id: String(aid) }));

		const token = await makeKey('read');
		const res = await contactAutomations(ev(`/api/v1/contacts/${cid}/automations`, 'GET', token, undefined, { id: String(cid) }));
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({ automation_id: aid, automation_name: 'Pass Flow', status: 'active' });

		const missing = await contactAutomations(ev('/api/v1/contacts/999999/automations', 'GET', token, undefined, { id: '999999' }));
		expect(missing.status).toBe(404);
	});
});
