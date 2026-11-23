// #119 follow-up: flag-off parity, a timezone read that throws, and resend times.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { enroll, tick, weekdayDueUtc } from '../src/lib/server/automations';
import { actions as automationActions } from '../src/routes/automations/[id]/+page.server';
import { actions as composeActions } from '../src/routes/compose/+page.server';
import { actions as campaignActions } from '../src/routes/campaign/[id]/+page.server';
import { sqliteUtc } from '../src/lib/server/businessdays';

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
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key = 'timezone'`)
	]);
});

function dbThatThrowsOnTimezone(): D1Database {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === 'prepare') {
				return (sql: string) => {
					if (sql.includes("key = 'timezone'")) throw new Error('timezone read failed');
					return target.prepare(sql);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

async function secondsApart(stored: string, sqlExpr: string): Promise<number> {
	const row = await db
		.prepare(`SELECT abs(strftime('%s', ?) - strftime('%s', ${sqlExpr})) AS delta`)
		.bind(stored)
		.first<{ delta: number }>();
	return row!.delta;
}

async function makeContact(email: string): Promise<number> {
	const c = await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>();
	return c!.id;
}

async function makeAutomation(): Promise<number> {
	const a = await db
		.prepare("INSERT INTO automations (name, status, reentry) VALUES ('F', 'active', 'once') RETURNING id")
		.first<{ id: number }>();
	return a!.id;
}

async function tagStep(aid: number, position: number, delay: number, weekdayOnly = false): Promise<number> {
	const s = await db
		.prepare(
			`INSERT INTO automation_steps
			   (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name, weekday_only)
			 VALUES (?, ?, ?, '', '', '', 'tag', 'add', 't', ?) RETURNING id`
		)
		.bind(aid, position, delay, weekdayOnly ? 1 : 0)
		.first<{ id: number }>();
	return s!.id;
}

function formEvent(path: string, fields: Record<string, string>, params: Record<string, string> = {}) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return {
		platform: {
			env: {
				DB: db,
				POSTMARK_TOKEN: 'test-token',
				POSTMARK_STREAM: 'broadcast',
				SESSION_SECRET: 'secret',
				PUBLIC_BASE_URL: 'https://example.test'
			}
		},
		params,
		request: new Request(`https://example.test${path}`, { method: 'POST', body: fd }),
		url: new URL(`https://example.test${path}`)
	} as any;
}

async function expectRedirect(run: unknown): Promise<void> {
	let result: unknown;
	try {
		result = await (run as Promise<unknown>);
	} catch (e) {
		if (isRedirect(e)) return;
		throw e;
	}
	throw new Error(`expected a redirect, got ${JSON.stringify(result)}`);
}

