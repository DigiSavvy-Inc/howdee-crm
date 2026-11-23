import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #395: automation engine safety — per-pass / per-visit send guard, unfinished steps held,
// full activation checks, safe list enrollment, NO for misconfigured conditions, NOCASE tag
// removal, step campaign kept in step with saves, auto-opens left out of "opened".
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', () => ({ sendBatch: spies.sendBatch, suppress: vi.fn() }));

import { addTag, enroll, tick } from '../src/lib/server/automations';
import { addStep } from '../src/lib/server/automation-write';
import { activationProblems, bulkSetStatus } from '../src/lib/server/automation-bulk';
import { ENROLL_REQUEST_CAP, processEnrollQueue } from '../src/lib/server/automation-enroll';
import { automationStepStats } from '../src/lib/server/automation-read';
import { actions } from '../src/routes/automations/[id]/+page.server';

const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const user = { kind: 'user' as const, id: null };
const APPLE = JSON.stringify({ UserAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/3.0', Client: { Name: 'Apple Mail' } });
const HUMAN = JSON.stringify({ UserAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', Client: { Name: 'Chrome' } });

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key = 'automation_enroll_queue'`)
	]);
});

async function automation(opts: { status?: string; reentry?: string; trigger?: string; listId?: number | null } = {}): Promise<number> {
	return (await db
		.prepare('INSERT INTO automations (name, status, reentry, trigger_type, trigger_list_id) VALUES (?, ?, ?, ?, ?) RETURNING id')
		.bind('Flow', opts.status ?? 'active', opts.reentry ?? 'once', opts.trigger ?? 'manual', opts.listId ?? null)
		.first<{ id: number }>())!.id;
}

type StepOpts = Record<string, string | number | null>;
async function step(aid: number, position: number, type: string, o: StepOpts = {}): Promise<number> {
	const cols: StepOpts = {
		automation_id: aid,
		position,
		type,
		delay_before_seconds: 0,
		subject: type === 'email' ? 'Hello' : '',
		body_md: type === 'email' ? 'Body' : '',
		from_email: type === 'email' ? 'alan@ourco.example' : '',
		...o
	};
	const keys = Object.keys(cols);
	return (await db
		.prepare(`INSERT INTO automation_steps (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`)
		.bind(...keys.map((k) => cols[k]))
		.first<{ id: number }>())!.id;
}

async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}

async function pass(aid: number, cid: number) {
	return db
		.prepare(
			`SELECT id, status, current_step_id, last_error, next_run_at <= datetime('now') AS due
			 FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1`
		)
		.bind(aid, cid)
		.first<{ id: number; status: string; current_step_id: number | null; last_error: string | null; due: number }>();
}

async function makeDue(aid: number) {
	await db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 seconds') WHERE automation_id = ? AND status = 'active'`).bind(aid).run();
}

async function tagsOf(cid: number): Promise<string[]> {
	const r = await db
		.prepare(`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = ? AND l.kind = 'tag' ORDER BY l.name`)
		.bind(cid)
		.all<{ name: string }>();
	return r.results.map((x) => x.name);
}

function ev(aid: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env: { ...(env as any), POSTMARK_FROM: 'alan@ourco.example' } },
		params: { id: String(aid) },
		locals: {},
		request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
	} as any;
}

const sends = () => spies.sendBatch.mock.calls.length;

describe('send guard is per pass and per visit (#395 P1.1)', () => {
	it("a 'multiple' re-entry gets the email on its second pass", async () => {
		const A = await automation({ reentry: 'multiple' });
		await step(A, 0, 'email');
		const c = await contact('twice@x.example.net');

		await enroll(db, A, [c]);
		await tick(db, cfg);
		expect((await pass(A, c))!.status).toBe('completed');
		expect(sends()).toBe(1);

		await enroll(db, A, [c]);
		await tick(db, cfg);
		expect(sends()).toBe(2);
		const rows = await db
			.prepare(`SELECT enrollment_id FROM recipients WHERE contact_id = ? AND status = 'accepted' ORDER BY id`)
			.bind(c)
			.all<{ enrollment_id: number }>();
		expect(new Set(rows.results.map((r) => r.enrollment_id)).size).toBe(2);
	});

	it('a go-to loop back to an email step sends it again', async () => {
		const A = await automation();
		const email = await step(A, 0, 'email');
		await step(A, 1, 'action', { action_kind: 'goto_step', target_step_id: email });
		const c = await contact('loop@x.example.net');
		await enroll(db, A, [c]);

		await tick(db, cfg); // send (visit 0) → goto
		await makeDue(A);
		await tick(db, cfg); // jump back (jump_count 1)
		await makeDue(A);
		await tick(db, cfg); // send again (visit 1)
		expect(sends()).toBe(2);
	});

	it('the first pass still de-dupes after a crash (accepted row for this visit already there)', async () => {
		const A = await automation();
		const email = await step(A, 0, 'email');
		await step(A, 1, 'tag', { tag_action: 'add', tag_name: 'after' });
		const c = await contact('crash@x.example.net');
		await enroll(db, A, [c]);
		const p = await pass(A, c);
		const camp = (await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id)
				 VALUES ('Hello', 'Body', '', 'alan@ourco.example', 'sent', ?, ?) RETURNING id`
			)
			.bind(A, email)
			.first<{ id: number }>())!.id;
		await db
			.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status, enrollment_id, enrollment_visit) VALUES (?, ?, 'crash@x.example.net', 'accepted', ?, 0)`)
			.bind(camp, c, p!.id)
			.run();

		await tick(db, cfg);
		expect(sends()).toBe(0);
		expect((await pass(A, c))!.current_step_id).not.toBe(email);
	});

	it('a pre-0099 row (no enrollment_id) de-dupes the first pass only', async () => {
		const A = await automation({ reentry: 'multiple' });
		const email = await step(A, 0, 'email');
		const c = await contact('legacy@x.example.net');
		const camp = (await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id)
				 VALUES ('Hello', 'Body', '', 'alan@ourco.example', 'sent', ?, ?) RETURNING id`
			)
			.bind(A, email)
			.first<{ id: number }>())!.id;
		await db.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'legacy@x.example.net', 'accepted')`).bind(camp, c).run();

		await enroll(db, A, [c]);
		await tick(db, cfg);
		expect(sends()).toBe(0); // first pass: the legacy row counts

		await enroll(db, A, [c]);
		await tick(db, cfg);
		expect(sends()).toBe(1); // second pass: it doesn't
	});
});

