import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { bulkLabel, bulkSetStatus, deleteAutomations } from '../src/lib/server/automation-bulk';
import { MAX_LABELS_PER_AUTOMATION, listLabels } from '../src/lib/server/automation-labels';
import { actions } from '../src/routes/automations/+page.server';
import { actions as detailActions } from '../src/routes/automations/[id]/+page.server';

// #164: bulk status / labels / delete on the /automations list.
const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_labels'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeAutomation(
	name: string,
	opts: { status?: string; steps?: number; trigger?: 'manual' | 'list_added' } = {}
): Promise<number> {
	const id = (await db
		.prepare('INSERT INTO automations (name, status, trigger_type) VALUES (?, ?, ?) RETURNING id')
		.bind(name, opts.status ?? 'draft', opts.trigger ?? 'manual')
		.first<{ id: number }>())!.id;
	for (let i = 0; i < (opts.steps ?? 1); i++) {
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type)
				 VALUES (?, ?, 'S', 'b', 'f@x.example.net', 'email')`
			)
			.bind(id, i)
			.run();
	}
	return id;
}

async function statusOf(id: number): Promise<string | undefined> {
	return (await db.prepare('SELECT status FROM automations WHERE id = ?').bind(id).first<{ status: string }>())?.status;
}

function listEvent(action: string, ids: (number | string)[], fields: Record<string, string> = {}, qs = '') {
	const fd = new FormData();
	for (const id of ids) fd.append('id', String(id));
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = new URL(`https://app.test/automations?/${action}${qs}`);
	return {
		platform: { env },
		params: {},
		url,
		request: new Request(url, { method: 'POST', body: fd })
	} as any;
}

describe('bulkSetStatus', () => {
	it('activates valid automations and skips ones the activate validation rejects', async () => {
		const ok1 = await makeAutomation('A');
		const ok2 = await makeAutomation('B', { status: 'paused' });
		const noSteps = await makeAutomation('Welcome v2', { steps: 0 });
		const noList = await makeAutomation('Listless', { trigger: 'list_added' });

		const r = await bulkSetStatus(db, [ok1, ok2, noSteps, noList], 'active');
		expect(r.changed).toBe(2);
		expect([...r.skipped].sort((x, y) => x.id - y.id)).toEqual([
			{ id: noSteps, name: 'Welcome v2', reason: 'no steps' },
			{ id: noList, name: 'Listless', reason: 'no trigger list' }
		]);
		expect(await statusOf(ok1)).toBe('active');
		expect(await statusOf(ok2)).toBe('active');
		expect(await statusOf(noSteps)).toBe('draft');
		expect(await statusOf(noList)).toBe('draft');
	});

	it('pauses, ignoring unknown ids and junk', async () => {
		const a = await makeAutomation('A', { status: 'active' });
		const b = await makeAutomation('B', { status: 'active' });
		const r = await bulkSetStatus(db, [a, b, 999999, 'x', -1], 'paused');
		expect(r).toEqual({ changed: 2, skipped: [] });
		expect(await statusOf(a)).toBe('paused');
	});

	it('handles more than 40 ids (chunked)', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 45; i++) ids.push(await makeAutomation(`A${i}`, { status: 'active', steps: 0 }));
		const r = await bulkSetStatus(db, ids, 'paused');
		expect(r.changed).toBe(45);
		const n = await db.prepare(`SELECT COUNT(*) AS n FROM automations WHERE status = 'paused'`).first<{ n: number }>();
		expect(n?.n).toBe(45);
	});
});

describe('bulkLabel', () => {
	it('adds a label across many, skipping one at the cap and leaving existing ones alone', async () => {
		const a = await makeAutomation('A');
		const b = await makeAutomation('B');
		const full = await makeAutomation('Full');
		await db.prepare(`INSERT INTO automation_labels (automation_id, label) VALUES (?, 'Nurture')`).bind(b).run();
		for (let i = 0; i < MAX_LABELS_PER_AUTOMATION; i++) {
			await db.prepare('INSERT INTO automation_labels (automation_id, label) VALUES (?, ?)').bind(full, `l${i}`).run();
		}

		const r = await bulkLabel(db, [a, b, full, 424242], '  nurture ', 'add');
		expect(r).toEqual({ changed: 1, skipped: [{ id: full, name: 'Full', reason: `already has ${MAX_LABELS_PER_AUTOMATION} tags` }] });
		expect(await listLabels(db, a)).toEqual(['nurture']);
		expect(await listLabels(db, b)).toEqual(['Nurture']); // NOCASE dedupe — untouched
		expect(await listLabels(db, full)).not.toContain('nurture');
	});

	it('removes a label; missing is a no-op; invalid label is an error', async () => {
		const a = await makeAutomation('A');
		const b = await makeAutomation('B');
		await db.prepare(`INSERT INTO automation_labels (automation_id, label) VALUES (?, 'cs')`).bind(a).run();
		expect(await bulkLabel(db, [a, b], 'CS', 'remove')).toEqual({ changed: 1, skipped: [] });
		expect(await listLabels(db, a)).toEqual([]);
		expect(await bulkLabel(db, [a], '   ', 'add')).toEqual({ error: 'Tags are 1–30 characters.' });
	});

	it('adds to more than 40 automations (chunked)', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 43; i++) ids.push(await makeAutomation(`A${i}`, { steps: 0 }));
		const r = await bulkLabel(db, ids, 'nurture', 'add');
		expect('changed' in r && r.changed).toBe(43);
	});
});

