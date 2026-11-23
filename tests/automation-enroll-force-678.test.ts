import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/automations/[id]/+page.server';
import automationPage from '../src/routes/automations/[id]/+page.svelte?raw';
import helpPanel from '../src/lib/components/HelpPanel.svelte?raw';

// #678: the automation's Enroll dialog names the reason each hand-picked contact is skipped and
// offers "Enroll again" (once only) / "Restart from the first step" (a running pass), with the
// same server rules as the contact page (#673). Unsubscribed and archived contacts are never
// enrolled, whatever the form says; list / segment enrolls take no override.
const db = (env as any).DB as D1Database;

const VIP_RULES = JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'has', value: 'vip' }] });

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

const STEP_SQL = `INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
	 VALUES (?, ?, 3600, '', '', '', 'tag', 'add', 'x') RETURNING id`;

async function automation(
	opts: { reentry?: 'once' | 'multiple'; entry_rules?: string | null } = {}
): Promise<{ aid: number; first: number; second: number }> {
	const aid = (await db
		.prepare("INSERT INTO automations (name, status, reentry, entry_rules) VALUES ('Nurture', 'active', ?, ?) RETURNING id")
		.bind(opts.reentry ?? 'once', opts.entry_rules ?? null)
		.first<{ id: number }>())!.id;
	const first = (await db.prepare(STEP_SQL).bind(aid, 0).first<{ id: number }>())!.id;
	const second = (await db.prepare(STEP_SQL).bind(aid, 1).first<{ id: number }>())!.id;
	return { aid, first, second };
}

async function contact(email: string, opts: { subscribed?: number; archived?: boolean } = {}): Promise<number> {
	const archived = opts.archived ? "datetime('now')" : 'NULL';
	return (await db
		.prepare(`INSERT INTO contacts (email, subscribed, archived_at) VALUES (?, ?, ${archived}) RETURNING id`)
		.bind(email, opts.subscribed ?? 1)
		.first<{ id: number }>())!.id;
}

async function pass(aid: number, cid: number, status: string, stepId: number | null = null) {
	await db
		.prepare(
			"INSERT INTO automation_enrollments (automation_id, contact_id, status, current_step_id, next_run_at) VALUES (?, ?, ?, ?, datetime('now'))"
		)
		.bind(aid, cid, status, stepId)
		.run();
}

async function passRows(aid: number, cid: number) {
	return (
		await db
			.prepare('SELECT status, current_step_id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id')
			.bind(aid, cid)
			.all<{ status: string; current_step_id: number | null }>()
	).results;
}

function ev(aid: number, fields: Record<string, string | string[]>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
	const url = new URL(`https://app.test/automations/${aid}`);
	return { platform: { env }, params: { id: String(aid) }, url, locals: { user: null }, request: new Request(url, { method: 'POST', body: fd }) } as any;
}

const preview = (aid: number, ids: number[]) =>
	actions.enrollPreview(ev(aid, { contact_ids: ids.map(String) })) as Promise<any>;
const enrollPicked = (aid: number, fields: Record<string, string | string[]>) =>
	actions.enrollContacts(ev(aid, fields)) as Promise<any>;

describe('preview reasons', () => {
	it('names the reason for each of the five skips, in pick order, with the email', async () => {
		const { aid, second } = await automation({ entry_rules: VIP_RULES });
		const archived = await contact('arch@x.test', { archived: true });
		const unsub = await contact('unsub@x.test', { subscribed: 0 });
		const running = await contact('run@x.test');
		await pass(aid, running, 'active', second);
		const done = await contact('done@x.test');
		await pass(aid, done, 'completed');
		const cond = await contact('cond@x.test');

		const r = await preview(aid, [archived, unsub, running, done, cond]);
		expect(r.preview).toMatchObject({ total: 5, eligible: 0, entry_blocked: 1, skipped_more: 0 });
		expect(r.preview.skipped).toEqual([
			{ id: archived, email: 'arch@x.test', reason: 'archived' },
			{ id: unsub, email: 'unsub@x.test', reason: 'unsubscribed' },
			{ id: running, email: 'run@x.test', reason: 'active' },
			{ id: done, email: 'done@x.test', reason: 'once' },
			{ id: cond, email: 'cond@x.test', reason: 'conditions' }
		]);
	});

	it('a contact that would be enrolled gets no row', async () => {
		const { aid } = await automation();
		const ok = await contact('ok@x.test');
		const r = await preview(aid, [ok]);
		expect(r.preview).toMatchObject({ total: 1, eligible: 1, skipped: [], skipped_more: 0 });
	});

	it('list previews carry no per-contact rows', async () => {
		const { aid } = await automation();
		const listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>())!.id;
		const r = (await actions.enrollPreview(ev(aid, { list_id: String(listId) }))) as any;
		expect(r.preview.skipped).toBeUndefined();
	});
});

