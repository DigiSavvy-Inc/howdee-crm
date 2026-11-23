import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import {
	DISCARD_MESSAGE,
	deleteMessage,
	dueIn,
	fingerprint,
	isDirty,
	mayClose,
	reorderLane,
	splitWait,
	statusLine,
	waitNodeText,
	waitSeconds
} from '../src/lib/automation-editor';
import { parseApprovedSenders, senderAllowed, senderOptions } from '../src/lib/approved-senders';
import { addStep, readSpec, restoreStepSnapshot, deleteStep, duplicateStep, stepSnapshot, type Actor } from '../src/lib/server/automation-write';
import { saveStepUndo, takeStepUndo } from '../src/lib/server/step-undo';
import { enrollPreviewCount, enrollmentPage } from '../src/lib/server/automation-read';
import { actions } from '../src/routes/automations/[id]/+page.server';

// #396: automation editor polish — pure helpers (unsaved-changes guard, delete + undo, lane
// reorder, wait nodes, status strip, From picker) and the server side (branch duplicate,
// undo restore, inspector paging, enroll preview, test send, retry all failed, inline wait).
const db = (env as any).DB as D1Database;
const actor: Actor = { kind: 'system' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare("DELETE FROM app_state WHERE key LIKE 'step_undo:%' OR key IN ('approved_senders', 'default_from')")
	]);
	spies.sendBatch.mockReset();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map(() => ({ ErrorCode: 0, Message: 'OK', MessageID: 'm' })));
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;
const automation = async (status = 'active', reentry = 'once') =>
	(await one<{ id: number }>("INSERT INTO automations (name, status, reentry) VALUES ('Flow', ?, ?) RETURNING id", status, reentry)).id;
const contact = async (email: string, extra = '') =>
	(await one<{ id: number }>(`INSERT INTO contacts (email, subscribed${extra ? ', archived_at' : ''}) VALUES (?, ?${extra ? ", datetime('now')" : ''}) RETURNING id`, email, 1)).id;

const platformEnv = { ...(env as any), POSTMARK_TOKEN: 'srv', POSTMARK_STREAM: 'broadcast', POSTMARK_FROM: 'alan@ourco.example', SESSION_SECRET: 'sec', PUBLIC_BASE_URL: 'https://app.test' };
function ev(aid: number, fields: Record<string, string | string[]>, user: { id: number; role: string } | null = null) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
	const url = new URL(`https://app.test/automations/${aid}`);
	return { platform: { env: platformEnv }, params: { id: String(aid) }, url, locals: { user }, request: new Request(url, { method: 'POST', body: fd }) } as any;
}