describe('unfinished steps are held (#395 P1.2)', () => {
	it('a builder-added step starts unfinished; end steps and steps added with fields are ready', async () => {
		const A = await automation({ status: 'draft' });
		const r: any = await actions.addStep(ev(A, { type: 'email' }));
		const bare = r.newStepId as number;
		const end = await addStep(db, A, { type: 'end' }, user);
		const full = await addStep(db, A, { type: 'tag', fields: { tag_action: 'add', tag_name: 'x' } }, user);
		const ready = async (id: number) => (await db.prepare('SELECT ready FROM automation_steps WHERE id = ?').bind(id).first<{ ready: number }>())!.ready;
		expect(await ready(bare)).toBe(0);
		expect(end.ok && (await ready(end.data.step_id))).toBe(1);
		expect(full.ok && (await ready(full.data.step_id))).toBe(1);
	});

	it('holds contacts at a not-ready step, then releases them when it is saved', async () => {
		const A = await automation();
		const email = await step(A, 0, 'email', { subject: '', body_md: '', ready: 0 });
		const c = await contact('held@x.example.net');
		await enroll(db, A, [c]);

		const s = await tick(db, cfg);
		expect(s.held).toBe(1);
		expect(sends()).toBe(0);
		let p = await pass(A, c);
		expect(p).toMatchObject({ status: 'active', current_step_id: email, last_error: 'Step not finished', due: 0 });

		const saved: any = await actions.updateStep(
			ev(A, { step_id: String(email), subject: 'Now', body_md: 'Done', from_email: 'alan@ourco.example', delay_value: '0', delay_unit: 'days' })
		);
		expect(saved.ok).toBe(true);
		p = await pass(A, c);
		expect(p).toMatchObject({ last_error: null, due: 1 });

		await tick(db, cfg);
		expect(sends()).toBe(1);
		expect((await pass(A, c))!.status).toBe('completed');
	});

	it('a save that fails validation keeps the step unfinished', async () => {
		const A = await automation();
		const email = await step(A, 0, 'email', { subject: '', body_md: '', ready: 0 });
		const r: any = await actions.updateStep(ev(A, { step_id: String(email), subject: '', body_md: '', from_email: 'a@b.example.net', delay_value: '0', delay_unit: 'days' }));
		expect(r.status).toBe(400);
		expect((await db.prepare('SELECT ready FROM automation_steps WHERE id = ?').bind(email).first<{ ready: number }>())!.ready).toBe(0);
	});

	it('deleting a not-ready step frees the contacts held there', async () => {
		const A = await automation();
		const bare = await step(A, 0, 'branch', { gate_kind: 'tag', ready: 0 });
		await step(A, 1, 'tag', { tag_action: 'add', tag_name: 'freed' });
		const c = await contact('free@x.example.net');
		await enroll(db, A, [c]);
		await tick(db, cfg);
		expect((await pass(A, c))!.last_error).toBe('Step not finished');

		await actions.deleteStep(ev(A, { step_id: String(bare) }));
		expect((await pass(A, c))!.last_error).toBeNull();
		await makeDue(A);
		await tick(db, cfg);
		expect(await tagsOf(c)).toEqual(['freed']);
	});
});

