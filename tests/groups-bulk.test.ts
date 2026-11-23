import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { deleteGroups, emptyGroup, mergeGroups, renameGroup, TRIGGER_DELETED_LABEL } from '../src/lib/server/groups-bulk';
import { listLabels } from '../src/lib/server/automation-labels';
import { actions } from '../src/routes/groups/[kind]/+page.server';

// #215: bulk management of lists / segments / tags on /groups/[kind].
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM webhook_keys'),
		db.prepare("DELETE FROM app_state WHERE key = 'luma_list'"),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function group(name: string, kind: string, rules: string | null = null): Promise<number> {
	return (await db
		.prepare('INSERT INTO lists (name, kind, rules) VALUES (?, ?, ?) RETURNING id')
		.bind(name, kind, rules)
		.first<{ id: number }>())!.id;
}

async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}

async function add(listId: number, ...contactIds: number[]) {
	for (const c of contactIds) {
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c).run();
	}
}

async function automation(name: string, status: string, triggerListId: number | null): Promise<number> {
	return (await db
		.prepare("INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, ?, 'list_added', ?) RETURNING id")
		.bind(name, status, triggerListId)
		.first<{ id: number }>())!.id;
}

async function members(listId: number): Promise<number[]> {
	const r = await db.prepare('SELECT contact_id FROM list_members WHERE list_id = ? ORDER BY contact_id').bind(listId).all<{ contact_id: number }>();
	return r.results.map((x) => x.contact_id);
}

async function exists(id: number): Promise<boolean> {
	return !!(await db.prepare('SELECT 1 FROM lists WHERE id = ?').bind(id).first());
}

