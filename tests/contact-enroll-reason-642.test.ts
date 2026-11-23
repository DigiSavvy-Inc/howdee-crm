import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/contacts/[id]/+page.server';
import { enrollSkipReason } from '../src/lib/server/enroll-reason';
import { bulkEnroll } from '../src/lib/server/contact-bulk';
import contactPage from '../src/routes/contacts/[id]/+page.svelte?raw';

// #642: the contact page's Enroll says exactly why a contact wasn't enrolled, and offers
// "Enroll anyway" when the contact conditions (entry rules, #412) are the only thing in the way.
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

async function automation(opts: { reentry?: 'once' | 'multiple'; entry_rules?: string | null; name?: string } = {}): Promise<number> {
	const aid = (await db
		.prepare("INSERT INTO automations (name, status, reentry, entry_rules) VALUES (?, 'active', ?, ?) RETURNING id")
		.bind(opts.name ?? 'Nurture', opts.reentry ?? 'once', opts.entry_rules ?? null)
		.first<{ id: number }>())!.id;
	await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
			 VALUES (?, 0, 3600, '', '', '', 'tag', 'add', 'x')`
		)
		.bind(aid)
		.run();
	return aid;
}

async function contact(email: string, opts: { subscribed?: number; archived?: boolean } = {}): Promise<number> {
	return (await db
		.prepare(`INSERT INTO contacts (email, subscribed, archived_at) VALUES (?, ?, ${opts.archived ? "datetime('now')" : 'NULL'}) RETURNING id`)
		.bind(email, opts.subscribed ?? 1)
		.first<{ id: number }>())!.id;
}

async function tag(contactId: number, name: string) {
	let t = await db.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'tag'").bind(name).first<{ id: number }>();
	if (!t) t = await db.prepare("INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id").bind(name).first<{ id: number }>();
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(t!.id, contactId).run();
}

async function passes(aid: number, cid: number): Promise<number> {
	return (await db
		.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?')
		.bind(aid, cid)
		.first<{ n: number }>())!.n;
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

describe('enrollSkipReason', () => {
	it('archived comes first, even when also unsubscribed', async () => {
		const aid = await automation();
		const cid = await contact('a@x.test', { subscribed: 0, archived: true });
		expect(await enrollSkipReason(db, aid, cid)).toBe('archived');
	});

	it('unsubscribed', async () => {
		const aid = await automation();
		const cid = await contact('u@x.test', { subscribed: 0 });
		expect(await enrollSkipReason(db, aid, cid)).toBe('unsubscribed');
	});

	it('active pass, then once only, then none for multiple re-entry', async () => {
		const once = await automation();
		const cid = await contact('p@x.test');
		expect(await enrollSkipReason(db, once, cid)).toBeNull();
		await db
			.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status, next_run_at) VALUES (?, ?, 'active', datetime('now'))")
			.bind(once, cid)
			.run();
		expect(await enrollSkipReason(db, once, cid)).toBe('active');
		await db.prepare("UPDATE automation_enrollments SET status = 'completed' WHERE automation_id = ?").bind(once).run();
		expect(await enrollSkipReason(db, once, cid)).toBe('once');

		const multi = await automation({ reentry: 'multiple', name: 'Again' });
		await db
			.prepare("INSERT INTO automation_enrollments (automation_id, contact_id, status, next_run_at) VALUES (?, ?, 'completed', datetime('now'))")
			.bind(multi, cid)
			.run();
		expect(await enrollSkipReason(db, multi, cid)).toBeNull();
	});

	it('contact conditions, unless ignored', async () => {
		const aid = await automation({ entry_rules: VIP_RULES });
		const cid = await contact('c@x.test');
		expect(await enrollSkipReason(db, aid, cid)).toBe('conditions');
		expect(await enrollSkipReason(db, aid, cid, { ignoreEntryRules: true })).toBeNull();
		await tag(cid, 'vip');
		expect(await enrollSkipReason(db, aid, cid)).toBeNull();
	});
});

describe('contact page ?/enrollInAutomation', () => {
	it('enrolls and keeps the success fields', async () => {
		const aid = await automation();
		const cid = await contact('ok@x.test');
		const res = await enrollAction(cid, aid);
		expect(res).toMatchObject({ enrollSuccess: true, enrollEnrolled: 1, enrollReason: null, enrollName: 'Nurture', enrollId: aid });
	});

	it.each([
		['archived', { subscribed: 1, archived: true }],
		['unsubscribed', { subscribed: 0 }]
	] as const)('returns %s and Enroll anyway does not get past it', async (reason, opts) => {
		const aid = await automation({ entry_rules: VIP_RULES });
		const cid = await contact(`${reason}@x.test`, opts);
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 0, enrollReason: reason });
		expect(await enrollAction(cid, aid, { ignore_entry: '1' })).toMatchObject({ enrollEnrolled: 0, enrollReason: reason });
		expect(await passes(aid, cid)).toBe(0);
	});

	it('returns active and once', async () => {
		const aid = await automation();
		const cid = await contact('twice@x.test');
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 1 });
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 0, enrollReason: 'active' });
		await db.prepare("UPDATE automation_enrollments SET status = 'completed' WHERE automation_id = ?").bind(aid).run();
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 0, enrollReason: 'once' });
	});

	it('returns conditions; Enroll anyway (ignore_entry=1) enrolls', async () => {
		const aid = await automation({ entry_rules: VIP_RULES });
		const cid = await contact('cond@x.test');
		expect(await enrollAction(cid, aid)).toMatchObject({ enrollEnrolled: 0, enrollReason: 'conditions' });
		expect(await passes(aid, cid)).toBe(0);
		expect(await enrollAction(cid, aid, { ignore_entry: '1' })).toMatchObject({ enrollEnrolled: 1, enrollReason: null });
		expect(await passes(aid, cid)).toBe(1);
	});

	it('the page names each reason and posts Enroll anyway with ignore_entry=1', () => {
		expect(contactPage).not.toContain('unsubscribed or already mid-flow');
		expect(contactPage).toContain('This contact is archived.');
		expect(contactPage).toContain('This contact is unsubscribed.');
		expect(contactPage).toContain('They are already going through');
		expect(contactPage).toContain('it only takes each contact once');
		expect(contactPage).toContain("They don't match the contact conditions on");
		expect(contactPage).toContain('name="ignore_entry" value="1"');
		expect(contactPage).toContain('Enroll anyway');
	});
});

describe('bulk enroll message', () => {
	it('counts contacts blocked by contact conditions as their own figure', async () => {
		const aid = await automation({ entry_rules: VIP_RULES, name: 'VIP drip' });
		const vip = await contact('vip@x.test');
		await tag(vip, 'vip');
		const plain1 = await contact('p1@x.test');
		const plain2 = await contact('p2@x.test');
		const unsub = await contact('un@x.test', { subscribed: 0 });
		await tag(unsub, 'vip');
		const res = await bulkEnroll(db, { ok: true, ids: [vip, plain1, plain2, unsub], all: false, missing: 0 }, aid);
		expect(res).toMatchObject({ ok: true, affected: 1, skipped: 3 });
		expect((res as any).message).toBe(
			// #705: each skip reason is its own figure.
			"Enrolled 1 in “VIP drip” · 1 unsubscribed · 2 don't match the contact conditions"
		);
	});

	it('leaves the conditions figure out when nobody was blocked by them', async () => {
		const aid = await automation({ name: 'Plain' });
		const a = await contact('a1@x.test');
		const res = await bulkEnroll(db, { ok: true, ids: [a], all: false, missing: 0 }, aid);
		expect((res as any).message).toBe('Enrolled 1 in “Plain”');
	});
});
