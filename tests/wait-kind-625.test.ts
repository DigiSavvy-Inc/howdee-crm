import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #625: the wait step's kind is picked first, and a plain timed wait (`delay`) is the default.
// Covers normalizeWait for the new mode and its limits, the engine timing with and without
// weekdays_only, the "no previous email" skip, the save / activation refusals, the default for a
// new step, the drawer's form fields and the plain-words summaries.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { enroll, tick } from '../src/lib/server/automations';
import { addStep, readSpec, updateStep, type Actor } from '../src/lib/server/automation-write';
import { activationProblems } from '../src/lib/server/automation-bulk';
import { timelineFor } from '../src/lib/server/automation-flow';
import {
	DEFAULT_WAIT,
	NO_PREVIOUS_EMAIL,
	WAIT_KIND_CHOICES,
	delayText,
	normalizeWait,
	previousEmailStep,
	splitDelay,
	stepHasLanes,
	waitText,
	type FlowStepRef
} from '../src/lib/automation-flow';
import { specWaitEmailProblems, toSeconds, type StepSpec } from '../src/lib/automation-spec';
import { actions } from '../src/routes/automations/[id]/+page.server';

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
		db.prepare(`DELETE FROM app_state WHERE key IN ('automation_frequency_cap', 'timezone')`)
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;

async function automation(status = 'active'): Promise<number> {
	return (await one<{ id: number }>("INSERT INTO automations (name, status, trigger_type) VALUES ('Flow', ?, 'manual') RETURNING id", status)).id;
}

