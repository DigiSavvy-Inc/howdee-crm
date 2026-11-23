import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #627: the "Until a date field matches" wait — config, target maths (on / before / after,
// hours / days / weeks), both if_passed choices, a missing value, a value that changes while
// waiting, and the save-time check that the field is a defined, active date custom field.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { enroll, tick } from '../src/lib/server/automations';
import { addStep, readSpec, type Actor } from '../src/lib/server/automation-write';
import { fieldDateTarget, timelineFor } from '../src/lib/server/automation-flow';
import { normalizeWait, stepHasLanes, waitText, type WaitSpec } from '../src/lib/automation-flow';

const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const actor: Actor = { kind: 'system' };

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM custom_fields'),
		db.prepare(`DELETE FROM app_state WHERE key IN ('automation_frequency_cap', 'timezone')`)
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;

async function automation(status = 'active'): Promise<number> {
	return (await one<{ id: number }>("INSERT INTO automations (name, status, trigger_type) VALUES ('Flow', ?, 'manual') RETURNING id", status)).id;
}
async function step(aid: number, position: number, type: string, o: Record<string, string | number | null> = {}): Promise<number> {
	const cols: Record<string, string | number | null> = { automation_id: aid, position, type, delay_before_seconds: 0, subject: '', body_md: '', from_email: '', ...o };
	const keys = Object.keys(cols);
	return (
		await one<{ id: number }>(
			`INSERT INTO automation_steps (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`,
			...keys.map((k) => cols[k])
		)
	).id;
}
const contact = async (email: string) => (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;
const pass = (aid: number, cid: number) =>
	one<{ id: number; status: string; next_run_at: string | null }>(
		'SELECT id, status, next_run_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1',
		aid,
		cid
	);
const dueNow = () => db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE status = 'active'`).run();
const hasTag = async (cid: number, tag: string) =>
	!!(await db
		.prepare(`SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = ? AND l.kind = 'tag' AND l.name = ?`)
		.bind(cid, tag)
		.first());

describe('field_date wait: config + text', () => {
	it('normalizeWait validates and keeps only its own fields', () => {
		expect(normalizeWait({ mode: 'field_date' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'sideways' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'before' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'before', offset: 3, unit: 'years' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'on', time: '25:00' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'on', if_passed: 'maybe' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'on', offset: 9, seconds: 5 })).toEqual({
			ok: true,
			wait: { mode: 'field_date', field: 'webinar', relation: 'on', time: '09:00', if_passed: 'continue' }
		});
		expect(
			normalizeWait({ mode: 'field_date', field: 'webinar', relation: 'before', offset: 3, unit: 'days', time: '08:30', if_passed: 'exit' })
		).toEqual({
			ok: true,
			wait: { mode: 'field_date', field: 'webinar', relation: 'before', offset: 3, unit: 'days', time: '08:30', if_passed: 'exit' }
		});
		expect(stepHasLanes({ type: 'wait', wait_config: JSON.stringify({ mode: 'field_date', field: 'w', relation: 'on' }) })).toBe(false);
	});

	it('summaries', () => {
		expect(waitText({ mode: 'field_date', field: 'webinar', relation: 'before', offset: 3, unit: 'days' }, { fieldLabel: 'Webinar date' })).toBe(
			'Wait until 3 days before Webinar date'
		);
		expect(waitText({ mode: 'field_date', field: 'renewal', relation: 'on', if_passed: 'exit' })).toBe('Wait until renewal · exit if passed');
	});
});

describe('fieldDateTarget (operator timezone America/Los_Angeles)', () => {
	const tz = 'America/Los_Angeles';
	const w = (o: object) => ({ mode: 'field_date', field: 'd', time: '09:00', ...o }) as never;
	it('on / before / after with days, weeks and hours', () => {
		expect(fieldDateTarget(w({ relation: 'on' }), '2099-06-15', tz)?.toISOString()).toBe('2099-06-15T16:00:00.000Z');
		expect(fieldDateTarget(w({ relation: 'before', offset: 3, unit: 'days' }), '2099-06-15', tz)?.toISOString()).toBe('2099-06-12T16:00:00.000Z');
		expect(fieldDateTarget(w({ relation: 'after', offset: 2, unit: 'weeks' }), '2099-06-15', tz)?.toISOString()).toBe('2099-06-29T16:00:00.000Z');
		expect(fieldDateTarget(w({ relation: 'before', offset: 5, unit: 'hours' }), '2099-06-15', tz)?.toISOString()).toBe('2099-06-15T11:00:00.000Z');
		expect(fieldDateTarget(w({ relation: 'after', offset: 1, unit: 'hours', time: '10:30' }), '2099-06-15T00:00:00Z', tz)?.toISOString()).toBe(
			'2099-06-15T18:30:00.000Z'
		);
	});
	it('missing or unreadable values are null', () => {
		for (const v of [undefined, null, '', 'soon', '2099-13-40', '15/06/2099', '2099-02-30']) {
			expect(fieldDateTarget(w({ relation: 'on' }), v, tz)).toBeNull();
		}
	});
});

describe('field_date wait: engine', () => {
	const setField = (cid: number, v: string | null) =>
		db.prepare('UPDATE contacts SET meta = ? WHERE id = ?').bind(v === null ? '{}' : JSON.stringify({ webinar: v }), cid).run();
	const ymd = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
	const flow = async (wait: object) => {
		const aid = await automation();
		await step(aid, 0, 'wait', { wait_config: JSON.stringify({ mode: 'field_date', field: 'webinar', relation: 'on', time: '09:00', ...wait }) });
		await step(aid, 1, 'tag', { tag_action: 'add', tag_name: 'after' });
		return aid;
	};
	const run = async (aid: number, cid: number) => {
		await enroll(db, aid, [cid]);
		for (let i = 0; i < 3; i++) await tick(db, cfg);
	};
	const kinds = async (pid: number) => (await timelineFor(db, [pid])).get(pid)!.map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ''}`);

	it('parks for a future date (re-check interval, not the far target), continues once the date is reached', async () => {
		const aid = await flow({ relation: 'before', offset: 1, unit: 'days' });
		const cid = await contact('f1@x.test');
		await setField(cid, '2099-06-15');
		await run(aid, cid);
		let p = await pass(aid, cid);
		expect(p.status).toBe('active');
		expect(Date.parse(`${p.next_run_at!.replace(' ', 'T')}Z`) - Date.now()).toBeLessThan(7 * 3600_000);
		expect(await hasTag(cid, 'after')).toBe(false);
		// The date moves into the past while waiting: the wait ran its course → continues.
		await setField(cid, ymd(-2));
		await dueNow();
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		p = await pass(aid, cid);
		expect(p.status).toBe('completed');
		expect(await hasTag(cid, 'after')).toBe(true);
		expect(await kinds(p.id)).toContain('wait:date reached');
	});

	it('a date pushed out while waiting keeps the contact waiting', async () => {
		const aid = await flow({});
		const cid = await contact('f2@x.test');
		await setField(cid, ymd(30));
		await run(aid, cid);
		await setField(cid, ymd(60));
		await dueNow();
		await tick(db, cfg);
		expect((await pass(aid, cid)).status).toBe('active');
		expect(await hasTag(cid, 'after')).toBe(false);
	});

	it('already passed on arrival: continue', async () => {
		const aid = await flow({ relation: 'after', offset: 1, unit: 'days', if_passed: 'continue' });
		const cid = await contact('f3@x.test');
		await setField(cid, '2000-01-01');
		await run(aid, cid);
		const p = await pass(aid, cid);
		expect(p.status).toBe('completed');
		expect(await hasTag(cid, 'after')).toBe(true);
		expect(await kinds(p.id)).toContain('wait:date already passed — continued');
	});

	it('already passed on arrival: exit ends the pass with a reason and skips later steps', async () => {
		const aid = await flow({ if_passed: 'exit' });
		const cid = await contact('f4@x.test');
		await setField(cid, '2000-01-01');
		await run(aid, cid);
		const p = await pass(aid, cid);
		expect(p.status).toBe('completed');
		expect(await hasTag(cid, 'after')).toBe(false);
		expect((await one<{ completed_reason: string }>('SELECT completed_reason FROM automation_enrollments WHERE id = ?', p.id)).completed_reason).toBe(
			'wait:field_date_passed'
		);
		expect(await kinds(p.id)).toContain('exit:date already passed — ended');
	});

	it('a missing / unreadable value counts as passed (both choices)', async () => {
		const cont = await flow({});
		const c1 = await contact('f5@x.test');
		await setField(c1, null);
		await run(cont, c1);
		expect(await hasTag(c1, 'after')).toBe(true);
		expect(await kinds((await pass(cont, c1)).id)).toContain('wait:date missing or unreadable — continued');

		const exit = await flow({ if_passed: 'exit' });
		const c2 = await contact('f6@x.test');
		await setField(c2, 'whenever');
		await run(exit, c2);
		const p = await pass(exit, c2);
		expect(p.status).toBe('completed');
		expect(await kinds(p.id)).toContain('exit:date missing or unreadable — ended');
	});

	it('a value that disappears while waiting follows if_passed', async () => {
		const aid = await flow({ if_passed: 'exit' });
		const cid = await contact('f7@x.test');
		await setField(cid, ymd(30));
		await run(aid, cid);
		expect((await pass(aid, cid)).status).toBe('active');
		await setField(cid, null);
		await dueNow();
		await tick(db, cfg);
		expect((await pass(aid, cid)).status).toBe('completed');
		expect(await hasTag(cid, 'after')).toBe(false);
	});
});