describe('Enroll again', () => {
	it('enrolls a once-only contact only when ticked', async () => {
		const { aid } = await automation();
		const cid = await contact('again@x.test');
		await pass(aid, cid, 'completed');
		expect(await enrollPicked(aid, { contact_ids: [String(cid)] })).toMatchObject({ enrolled: 0, skipped: 1 });
		expect(await enrollPicked(aid, { contact_ids: [String(cid)], again_ids: [String(cid)] })).toMatchObject({
			enrolled: 1,
			restarted: 0,
			skipped: 0
		});
		expect((await passRows(aid, cid)).map((r) => r.status)).toEqual(['completed', 'active']);
	});

	it('mixes plain and forced contacts in one submit', async () => {
		const { aid } = await automation();
		const fresh = await contact('fresh@x.test');
		const done = await contact('done@x.test');
		await pass(aid, done, 'completed');
		const unsub = await contact('unsub@x.test', { subscribed: 0 });
		const res = await enrollPicked(aid, { contact_ids: [String(fresh), String(done), String(unsub)], again_ids: [String(done)] });
		expect(res).toMatchObject({ enrolled: 2, restarted: 0, skipped: 1, enrollDone: true });
	});
});

describe('Restart from the first step', () => {
	it('cancels the running pass and starts a new one at step 1', async () => {
		const { aid, first, second } = await automation();
		const cid = await contact('run@x.test');
		await pass(aid, cid, 'active', second);
		expect(await enrollPicked(aid, { contact_ids: [String(cid)], restart_ids: [String(cid)] })).toMatchObject({
			enrolled: 1,
			restarted: 1,
			skipped: 0
		});
		const rows = await passRows(aid, cid);
		expect(rows.map((r) => r.status)).toEqual(['cancelled', 'active']);
		expect(rows[1].current_step_id).toBe(first);
	});

	it('a forged restart for a contact with no running pass cancels nothing', async () => {
		const { aid } = await automation();
		const done = await contact('done@x.test');
		await pass(aid, done, 'completed');
		const res = await enrollPicked(aid, { contact_ids: [String(done)], restart_ids: [String(done)] });
		expect(res).toMatchObject({ enrolled: 0, restarted: 0, skipped: 1 });
		expect((await passRows(aid, done)).map((r) => r.status)).toEqual(['completed']);
	});

	it('an override for a contact that was not picked is ignored', async () => {
		const { aid } = await automation();
		const run = await contact('run@x.test');
		await pass(aid, run, 'active');
		const other = await contact('other@x.test');
		const res = await enrollPicked(aid, { contact_ids: [String(other)], restart_ids: [String(run)] });
		expect(res).toMatchObject({ enrolled: 1, restarted: 0 });
		expect((await passRows(aid, run)).map((r) => r.status)).toEqual(['active']);
	});
});

describe('never for unsubscribed or archived contacts', () => {
	it('forged again_ids / restart_ids enroll nothing', async () => {
		const { aid } = await automation();
		const unsub = await contact('unsub@x.test', { subscribed: 0 });
		await pass(aid, unsub, 'completed');
		const arch = await contact('arch@x.test', { archived: true });
		await pass(aid, arch, 'active');
		const ids = [String(unsub), String(arch)];
		const res = await enrollPicked(aid, { contact_ids: ids, again_ids: ids, restart_ids: ids });
		expect(res).toMatchObject({ enrolled: 0, restarted: 0, skipped: 2 });
		expect((await passRows(aid, unsub)).map((r) => r.status)).toEqual(['completed']);
		expect((await passRows(aid, arch)).map((r) => r.status)).toEqual(['active']);
	});
});

describe('list enroll', () => {
	it('ignores again_ids and restart_ids', async () => {
		const { aid, second } = await automation();
		const listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>())!.id;
		const run = await contact('run@x.test');
		await pass(aid, run, 'active', second);
		const done = await contact('done@x.test');
		await pass(aid, done, 'completed');
		for (const cid of [run, done]) await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, cid).run();
		const res = (await actions.enrollList(
			ev(aid, { list_id: String(listId), confirm: '1', again_ids: [String(done)], restart_ids: [String(run)] })
		)) as any;
		expect(res).toMatchObject({ enrolled: 0, enrollDone: true });
		expect((await passRows(aid, run)).map((r) => r.status)).toEqual(['active']);
		expect((await passRows(aid, done)).map((r) => r.status)).toEqual(['completed']);
	});
});

describe('dialog and help text', () => {
	it('shows the reasons, the per-row overrides and the new wording', () => {
		expect(automationPage).toContain('is already going through this automation');
		expect(automationPage).toContain('already went through this automation, which takes each contact once');
		expect(automationPage).toContain('does not match the contact conditions');
		expect(automationPage).toContain('is unsubscribed. Resubscribe them on their contact page first.');
		expect(automationPage).toContain('is archived. Restore them on their contact page first.');
		expect(automationPage).toContain("'restart_ids' : 'again_ids'");
		expect(automationPage).toContain('skipped: unsubscribed, archived, already going through it, or already went through it once');
		expect(automationPage).toContain('skipped contacts are listed with the reason');
		expect(automationPage).not.toContain('already-enrolled contacts are skipped');
		expect(helpPanel).toContain('Enroll contacts');
	});
});