describe('activation checks (#395 P1.3)', () => {
	it('lists every problem with its step id, in canvas order', async () => {
		const other = await automation({ status: 'paused' });
		const A = await automation({ status: 'draft', trigger: 'site_visit' }); // no path set
		const unfinished = await step(A, 0, 'email', { ready: 0 });
		const noSubject = await step(A, 1, 'email', { subject: '' });
		const noTag = await step(A, 2, 'tag', { tag_action: 'add', tag_name: '' });
		const branch = await step(A, 3, 'branch', { gate_kind: 'tag', gate_name: '' });
		const deletedList = await step(A, 4, 'branch', { gate_kind: 'list-member', gate_ref_id: 999999 });
		const gotoNone = await step(A, 5, 'action', { action_kind: 'goto_step', target_step_id: null });
		const selfTarget = await step(A, 6, 'action', { action_kind: 'enroll_automation', target_automation_id: A });
		const fine = await step(A, 7, 'action', { action_kind: 'end_automation', target_automation_id: other });

		const problems = await activationProblems(db, A);
		expect(problems[0]).toMatchObject({ step_id: null });
		expect(problems[0].message).toMatch(/^Trigger: /);
		const ids = problems.map((p) => p.step_id);
		expect(ids).toEqual([null, unfinished, noSubject, noTag, branch, deletedList, gotoNone, selfTarget]);
		expect(ids).not.toContain(fine);
		expect(problems.find((p) => p.step_id === unfinished)!.message).toMatch(/^1\. .*isn’t finished/);
		expect(problems.find((p) => p.step_id === deletedList)!.message).toMatch(/no longer exists/);
	});

	it('a complete flow has no problems; triggers are checked', async () => {
		const A = await automation({ status: 'draft' });
		await step(A, 0, 'email');
		expect(await activationProblems(db, A)).toEqual([]);

		await db.prepare(`UPDATE automations SET trigger_type = 'pipeline_stage_entered', trigger_stage_id = 999999 WHERE id = ?`).bind(A).run();
		expect((await activationProblems(db, A)).map((p) => p.step_id)).toEqual([null]);
	});

	it('the activate action refuses with the list, and bulk activation skips', async () => {
		const A = await automation({ status: 'draft' });
		await step(A, 0, 'tag', { tag_action: 'add', tag_name: '' });
		const r: any = await actions.activate(ev(A, {}));
		expect(r.status).toBe(400);
		expect(r.data.activationProblems).toHaveLength(1);
		const bulk = await bulkSetStatus(db, [A], 'active');
		expect(bulk.changed).toBe(0);
		expect(bulk.skipped[0].reason).toMatch(/Choose a tag/);
		expect((await db.prepare('SELECT status FROM automations WHERE id = ?').bind(A).first<{ status: string }>())!.status).toBe('draft');
	});

	it('asks to confirm when contacts are overdue, then activates', async () => {
		const A = await automation({ status: 'paused' });
		await step(A, 0, 'email');
		await enroll(db, A, [await contact('due@x.example.net')]);

		const first: any = await actions.activate(ev(A, {}));
		expect(first).toEqual({ activateConfirm: { overdue: 1 } });
		expect((await db.prepare('SELECT status FROM automations WHERE id = ?').bind(A).first<{ status: string }>())!.status).toBe('paused');

		const second: any = await actions.activate(ev(A, { confirm: '1' }));
		expect(second).toEqual({ ok: true });
		expect((await db.prepare('SELECT status FROM automations WHERE id = ?').bind(A).first<{ status: string }>())!.status).toBe('active');
	});
});

