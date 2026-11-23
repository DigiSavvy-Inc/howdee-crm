import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { addTag, enroll } from '../src/lib/server/automations';
import { syncCompanyMembership } from '../src/lib/server/companies';

const db = (env as any).DB as D1Database;

async function freshContact(email: string): Promise<number> {
	const row = await db
		.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id')
		.bind(email)
		.first<{ id: number }>();
	return row!.id;
}

beforeEach(async () => {
	// Each test starts from clean membership state.
	await db.batch([
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('addTag', () => {
	it('creates the tag (kind=tag) and is idempotent', async () => {
		const cid = await freshContact('t@x.example.net');
		await addTag(db, 'vip', cid);
		await addTag(db, 'vip', cid); // repeat must not duplicate
		const tags = await db
			.prepare("SELECT COUNT(*) AS n FROM lists WHERE name='vip' AND kind='tag'")
			.first<{ n: number }>();
		const members = await db
			.prepare('SELECT COUNT(*) AS n FROM list_members WHERE contact_id = ?')
			.bind(cid)
			.first<{ n: number }>();
		expect(tags?.n).toBe(1);
		expect(members?.n).toBe(1);
	});

	it('ignores blank names', async () => {
		const cid = await freshContact('blank@x.example.net');
		await addTag(db, '   ', cid);
		const n = await db.prepare('SELECT COUNT(*) AS n FROM lists').first<{ n: number }>();
		expect(n?.n).toBe(0);
	});
});

describe('syncCompanyMembership (many-to-one)', () => {
	it('creates and joins, moves between companies, and clears', async () => {
		const cid = await freshContact('co@x.example.net');

		await syncCompanyMembership(db, cid, 'Acme');
		let m = await memberships(cid);
		expect(m).toEqual(['Acme']);

		await syncCompanyMembership(db, cid, 'Globex'); // move — must leave Acme
		m = await memberships(cid);
		expect(m).toEqual(['Globex']);

		// Acme is now empty → pruned (derived groups don't linger).
		const acme = await db
			.prepare("SELECT COUNT(*) AS n FROM lists WHERE name='Acme' AND kind='company'")
			.first<{ n: number }>();
		expect(acme?.n).toBe(0);

		await syncCompanyMembership(db, cid, null); // clear
		m = await memberships(cid);
		expect(m).toEqual([]);
		const left = await db
			.prepare("SELECT COUNT(*) AS n FROM lists WHERE kind='company'")
			.first<{ n: number }>();
		expect(left?.n).toBe(0); // Globex pruned too
	});

	it('keeps an empty company referenced by an automation trigger', async () => {
		const cid = await freshContact('trig@x.example.net');
		await syncCompanyMembership(db, cid, 'Initech');
		const co = await db
			.prepare("SELECT id FROM lists WHERE name='Initech' AND kind='company'")
			.first<{ id: number }>();
		await db
			.prepare("INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES ('Co flow', 'active', 'list_added', ?)")
			.bind(co!.id)
			.run();
		await syncCompanyMembership(db, cid, null); // Initech now empty but trigger-referenced
		const kept = await db
			.prepare("SELECT COUNT(*) AS n FROM lists WHERE name='Initech' AND kind='company'")
			.first<{ n: number }>();
		expect(kept?.n).toBe(1);
	});

	async function memberships(cid: number): Promise<string[]> {
		const rows = await db
			.prepare(
				"SELECT l.name FROM list_members lm JOIN lists l ON l.id=lm.list_id WHERE lm.contact_id=? AND l.kind='company' ORDER BY l.name"
			)
			.bind(cid)
			.all<{ name: string }>();
		return rows.results.map((r) => r.name);
	}
});

describe('enroll', () => {
	async function automationWithStep(): Promise<number> {
		const a = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('Flow', 'active') RETURNING id")
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type) VALUES (?, 0, 's', 'b', 'f@x.example.net', 'email')"
			)
			.bind(a!.id)
			.run();
		return a!.id;
	}

	it('enrolls subscribed contacts once; dedupes repeats', async () => {
		const aid = await automationWithStep();
		const cid = await freshContact('e@x.example.net');
		const first = await enroll(db, aid, [cid]);
		const second = await enroll(db, aid, [cid]);
		expect(first.enrolled).toBe(1);
		expect(second.enrolled).toBe(0);
		expect(second.skipped).toBe(1);
	});

	it('skips unsubscribed contacts', async () => {
		const aid = await automationWithStep();
		const cid = await freshContact('un@x.example.net');
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(cid).run();
		const res = await enroll(db, aid, [cid]);
		expect(res.enrolled).toBe(0);
		expect(res.skipped).toBe(1);
	});
});