type StepOpts = Record<string, string | number | null>;
async function step(aid: number, position: number, type: string, o: StepOpts = {}): Promise<number> {
	const cols: StepOpts = {
		automation_id: aid,
		position,
		type,
		delay_before_seconds: 0,
		subject: type === 'email' ? 'Hello' : '',
		body_md: type === 'email' ? 'Body' : '',
		from_email: type === 'email' ? 'alan@ourco.example' : '',
		...o
	};
	const keys = Object.keys(cols);
	return (
		await one<{ id: number }>(
			`INSERT INTO automation_steps (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`,
			...keys.map((k) => cols[k])
		)
	).id;
}
const waitStep = (aid: number, position: number, wait: unknown, o: StepOpts = {}) => step(aid, position, 'wait', { wait_config: JSON.stringify(wait), ...o });
const contact = async (email: string) => (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;
const pass = (aid: number, cid: number) =>
	one<{ id: number; status: string; current_step_id: number | null; next_run_at: string | null }>(
		'SELECT id, status, current_step_id, next_run_at FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1',
		aid,
		cid
	);
const dueNow = () => db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE status = 'active'`).run();
const hasTag = async (cid: number, tag: string) =>
	!!(await db
		.prepare(`SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = ? AND l.kind = 'tag' AND l.name = ?`)
		.bind(cid, tag)
		.first());

describe('delay wait: config + text', () => {
	it('normalizeWait accepts 1 minute to 365 days and keeps weekdays_only', () => {
		expect(normalizeWait({ mode: 'delay', seconds: 59 })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'delay', seconds: 365 * 86400 + 1 })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'delay' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'delay', seconds: 60 })).toEqual({ ok: true, wait: { mode: 'delay', seconds: 60 } });
		expect(normalizeWait({ mode: 'delay', seconds: 365 * 86400 })).toMatchObject({ ok: true });
		expect(normalizeWait({ mode: 'delay', seconds: 300.7, weekdays_only: true, event: 'clicked', junk: 1 })).toEqual({
			ok: true,
			wait: { mode: 'delay', seconds: 300, weekdays_only: true }
		});
		expect(normalizeWait({ mode: 'delay', seconds: 300, weekdays_only: false })).toEqual({ ok: true, wait: { mode: 'delay', seconds: 300 } });
		expect(stepHasLanes({ type: 'wait', wait_config: JSON.stringify({ mode: 'delay', seconds: 300 }) })).toBe(false);
		expect(DEFAULT_WAIT).toEqual({ mode: 'delay', seconds: 86400 });
		expect(WAIT_KIND_CHOICES.map((k) => k.mode)).toEqual(['delay', 'date', 'event', 'window', 'field_date', 'rules']); // #627 field_date, #626 rules
	});

	it('units and plain-words summaries', () => {
		expect(toSeconds(2, 'weeks')).toBe(1209600);
		expect(splitDelay(300)).toEqual({ value: 5, unit: 'minutes' });
		expect(splitDelay(6 * 3600)).toEqual({ value: 6, unit: 'hours' });
		expect(splitDelay(2 * 86400)).toEqual({ value: 2, unit: 'days' });
		expect(splitDelay(14 * 86400)).toEqual({ value: 2, unit: 'weeks' });
		expect(delayText(60)).toBe('1 minute');
		expect(delayText(604800)).toBe('1 week');
		expect(waitText({ mode: 'delay', seconds: 300 })).toBe('Wait 5 minutes');
		expect(waitText({ mode: 'delay', seconds: 86400, weekdays_only: true })).toBe('Wait 1 day · weekdays only');
		expect(waitText({ mode: 'event', event: 'clicked', timeout_seconds: 259200 }, { emailSubject: 'Welcome' })).toBe(
			'Wait until they click “Welcome”, up to 3 days'
		);
		expect(waitText({ mode: 'event', event: 'opened', timeout_seconds: 86400 })).toBe('Wait until they open the previous email, up to 1 day');
		expect(waitText({ mode: 'date', day: 'weekday', time: '09:00' })).toBe('Wait until next weekday at 09:00');
	});
});

describe('previous email', () => {
	const s = (id: number, type: string, position: number, parent: number | null = null, label: string | null = null): FlowStepRef => ({
		id,
		type,
		position,
		parent_step_id: parent,
		branch_label: label
	});

	it('finds the nearest email before a step, up through lanes; none before → null', () => {
		const steps = [s(1, 'email', 0), s(2, 'branch', 1), s(3, 'email', 0, 2, 'yes'), s(4, 'tag', 0, 2, 'no'), s(5, 'wait', 1, 2, 'no'), s(6, 'wait', 2)];
		expect(previousEmailStep(steps, 5)?.id).toBe(1); // NO lane: up to the trunk's email
		expect(previousEmailStep(steps, 6)?.id).toBe(3); // after the branch: the email inside its lanes
		expect(previousEmailStep(steps, 1)).toBeNull();
		expect(previousEmailStep([s(1, 'tag', 0), s(2, 'wait', 1)], 2)).toBeNull();
	});

	it('a spec flags an opened / clicked wait with no email before it', () => {
		const wait = (event: string): StepSpec => ({ type: 'wait', wait: { mode: 'event', event: event as 'clicked', timeout_seconds: 3600 } });
		expect(specWaitEmailProblems([wait('clicked')])).toEqual([{ path: 'steps[0]', message: NO_PREVIOUS_EMAIL }]);
		expect(specWaitEmailProblems([wait('replied')])).toEqual([]);
		expect(specWaitEmailProblems([{ type: 'email', subject: 'Hi', body_md: 'x' }, wait('opened')])).toEqual([]);
		expect(specWaitEmailProblems([{ type: 'branch', yes: [{ type: 'email' }], no: [wait('clicked')] }])).toEqual([
			{ path: 'steps[0].no[0]', message: NO_PREVIOUS_EMAIL }
		]);
	});
});

describe('delay wait: engine', () => {
	it('parks until the time has passed, then continues (no lanes)', async () => {
		const aid = await automation();
		const w = await waitStep(aid, 0, { mode: 'delay', seconds: 300 });
		await step(aid, 1, 'tag', { tag_action: 'add', tag_name: 'after' });
		const cid = await contact('d1@x.test');
		await enroll(db, aid, [cid]);
		const r = await tick(db, cfg);
		expect(r.waiting).toBe(1);
		const p = await pass(aid, cid);
		expect(p.current_step_id).toBe(w);
		const started = (await one<{ wait_started_at: string }>('SELECT wait_started_at FROM automation_enrollments WHERE id = ?', p.id)).wait_started_at;
		const expected = new Date(Date.parse(`${started.replace(' ', 'T')}Z`) + 300_000).toISOString().slice(0, 19).replace('T', ' ');
		expect(p.next_run_at).toBe(expected);
		expect(await hasTag(cid, 'after')).toBe(false);

		await db.prepare(`UPDATE automation_enrollments SET wait_started_at = datetime('now', '-6 minutes')`).run();
		await dueNow();
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		expect(await hasTag(cid, 'after')).toBe(true);
		expect((await pass(aid, cid)).status).toBe('completed');
		const kinds = (await timelineFor(db, [p.id])).get(p.id)!.map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ''}`);
		expect(kinds).toContain('wait:time passed');
	});

	it('weekdays_only moves a Saturday end to Monday at the same time (operator timezone)', async () => {
		const plain = await automation();
		await waitStep(plain, 0, { mode: 'delay', seconds: 86400 });
		const weekdays = await automation();
		await waitStep(weekdays, 0, { mode: 'delay', seconds: 86400, weekdays_only: true });
		const cid = await contact('d2@x.test');
		await enroll(db, plain, [cid]);
		await enroll(db, weekdays, [cid]);
		await tick(db, cfg); // both start waiting
		// Friday 2027-01-01 12:00 PST + 1 day = Saturday 12:00 → Monday Jan 4, 12:00 PST (20:00Z).
		await db.prepare(`UPDATE automation_enrollments SET wait_started_at = '2027-01-01 20:00:00'`).run();
		await dueNow();
		await tick(db, cfg);
		expect((await pass(plain, cid)).next_run_at).toBe('2027-01-02 20:00:00');
		expect((await pass(weekdays, cid)).next_run_at).toBe('2027-01-04 20:00:00');
	});
});

