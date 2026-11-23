import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/automations/[id]/+page.server';

// #77: duplicate automation (tree + remapped refs).
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations')
	]);
});

function actionEvent(automationId: number, fields: Record<string, string> = {}) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: { env },
		params: { id: String(automationId) },
		request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
	} as any;
}

describe('duplicate automation (#77)', () => {
	it('copies the tree with remapped parent + opened-ref ids, as a draft', async () => {
		const a = (await db
			.prepare("INSERT INTO automations (name, status, trigger_type) VALUES ('Orig', 'active', 'manual') RETURNING id")
			.first<{ id: number }>())!.id;
		const email = (await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type)
				 VALUES (?, 0, 'Welcome', 'hi', 'f@x.example.net', 'email') RETURNING id`
			)
			.bind(a)
			.first<{ id: number }>())!.id;
		const branch = (await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type, gate_kind, gate_ref_id)
				 VALUES (?, 1, '', '', '', 'branch', 'opened', ?) RETURNING id`
			)
			.bind(a, email)
			.first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type, tag_action, tag_name, parent_step_id, branch_label)
				 VALUES (?, 0, '', '', '', 'tag', 'add', 'engaged', ?, 'yes')`
			)
			.bind(a, branch)
			.run();

		// duplicate throws a redirect to the new automation
		let location = '';
		try {
			await actions.duplicate(actionEvent(a));
		} catch (r: any) {
			location = r?.location ?? '';
		}
		expect(location).toMatch(/^\/automations\/\d+$/);
		const newId = Number(location.split('/').pop());

		const copy = await db.prepare('SELECT name, status FROM automations WHERE id = ?').bind(newId).first<any>();
		expect(copy).toMatchObject({ name: 'Orig (copy)', status: 'draft' });

		const steps = await db
			.prepare('SELECT id, type, gate_kind, gate_ref_id, parent_step_id, branch_label, tag_name FROM automation_steps WHERE automation_id = ? ORDER BY position, id')
			.bind(newId)
			.all<any>();
		expect(steps.results).toHaveLength(3);
		const newEmail = steps.results.find((s: any) => s.type === 'email');
		const newBranch = steps.results.find((s: any) => s.type === 'branch');
		const newTag = steps.results.find((s: any) => s.type === 'tag');
		// opened-ref remapped to the COPIED email step, not the original.
		expect(newBranch.gate_ref_id).toBe(newEmail.id);
		expect(newBranch.gate_ref_id).not.toBe(email);
		// child re-parented to the copied branch.
		expect(newTag.parent_step_id).toBe(newBranch.id);
		expect(newTag.branch_label).toBe('yes');
		expect(newTag.tag_name).toBe('engaged');
	});
});