describe('pure helpers', () => {
	it('unsaved-changes guard: a fingerprint ignores key order; closing asks only when dirty', () => {
		expect(fingerprint({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(fingerprint({ b: [1, { x: 1, y: 2 }], a: 1 }));
		const base = fingerprint({ subject: 'Hi' });
		expect(isDirty(base, fingerprint({ subject: 'Hi' }))).toBe(false);
		expect(isDirty(base, fingerprint({ subject: 'Hello' }))).toBe(true);
		expect(isDirty(null, fingerprint({ subject: 'x' }))).toBe(false); // not baselined yet

		const confirm = vi.fn(() => false);
		expect(mayClose(false, confirm)).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(mayClose(true, confirm)).toBe(false);
		expect(confirm).toHaveBeenCalledWith(DISCARD_MESSAGE);
		expect(mayClose(true, () => true)).toBe(true);
	});

	it('every delete has a confirm message', () => {
		expect(deleteMessage('tag', 0)).toMatch(/^Delete this step\?/);
		expect(deleteMessage('email', 3)).toMatch(/^3 contacts are waiting/);
		expect(deleteMessage('branch', 0)).toMatch(/YES\/NO paths/);
		for (const m of [deleteMessage('tag', 0), deleteMessage('email', 1), deleteMessage('branch', 2)]) expect(m).toMatch(/undo/);
	});

	it('reorderLane moves within the lane only', () => {
		expect(reorderLane([1, 2, 3], 3, 1)).toEqual([3, 1, 2]);
		expect(reorderLane([1, 2, 3], 1, 3)).toEqual([2, 3, 1]);
		expect(reorderLane([1, 2, 3], 2, 2)).toBeNull();
		expect(reorderLane([1, 2, 3], 9, 1)).toBeNull();
	});

	it('wait nodes', () => {
		expect(splitWait(2 * 86400)).toEqual({ value: 2, unit: 'days' });
		expect(splitWait(5400)).toEqual({ value: 90, unit: 'minutes' });
		expect(waitSeconds(3, 'hours')).toBe(10800);
		expect(waitNodeText(0, false, 'email')).toBe('No wait');
		expect(waitNodeText(2 * 86400, true, 'email')).toBe('Wait 2 days · weekdays');
		expect(waitNodeText(3600, false, 'branch')).toBe('Wait 1 hour, then check');
	});

	it('status strip', () => {
		const now = '2026-10-21T12:00:00.000Z';
		const live = statusLine({ status: 'active', since: '2026-10-03 09:00:00', waiting: 12, nextRunAt: '2026-10-21 12:05:00', now });
		expect(live.title).toBe('Live since Oct 3, 2026');
		expect(live.detail).toBe('12 contacts waiting · next step due in ~5 min');
		expect(statusLine({ status: 'active', since: null, waiting: 0, nextRunAt: null, now }).detail).toBe('Nobody waiting');
		expect(statusLine({ status: 'paused', since: null, waiting: 1, nextRunAt: null, now })).toMatchObject({ title: 'Paused', detail: '1 contact held in place' });
		expect(statusLine({ status: 'draft', since: '2026-10-01 00:00:00', waiting: 0, nextRunAt: null, now }).title).toBe('Draft · created Oct 1, 2026');
		expect(dueIn('2026-10-21 11:00:00', now)).toBe('now');
		expect(dueIn('2026-10-21 15:00:00', now)).toBe('~3 h');
	});

	it('From picker: approved addresses, the current value kept + flagged', () => {
		const approved = parseApprovedSenders('alan@ourco.example, ourco.example, hi@other.example.net');
		expect(senderAllowed('ANYONE@ourco.example', approved)).toBe(true);
		expect(senderAllowed('x@gmail.com', approved)).toBe(false);
		const r = senderOptions(approved, ['alan@ourco.example', 'team@ourco.example', 'old@gone.example.net'], 'old@gone.example.net');
		expect(r.options).toEqual([
			{ value: 'old@gone.example.net', approved: false },
			{ value: 'alan@ourco.example', approved: true },
			{ value: 'hi@other.example.net', approved: true },
			{ value: 'team@ourco.example', approved: true }
		]);
		expect(r.other).toBe(true); // a domain entry → "Other address…"
		expect(senderOptions(parseApprovedSenders('a@b.example.net'), [], 'a@b.example.net').other).toBe(false);
		expect(senderOptions(parseApprovedSenders(''), [], 'x@y.example.net').options).toEqual([{ value: 'x@y.example.net', approved: true }]);
	});
});

describe('branch duplicate + delete undo', () => {
	async function flow() {
		const aid = await automation('draft');
		const first = await addStep(db, aid, { type: 'email', fields: { subject: 'Welcome', from_email: 'alan@ourco.example', body_md: 'Hi' } }, actor);
		const branch = await addStep(db, aid, { type: 'branch', fields: { wait_seconds: 3600, condition: { kind: 'opened', step_id: first.ok ? first.data.step_id : 0 } } }, actor);
		if (!first.ok || !branch.ok) throw new Error('setup');
		const b = branch.data.step_id;
		const yesMail = await addStep(db, aid, { type: 'email', parent_step_id: b, branch_label: 'yes', fields: { subject: 'Thanks', from_email: 'alan@ourco.example', body_md: 'Yay' } }, actor);
		if (!yesMail.ok) throw new Error('setup');
		// A go-to in the NO lane points at the YES email (inside the subtree).
		await addStep(db, aid, { type: 'action', parent_step_id: b, branch_label: 'no', fields: { action: { kind: 'goto_step', step_id: yesMail.data.step_id } } }, actor);
		const tail = await addStep(db, aid, { type: 'tag', fields: { tag_name: 'done' } }, actor);
		if (!tail.ok) throw new Error('setup');
		return { aid, first: first.data.step_id, b, yesMail: yesMail.data.step_id, tail: tail.data.step_id };
	}

	it('duplicates a condition with both lanes; refs inside the copy point at the copies', async () => {
		const { aid, b, yesMail } = await flow();
		const r = await duplicateStep(db, aid, { step_id: b }, actor);
		if (!r.ok) throw new Error(r.error);
		const spec = await readSpec(db, aid);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps.map((s) => s.type)).toEqual(['email', 'branch', 'branch', 'tag']);
		const [orig, copy] = [spec.data.steps[1], spec.data.steps[2]];
		expect(copy.wait_seconds).toBe(3600);
		expect(copy.yes!.map((s) => s.subject)).toEqual(['Thanks']);
		expect(copy.no!.map((s) => s.type)).toEqual(['action']);
		// Both conditions still check the (outside) Welcome email.
		expect((copy.condition as { step_ref: string }).step_ref).toBe((orig.condition as { step_ref: string }).step_ref);
		// The copied go-to targets the copied YES email, not the original.
		const copyGoto = await one<{ target_step_id: number }>(
			"SELECT target_step_id FROM automation_steps WHERE parent_step_id = ? AND branch_label = 'no'",
			r.data.step_id
		);
		expect(copyGoto.target_step_id).not.toBe(yesMail);
		const target = await one<{ parent_step_id: number }>('SELECT parent_step_id FROM automation_steps WHERE id = ?', copyGoto.target_step_id);
		expect(target.parent_step_id).toBe(r.data.step_id);
	});

	it('undo puts a deleted condition back in place, lanes and outside references included', async () => {
		const { aid, b, first } = await flow();
		// Another step outside the subtree that jumps INTO it.
		const outside = await addStep(db, aid, { type: 'action', fields: { action: { kind: 'goto_step', step_id: b } } }, actor);
		if (!outside.ok) throw new Error('setup');
		const before = await readSpec(db, aid);

		const snap = await stepSnapshot(db, aid, b);
		expect(snap!.rows.map((r) => r.type).sort()).toEqual(['action', 'branch', 'email']);
		expect(snap!.rows[0].id).toBe(b); // the root first, then its lanes
		const del = await deleteStep(db, aid, { step_id: b }, actor);
		expect(del.ok && del.data.deleted.length).toBe(3);
		const token = await saveStepUndo(db, snap!);

		expect(await takeStepUndo(db, aid + 1, token)).toBeNull(); // another automation
		const back = await takeStepUndo(db, aid, token);
		expect(back).not.toBeNull();
		expect(await takeStepUndo(db, aid, token)).toBeNull(); // one-time

		const r = await restoreStepSnapshot(db, aid, back!, actor);
		if (!r.ok) throw new Error(r.error);
		const after = await readSpec(db, aid);
		expect(after).toEqual(before);
		const g = await one<{ target_step_id: number }>('SELECT target_step_id FROM automation_steps WHERE id = ?', outside.data.step_id);
		expect(g.target_step_id).toBe(r.data.step_id);
		void first;
	});

	it('the delete action returns an undo token and restoreStep redeems it once', async () => {
		const { aid, tail } = await flow();
		const del = (await actions.deleteStep(ev(aid, { step_id: String(tail) }))) as any;
		expect(del.undoToken).toMatch(/^[0-9a-f-]{36}$/);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_steps WHERE id = ?', tail)).n).toBe(0);
		const ok = (await actions.restoreStep(ev(aid, { token: del.undoToken }))) as any;
		expect(ok.restoredStep).toBeGreaterThan(0);
		const spec = await readSpec(db, aid);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps.at(-1)).toMatchObject({ type: 'tag', tag_name: 'done' });
		const again = (await actions.restoreStep(ev(aid, { token: del.undoToken }))) as any;
		expect(again.status).toBe(400);
	});

	it('the inline wait changes only the wait; reorder works inside a lane', async () => {
		const { aid, b, yesMail } = await flow();
		await actions.setWait(ev(aid, { step_id: String(yesMail), delay_value: '2', delay_unit: 'days', weekday_only: '1' }));
		const s = await one<{ delay_before_seconds: number; weekday_only: number; subject: string }>(
			'SELECT delay_before_seconds, weekday_only, subject FROM automation_steps WHERE id = ?',
			yesMail
		);
		expect(s).toEqual({ delay_before_seconds: 172800, weekday_only: 1, subject: 'Thanks' });

		const extra = await addStep(db, aid, { type: 'tag', parent_step_id: b, branch_label: 'yes', fields: { tag_name: 'x' } }, actor);
		if (!extra.ok) throw new Error('setup');
		const r = (await actions.reorderSteps(ev(aid, { order: `${extra.data.step_id},${yesMail}`, parent_step_id: String(b), branch_label: 'yes' }))) as any;
		expect(r.ok).toBe(true);
		const spec = await readSpec(db, aid);
		if (!spec.ok) throw new Error(spec.error);
		expect(spec.data.steps[1].yes!.map((x) => x.type)).toEqual(['tag', 'email']);
	});
});

describe('inspector + enroll preview', () => {
	it('filters and pages in SQL, past the newest 100', async () => {
		const aid = await automation();
		const step = (await one<{ id: number }>("INSERT INTO automation_steps (automation_id, position, type, subject, body_md, from_email) VALUES (?, 0, 'email', 's', 'b', 'f@x.example.net') RETURNING id", aid)).id;
		for (let i = 0; i < 120; i++) {
			const c = await contact(`p${String(i).padStart(3, '0')}@insp.test`);
			await db
				.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, enrolled_at) VALUES (?, ?, ?, ?, datetime('now', ?))")
				.bind(aid, c, step, i === 0 ? 'failed' : 'completed', `-${i} minutes`)
				.run();
		}
		const p1 = await enrollmentPage(db, aid, { limit: 50 });
		expect(p1.total).toBe(120);
		expect(p1.rows).toHaveLength(50);
		const p3 = await enrollmentPage(db, aid, { limit: 50, offset: 100 });
		expect(p3.rows).toHaveLength(20);
		// The oldest enrollment is findable by search.
		const oldest = await enrollmentPage(db, aid, { q: 'P119@' });
		expect(oldest.rows.map((r) => r.email)).toEqual(['p119@insp.test']);
		expect((await enrollmentPage(db, aid, { status: 'failed' })).rows.map((r) => r.email)).toEqual(['p000@insp.test']);
		expect((await enrollmentPage(db, aid, { stepId: step + 1 })).total).toBe(0);
		expect((await enrollmentPage(db, aid, { q: '100%' })).total).toBe(0); // LIKE wildcards escaped
	});

	it('enroll preview counts what enroll() would start', async () => {
		const aid = await automation('active', 'once');
		const a = await contact('a@prev.test');
		const b = await contact('b@prev.test');
		const archived = await contact('c@prev.test', 'archived');
		const unsub = (await one<{ id: number }>("INSERT INTO contacts (email, subscribed) VALUES ('d@prev.test', 0) RETURNING id")).id;
		await db.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status) VALUES (?, ?, 'completed')").bind(aid, b).run();
		expect(await enrollPreviewCount(db, aid, [a, b, archived, unsub, a])).toMatchObject({ total: 4, eligible: 1 });
		await db.prepare("UPDATE automations SET reentry = 'multiple' WHERE id = ?").bind(aid).run();
		expect(await enrollPreviewCount(db, aid, [a, b])).toMatchObject({ total: 2, eligible: 2 });

		const list = (await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES ('Prev', 'list') RETURNING id")).id;
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?), (?, ?)').bind(list, a, list, unsub).run();
		// #395: a list preview is refused until the automation has a step.
		const noSteps = (await actions.enrollPreview(ev(aid, { list_id: String(list) }))) as any;
		expect(noSteps.status).toBe(400);
		await db
			.prepare("INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 't', '', '', '')")
			.bind(aid)
			.run();
		const r = (await actions.enrollPreview(ev(aid, { list_id: String(list) }))) as any;
		expect(r.preview).toMatchObject({ total: 2, eligible: 1 });
		expect(r.enrollPreview).toMatchObject({ members: 2, eligible: 1, already: 0, will_enroll: 1 });
		// Hand-picked contacts are counted with enroll()'s rules.
		const picked = (await actions.enrollPreview(ev(aid, { contact_ids: [String(a), String(unsub)] }))) as any;
		expect(picked.preview).toMatchObject({ total: 2, eligible: 1 });
	});

	it('retry all failed: the newest failed pass per contact, none with an active pass', async () => {
		const aid = await automation();
		const step = (await one<{ id: number }>("INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email) VALUES (?, 0, 'tag', 'add', 't', '', '', '') RETURNING id", aid)).id;
		const x = await contact('x@retry.test');
		const y = await contact('y@retry.test');
		const ins = (cid: number, status: string) =>
			db.prepare('INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, attempts) VALUES (?, ?, ?, ?, 3)').bind(aid, cid, step, status).run();
		await ins(x, 'failed');
		await ins(x, 'failed');
		await ins(y, 'failed');
		await ins(y, 'active');
		const r = (await actions.retryAllFailed(ev(aid, {}))) as any;
		expect(r).toEqual({ retried: 1, stillFailed: 2 });
		const xs = await db.prepare("SELECT status FROM automation_enrollments WHERE contact_id = ? ORDER BY id").bind(x).all<{ status: string }>();
		expect(xs.results.map((s) => s.status)).toEqual(['failed', 'active']);
	});
});