describe('opened / clicked wait without a previous email', () => {
	it('engine: no email sent in this pass → "Timed out" at once, logged', async () => {
		const aid = await automation();
		const w = await waitStep(aid, 0, { mode: 'event', event: 'clicked', timeout_seconds: 3 * 86400 });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'yes', tag_action: 'add', tag_name: 'clicked' });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'no', tag_action: 'add', tag_name: 'skipped' });
		const cid = await contact('np@x.test');
		await enroll(db, aid, [cid]);
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		expect(await hasTag(cid, 'skipped')).toBe(true);
		expect(await hasTag(cid, 'clicked')).toBe(false);
		const p = await pass(aid, cid);
		expect(p.status).toBe('completed');
		const kinds = (await timelineFor(db, [p.id])).get(p.id)!.map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ''}`);
		expect(kinds).toContain('wait:no previous email, skipped');
		expect((await one<{ label: string }>('SELECT label FROM automation_branch_hits WHERE step_id = ?', w)).label).toBe('no');
	});

	it('save is refused with a plain message; an email before it makes it valid; activation lists a stored one', async () => {
		const aid = await automation('draft');
		const add = await addStep(db, aid, { type: 'wait' }, actor);
		const wid = add.ok ? add.data.step_id : 0;
		const r = await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'clicked', timeout_seconds: 86400 } } }, actor);
		expect(r).toMatchObject({ ok: false, error: NO_PREVIOUS_EMAIL });
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'replied', timeout_seconds: 86400 } } }, actor)).ok).toBe(true);

		// An email before the wait → clicked is fine.
		await db.prepare('UPDATE automation_steps SET position = position + 1 WHERE automation_id = ?').bind(aid).run();
		await step(aid, 0, 'email');
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'clicked', timeout_seconds: 86400 } } }, actor)).ok).toBe(true);

		// An automation that already stores one (saved before #625) can't be activated.
		const old = await automation('draft');
		const ow = await waitStep(old, 0, { mode: 'event', event: 'opened', timeout_seconds: 86400 });
		const problems = await activationProblems(db, old);
		expect(problems).toContainEqual(expect.objectContaining({ step_id: ow, message: expect.stringContaining(NO_PREVIOUS_EMAIL) }));
	});
});

describe('defaults, the drawer form and the spec', () => {
	it('a new wait step is "a set period of time", 1 day; the spec reads it back', async () => {
		const aid = await automation('draft');
		const add = await addStep(db, aid, { type: 'wait' }, actor);
		expect(add.ok).toBe(true);
		const row = await one<{ wait_config: string; ready: number }>('SELECT wait_config, ready FROM automation_steps WHERE id = ?', add.ok ? add.data.step_id : 0);
		expect(JSON.parse(row.wait_config)).toEqual({ mode: 'delay', seconds: 86400 });
		const spec = await readSpec(db, aid);
		expect(spec.ok && spec.data.steps[0]).toMatchObject({ type: 'wait', wait: { mode: 'delay', seconds: 86400 } });
		expect(spec.ok && spec.data.steps[0].yes).toBeUndefined();
	});

	it('the drawer posts a delay in minutes / hours / days / weeks and keeps an older extra delay', async () => {
		const aid = await automation('draft');
		const wid = await waitStep(aid, 0, { mode: 'delay', seconds: 86400 }, { delay_before_seconds: 3600 });
		const post = (fields: Record<string, string>) => {
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.append(k, v);
			const url = new URL(`https://app.test/automations/${aid}`);
			return actions.updateStep({
				platform: { env: { ...(env as any), POSTMARK_FROM: 'alan@ourco.example' } },
				params: { id: String(aid) },
				url,
				locals: { user: { id: 1, role: 'admin', login: 'admin' } },
				request: new Request(url, { method: 'POST', body: fd })
			} as any);
		};
		await post({ step_id: String(wid), wait_mode: 'delay', wait_delay_value: '2', wait_delay_unit: 'weeks', wait_weekdays_only: '1', delay_value: '1', delay_unit: 'hours' });
		let row = await one<{ wait_config: string; delay_before_seconds: number }>('SELECT wait_config, delay_before_seconds FROM automation_steps WHERE id = ?', wid);
		expect(JSON.parse(row.wait_config)).toEqual({ mode: 'delay', seconds: 1209600, weekdays_only: true });
		expect(row.delay_before_seconds).toBe(3600);
		// "Remove the extra wait" posts delay_value 0.
		await post({ step_id: String(wid), wait_mode: 'delay', wait_delay_value: '5', wait_delay_unit: 'minutes', delay_value: '0', delay_unit: 'hours' });
		row = await one<{ wait_config: string; delay_before_seconds: number }>('SELECT wait_config, delay_before_seconds FROM automation_steps WHERE id = ?', wid);
		expect(JSON.parse(row.wait_config)).toEqual({ mode: 'delay', seconds: 300 });
		expect(row.delay_before_seconds).toBe(0);
	});
});