describe('deleteAutomations', () => {
	it('cascades steps, enrollments, branch hits and labels; skips one that has sent', async () => {
		const a = await makeAutomation('A', { status: 'active', steps: 2 });
		const sent = await makeAutomation('Sent', { status: 'active' });
		const contact = (await db
			.prepare(`INSERT INTO contacts (email, subscribed) VALUES ('x@y.example.net', 1) RETURNING id`)
			.first<{ id: number }>())!.id;
		const step = (await db.prepare('SELECT id FROM automation_steps WHERE automation_id = ? LIMIT 1').bind(a).first<{ id: number }>())!.id;
		await db.prepare('UPDATE automation_steps SET parent_step_id = ? WHERE automation_id = ? AND id != ?').bind(step, a, step).run();
		const enr = (await db
			.prepare(
				`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, next_run_at)
				 VALUES (?, ?, ?, 'active', datetime('now')) RETURNING id`
			)
			.bind(a, contact, step)
			.first<{ id: number }>())!.id;
		await db.prepare(`INSERT INTO automation_branch_hits (step_id, enrollment_id, label) VALUES (?, ?, 'yes')`).bind(step, enr).run();
		await db.prepare(`INSERT INTO automation_labels (automation_id, label) VALUES (?, 'nurture')`).bind(a).run();
		await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id)
				 VALUES ('s', 'b', 'b', 'f@x.example.net', 'sent', ?)`
			)
			.bind(sent)
			.run();

		const r = await deleteAutomations(db, [a, sent, 777777]);
		expect(r.changed).toBe(1);
		expect(r.skipped).toEqual([{ id: sent, name: 'Sent', reason: 'already sent emails — pause it instead' }]);

		const count = async (sql: string) => (await db.prepare(sql).bind(a).first<{ n: number }>())!.n;
		expect(await count('SELECT COUNT(*) AS n FROM automations WHERE id = ?')).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ?')).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?')).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM automation_labels WHERE automation_id = ?')).toBe(0);
		const hits = await db.prepare('SELECT COUNT(*) AS n FROM automation_branch_hits').first<{ n: number }>();
		expect(hits?.n).toBe(0);
		expect(await statusOf(sent)).toBe('active');
		// The contact itself is untouched.
		expect(await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(contact).first()).not.toBeNull();
	});

	it('deletes more than 40 at once (chunked)', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 41; i++) ids.push(await makeAutomation(`A${i}`));
		expect((await deleteAutomations(db, ids)).changed).toBe(41);
		const n = await db.prepare('SELECT COUNT(*) AS n FROM automations').first<{ n: number }>();
		expect(n?.n).toBe(0);
	});
});

describe('list page bulk actions', () => {
	it('bulkPause pauses all selected and reports counts', async () => {
		const ids = [
			await makeAutomation('A', { status: 'active' }),
			await makeAutomation('B', { status: 'active' }),
			await makeAutomation('C', { status: 'active' })
		];
		const res = await actions.bulkPause(listEvent('bulkPause', ids, {}, '&status=active'));
		expect(res).toEqual({ bulkMessage: 'Paused 3 of 3 selected' });
		for (const id of ids) expect(await statusOf(id)).toBe('paused');
	});

	it('bulkActivate banner names skipped automations', async () => {
		const a = await makeAutomation('A');
		const w = await makeAutomation('Welcome v2', { steps: 0 });
		const res = await actions.bulkActivate(listEvent('bulkActivate', [a, w]));
		expect(res).toEqual({ bulkMessage: 'Activated 1 of 2 selected · skipped 1 (Welcome v2: no steps)' });
	});

	it('bulkDelete requires typing "delete"', async () => {
		const a = await makeAutomation('A');
		const refused: any = await actions.bulkDelete(listEvent('bulkDelete', [a], { confirm: 'yes' }));
		expect(refused.status).toBe(400);
		expect(await statusOf(a)).toBe('draft');
		const res = await actions.bulkDelete(listEvent('bulkDelete', [a], { confirm: 'delete' }));
		expect(res).toEqual({ bulkMessage: 'Deleted 1 of 1 selected' });
		expect(await statusOf(a)).toBeUndefined();
	});

	it('the single delete action uses the same rule (refuses a sent automation)', async () => {
		const sent = await makeAutomation('Sent');
		await db
			.prepare(`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, automation_id) VALUES ('s','b','b','f@x.example.net','sent',?)`)
			.bind(sent)
			.run();
		const fd = new FormData();
		const res: any = await detailActions.delete({
			platform: { env },
			params: { id: String(sent) },
			request: new Request('https://app.test/automations/x', { method: 'POST', body: fd })
		} as any);
		expect(res.status).toBe(400);
		expect(await statusOf(sent)).toBe('draft');
	});
});
