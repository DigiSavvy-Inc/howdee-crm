import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/contacts/+page.server';

const db = (env as any).DB as D1Database;

function deleteEvent(ids: number[]) {
	const fd = new FormData();
	for (const id of ids) fd.append('contact_ids', String(id));
	return {
		platform: { env },
		request: new Request('https://app.test/contacts?/deleteContacts', { method: 'POST', body: fd })
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

describe('deleteContacts action (#bulk-delete)', () => {
	it('deletes selected contacts and clears their dependent rows, preserving replies + unsubscribes', async () => {
		// Two contacts; one (keep) must be untouched.
		const a = (await db.prepare("INSERT INTO contacts (email) VALUES ('del@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const b = (await db.prepare("INSERT INTO contacts (email) VALUES ('del2@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const keep = (await db.prepare("INSERT INTO contacts (email) VALUES ('keep@x.example.net') RETURNING id").first<{ id: number }>())!.id;

		const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>())!.id;
		const camp = (await db
			.prepare("INSERT INTO campaigns (subject, body_md, body_html, from_email) VALUES ('s','m','h','f@x.example.net') RETURNING id")
			.first<{ id: number }>())!.id;
		const auto = (await db.prepare("INSERT INTO automations (name) VALUES ('A') RETURNING id").first<{ id: number }>())!.id;

		// Seed dependents for the to-be-deleted contacts (and the keeper, to prove isolation).
		for (const cid of [a, b, keep]) {
			await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, cid).run();
			await db.prepare('INSERT INTO automation_enrollments (automation_id, contact_id) VALUES (?, ?)').bind(auto, cid).run();
			const rid = (await db
				.prepare("INSERT INTO recipients (campaign_id, contact_id, email, status) VALUES (?, ?, 'r@x.example.net', 'accepted') RETURNING id")
				.bind(camp, cid)
				.first<{ id: number }>())!.id;
			await db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, 'open')").bind(camp, rid, cid).run();
			await db.prepare("INSERT INTO replies (contact_id, from_email) VALUES (?, 'r@x.example.net')").bind(cid).run();
			await db.prepare("INSERT INTO unsubscribes (contact_id, email) VALUES (?, 'u@x.example.net')").bind(cid).run();
		}

		const res = await actions.deleteContacts(deleteEvent([a, b]));
		expect((res as any).bulkSuccess).toMatch(/^Deleted/);
		expect((res as any).affected).toBe(2);

		// Deleted contacts gone; keeper remains.
		expect(await count('SELECT COUNT(*) AS n FROM contacts WHERE id IN (?, ?)', a, b)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM contacts WHERE id = ?', keep)).toBe(1);

		// Hard-dependent rows removed for the deleted pair...
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE contact_id IN (?, ?)', a, b)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM automation_enrollments WHERE contact_id IN (?, ?)', a, b)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM recipients WHERE contact_id IN (?, ?)', a, b)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM events WHERE contact_id IN (?, ?)', a, b)).toBe(0);

		// ...but the keeper's rows are intact.
		expect(await count('SELECT COUNT(*) AS n FROM recipients WHERE contact_id = ?', keep)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM events WHERE contact_id = ?', keep)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE contact_id = ?', keep)).toBe(1);

		// Replies + unsubscribes are PRESERVED with contact_id nulled (compliance / record).
		expect(await count('SELECT COUNT(*) AS n FROM replies')).toBe(3);
		expect(await count('SELECT COUNT(*) AS n FROM replies WHERE contact_id IS NULL')).toBe(2);
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes')).toBe(3);
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes WHERE contact_id IS NULL')).toBe(2);
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes WHERE contact_id = ?', keep)).toBe(1);
	});

	it('rejects an empty selection', async () => {
		const res = await actions.deleteContacts(deleteEvent([]));
		expect((res as any).status).toBe(400);
	});

	it('handles a large batch across the 100-id chunk boundary', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 150; i++) {
			const id = (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(`b${i}@x.example.net`).first<{ id: number }>())!.id;
			ids.push(id);
		}
		const res = await actions.deleteContacts(deleteEvent(ids));
		expect((res as any).affected).toBe(150);
		expect(await count('SELECT COUNT(*) AS n FROM contacts')).toBe(0);
	});
});
