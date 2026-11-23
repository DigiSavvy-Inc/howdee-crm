import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick, addTag } from '../src/lib/server/automations';

// #13/#75/0029: condition gates were unified into branches — a gate is exactly a branch
// whose 'no' lane holds an 'end' step. These tests exercise that shape directly (as
// migration 0029 produces it) instead of the old standalone 'gate' step type, which the
// engine no longer accepts.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

/** Tick until nothing is due (delays are 0 in these tests) — cap guards runaway loops. */
async function drain(maxTicks = 10): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		const s = await tick(db, cfg);
		if (s.processed === 0) return;
	}
}

async function tagsOf(contactId: number): Promise<string[]> {
	const rows = await db
		.prepare(
			`SELECT l.name FROM list_members lm JOIN lists l ON l.id = lm.list_id
			 WHERE lm.contact_id = ? AND l.kind = 'tag' ORDER BY l.name`
		)
		.bind(contactId)
		.all<{ name: string }>();
	return rows.results.map((r) => r.name);
}

/** Build a branch step with an 'end' child in its 'no' lane — the old gate shape,
 *  exactly as migration 0029 produces it from a legacy 'gate' row. */
async function makeGateShapedBranch(
	automationId: number,
	position: number,
	gateKind: string,
	gateName: string | null,
	gateValue: string | null = null
): Promise<number> {
	const branch = await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, gate_kind, gate_name, gate_value)
			 VALUES (?, ?, 0, 'branch', '', '', '', ?, ?, ?) RETURNING id`
		)
		.bind(automationId, position, gateKind, gateName, gateValue)
		.first<{ id: number }>();
	await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, parent_step_id, branch_label)
			 VALUES (?, 0, 0, 'end', '', '', '', ?, 'no')`
		)
		.bind(automationId, branch!.id)
		.run();
	return branch!.id;
}

describe('condition gate, unified into branch + end (#13/0029)', () => {
	it('matching contacts advance past; non-matching complete at the no-lane end step', async () => {
		const a = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('Gated', 'active') RETURNING id")
			.first<{ id: number }>();
		const branch = await makeGateShapedBranch(a!.id, 0, 'tag', 'hot');
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, tag_action, tag_name)
				 VALUES (?, 1, 0, 'tag', '', '', '', 'add', 'after')`
			)
			.bind(a!.id)
			.run();

		const hot = await db.prepare("INSERT INTO contacts (email) VALUES ('hot@x.example.net') RETURNING id").first<{ id: number }>();
		const cold = await db.prepare("INSERT INTO contacts (email) VALUES ('cold@x.example.net') RETURNING id").first<{ id: number }>();
		await addTag(db, 'hot', hot!.id);

		await enroll(db, a!.id, [hot!.id, cold!.id]);
		await drain();

		// hot matched → yes lane (empty) → advances past the branch → runs 'after'.
		expect(await tagsOf(hot!.id)).toEqual(['after', 'hot']);
		// cold didn't match → no lane → the end step → completes; 'after' never runs.
		expect(await tagsOf(cold!.id)).toEqual([]);

		const statuses = await db
			.prepare('SELECT status, COUNT(*) AS n FROM automation_enrollments GROUP BY status')
			.all<{ status: string; n: number }>();
		expect(statuses.results).toEqual([{ status: 'completed', n: 2 }]);

		const hits = await db
			.prepare('SELECT label, COUNT(*) AS n FROM automation_branch_hits WHERE step_id = ? GROUP BY label ORDER BY label')
			.bind(branch)
			.all<{ label: string; n: number }>();
		expect(hits.results).toEqual([
			{ label: 'no', n: 1 },
			{ label: 'yes', n: 1 }
		]);
	});

	it('field-eq gate-shape works against custom fields', async () => {
		const a = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('FieldGate', 'active') RETURNING id")
			.first<{ id: number }>();
		await makeGateShapedBranch(a!.id, 0, 'field-eq', 'tier', 'hot');
		const yes = await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('y@x.example.net', '{"tier":"hot"}') RETURNING id`).first<{ id: number }>();
		const no = await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('n@x.example.net', '{"tier":"warm"}') RETURNING id`).first<{ id: number }>();
		await enroll(db, a!.id, [yes!.id, no!.id]);
		await drain();

		const statuses = await db
			.prepare(
				`SELECT c.email, e.status FROM automation_enrollments e JOIN contacts c ON c.id = e.contact_id ORDER BY c.email`
			)
			.all<{ email: string; status: string }>();
		expect(statuses.results).toEqual([
			{ email: 'n@x.example.net', status: 'completed' },
			{ email: 'y@x.example.net', status: 'completed' }
		]);
		const hits = await db.prepare('SELECT label FROM automation_branch_hits').all<{ label: string }>();
		expect(hits.results.sort((a, b) => a.label.localeCompare(b.label))).toEqual([{ label: 'no' }, { label: 'yes' }]);
	});

	it('misconfigured gate-shape (no name) goes NO (#395 — no longer fails open)', async () => {
		const a = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('OpenGate', 'active') RETURNING id")
			.first<{ id: number }>();
		await makeGateShapedBranch(a!.id, 0, 'tag', '');
		const c = await db.prepare("INSERT INTO contacts (email) VALUES ('o@x.example.net') RETURNING id").first<{ id: number }>();
		await enroll(db, a!.id, [c!.id]);
		await drain();

		const hit = await db.prepare('SELECT label FROM automation_branch_hits').first<{ label: string }>();
		expect(hit!.label).toBe('no');
		const enr = await db
			.prepare('SELECT status, last_error FROM automation_enrollments WHERE contact_id = ?')
			.bind(c!.id)
			.first<{ status: string; last_error: string }>();
		expect(enr!.status).toBe('completed'); // fell through the empty no lane, nothing after
		expect(enr!.last_error).toBe('Branch condition is not configured');
	});
});

describe('field-not-exists condition (#78/0029)', () => {
	it('true when the meta field is absent, false when present', async () => {
		const a = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('NoField', 'active') RETURNING id")
			.first<{ id: number }>();
		const branch = await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, gate_kind, gate_name)
				 VALUES (?, 0, 0, 'branch', '', '', '', 'field-not-exists', 'vip') RETURNING id`
			)
			.bind(a!.id)
			.first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, tag_action, tag_name, parent_step_id, branch_label)
				 VALUES (?, 0, 0, 'tag', '', '', '', 'add', 'no-vip-field', ?, 'yes')`
			)
			.bind(a!.id, branch!.id)
			.run();
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, tag_action, tag_name, parent_step_id, branch_label)
				 VALUES (?, 0, 0, 'tag', '', '', '', 'add', 'has-vip-field', ?, 'no')`
			)
			.bind(a!.id, branch!.id)
			.run();

		const absent = await db.prepare("INSERT INTO contacts (email) VALUES ('absent@x.example.net') RETURNING id").first<{ id: number }>();
		const present = await db
			.prepare(`INSERT INTO contacts (email, meta) VALUES ('present@x.example.net', '{"vip":"yes"}') RETURNING id`)
			.first<{ id: number }>();
		const blankMeta = await db
			.prepare(`INSERT INTO contacts (email, meta) VALUES ('blank@x.example.net', '{}') RETURNING id`)
			.first<{ id: number }>();

		await enroll(db, a!.id, [absent!.id, present!.id, blankMeta!.id]);
		await drain();

		expect(await tagsOf(absent!.id)).toEqual(['no-vip-field']);
		expect(await tagsOf(present!.id)).toEqual(['has-vip-field']);
		expect(await tagsOf(blankMeta!.id)).toEqual(['no-vip-field']);
	});
});