describe('flag-off parity (#119 follow-up)', () => {
	it('enroll due time matches datetime(now, +N seconds) within a few seconds', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 90, false);
		const cid = await makeContact('enroll@x.example.net');
		expect((await enroll(db, aid, [cid])).enrolled).toBe(1);
		const row = await db
			.prepare('SELECT next_run_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ next_run_at: string }>();
		expect(await secondsApart(row!.next_run_at, "datetime('now', '+90 seconds')")).toBeLessThanOrEqual(5);
	});

	it('goToStep, advance, and tick with the flag off keep the SQL delay', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 0, false);
		const parked = await tagStep(aid, 1, 120, false);
		const cid = await makeContact('tick@x.example.net');
		await enroll(db, aid, [cid]);
		const summary = await tick(db, cfg);
		expect(summary.retried).toBe(0);
		expect(summary.failed).toBe(0);
		expect(summary.advanced).toBe(1);
		const row = await db
			.prepare('SELECT current_step_id, next_run_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ current_step_id: number; next_run_at: string }>();
		expect(row?.current_step_id).toBe(parked);
		expect(await secondsApart(row!.next_run_at, "datetime('now', '+120 seconds')")).toBeLessThanOrEqual(5);
	});

	it('tick still completes when a timezone read throws and the flag is off', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 0, false);
		const cid = await makeContact('throw@x.example.net');
		await enroll(db, aid, [cid]);
		const summary = await tick(dbThatThrowsOnTimezone(), cfg);
		expect(summary.processed).toBe(1);
		expect(summary.completed).toBe(1);
		expect(summary.retried).toBe(0);
		expect(summary.failed).toBe(0);
	});

	it('tick still advances when the next step is weekday_only and the timezone read throws', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 0, false);
		const next = await tagStep(aid, 1, 0, true);
		const cid = await makeContact('throw-on@x.example.net');
		await enroll(db, aid, [cid]);
		const summary = await tick(dbThatThrowsOnTimezone(), cfg);
		expect(summary.retried).toBe(0);
		expect(summary.failed).toBe(0);
		expect(summary.advanced).toBe(1);
		const row = await db
			.prepare('SELECT current_step_id, next_run_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ current_step_id: number; next_run_at: string }>();
		expect(row?.current_step_id).toBe(next);
		expect(row?.next_run_at).toBeTruthy();
	});

	it('weekdayDueUtc on a Saturday is Monday, and flag-off returns null without reading the zone', async () => {
		const saturday = new Date('2026-10-03T16:00:00Z'); // Sat 09:00 PDT
		expect(await weekdayDueUtc(dbThatThrowsOnTimezone(), 0, 0, saturday)).toBeNull();
		expect(await weekdayDueUtc(db, 0, 1, saturday, 'America/Los_Angeles')).toBe('2026-10-05 16:00:00');
	});

	it('deleteStep keeps the SQL delay when the following step is not flagged', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 0, false);
		const doomed = await tagStep(aid, 1, 0, false);
		const after = await tagStep(aid, 2, 45, false);
		const cid = await makeContact('del@x.example.net');
		await enroll(db, aid, [cid]);
		await tick(db, cfg);
		await automationActions.deleteStep(formEvent(`/automations/${aid}`, { step_id: String(doomed) }, { id: String(aid) }));
		const row = await db
			.prepare('SELECT current_step_id, next_run_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ current_step_id: number; next_run_at: string }>();
		expect(row?.current_step_id).toBe(after);
		expect(await secondsApart(row!.next_run_at, "datetime('now', '+45 seconds')")).toBeLessThanOrEqual(5);
	});

	it('deleteStep uses the weekday due time when the following step is flagged', async () => {
		const aid = await makeAutomation();
		await tagStep(aid, 0, 0, false);
		const doomed = await tagStep(aid, 1, 0, false);
		const after = await tagStep(aid, 2, 0, true);
		const cid = await makeContact('del-on@x.example.net');
		await enroll(db, aid, [cid]);
		await tick(db, cfg);
		const before = Date.now();
		await automationActions.deleteStep(formEvent(`/automations/${aid}`, { step_id: String(doomed) }, { id: String(aid) }));
		const afterMs = Date.now();
		const row = await db
			.prepare('SELECT current_step_id, next_run_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(cid)
			.first<{ current_step_id: number; next_run_at: string }>();
		expect(row?.current_step_id).toBe(after);
		const lo = Date.parse((await weekdayDueUtc(db, 0, 1, new Date(before)))!.replace(' ', 'T') + 'Z');
		const hi = Date.parse((await weekdayDueUtc(db, 0, 1, new Date(afterMs)))!.replace(' ', 'T') + 'Z');
		const stored = Date.parse(row!.next_run_at.replace(' ', 'T') + 'Z');
		expect(stored).toBeGreaterThanOrEqual(lo - 2000);
		expect(stored).toBeLessThanOrEqual(hi + 2000);
	});
});

async function makeList(): Promise<number> {
	const list = await db.prepare("INSERT INTO lists (name, kind) VALUES ('Resend', 'list') RETURNING id").first<{ id: number }>();
	const cid = await makeContact('reader@x.example.net');
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list!.id, cid).run();
	return list!.id;
}

