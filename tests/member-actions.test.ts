import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/lists/[id]/+page.server';

const db = (env as any).DB as D1Database;

function makeEvent(action: string, listId: number, contactIds: number[]) {
	const fd = new FormData();
	for (const id of contactIds) fd.append('contact_ids', String(id));
	return {
		platform: { env },
		params: { id: String(listId) },
		request: new Request(`https://app.test/lists/${listId}?/${action}`, { method: 'POST', body: fd })
	} as any;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const r = await db.prepare(sql).bind(...binds).first<{ n: number }>();
	return r?.n ?? 0;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('removeMembers action (#73)', () => {
	it('removes membership rows for kind=list without touching contacts or other lists', async () => {
		const listA = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('A', 'list') RETURNING id").first<{ id: number }>())!.id;
		const listB = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('B', 'list') RETURNING id").first<{ id: number }>())!.id;

		const c1 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c1@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const c2 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c2@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const c3 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c3@x.example.net') RETURNING id").first<{ id: number }>())!.id;

		// All three in listA; c1+c2 also in listB.
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c1),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c2),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c3),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listB, c1),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listB, c2)
		]);

		// Remove c1 and c2 from listA.
		const res = await actions.removeMembers(makeEvent('removeMembers', listA, [c1, c2]));
		expect((res as any).bulkSuccess).toMatch(/^Removed/);
		expect((res as any).affected).toBe(2);

		// c3 still in listA; c1+c2 gone from listA.
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', listA, c3)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id IN (?, ?)', listA, c1, c2)).toBe(0);

		// Contacts themselves are untouched.
		expect(await count('SELECT COUNT(*) AS n FROM contacts')).toBe(3);

		// listB memberships for c1+c2 are untouched (different list).
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', listB)).toBe(2);
	});

	it('returns a 400-shaped failure for kind=company (derived membership)', async () => {
		const co = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Acme', 'company') RETURNING id").first<{ id: number }>())!.id;
		const c1 = (await db.prepare("INSERT INTO contacts (email) VALUES ('emp@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(co, c1).run();

		const res = await actions.removeMembers(makeEvent('removeMembers', co, [c1]));
		expect((res as any).status).toBe(400);
		expect((res as any).data?.bulkError).toMatch(/Cannot remove/i);

		// Membership row is still intact.
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', co)).toBe(1);
	});
});

describe('deleteContacts action on member page (#73)', () => {
	it('deletes contacts via cascade and leaves a kept contact intact', async () => {
		const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>())!.id;

		const del1 = (await db.prepare("INSERT INTO contacts (email) VALUES ('del1@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const del2 = (await db.prepare("INSERT INTO contacts (email) VALUES ('del2@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const keep = (await db.prepare("INSERT INTO contacts (email) VALUES ('keep@x.example.net') RETURNING id").first<{ id: number }>())!.id;

		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, del1),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, del2),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, keep)
		]);

		const res = await actions.deleteContacts(makeEvent('deleteContacts', list, [del1, del2]));
		expect((res as any).bulkSuccess).toMatch(/^Deleted/);
		expect((res as any).affected).toBe(2);

		// Deleted contacts gone; keeper intact.
		expect(await count('SELECT COUNT(*) AS n FROM contacts WHERE id IN (?, ?)', del1, del2)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM contacts WHERE id = ?', keep)).toBe(1);

		// Keeper's list membership survives.
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', list, keep)).toBe(1);
	});
});