function formEvent(kind: string, action: string, fields: [string, string][]) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test/groups/${kind}?/${action}`);
	return {
		platform: { env },
		params: { kind },
		url,
		locals: { user: { id: 2, role: 'member' } },
		request: new Request(url, { method: 'POST', body: fd })
	} as any;
}

describe('deleteGroups', () => {
	it('removes memberships and the group, keeps contacts, pauses triggering automations', async () => {
		const a = await group('Alpha', 'list');
		const b = await group('Beta', 'list');
		const c1 = await contact('a@x.example.net');
		const c2 = await contact('b@x.example.net');
		await add(a, c1, c2);
		await add(b, c2);
		const active = await automation('Nurture', 'active', a);
		const draft = await automation('Draft flow', 'draft', b);

		const r = await deleteGroups(db, [a, b], 'list');
		expect(r.deleted).toBe(2);
		expect(r.membersRemoved).toBe(3);
		expect(r.automationsPaused).toEqual([{ id: active, name: 'Nurture' }]);
		expect(await exists(a)).toBe(false);
		expect(await exists(b)).toBe(false);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM contacts').first<{ n: number }>())!.n).toBe(2);

		const autos = await db.prepare('SELECT id, status, trigger_list_id FROM automations ORDER BY id').all<{ id: number; status: string; trigger_list_id: number | null }>();
		expect(autos.results).toEqual([
			{ id: active, status: 'paused', trigger_list_id: null },
			{ id: draft, status: 'draft', trigger_list_id: null }
		]);
		expect(await listLabels(db, active)).toEqual([TRIGGER_DELETED_LABEL]);
	});

	it('skips a group a campaign was sent to, and other kinds', async () => {
		const sent = await group('Sent list', 'list');
		const tag = await group('hot', 'tag');
		await db.prepare("INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status) VALUES ('S', 'b', 'b', ?, 'f@x.example.net', 'sent')").bind(sent).run();
		const r = await deleteGroups(db, [sent, tag], 'list');
		expect(r.deleted).toBe(0);
		expect(r.skipped.map((s) => s.reason)).toEqual(['sent to by 1 campaign', 'not a list']);
		expect(await exists(sent)).toBe(true);
		expect(await exists(tag)).toBe(true);
	});

	it('deletes a dynamic segment with its rules', async () => {
		const s = await group('Dyn', 'segment', JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] }));
		const r = await deleteGroups(db, [s], 'segment');
		expect(r.deleted).toBe(1);
		expect(await exists(s)).toBe(false);
	});

	it('the action requires typed confirm when an automation triggers from the selection', async () => {
		const a = await group('Alpha', 'list');
		await automation('Nurture', 'active', a);
		const refused = (await actions.delete!(formEvent('list', 'delete', [['id', String(a)]]))) as any;
		expect(refused.status).toBe(400);
		expect(await exists(a)).toBe(true);
		const ok = (await actions.delete!(formEvent('list', 'delete', [['id', String(a)], ['confirm', 'delete']]))) as any;
		expect(ok.bulkMessage).toContain('Paused Nurture');
		expect(await exists(a)).toBe(false);
	});

	it('a member can delete a small unreferenced tag without typing', async () => {
		const t = await group('cold', 'tag');
		await add(t, await contact('a@x.example.net'));
		const ok = (await actions.delete!(formEvent('tag', 'delete', [['id', String(t)]]))) as any;
		expect(ok.bulkMessage).toContain('Deleted 1 tag');
		expect(await exists(t)).toBe(false);
	});
});

describe('mergeGroups', () => {
	it('combines members once, repoints triggers / rules / steps, deletes the others', async () => {
		const keep = await group('hot', 'tag');
		const t2 = await group('Hot lead', 'tag');
		const t3 = await group('hot-lead', 'tag');
		const [c1, c2, c3] = [await contact('1@x.example.net'), await contact('2@x.example.net'), await contact('3@x.example.net')];
		await add(keep, c1);
		await add(t2, c1, c2);
		await add(t3, c2, c3);
		const auto = await automation('Hot flow', 'active', t2);
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email)
				 VALUES (?, 0, 'tag', 'add', 'hot lead', '', '', '')`
			)
			.bind(auto)
			.run();
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, type, gate_kind, gate_name, gate_ref_id, subject, body_md, from_email)
				 VALUES (?, 1, 'branch', 'list-member', NULL, ?, '', '', '')`
			)
			.bind(auto, t3)
			.run();
		const seg = await group('Seg', 'segment', JSON.stringify({ match: 'all', rules: [{ field: 'tag', op: 'is', value: 'Hot-Lead' }] }));
		await db.prepare("INSERT INTO webhook_keys (label, token, default_tags) VALUES ('Form', 'tok', 'hot, Hot lead, x')").run();

		const r = await mergeGroups(db, { intoId: keep }, [keep, t2, t3], 'tag');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.membersAdded).toBe(2);
		expect(r.duplicates).toBe(2);
		expect(await members(keep)).toEqual([c1, c2, c3]);
		expect(await exists(t2)).toBe(false);
		expect(await exists(t3)).toBe(false);

		expect((await db.prepare('SELECT trigger_list_id FROM automations WHERE id = ?').bind(auto).first<{ trigger_list_id: number }>())!.trigger_list_id).toBe(keep);
		const steps = await db.prepare('SELECT tag_name, gate_ref_id FROM automation_steps ORDER BY position').all<{ tag_name: string | null; gate_ref_id: number | null }>();
		expect(steps.results[0].tag_name).toBe('hot');
		expect(steps.results[1].gate_ref_id).toBe(keep);
		const rules = JSON.parse((await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(seg).first<{ rules: string }>())!.rules);
		expect(rules.rules[0].value).toBe('hot');
		expect((await db.prepare('SELECT default_tags FROM webhook_keys').first<{ default_tags: string }>())!.default_tags).toBe('hot, x');

		// Idempotent: nothing left to merge the second time.
		const again = await mergeGroups(db, { intoId: keep }, [keep, t2, t3], 'tag');
		expect(again.ok).toBe(false);
		expect(await members(keep)).toEqual([c1, c2, c3]);
	});

	it('merges into a new name, or into an existing group of that name', async () => {
		const a = await group('vip', 'tag');
		const b = await group('VIPs', 'tag');
		await add(a, await contact('1@x.example.net'));
		const r = await mergeGroups(db, { newName: 'Customer' }, [a, b], 'tag');
		expect(r.ok && r.into.created).toBe(true);
		const c = await group('later', 'tag');
		const r2 = await mergeGroups(db, { newName: 'customer' }, [c], 'tag');
		expect(r2.ok && !r2.into.created && r2.into.name).toBe('Customer');
	});

	it('merges lists and repoints campaign rows and the Luma list setting', async () => {
		const a = await group('News', 'list');
		const b = await group('Newsletter', 'list');
		await db.prepare("INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status) VALUES ('S', 'b', 'b', ?, 'f@x.example.net', 'sent')").bind(b).run();
		await db.prepare("INSERT INTO app_state (key, value) VALUES ('luma_list', 'Newsletter')").run();
		const r = await mergeGroups(db, { intoId: a }, [b], 'list');
		expect(r.ok && r.campaigns).toBe(1);
		expect((await db.prepare("SELECT value FROM app_state WHERE key = 'luma_list'").first<{ value: string }>())!.value).toBe('News');
	});

	it('refuses segments and mixed kinds', async () => {
		const s1 = await group('S1', 'segment');
		const s2 = await group('S2', 'segment');
		expect((await mergeGroups(db, { intoId: s1 }, [s2], 'segment')).ok).toBe(false);
		const t = await group('x', 'tag');
		const l = await group('y', 'list');
		expect((await mergeGroups(db, { intoId: t }, [l], 'tag')).ok).toBe(false);
	});
});

describe('renameGroup', () => {
	it('is unique per kind, case-insensitive, and rewrites tag references', async () => {
		const t = await group('warm', 'tag');
		await group('Hot', 'tag');
		await group('hot', 'list'); // other kind: no clash
		expect(await renameGroup(db, t, 'HOT')).toEqual({ ok: false, error: 'A tag named “Hot” already exists.' });
		const seg = await group('Seg', 'segment', JSON.stringify({ match: 'any', rules: [{ field: 'tag', op: 'not', value: 'warm' }] }));
		const r = await renameGroup(db, t, ' Warm leads ');
		expect(r.ok).toBe(true);
		expect((await db.prepare('SELECT name FROM lists WHERE id = ?').bind(t).first<{ name: string }>())!.name).toBe('Warm leads');
		const rules = JSON.parse((await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(seg).first<{ rules: string }>())!.rules);
		expect(rules).toEqual({ match: 'any', rules: [{ field: 'tag', op: 'not', value: 'Warm leads' }] });
	});

	it('the action reports errors against the row', async () => {
		const t = await group('a', 'tag');
		const res = (await actions.rename!(formEvent('tag', 'rename', [['id', String(t)], ['name', '']]))) as any;
		expect(res.status).toBe(400);
		expect(res.data.renameId).toBe(t);
	});
});

describe('emptyGroup', () => {
	it('removes members and keeps the group; skips dynamic segments', async () => {
		const l = await group('L', 'list');
		const dyn = await group('D', 'segment', JSON.stringify({ match: 'all', rules: [{ field: 'subscribed', op: 'yes' }] }));
		const c1 = await contact('1@x.example.net');
		await add(l, c1, await contact('2@x.example.net'));
		const r = await emptyGroup(db, [l, dyn]);
		expect(r.emptied).toBe(1);
		expect(r.membersRemoved).toBe(2);
		expect(r.skipped.map((s) => s.id)).toEqual([dyn]);
		expect(await exists(l)).toBe(true);
		expect(await members(l)).toEqual([]);
		expect(await db.prepare('SELECT 1 FROM contacts WHERE id = ?').bind(c1).first()).toBeTruthy();
	});
});
