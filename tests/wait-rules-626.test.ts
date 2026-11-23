import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #626: a wait step "Until specific conditions are met" — a Condition rule set the contact must
// match, with an optional time limit. Covers normalising, the engine (match → "Did it", the
// deadline → "Timed out", no limit = waits until they match), save / activation checks, the
// spec round trip, the drawer's form fields and the plain-words summaries.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { enroll, tick } from '../src/lib/server/automations';
import { addStep, createFromSpec, readSpec, updateStep, type Actor } from '../src/lib/server/automation-write';
import { activationProblems } from '../src/lib/server/automation-bulk';
import { timelineFor } from '../src/lib/server/automation-flow';
import {
	WAIT_KIND_CHOICES,
	WAIT_RULES_NO_STEP,
	normalizeWait,
	parseWait,
	stepHasLanes,
	waitModeHasLanes,
	waitText,
	waitingText
} from '../src/lib/automation-flow';
import { waitRulesText } from '../src/lib/automation-action-labels';
import { specHasLanes } from '../src/lib/automation-spec';
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
	const cols: StepOpts = { automation_id: aid, position, type, delay_before_seconds: 0, subject: '', body_md: '', from_email: '', ...o };
	const keys = Object.keys(cols);
	return (
		await one<{ id: number }>(
			`INSERT INTO automation_steps (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`,
			...keys.map((k) => cols[k])
		)
	).id;
}
const waitStep = (aid: number, position: number, wait: unknown) => step(aid, position, 'wait', { wait_config: JSON.stringify(wait) });
const contact = async (email: string) => (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;
async function tagContact(cid: number, name: string) {
	const found = await db.prepare(`SELECT id FROM lists WHERE name = ? AND kind = 'tag'`).bind(name).first<{ id: number }>();
	const id = found?.id ?? (await one<{ id: number }>(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, name)).id;
	await db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(id, cid).run();
}
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
const timeline = async (enrollmentId: number) =>
	(await timelineFor(db, [enrollmentId])).get(enrollmentId)!.map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ''}`);

const CUSTOMER = { match: 'all' as const, rules: [{ field: 'tag', op: 'has', value: 'customer' }] };

describe('rules wait: config + text', () => {
	it('normalizeWait keeps the rule set and an optional 1 h – 90 d time limit', () => {
		expect(normalizeWait({ mode: 'rules', rules: CUSTOMER })).toEqual({ ok: true, wait: { mode: 'rules', rules: CUSTOMER } });
		expect(normalizeWait({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 0 })).toEqual({ ok: true, wait: { mode: 'rules', rules: CUSTOMER } });
		expect(normalizeWait({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 7200, event: 'clicked' })).toEqual({
			ok: true,
			wait: { mode: 'rules', rules: CUSTOMER, timeout_seconds: 7200 }
		});
		expect(normalizeWait({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 60 })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 91 * 86400 })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'rules' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'rules', rules: { match: 'all', rules: [] } })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'rules', rules: { match: 'any', rules: [{ field: 'step_clicked', op: 'yes', value: '3' }] } })).toEqual({
			ok: false,
			error: WAIT_RULES_NO_STEP
		});
		expect(stepHasLanes({ type: 'wait', wait_config: JSON.stringify({ mode: 'rules', rules: CUSTOMER }) })).toBe(true);
		expect(specHasLanes({ type: 'wait', wait: { mode: 'rules' } })).toBe(true);
		expect(waitModeHasLanes('delay')).toBe(false);
		expect(waitModeHasLanes('field_date')).toBe(false); // #627: a date-field wait has no lanes
		expect(WAIT_KIND_CHOICES.find((k) => k.mode === 'rules')?.title).toBe('Until specific conditions are met');
	});

	it('plain-words summaries say when there is no time limit', () => {
		expect(waitText({ mode: 'rules', rules: CUSTOMER }, { rulesText: waitRulesText(CUSTOMER) })).toBe(
			'Wait until they match: has tag “customer” · no time limit'
		);
		expect(waitText({ mode: 'rules', rules: { match: 'any', rules: [CUSTOMER.rules[0], CUSTOMER.rules[0]] }, timeout_seconds: 3 * 86400 })).toBe(
			'Wait until they match: 2 conditions (any) · up to 3 days'
		);
		expect(waitingText({ mode: 'rules', rules: CUSTOMER }, null, null, '2027-01-01 00:00:00')).toBe(
			'Waiting until they match the conditions (no time limit)'
		);
		expect(waitingText({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 86400 }, '2027-01-01 00:00:00', null, '2027-01-01 12:00:00')).toBe(
			'Waiting until they match the conditions (12 hours left)'
		);
	});
});

describe('rules wait: engine', () => {
	it('a contact who matches goes down "Did it"', async () => {
		const aid = await automation();
		const w = await waitStep(aid, 0, { mode: 'rules', rules: CUSTOMER });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'yes', tag_action: 'add', tag_name: 'matched' });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'no', tag_action: 'add', tag_name: 'timed-out' });
		const cid = await contact('m@x.test');
		await tagContact(cid, 'customer');
		await enroll(db, aid, [cid]);
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		expect(await hasTag(cid, 'matched')).toBe(true);
		expect(await hasTag(cid, 'timed-out')).toBe(false);
		const p = await pass(aid, cid);
		expect(p.status).toBe('completed');
		expect(await timeline(p.id)).toContain('wait:conditions met');
		expect((await one<{ label: string }>('SELECT label FROM automation_branch_hits WHERE step_id = ?', w)).label).toBe('yes');
	});

	it('no time limit: waits however long it takes, then continues once they match (empty lanes → after the step)', async () => {
		const aid = await automation();
		const w = await waitStep(aid, 0, { mode: 'rules', rules: CUSTOMER });
		await step(aid, 1, 'tag', { tag_action: 'add', tag_name: 'after' });
		const cid = await contact('n@x.test');
		await enroll(db, aid, [cid]);
		const r = await tick(db, cfg);
		expect(r.waiting).toBe(1);
		// 200 days later, still not a customer → still waiting, re-checked in a few minutes.
		await db.prepare(`UPDATE automation_enrollments SET wait_started_at = datetime('now', '-200 days')`).run();
		await dueNow();
		await tick(db, cfg);
		let p = await pass(aid, cid);
		expect(p.status).toBe('active');
		expect(p.current_step_id).toBe(w);
		const nextMs = Date.parse(`${p.next_run_at!.replace(' ', 'T')}Z`);
		expect(nextMs).toBeGreaterThan(Date.now());
		expect(nextMs).toBeLessThan(Date.now() + 15 * 60_000);
		expect(await hasTag(cid, 'after')).toBe(false);

		await tagContact(cid, 'customer');
		await dueNow();
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		p = await pass(aid, cid);
		expect(await hasTag(cid, 'after')).toBe(true);
		expect(p.status).toBe('completed');
	});

	it('with a time limit the deadline sends them down "Timed out"', async () => {
		const aid = await automation();
		const w = await waitStep(aid, 0, { mode: 'rules', rules: CUSTOMER, timeout_seconds: 3600 });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'yes', tag_action: 'add', tag_name: 'matched' });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'no', tag_action: 'add', tag_name: 'timed-out' });
		const cid = await contact('t@x.test');
		await enroll(db, aid, [cid]);
		await tick(db, cfg);
		const p0 = await pass(aid, cid);
		expect(p0.status).toBe('active');
		// Wakes no later than the deadline.
		const started = (await one<{ wait_started_at: string }>('SELECT wait_started_at FROM automation_enrollments WHERE id = ?', p0.id)).wait_started_at;
		expect(Date.parse(`${p0.next_run_at!.replace(' ', 'T')}Z`)).toBeLessThanOrEqual(Date.parse(`${started.replace(' ', 'T')}Z`) + 3600_000);

		await db.prepare(`UPDATE automation_enrollments SET wait_started_at = datetime('now', '-2 hours')`).run();
		await dueNow();
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		expect(await hasTag(cid, 'timed-out')).toBe(true);
		expect(await hasTag(cid, 'matched')).toBe(false);
		const p = await pass(aid, cid);
		expect(p.status).toBe('completed');
		expect(await timeline(p.id)).toContain('wait:timed out');
		expect((await one<{ label: string }>('SELECT label FROM automation_branch_hits WHERE step_id = ?', w)).label).toBe('no');
	});
});

describe('rules wait: save, activation, spec', () => {
	it('save checks the rules like a Condition step; lane steps keep event ↔ rules switchable only', async () => {
		const aid = await automation('draft');
		const add = await addStep(db, aid, { type: 'wait' }, actor);
		const wid = add.ok ? add.data.step_id : 0;
		const bad = await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'rules', rules: { match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }] } } } }, actor);
		expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('Wait conditions:') });
		const gone = await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'rules', rules: { match: 'all', rules: [{ field: 'list', op: 'in', value: '999999' }] } } } }, actor);
		expect(gone).toMatchObject({ ok: false, error: expect.stringContaining('no longer exists') });
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'rules', rules: CUSTOMER, timeout_seconds: 86400 } } }, actor)).ok).toBe(true);
		const row = await one<{ wait_config: string; ready: number }>('SELECT wait_config, ready FROM automation_steps WHERE id = ?', wid);
		expect(parseWait(row.wait_config)).toEqual({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 86400 });
		expect(row.ready).toBe(1);

		// A step in its lane: switching to an event wait is fine, to a delay isn't.
		await step(aid, 0, 'tag', { parent_step_id: wid, branch_label: 'yes', tag_action: 'add', tag_name: 'x' });
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'replied', timeout_seconds: 86400 } } }, actor)).ok).toBe(true);
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'delay', seconds: 300 } } }, actor)).ok).toBe(false);
		// #627: a date-field wait has no lanes either — refused the same way.
		await db.prepare(`INSERT OR IGNORE INTO custom_fields (key, label, type, options, position) VALUES ('renewal', 'Renewal', 'date', '[]', 0)`).run();
		expect(await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'field_date', field: 'renewal', relation: 'on' } } }, actor)).toMatchObject({
			ok: false,
			error: expect.stringContaining('“Did it” and “Timed out” paths')
		});
	});

	it('activation lists a stored rules wait whose conditions are incomplete', async () => {
		const aid = await automation('draft');
		const w = await waitStep(aid, 0, { mode: 'rules', rules: { match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }] } });
		const problems = await activationProblems(db, aid);
		expect(problems).toContainEqual(expect.objectContaining({ step_id: w, message: expect.stringContaining('Wait conditions:') }));

		const ok = await automation('draft');
		await waitStep(ok, 0, { mode: 'rules', rules: CUSTOMER });
		expect((await activationProblems(db, ok)).filter((p) => p.message.includes('Wait conditions'))).toEqual([]);
	});

	it('a spec with a rules wait and its lanes round-trips', async () => {
		const created = await createFromSpec(
			db,
			{
				name: 'Rules wait',
				trigger: { type: 'manual' },
				steps: [
					{
						type: 'wait',
						wait: { mode: 'rules', rules: CUSTOMER, timeout_seconds: 7 * 86400 },
						yes: [{ type: 'tag', tag_action: 'add', tag_name: 'matched' }],
						no: []
					},
					{ type: 'tag', tag_action: 'add', tag_name: 'after' }
				]
			},
			actor
		);
		expect(created.ok).toBe(true);
		const aid = created.ok ? created.data.automation_id : 0;
		const spec = await readSpec(db, aid);
		expect(spec.ok && spec.data.steps[0]).toMatchObject({
			type: 'wait',
			wait: { mode: 'rules', rules: CUSTOMER, timeout_seconds: 7 * 86400 },
			yes: [{ type: 'tag', tag_name: 'matched' }],
			no: []
		});
		const refused = await createFromSpec(
			db,
			{ name: 'Bad', trigger: { type: 'manual' }, steps: [{ type: 'wait', wait: { mode: 'rules', rules: { match: 'all', rules: [] } } as never }] },
			actor
		);
		expect(refused.ok).toBe(false);
	});

	it('the drawer posts the rules, and the time limit only when "Set a time limit" is ticked', async () => {
		const aid = await automation('draft');
		const wid = await waitStep(aid, 0, { mode: 'delay', seconds: 86400 });
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
		const base = { step_id: String(wid), wait_mode: 'rules', wait_rules: JSON.stringify(CUSTOMER), wait_timeout_value: '2', wait_timeout_unit: 'days', delay_value: '0', delay_unit: 'hours' };
		await post(base);
		let row = await one<{ wait_config: string }>('SELECT wait_config FROM automation_steps WHERE id = ?', wid);
		expect(JSON.parse(row.wait_config)).toEqual({ mode: 'rules', rules: CUSTOMER });
		await post({ ...base, wait_limit: '1' });
		row = await one<{ wait_config: string }>('SELECT wait_config FROM automation_steps WHERE id = ?', wid);
		expect(JSON.parse(row.wait_config)).toEqual({ mode: 'rules', rules: CUSTOMER, timeout_seconds: 2 * 86400 });
	});
});
