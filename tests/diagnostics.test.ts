import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { enroll, tick } from '../src/lib/server/automations';
import { actions } from '../src/routes/automations/[id]/+page.server';

// #80: automation diagnostics — tick_log summaries and last_error capture.
const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://x', stream: 'broadcast' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM tick_log'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		// Null self-referencing parents before bulk delete (avoids FK trips).
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

async function makeContact(email: string): Promise<number> {
	const c = await db
		.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id')
		.bind(email)
		.first<{ id: number }>();
	return c!.id;
}

async function makeAutomation(): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status) VALUES ('D', 'active') RETURNING id")
		.first<{ id: number }>();
	return a!.id;
}

async function addStep(aid: number, type: string, position = 0, extra: Record<string, unknown> = {}): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, type, subject, body_md, from_email,
			    tag_action, tag_name)
			 VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			aid,
			position,
			type,
			type === 'email' ? (extra.subject as string ?? 'Subj') : '',
			type === 'email' ? (extra.body as string ?? 'Body') : '',
			type === 'email' ? (extra.from as string ?? 'f@x.example.net') : '',
			type === 'tag' ? 'add' : null,
			type === 'tag' ? (extra.tag as string ?? 'mytag') : null
		)
		.first<{ id: number }>();
	return s!.id;
}

describe('diagnostics (#80)', () => {
	it('tick logs a summary row and prunes; a tick with nothing due adds no row', async () => {
		const aid = await makeAutomation();
		await addStep(aid, 'tag', 0, { tag: 'diag-tag' });
		const cid = await makeContact('diag@x.example.net');
		await enroll(db, aid, [cid]);

		// First tick: one enrollment due → should write one tick_log row.
		await tick(db, cfg);

		const rows = await db
			.prepare('SELECT processed, tagged FROM tick_log ORDER BY id DESC LIMIT 5')
			.all<{ processed: number; tagged: number }>();
		expect(rows.results.length).toBe(1);
		expect(rows.results[0].processed).toBe(1);
		expect(rows.results[0].tagged).toBe(1);

		// Second tick: nothing due → should NOT write another row.
		await tick(db, cfg);

		const rows2 = await db
			.prepare('SELECT COUNT(*) AS n FROM tick_log')
			.first<{ n: number }>();
		expect(rows2!.n).toBe(1);
	});

	it('a failing email step records last_error and eventually reaches failed status', async () => {
		const aid = await makeAutomation();
		// Email step: in tests, the Postmark fetch to 'https://api.postmarkapp.com/email/batch'
		// either errors (no network in vitest-workers env) or returns a non-OK auth error
		// because the token is 'x'. Either way, each tick calls failTransient; after
		// MAX_ATTEMPTS (5) the enrollment transitions to 'failed'.
		await addStep(aid, 'email', 0, {
			subject: 'Test',
			body: 'Hello',
			from: 'f@x.example.net'
		});
		const cid = await makeContact('fail@x.example.net');
		await enroll(db, aid, [cid]);

		// Run up to 6 ticks, forcing next_run_at due between each attempt.
		for (let i = 0; i < 6; i++) {
			await tick(db, cfg);
			// Force the enrollment back to due even when it was re-armed for later.
			await db
				.prepare("UPDATE automation_enrollments SET next_run_at=datetime('now') WHERE status='active' AND automation_id=?")
				.bind(aid)
				.run();
		}

		const enr = await db
			.prepare('SELECT status, last_error FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ status: string; last_error: string | null }>();

		expect(enr!.status).toBe('failed');
		expect(enr!.last_error).not.toBeNull();
	});

	it('retryEnrollment and cancelEnrollment actions work correctly', async () => {
		const aid = await makeAutomation();
		const sid = await addStep(aid, 'tag', 0, { tag: 'action-test' });
		const cid = await makeContact('action@x.example.net');

		// Insert a failed enrollment pointing at the real step.
		await db
			.prepare(
				`INSERT INTO automation_enrollments
				   (automation_id, contact_id, current_step_id, status, attempts, next_run_at)
				 VALUES (?, ?, ?, 'failed', 5, NULL)`
			)
			.bind(aid, cid, sid)
			.run();

		const eid = (await db
			.prepare('SELECT id FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ id: number }>())!.id;

		// retryEnrollment on a failed enrollment → makes it active with attempts=0.
		const fdRetry = new FormData();
		fdRetry.append('enrollment_id', String(eid));
		const retryResult = await actions.retryEnrollment({
			platform: { env },
			params: { id: String(aid) },
			request: new Request('https://app.test/', { method: 'POST', body: fdRetry })
		} as any);
		expect((retryResult as any).ok).toBe(true);

		const afterRetry = await db
			.prepare('SELECT status, attempts FROM automation_enrollments WHERE id = ?')
			.bind(eid)
			.first<{ status: string; attempts: number }>();
		expect(afterRetry!.status).toBe('active');
		expect(afterRetry!.attempts).toBe(0);

		// retryEnrollment on an active enrollment → fail(400).
		const fdRetry2 = new FormData();
		fdRetry2.append('enrollment_id', String(eid));
		const retryResult2 = await actions.retryEnrollment({
			platform: { env },
			params: { id: String(aid) },
			request: new Request('https://app.test/', { method: 'POST', body: fdRetry2 })
		} as any);
		expect((retryResult2 as any).status).toBe(400);

		// cancelEnrollment on the now-active enrollment → makes it cancelled.
		const fdCancel = new FormData();
		fdCancel.append('enrollment_id', String(eid));
		const cancelResult = await actions.cancelEnrollment({
			platform: { env },
			params: { id: String(aid) },
			request: new Request('https://app.test/', { method: 'POST', body: fdCancel })
		} as any);
		expect((cancelResult as any).ok).toBe(true);

		const afterCancel = await db
			.prepare('SELECT status FROM automation_enrollments WHERE id = ?')
			.bind(eid)
			.first<{ status: string }>();
		expect(afterCancel!.status).toBe('cancelled');
	});
});