describe('email step test send', () => {
	async function emailStep() {
		const aid = await automation('draft');
		const sid = (await one<{ id: number }>("INSERT INTO automation_steps (automation_id, position, type, subject, body_md, from_email) VALUES (?, 0, 'email', 'Saved', 'b', 'alan@ourco.example') RETURNING id", aid)).id;
		return { aid, sid };
	}
	const fields = (sid: number, extra: Record<string, string> = {}) => ({ step_id: String(sid), subject: 'Draft subject', from_email: 'alan@ourco.example', body_md: 'Hello {{first_name}}', ...extra });

	it('sends the drawer content to the signed-in user with the unsubscribe headers — never a posted address', async () => {
		const { aid, sid } = await emailStep();
		const uid = (await one<{ id: number }>("INSERT INTO users (github_login, role, email) VALUES ('t396-m', 'member', 'member396@example.com') RETURNING id")).id;
		const r = (await actions.testStep(ev(aid, fields(sid, { test_to: 'victim@example.com', to: 'victim@example.com' }), { id: uid, role: 'member' }))) as any;
		expect(r).toMatchObject({ testSuccess: true, testTo: 'member396@example.com' });
		const [m] = spies.sendBatch.mock.calls[0][1] as { To: string; Subject: string; Headers: { Name: string; Value: string }[]; HtmlBody: string }[];
		expect(m.To).toBe('member396@example.com');
		expect(m.Subject).toBe('[TEST] Draft subject');
		expect(m.Headers.map((h) => h.Name)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
		expect(m.Headers[0].Value).toMatch(/^<https:\/\/app\.test\/unsubscribe\/one-click\?t=/);
		expect(m.HtmlBody).toContain('https://app.test/unsubscribe?t=');
		await db.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
	});

	it('without an account email it goes to the default From; refused for an unapproved From', async () => {
		const { aid, sid } = await emailStep();
		const r = (await actions.testStep(ev(aid, fields(sid)))) as any;
		expect(r.testTo).toBe('alan@ourco.example');
		await db.prepare("INSERT INTO app_state (key, value) VALUES ('approved_senders', 'ourco.example')").run();
		const bad = (await actions.testStep(ev(aid, fields(sid, { from_email: 'someone@gmail.com' })))) as any;
		expect(bad.status).toBe(400);
		expect(bad.data.testError).toMatch(/approved Postmark sender/);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
	});
});