describe("migration 0029 conversion shape", () => {
	it('a gate row converted in place (type flipped, no-lane end child inserted) traverses identically to a native gate would have', async () => {
		const a = await db
			.prepare("INSERT INTO automations (name, status) VALUES ('PreMigration', 'active') RETURNING id")
			.first<{ id: number }>();

		// Simulate a pre-0029 gate row exactly as it existed before the migration.
		const gate = await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, gate_kind, gate_name)
				 VALUES (?, 0, 0, 'gate', '', '', '', 'tag', 'hot') RETURNING id`
			)
			.bind(a!.id)
			.first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, tag_action, tag_name)
				 VALUES (?, 1, 0, 'tag', '', '', '', 'add', 'after')`
			)
			.bind(a!.id)
			.run();

		// Apply exactly what migrations/0029_unify_gate_branch.sql does.
		await db
			.prepare(
				`INSERT INTO automation_steps
				   (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, parent_step_id, branch_label)
				 SELECT automation_id, 0, 0, 'end', '', '', '', id, 'no'
				 FROM automation_steps WHERE type = 'gate'`
			)
			.run();
		await db.prepare("UPDATE automation_steps SET type = 'branch' WHERE type = 'gate'").run();

		// Assert the produced shape: exactly one 'no'-lane end child at position 0.
		const child = await db
			.prepare(`SELECT type, position, branch_label FROM automation_steps WHERE parent_step_id = ?`)
			.bind(gate!.id)
			.first<{ type: string; position: number; branch_label: string }>();
		expect(child).toEqual({ type: 'end', position: 0, branch_label: 'no' });
		const converted = await db.prepare('SELECT type, gate_kind, gate_name FROM automation_steps WHERE id = ?').bind(gate!.id).first<any>();
		expect(converted).toMatchObject({ type: 'branch', gate_kind: 'tag', gate_name: 'hot' });

		// No gate rows survive the migration — the engine no longer knows how to run one.
		const remaining = await db.prepare("SELECT COUNT(*) AS n FROM automation_steps WHERE type = 'gate'").first<{ n: number }>();
		expect(remaining!.n).toBe(0);

		// Traversal reproduces old gate semantics exactly: match → advance to 'after';
		// no match → complete at the end step, 'after' never runs.
		const hot = await db.prepare("INSERT INTO contacts (email) VALUES ('hot@x.example.net') RETURNING id").first<{ id: number }>();
		const cold = await db.prepare("INSERT INTO contacts (email) VALUES ('cold@x.example.net') RETURNING id").first<{ id: number }>();
		await addTag(db, 'hot', hot!.id);
		await enroll(db, a!.id, [hot!.id, cold!.id]);
		await drain();

		expect(await tagsOf(hot!.id)).toEqual(['after', 'hot']);
		expect(await tagsOf(cold!.id)).toEqual([]);
		const statuses = await db
			.prepare('SELECT status, COUNT(*) AS n FROM automation_enrollments GROUP BY status')
			.all<{ status: string; n: number }>();
		expect(statuses.results).toEqual([{ status: 'completed', n: 2 }]);
	});
});