describe('field_date wait: save validation', () => {
	const makeField = (key: string, type: string, archived = false) =>
		db
			.prepare(
				`INSERT INTO custom_fields (key, label, type, options, position, archived_at) VALUES (?, ?, ?, '[]', 0, ${archived ? "datetime('now')" : 'NULL'})`
			)
			.bind(key, `${key} label`, type)
			.run();
	it('only an active, defined custom field of type date is accepted', async () => {
		const aid = await automation('draft');
		const w = (field: string): WaitSpec => ({ mode: 'field_date', field, relation: 'on' });
		expect(await addStep(db, aid, { type: 'wait', fields: { wait: w('nope') } }, actor)).toMatchObject({ ok: false });
		await makeField('webinar', 'date');
		await makeField('notes', 'text');
		await makeField('old', 'date', true);
		expect(await addStep(db, aid, { type: 'wait', fields: { wait: w('notes') } }, actor)).toMatchObject({ ok: false });
		expect(await addStep(db, aid, { type: 'wait', fields: { wait: w('old') } }, actor)).toMatchObject({ ok: false });
		expect(await addStep(db, aid, { type: 'wait', fields: { wait: w('webinar') } }, actor)).toMatchObject({ ok: true });
		const spec = await readSpec(db, aid);
		expect(spec.ok && spec.data.steps[0].wait).toMatchObject({ mode: 'field_date', field: 'webinar', relation: 'on', if_passed: 'continue' });
	});
});