describe('compose and campaign resend with the box unticked (#119 follow-up)', () => {
	// These cases send fixed October 2026 instants. Compose rejects a resend under
	// an hour out and campaign rejects one under 15 minutes, so pin "now" before
	// those dates. Only Date is faked; SQLite datetime('now') stays the real clock.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('compose 24h and 3d stay on the calendar day, including a weekend', async () => {
		const listId = await makeList();
		await expectRedirect(
			composeActions.send(
				formEvent('/compose', {
					subject: 'Hello',
					from: 'alan@ourco.example',
					body_md: 'Body',
					list_id: String(listId),
					schedule_at: '2026-10-09T17:00:00.000Z',
					resend_delay: '24h'
				})
			)
		);
		const day = await db
			.prepare(`SELECT resend_at, weekday_only FROM campaigns WHERE resend_status = 'pending'`)
			.first<{ resend_at: string; weekday_only: number }>();
		expect(day).toEqual({ resend_at: '2026-10-10 17:00:00', weekday_only: 0 });

		await db.prepare('DELETE FROM campaigns').run();
		await expectRedirect(
			composeActions.send(
				formEvent('/compose', {
					subject: 'Hello',
					from: 'alan@ourco.example',
					body_md: 'Body',
					list_id: String(listId),
					schedule_at: '2026-10-07T17:00:00.000Z',
					resend_delay: '3d'
				})
			)
		);
		const three = await db
			.prepare(`SELECT resend_at, weekday_only FROM campaigns WHERE resend_status = 'pending'`)
			.first<{ resend_at: string; weekday_only: number }>();
		expect(three).toEqual({ resend_at: '2026-10-10 17:00:00', weekday_only: 0 });
	});

	it('compose custom resend is the operator timezone, not UTC', async () => {
		const listId = await makeList();
		await expectRedirect(
			composeActions.send(
				formEvent('/compose', {
					subject: 'Hello',
					from: 'alan@ourco.example',
					body_md: 'Body',
					list_id: String(listId),
					schedule_at: '2026-10-07T15:00:00.000Z',
					resend_delay: 'custom',
					resend_at: '2026-10-07T10:00'
				})
			)
		);
		const row = await db
			.prepare(`SELECT scheduled_at, resend_at, weekday_only FROM campaigns`)
			.first<{ scheduled_at: string; resend_at: string; weekday_only: number }>();
		expect(row).toEqual({
			scheduled_at: '2026-10-07 15:00:00',
			resend_at: '2026-10-07 17:00:00',
			weekday_only: 0
		});
	});

	async function sentCampaign(weekdayOnly: number): Promise<number> {
		const created = await db
			.prepare(
				`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, weekday_only)
				 VALUES ('Hello', 'md', '<p>hi %%UNSUB_URL%%</p>', 'alan@ourco.example', 'sent', ?) RETURNING id`
			)
			.bind(weekdayOnly)
			.first<{ id: number }>();
		return created!.id;
	}

	it('campaign 24h and 3d with the box unticked do not clear weekday_only', async () => {
		const dayId = await sentCampaign(1);
		await expectRedirect(
			campaignActions.resend(formEvent(`/campaign/${dayId}`, { subject: 'Hello', resend_when: '24h' }, { id: String(dayId) }))
		);
		const day = await db
			.prepare('SELECT resend_at, weekday_only, resend_status FROM campaigns WHERE id = ?')
			.bind(dayId)
			.first<{ resend_at: string; weekday_only: number; resend_status: string }>();
		expect(day?.weekday_only).toBe(1);
		expect(day?.resend_status).toBe('pending');
		expect(await secondsApart(day!.resend_at, "datetime('now', '+1 day')")).toBeLessThanOrEqual(5);

		const threeId = await sentCampaign(1);
		await expectRedirect(
			campaignActions.resend(formEvent(`/campaign/${threeId}`, { subject: 'Hello', resend_when: '3d' }, { id: String(threeId) }))
		);
		const three = await db
			.prepare('SELECT resend_at, weekday_only FROM campaigns WHERE id = ?')
			.bind(threeId)
			.first<{ resend_at: string; weekday_only: number }>();
		expect(three?.weekday_only).toBe(1);
		expect(await secondsApart(three!.resend_at, "datetime('now', '+3 days')")).toBeLessThanOrEqual(5);
	});

	it('campaign custom resend with the box unticked keeps weekday_only and uses the operator zone', async () => {
		const id = await sentCampaign(1);
		await expectRedirect(
			campaignActions.resend(
				formEvent(
					`/campaign/${id}`,
					{ subject: 'Hello', resend_when: 'custom', resend_at: '2026-10-07T10:00' },
					{ id: String(id) }
				)
			)
		);
		const row = await db
			.prepare('SELECT resend_at, weekday_only FROM campaigns WHERE id = ?')
			.bind(id)
			.first<{ resend_at: string; weekday_only: number }>();
		expect(row).toEqual({ resend_at: '2026-10-07 17:00:00', weekday_only: 1 });
		expect(sqliteUtc(new Date('2026-10-07T10:00:00.000Z'))).toBe('2026-10-07 10:00:00');
	});
});
