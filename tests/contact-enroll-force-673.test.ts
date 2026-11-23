import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/contacts/[id]/+page.server';
import { enrollSkipReason } from '../src/lib/server/enroll-reason';
import { enroll, enrollContactsInAutomation } from '../src/lib/server/automations';
import contactPage from '../src/routes/contacts/[id]/+page.svelte?raw';

// #673: the contact page can force an enroll past once-only re-entry ("Enroll again") and
// restart a running pass ("Restart from the first step"). Unsubscribed and archived contacts
// are never enrolled, forced or not.
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
			.prepare(
				'SELECT status, current_step_id, ended_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id'
			)
			.bind(aid, cid)
			.all<{ status: string; current_step_id: number | null; ended_at: string | null }>()
	).results;
}

// Bare fake event, no locals (the action reads none).
function ev(id: number, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env },
		params: { id: String(id) },
		request: new Request(`https://app.test/contacts/${id}?/enrollInAutomation`, { method: 'POST', body: fd })
	} as any;
}

const enrollAction = (cid: number, aid: number, extra: Record<string, string> = {}) =>
	actions.enrollInAutomation(ev(cid, { automation_id: String(aid), ...extra })) as Promise<any>;

describe('ignoreReentry', () => {
	it('once-only with a completed pass: plain enroll skips, ignoreReentry enrolls', async () => {
		const { aid } = await automation();
		const cid = await contact('done@x.test');
		await pass(aid, cid, 'completed');
		expect((await enroll(db, aid, [cid])).enrolled).toBe(0);
		expect(await enrollSkipReason(db, aid, cid)).toBe('once');
		expect(await enrollSkipReason(db, aid, cid, { ignoreReentry: true })).toBeNull();
		expect(await enrollContactsInAutomation(db, aid, [cid], { ignoreReentry: true })).toMatchObject({ ok: true, enrolled: 1 });
	});

	it('Enroll again (force=1) on the contact page enrolls a once-only contact', async () => {
		const { aid } = await automation();
		const cid = await contact('again@x.test');
		await pass(aid, cid, 'completed');
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 0, enrollReason: 'once' });
		expect(await enrollAction(cid, aid, { force: '1' })).toMatchObject({ enrollEnrolled: 1, enrollReason: null });
	});

	it('force=1 gets past contact conditions on a once-only automation already gone through', async () => {
		const { aid } = await automation({ entry_rules: VIP_RULES });
		const cid = await contact('cond@x.test');
		await pass(aid, cid, 'completed');
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 0, enrollReason: 'once' });
		expect(await enrollAction(cid, aid, { force: '1', ignore_entry: '1' })).toMatchObject({ enrollEnrolled: 1 });
	});
});

describe('restart', () => {
	it('active is still reported with both ignore flags; restart ends it and starts a new pass at step 1', async () => {
		const { aid, first, second } = await automation();
		const cid = await contact('run@x.test');
		await pass(aid, cid, 'active', second);
		expect(await enrollSkipReason(db, aid, cid, { ignoreEntryRules: true, ignoreReentry: true })).toBe('active');
		// force alone doesn't end the running pass
		expect(await enrollAction(cid, aid, { force: '1' })).toMatchObject({ enrollEnrolled: 0, enrollReason: 'active' });
		expect(await enrollAction(cid, aid, { force: '1', restart: '1' })).toMatchObject({
			enrollEnrolled: 1,
			enrollReason: null
		});
		const rows = await passRows(aid, cid);
		expect(rows).toHaveLength(2);
		expect(rows[0].status).toBe('cancelled');
		expect(rows[0].ended_at).not.toBeNull();
		expect(rows[1]).toMatchObject({ status: 'active', current_step_id: first });
	});

	it('restart=1 without force does nothing extra', async () => {
		const { aid } = await automation();
		const cid = await contact('noforce@x.test');
		await pass(aid, cid, 'active');
		expect(await enrollAction(cid, aid, { restart: '1' })).toMatchObject({ enrollEnrolled: 0, enrollReason: 'active' });
		expect((await passRows(aid, cid)).map((r) => r.status)).toEqual(['active']);
	});

	it('a paused automation never loses the running pass', async () => {
		const { aid } = await automation();
		const cid = await contact('paused@x.test');
		await pass(aid, cid, 'active');
		await db.prepare("UPDATE automations SET status = 'paused' WHERE id = ?").bind(aid).run();
		const res = await enrollAction(cid, aid, { force: '1', restart: '1' });
		expect(res.status).toBe(400);
		expect((await passRows(aid, cid)).map((r) => r.status)).toEqual(['active']);
	});
});

describe('never forced', () => {
	it.each([
		['unsubscribed', { subscribed: 0 }],
		['archived', { subscribed: 1, archived: true }]
	] as const)('%s: forced enroll and restart enroll nobody and keep the running pass', async (reason, opts) => {
		const { aid } = await automation({ entry_rules: VIP_RULES });
		const cid = await contact(`${reason}@x.test`, opts);
		expect(await enrollAction(cid, aid, { force: '1' })).toMatchObject({ enrollEnrolled: 0, enrollReason: reason });
		await pass(aid, cid, 'active');
		expect(await enrollAction(cid, aid, { force: '1', restart: '1' })).toMatchObject({
			enrollEnrolled: 0,
			enrollReason: reason
		});
		const rows = await passRows(aid, cid);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'active', ended_at: null });
	});
});

describe('contact page', () => {
	it('offers Enroll again, Restart and Enroll anyway, and points unsubscribed at Resubscribe', () => {
		expect(contactPage).toContain('Enroll again');
		expect(contactPage).toContain('Restart from the first step');
		expect(contactPage).toContain('Enroll anyway');
		expect(contactPage).toContain('name="force" value="1"');
		expect(contactPage).toContain('name="restart" value="1"');
		expect(contactPage).toContain('Resubscribe them first with the Resubscribe button at the top of this page.');
	});
});