describe('enroll from a list / segment (#395 P1.4)', () => {
	async function listOf(n: number): Promise<number> {
		const list = (await db.prepare(`INSERT INTO lists (name, kind) VALUES ('Big', 'list') RETURNING id`).first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO contacts (email)
				 WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
				 SELECT 'bulk' || i || '@x.example.net' FROM seq`
			)
			.bind(n)
			.run();
		await db.prepare(`INSERT INTO list_members (list_id, contact_id) SELECT ?, id FROM contacts WHERE email LIKE 'bulk%'`).bind(list).run();
		return list;
	}

	it('refuses unless the automation is active (403)', async () => {
		const A = await automation({ status: 'paused' });
		await step(A, 0, 'email');
		const list = await listOf(3);
		const r: any = await actions.enrollList(ev(A, { list_id: String(list), confirm: '1' }));
		expect(r.status).toBe(403);
		const n = await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments').first<{ n: number }>();
		expect(n!.n).toBe(0);
	});

	it('previews first, then enrolls in batches with confirm=1', async () => {
		const A = await automation();
		await step(A, 0, 'email', { delay_before_seconds: 3600 });
		const list = await listOf(200);
		await enroll(db, A, [(await db.prepare(`SELECT id FROM contacts WHERE email = 'bulk1@x.example.net'`).first<{ id: number }>())!.id]);

		const preview: any = await actions.enrollList(ev(A, { list_id: String(list) }));
		expect(preview.enrollPreview).toMatchObject({ members: 200, eligible: 200, already: 1, will_enroll: 199, now: 200, queued: 0 });
		const same: any = await actions.enrollPreview(ev(A, { list_id: String(list) }));
		expect(same.enrollPreview.will_enroll).toBe(199);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments').first<{ n: number }>())!.n).toBe(1);

		const done: any = await actions.enrollList(ev(A, { list_id: String(list), confirm: '1' }));
		expect(done).toMatchObject({ enrolled: 199, skipped: 1, queued: 0, enrollDone: true });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments').first<{ n: number }>())!.n).toBe(200);
	});

	it(`caps a request at ${ENROLL_REQUEST_CAP} and queues the rest for the heartbeat`, async () => {
		const A = await automation();
		await step(A, 0, 'email', { delay_before_seconds: 3600 });
		const list = await listOf(ENROLL_REQUEST_CAP + 50);

		const done: any = await actions.enrollList(ev(A, { list_id: String(list), confirm: '1' }));
		expect(done).toMatchObject({ enrolled: ENROLL_REQUEST_CAP, queued: 50 });
		const q = await processEnrollQueue(db);
		expect(q).toMatchObject({ jobs: 1, enrolled: 50, remaining: 0 });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments').first<{ n: number }>())!.n).toBe(ENROLL_REQUEST_CAP + 50);
		expect(await processEnrollQueue(db)).toMatchObject({ jobs: 0 });
	}, 120_000);

	it('a queued job is dropped once the automation is paused', async () => {
		const A = await automation();
		await step(A, 0, 'email', { delay_before_seconds: 3600 });
		const list = await listOf(ENROLL_REQUEST_CAP + 5);
		await actions.enrollList(ev(A, { list_id: String(list), confirm: '1' }));
		await db.prepare(`UPDATE automations SET status = 'paused' WHERE id = ?`).bind(A).run();
		expect(await processEnrollQueue(db)).toMatchObject({ jobs: 1, enrolled: 0, remaining: 0 });
	}, 120_000);
});

describe('engine consistency (#395 P2)', () => {
	it('remove-tag matches the tag name case-insensitively', async () => {
		const A = await automation();
		await step(A, 0, 'tag', { tag_action: 'remove', tag_name: 'vip' });
		const c = await contact('case@x.example.net');
		await addTag(db, 'VIP', c);
		await enroll(db, A, [c]);
		await tick(db, cfg);
		expect(await tagsOf(c)).toEqual([]);
	});

	it("saving an email step updates its campaign row's subject, body and From", async () => {
		const A = await automation();
		const email = await step(A, 0, 'email');
		await enroll(db, A, [await contact('arch@x.example.net')]);
		await tick(db, cfg);
		await actions.updateStep(
			ev(A, { step_id: String(email), subject: 'New subject', body_md: 'New **body**', from_email: 'alan@ourco.example', delay_value: '0', delay_unit: 'days' })
		);
		const camp = await db
			.prepare('SELECT subject, body_md, body_html FROM campaigns WHERE automation_step_id = ?')
			.bind(email)
			.first<{ subject: string; body_md: string; body_html: string }>();
		expect(camp!.subject).toBe('New subject');
		expect(camp!.body_md).toBe('New **body**');
		expect(camp!.body_html).toContain('<strong>body</strong>');
	});

	it('the opened branch and per-step opens leave out Apple Mail auto-opens (a click counts)', async () => {
		const A = await automation();
		const email = await step(A, 1, 'email', { delay_before_seconds: 99999 }); // referenced only
		const branch = await step(A, 0, 'branch', { gate_kind: 'opened', gate_ref_id: email });
		await step(A, 0, 'tag', { tag_action: 'add', tag_name: 'opened', parent_step_id: branch, branch_label: 'yes' });
		await step(A, 0, 'tag', { tag_action: 'add', tag_name: 'not-opened', parent_step_id: branch, branch_label: 'no' });

		const camp = (await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id, automation_step_id)
				 VALUES ('Hello', 'Body', '', 'alan@ourco.example', 'sent', ?, ?) RETURNING id`
			)
			.bind(A, email)
			.first<{ id: number }>())!.id;
		const people: Record<string, number> = {};
		for (const [who, type, detail] of [
			['apple', 'open', APPLE],
			['human', 'open', HUMAN],
			['clicker', 'click', APPLE]
		] as const) {
			const cid = await contact(`${who}@x.example.net`);
			people[who] = cid;
			const rid = (await db
				.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'accepted') RETURNING id`)
				.bind(camp, cid, `${who}@x.example.net`)
				.first<{ id: number }>())!.id;
			await db.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail) VALUES (?, ?, ?, ?, ?)').bind(camp, rid, cid, type, detail).run();
		}
		await enroll(db, A, Object.values(people));
		await tick(db, cfg); // branch decides → lane tag step
		await makeDue(A);
		await tick(db, cfg); // lane tag step runs
		expect(await tagsOf(people.apple)).toEqual(['not-opened']);
		expect(await tagsOf(people.human)).toEqual(['opened']);
		expect(await tagsOf(people.clicker)).toEqual(['opened']);

		const stats = await automationStepStats(db, A);
		expect(stats.find((s) => s.step_id === email)!.opens).toBe(2);
	});
});
