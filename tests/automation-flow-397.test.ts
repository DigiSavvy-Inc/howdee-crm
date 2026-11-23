import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #397: automation flow capabilities — exit goals, wait-until steps (event + timeout lane,
// date / time, send window, DST), the frequency cap, pause reason + status history, triggers
// recorded while paused, the appended per-pass timeline and the funnel stats.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { autoEnroll, enroll, tick } from '../src/lib/server/automations';
import {
	addStep,
	createFromSpec,
	readSpec,
	setExitRules,
	updateStep,
	type Actor
} from '../src/lib/server/automation-write';
import { activationProblems, bulkSetStatus } from '../src/lib/server/automation-bulk';
import {
	frequencyHold,
	funnelStats,
	pendingTriggerCount,
	predecessors,
	setFrequencyCap,
	statusHistory,
	timelineFor,
	waitDateTarget,
	windowNextOpen
} from '../src/lib/server/automation-flow';
import {
	FREQUENCY_CAP_PREFIX,
	completedReasonText,
	normalizeExitRules,
	normalizeFrequencyCap,
	normalizeWait,
	stepHasLanes,
	timelineText,
	waitText,
	waitingText
} from '../src/lib/automation-flow';
import { stepNumbers } from '../src/lib/automation-action-labels';
import { treeFromSteps } from '../src/lib/canvas-layout';
import { actions } from '../src/routes/automations/[id]/+page.server';

const db = (env as any).DB as D1Database;
const cfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const actor: Actor = { kind: 'system' };
const TZ = 'America/Los_Angeles';

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL, target_step_id = NULL, target_automation_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM app_state WHERE key IN ('automation_frequency_cap', 'timezone') OR key LIKE 'automation_status_at:%'`)
	]);
});

const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>())!;

async function automation(o: { status?: string; trigger?: string; listId?: number | null; exitRules?: unknown } = {}): Promise<number> {
	return (
		await one<{ id: number }>(
			'INSERT INTO automations (name, status, trigger_type, trigger_list_id, exit_rules) VALUES (?, ?, ?, ?, ?) RETURNING id',
			'Flow',
			o.status ?? 'active',
			o.trigger ?? 'manual',
			o.listId ?? null,
			o.exitRules === undefined ? null : JSON.stringify(o.exitRules)
		)
	).id;
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

async function contact(email: string): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email, subscribed) VALUES (?, 1) RETURNING id', email)).id;
}

async function pass(aid: number, cid: number) {
	return one<{ id: number; status: string; current_step_id: number | null; last_error: string | null; completed_reason: string | null; next_run_at: string | null }>(
		`SELECT id, status, current_step_id, last_error, completed_reason, next_run_at FROM automation_enrollments
		 WHERE automation_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1`,
		aid,
		cid
	);
}
/** Make every active pass due now (skip the waits in a test). */
const dueNow = () => db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE status = 'active'`).run();
const hasTag = async (cid: number, tag: string) =>
	!!(await db
		.prepare(`SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id WHERE lm.contact_id = ? AND l.kind = 'tag' AND l.name = ?`)
		.bind(cid, tag)
		.first());
async function tagged(cid: number, tag: string) {
	const l = await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id", tag);
	await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(l.id, cid).run();
}

function ev(aid: number, fields: Record<string, string>, user: { id: number; role: string } | null = null) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	const url = new URL(`https://app.test/automations/${aid}`);
	return { platform: { env: { ...(env as any), POSTMARK_FROM: 'alan@ourco.example' } }, params: { id: String(aid) }, url, locals: { user }, request: new Request(url, { method: 'POST', body: fd }) } as any;
}

describe('exit goals', () => {
	async function goalFlow(rules: unknown) {
		const aid = await automation({ exitRules: rules });
		const s1 = await step(aid, 0, 'tag', { tag_action: 'add', tag_name: 'step-1', delay_before_seconds: 3600 });
		const cid = await contact(`g-${Math.random()}@x.test`);
		await enroll(db, aid, [cid]);
		await dueNow();
		return { aid, s1, cid };
	}

	it('a reply after enrollment exits the pass (goal:reply) before the step runs', async () => {
		const { aid, s1, cid } = await goalFlow([{ kind: 'reply' }]);
		await db.prepare('INSERT INTO replies (contact_id, from_email, text) VALUES (?, ?, ?)').bind(cid, 'a@x.test', 'Thanks!').run();
		const r = await tick(db, cfg);
		expect(r.goals).toBe(1);
		expect(r.completed).toBe(1);
		const p = await pass(aid, cid);
		expect(p).toMatchObject({ status: 'completed', completed_reason: 'goal:reply' });
		expect(await hasTag(cid, 'step-1')).toBe(false);
		const events = (await timelineFor(db, [p.id])).get(p.id)!;
		expect(events.map((e) => e.kind)).toEqual(['enrolled', 'exit']);
		expect(events[1]).toMatchObject({ step_id: s1, detail: 'goal:reply' });
		const f = await funnelStats(db, aid);
		expect(f.steps.find((x) => x.step_id === s1)).toMatchObject({ reached: 1, exited: 1 });
		expect(f.goals).toEqual([{ kind: 'reply', n: 1 }]);
	});

	it('a reply from BEFORE the enrollment does not count', async () => {
		const aid = await automation({ exitRules: [{ kind: 'reply' }] });
		await step(aid, 0, 'tag', { tag_action: 'add', tag_name: 'ran' });
		const cid = await contact('old-reply@x.test');
		await db
			.prepare(`INSERT INTO replies (contact_id, from_email, text, received_at) VALUES (?, 'a@x.test', 'old', datetime('now', '-2 days'))`)
			.bind(cid)
			.run();
		await enroll(db, aid, [cid]);
		await tick(db, cfg);
		expect(await pass(aid, cid)).toMatchObject({ status: 'completed', completed_reason: null });
		expect(await hasTag(cid, 'ran')).toBe(true);
	});

	it('tag added (case-insensitive), segment match and pipeline stage entered each exit', async () => {
		const tag = await goalFlow([{ kind: 'tag', tag: 'Customer' }]);
		await tagged(tag.cid, 'customer');

		const list = await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES ('VIP', 'segment') RETURNING id");
		const seg = await goalFlow([{ kind: 'segment', list_id: list.id }]);
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list.id, seg.cid).run();

		const stage = await one<{ id: number }>('SELECT id FROM pipeline_stages ORDER BY position LIMIT 1');
		const stg = await goalFlow([{ kind: 'stage', stage_id: stage.id }]);
		await db
			.prepare(`INSERT INTO pipeline_history (contact_id, from_stage_id, to_stage_id, actor_kind) VALUES (?, NULL, ?, 'user')`)
			.bind(stg.cid, stage.id)
			.run();

		const untouched = await goalFlow([{ kind: 'tag', tag: 'customer' }]);

		const r = await tick(db, cfg);
		expect(r.goals).toBe(3);
		expect((await pass(tag.aid, tag.cid)).completed_reason).toBe('goal:tag');
		expect((await pass(seg.aid, seg.cid)).completed_reason).toBe('goal:segment');
		expect((await pass(stg.aid, stg.cid)).completed_reason).toBe('goal:stage');
		expect(await pass(untouched.aid, untouched.cid)).toMatchObject({ status: 'completed', completed_reason: null });
		expect(completedReasonText('goal:tag')).toBe('Exited by goal: tag added');
	});

	it('unsubscribe still cancels (not a goal); setExitRules validates and stores', async () => {
		const { aid, cid } = await goalFlow([{ kind: 'reply' }]);
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(cid).run();
		await tick(db, cfg);
		expect(await pass(aid, cid)).toMatchObject({ status: 'cancelled', completed_reason: null });

		expect((await setExitRules(db, aid, { rules: [{ kind: 'segment', list_id: 999999 }] }, actor)).ok).toBe(false);
		expect((await setExitRules(db, aid, { rules: [{ kind: 'nope' }] }, actor)).ok).toBe(false);
		const ok = await setExitRules(db, aid, { rules: [{ kind: 'reply' }, { kind: 'reply' }, { kind: 'tag', tag: 'won' }] }, actor);
		expect(ok).toMatchObject({ ok: true, data: { count: 2 } });
		expect(JSON.parse((await one<{ exit_rules: string }>('SELECT exit_rules FROM automations WHERE id = ?', aid)).exit_rules)).toEqual([
			{ kind: 'reply' },
			{ kind: 'tag', tag: 'won' }
		]);
		expect((await setExitRules(db, aid, { rules: [] }, actor)).ok).toBe(true);
		expect((await one<{ exit_rules: string | null }>('SELECT exit_rules FROM automations WHERE id = ?', aid)).exit_rules).toBeNull();
		expect(normalizeExitRules('x')).toMatchObject({ ok: false });
	});
});

describe('wait-until steps', () => {
	async function clickFlow(timeoutSeconds = 86400) {
		const aid = await automation();
		await step(aid, 0, 'email');
		const w = await waitStep(aid, 1, { mode: 'event', event: 'clicked', timeout_seconds: timeoutSeconds });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'yes', tag_action: 'add', tag_name: 'clicked-yes' });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'no', tag_action: 'add', tag_name: 'timed-out' });
		await step(aid, 2, 'tag', { tag_action: 'add', tag_name: 'after-wait' });
		const cid = await contact(`w-${Math.random()}@x.test`);
		await enroll(db, aid, [cid]);
		await tick(db, cfg); // sends the email → at the wait
		const r = await tick(db, cfg); // the wait parks
		expect(r.waiting).toBe(1);
		return { aid, w, cid };
	}

	it('event: a click on the previous email takes the YES lane, then the flow re-joins', async () => {
		const { aid, w, cid } = await clickFlow();
		const p = await pass(aid, cid);
		expect(p.current_step_id).toBe(w);
		expect(new Date(`${p.next_run_at!.replace(' ', 'T')}Z`).getTime()).toBeGreaterThan(Date.now());
		const started = (await one<{ wait_started_at: string }>('SELECT wait_started_at FROM automation_enrollments WHERE id = ?', p.id)).wait_started_at;
		expect(waitingText({ mode: 'event', event: 'clicked', timeout_seconds: 86400 }, started, p.next_run_at, new Date().toISOString())).toMatch(
			/^Waiting for click \((23 hours|24 hours|1 day) left\)$/
		);

		const rec = await one<{ id: number; campaign_id: number }>('SELECT id, campaign_id FROM recipients WHERE enrollment_id = ?', p.id);
		await db.prepare(`INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, 'click')`).bind(rec.campaign_id, rec.id, cid).run();
		await dueNow();
		for (let i = 0; i < 4; i++) await tick(db, cfg);
		expect(await hasTag(cid, 'clicked-yes')).toBe(true);
		expect(await hasTag(cid, 'timed-out')).toBe(false);
		expect(await hasTag(cid, 'after-wait')).toBe(true);
		expect((await pass(aid, cid)).status).toBe('completed');
		const hit = await one<{ label: string }>('SELECT label FROM automation_branch_hits WHERE step_id = ? AND enrollment_id = ?', w, p.id);
		expect(hit.label).toBe('yes');
	});

	it('event: no click by the timeout takes the timed-out lane', async () => {
		const { aid, cid } = await clickFlow(3600);
		await db.prepare(`UPDATE automation_enrollments SET wait_started_at = datetime('now', '-2 hours')`).run();
		await dueNow();
		for (let i = 0; i < 4; i++) await tick(db, cfg);
		expect(await hasTag(cid, 'timed-out')).toBe(true);
		expect(await hasTag(cid, 'clicked-yes')).toBe(false);
		expect(await hasTag(cid, 'after-wait')).toBe(true);
		const p = await pass(aid, cid);
		const kinds = (await timelineFor(db, [p.id])).get(p.id)!.map((e) => `${e.kind}${e.detail ? `:${e.detail}` : ''}`);
		expect(kinds).toContain('wait:timed out');
	});

	it('event: a reply after the wait started, and a page visit, also count', async () => {
		const aid = await automation();
		const w = await waitStep(aid, 0, { mode: 'event', event: 'replied', timeout_seconds: 86400 });
		await step(aid, 0, 'tag', { parent_step_id: w, branch_label: 'yes', tag_action: 'add', tag_name: 'replied' });
		const aid2 = await automation();
		const w2 = await waitStep(aid2, 0, { mode: 'event', event: 'visited', path: '/pricing', timeout_seconds: 86400 });
		await step(aid2, 0, 'tag', { parent_step_id: w2, branch_label: 'yes', tag_action: 'add', tag_name: 'visited' });
		const cid = await contact('r@x.test');
		await enroll(db, aid, [cid]);
		await enroll(db, aid2, [cid]);
		await tick(db, cfg); // both park
		await db.prepare("INSERT INTO replies (contact_id, from_email, text) VALUES (?, 'r@x.test', 'yes')").bind(cid).run();
		const site = await one<{ id: number }>("INSERT INTO tracking_sites (name, domain, site_key) VALUES ('Site', 'x.test', 'dsv_k') RETURNING id");
		await db
			.prepare(`INSERT INTO site_events (site_id, contact_id, kind, name, path, occurred_at) VALUES (?, ?, 'pageview', 'pageview', '/Pricing/plans', datetime('now'))`)
			.bind(site.id, cid)
			.run();
		await dueNow();
		await tick(db, cfg);
		await tick(db, cfg);
		expect(await hasTag(cid, 'replied')).toBe(true);
		expect(await hasTag(cid, 'visited')).toBe(true);
	});

	it('date: a passed fixed date continues; a future one parks until then (operator time)', async () => {
		const aid = await automation();
		await waitStep(aid, 0, { mode: 'date', at: '2020-01-01T09:00' });
		await step(aid, 1, 'tag', { tag_action: 'add', tag_name: 'past' });
		const aid2 = await automation();
		const w2 = await waitStep(aid2, 0, { mode: 'date', at: '2099-01-01T09:00' });
		const cid = await contact('d@x.test');
		await enroll(db, aid, [cid]);
		await enroll(db, aid2, [cid]);
		await tick(db, cfg);
		await tick(db, cfg);
		expect(await hasTag(cid, 'past')).toBe(true);
		const p2 = await pass(aid2, cid);
		expect(p2.current_step_id).toBe(w2);
		expect(p2.next_run_at).toBe('2099-01-01 17:00:00'); // 09:00 PST
	});

	it('window: continues inside the window, otherwise wakes when it opens', async () => {
		const wait = { mode: 'window' as const, start: '00:00', end: '00:01', days: 'every' as const };
		const aid = await automation();
		const w = await waitStep(aid, 0, wait);
		const cid = await contact('win@x.test');
		await enroll(db, aid, [cid]);
		const expected = windowNextOpen(wait, new Date(), TZ);
		await tick(db, cfg);
		const p = await pass(aid, cid);
		if (expected === null) expect(p.status).toBe('completed');
		else {
			expect(p.current_step_id).toBe(w);
			expect(p.next_run_at).toBe(expected.toISOString().slice(0, 19).replace('T', ' '));
		}
	});

	it('date / window maths across the DST change (America/Los_Angeles, Nov 1 2026)', () => {
		// Friday Oct 30 2026, 18:00 PDT → the next weekday 09:00 is Monday Nov 2, 09:00 PST = 17:00Z.
		const fri = new Date('2026-10-31T01:00:00Z');
		expect(waitDateTarget({ mode: 'date', day: 'weekday', time: '09:00' }, fri, TZ).toISOString()).toBe('2026-11-02T17:00:00.000Z');
		// The next Sunday 10:00 from there is Nov 1 — already PST.
		expect(waitDateTarget({ mode: 'date', day: 'sun', time: '10:00' }, fri, TZ).toISOString()).toBe('2026-11-01T18:00:00.000Z');
		// Before the change: Thursday 08:00 PDT → Thursday 09:00 PDT = 16:00Z.
		expect(waitDateTarget({ mode: 'date', day: 'weekday', time: '09:00' }, new Date('2026-10-29T15:00:00Z'), TZ).toISOString()).toBe(
			'2026-10-29T16:00:00.000Z'
		);
		// Fixed date in PDT vs PST.
		expect(waitDateTarget({ mode: 'date', at: '2026-10-30T09:00' }, fri, TZ).toISOString()).toBe('2026-10-30T16:00:00.000Z');
		expect(waitDateTarget({ mode: 'date', at: '2026-11-03T09:00' }, fri, TZ).toISOString()).toBe('2026-11-03T17:00:00.000Z');

		const win = { mode: 'window' as const, start: '09:00', end: '17:00', days: 'weekdays' as const };
		// Saturday Oct 31, 12:00 PDT → opens Monday 09:00 PST.
		expect(windowNextOpen(win, new Date('2026-10-31T19:00:00Z'), TZ)?.toISOString()).toBe('2026-11-02T17:00:00.000Z');
		// Monday Nov 2, 10:00 PST → inside.
		expect(windowNextOpen(win, new Date('2026-11-02T18:00:00Z'), TZ)).toBeNull();
		// Monday 17:30 PST → Tuesday 09:00.
		expect(windowNextOpen(win, new Date('2026-11-03T01:30:00Z'), TZ)?.toISOString()).toBe('2026-11-03T17:00:00.000Z');
		// Every day: Saturday 08:00 → Saturday 09:00.
		expect(windowNextOpen({ ...win, days: 'every' }, new Date('2026-10-31T15:00:00Z'), TZ)?.toISOString()).toBe('2026-10-31T16:00:00.000Z');
	});

	it('config validation + text', () => {
		expect(normalizeWait({ mode: 'event', event: 'clicked', timeout_seconds: 60 })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'event', event: 'visited', timeout_seconds: 3600 })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'date', at: 'tomorrow' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'window', start: '17:00', end: '09:00' })).toMatchObject({ ok: false });
		expect(normalizeWait({ mode: 'window', start: '09:00', end: '17:00', junk: 1 })).toEqual({
			ok: true,
			wait: { mode: 'window', start: '09:00', end: '17:00', days: 'weekdays' }
		});
		expect(waitText({ mode: 'event', event: 'clicked', timeout_seconds: 259200 })).toBe('Wait until they click the previous email, up to 3 days');
		expect(waitText({ mode: 'window', start: '09:00', end: '17:00', days: 'weekdays' })).toBe('Wait for the send window: Mon–Fri 09:00–17:00');
		expect(stepHasLanes({ type: 'wait', wait_config: JSON.stringify({ mode: 'event', event: 'opened', timeout_seconds: 3600 }) })).toBe(true);
		expect(stepHasLanes({ type: 'wait', wait_config: JSON.stringify({ mode: 'date', at: '2026-01-01T09:00' }) })).toBe(false);
	});
});

describe('wait steps in the write layer', () => {
	it('bare wait is unfinished with a delay default; lanes; mode change guarded; spec round trip', async () => {
		const aid = await automation({ status: 'draft' });
		const add = await addStep(db, aid, { type: 'wait' }, actor);
		expect(add.ok).toBe(true);
		const wid = add.ok ? add.data.step_id : 0;
		const row = await one<{ ready: number; wait_config: string }>('SELECT ready, wait_config FROM automation_steps WHERE id = ?', wid);
		expect(row.ready).toBe(0);
		expect(JSON.parse(row.wait_config)).toEqual({ mode: 'delay', seconds: 86400 }); // #625
		expect((await activationProblems(db, aid)).some((p) => p.step_id === wid)).toBe(true);

		// #625: a delay wait has no lanes; switch it to an event wait first.
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'replied', timeout_seconds: 7200 } } }, actor)).ok).toBe(true);
		const child = await addStep(db, aid, { type: 'tag', parent_step_id: wid, branch_label: 'no', fields: { tag_name: 'cold' } }, actor);
		expect(child.ok).toBe(true);
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'date', at: '2026-12-01T09:00' } } }, actor)).ok).toBe(false);
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'replied', timeout_seconds: 10 } } }, actor)).ok).toBe(false);
		expect((await updateStep(db, aid, { step_id: wid, fields: { wait: { mode: 'event', event: 'replied', timeout_seconds: 7200 } } }, actor)).ok).toBe(true);
		expect((await one<{ ready: number }>('SELECT ready FROM automation_steps WHERE id = ?', wid)).ready).toBe(1);

		// A date wait has no lanes: a step can't be added under one.
		const dateWait = await addStep(db, aid, { type: 'wait', fields: { wait: { mode: 'date', day: 'mon', time: '08:30' } } }, actor);
		expect(dateWait.ok).toBe(true);
		const under = await addStep(db, aid, { type: 'tag', parent_step_id: dateWait.ok ? dateWait.data.step_id : 0, fields: { tag_name: 'x' } }, actor);
		expect(under.ok).toBe(false);

		const spec = await readSpec(db, aid);
		expect(spec.ok).toBe(true);
		if (!spec.ok) return;
		expect(spec.data.steps[0]).toMatchObject({ type: 'wait', wait: { mode: 'event', event: 'replied', timeout_seconds: 7200 }, yes: [], no: [{ type: 'tag', tag_name: 'cold' }] });
		expect(spec.data.steps[1]).toMatchObject({ type: 'wait', wait: { mode: 'date', day: 'mon', time: '08:30' } });
		expect(spec.data.steps[1].yes).toBeUndefined();
		const copy = await createFromSpec(db, spec.data, actor);
		expect(copy.ok).toBe(true);
		if (!copy.ok) return;
		const again = await readSpec(db, copy.data.automation_id);
		expect(again.ok && again.data.steps).toEqual(spec.data.steps);

		const rows = (await db.prepare('SELECT id, position, type, parent_step_id, branch_label, wait_config FROM automation_steps WHERE automation_id = ? ORDER BY id').bind(aid).all<{ id: number; position: number; type: string; parent_step_id: number | null; branch_label: string | null; wait_config: string | null }>()).results;
		expect(stepNumbers(rows).size).toBe(3);
		expect(treeFromSteps(rows)[0].lanes?.length).toBe(2);
		expect(treeFromSteps(rows)[1].lanes).toBeUndefined();
	});
});

describe('frequency cap', () => {
	it('holds an email step until the cap allows it, with the reason visible, then sends', async () => {
		await setFrequencyCap(db, { per_day: 1, per_week: null });
		const A = await automation();
		await step(A, 0, 'email');
		const B = await automation();
		await step(B, 0, 'email');
		const cid = await contact('cap@x.test');
		await enroll(db, A, [cid]);
		expect((await tick(db, cfg)).sent).toBe(1);

		await enroll(db, B, [cid]);
		const held = await tick(db, cfg);
		expect(held).toMatchObject({ sent: 0, held: 1 });
		const p = await pass(B, cid);
		expect(p.last_error?.startsWith(FREQUENCY_CAP_PREFIX)).toBe(true);
		const until = new Date(`${p.next_run_at!.replace(' ', 'T')}Z`).getTime();
		expect(until).toBeGreaterThan(Date.now() + 23 * 3600_000);
		// Held again on the next due check — logged once.
		await dueNow();
		await tick(db, cfg);
		expect((await timelineFor(db, [p.id])).get(p.id)!.filter((e) => e.kind === 'held')).toHaveLength(1);

		// The first email ages out of the 24 h window → the held one goes, reason cleared.
		await db.prepare(`UPDATE automation_enrollment_events SET at = datetime('now', '-25 hours') WHERE kind = 'sent'`).run();
		await dueNow();
		expect((await tick(db, cfg)).sent).toBe(1);
		expect(await pass(B, cid)).toMatchObject({ status: 'completed', last_error: null });
	});

	it('off by default; per-week window; settings are normalised', async () => {
		const cid = await contact('cap2@x.test');
		expect(await frequencyHold(db, cid, { per_day: null, per_week: null })).toBeNull();
		expect(normalizeFrequencyCap({ per_day: '0', per_week: 'abc' })).toEqual({ per_day: null, per_week: null });
		expect(normalizeFrequencyCap({ per_day: 3, per_week: 1000 })).toEqual({ per_day: 3, per_week: 100 });
		const aid = await automation();
		const e = await one<{ id: number }>("INSERT INTO automation_enrollments (automation_id, contact_id, status) VALUES (?, ?, 'completed') RETURNING id", aid, cid);
		for (const ago of ['-3 days', '-1 days']) {
			await db
				.prepare(`INSERT INTO automation_enrollment_events (enrollment_id, automation_id, contact_id, kind, at) VALUES (?, ?, ?, 'sent', datetime('now', ?))`)
				.bind(e.id, aid, cid, ago)
				.run();
		}
		expect(await frequencyHold(db, cid, { per_day: 1, per_week: null })).toBeNull();
		const h = await frequencyHold(db, cid, { per_day: null, per_week: 2 });
		expect(h?.reason).toMatch(/^Frequency cap: 2 per 7 days/);
	});
});

describe('pause reason, status history, triggers while paused', () => {
	it('records pause / activate with the reason; list_added triggers while paused are offered on resume', async () => {
		const list = await one<{ id: number }>("INSERT INTO lists (name, kind) VALUES ('Leads', 'list') RETURNING id");
		const aid = await automation({ trigger: 'list_added', listId: list.id });
		await step(aid, 0, 'tag', { tag_action: 'add', tag_name: 'welcomed' });
		const cid = await contact('p@x.test');

		await actions.pause(ev(aid, { reason: 'Fixing the copy' }));
		await autoEnroll(db, list.id, [cid]);
		await autoEnroll(db, list.id, [cid]); // a second trigger keeps one row
		expect(await pendingTriggerCount(db, aid)).toBe(1);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?').bind(aid).first<{ n: number }>())!.n).toBe(0);

		const refused = (await actions.enrollPending(ev(aid, { confirm: '1' }))) as { status: number };
		expect(refused.status).toBe(403);

		await actions.activate(ev(aid, {}));
		const h = await statusHistory(db, aid);
		expect(h.map((x) => [x.from_status, x.to_status, x.reason])).toEqual([
			['paused', 'active', null],
			['active', 'paused', 'Fixing the copy']
		]);

		const preview = (await actions.enrollPending(ev(aid, {}))) as { pendingPreview: { total: number; eligible: number } };
		expect(preview.pendingPreview).toMatchObject({ total: 1, eligible: 1 });
		expect(await pendingTriggerCount(db, aid)).toBe(1); // nothing enrolled without the confirm
		const done = (await actions.enrollPending(ev(aid, { confirm: '1' }))) as { enrolled: number };
		expect(done.enrolled).toBe(1);
		expect(await pendingTriggerCount(db, aid)).toBe(0);

		await bulkSetStatus(db, [aid], 'paused', { reason: 'bulk' });
		expect((await statusHistory(db, aid))[0]).toMatchObject({ from_status: 'active', to_status: 'paused', reason: 'bulk' });
		await autoEnroll(db, list.id, [await contact('p2@x.test')]);
		expect((await actions.discardPending(ev(aid, {}))) as { pendingDiscarded: number }).toEqual({ pendingDiscarded: 1 });
	});
});

describe('timeline + funnel', () => {
	it('appends every decision (a revisited branch gets two rows; branch_hits keeps one)', async () => {
		const aid = await automation();
		const br = await step(aid, 0, 'branch', { gate_kind: 'tag', gate_name: 'never' });
		const go = await step(aid, 1, 'action', { action_kind: 'goto_step', target_step_id: br });
		const cid = await contact('t@x.test');
		await enroll(db, aid, [cid]);
		for (let i = 0; i < 3; i++) await tick(db, cfg);
		const p = await pass(aid, cid);
		const events = (await timelineFor(db, [p.id])).get(p.id)!;
		expect(events.filter((e) => e.kind === 'branch' && e.step_id === br)).toHaveLength(2);
		expect(events.filter((e) => e.kind === 'action' && e.step_id === go)).toHaveLength(1);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM automation_branch_hits WHERE step_id = ?').bind(br).first<{ n: number }>())!.n).toBe(1);
		expect(timelineText({ kind: 'branch', detail: 'no' })).toBe('Condition → no');
	});

	it('reached per step, conversion order and the date range', async () => {
		const aid = await automation();
		const s1 = await step(aid, 0, 'tag', { tag_action: 'add', tag_name: 'one' });
		const s2 = await step(aid, 1, 'tag', { tag_action: 'add', tag_name: 'two' });
		const a = await contact('f1@x.test');
		const b = await contact('f2@x.test');
		await enroll(db, aid, [a, b]);
		await tick(db, cfg);
		await tick(db, cfg);
		const all = await funnelStats(db, aid);
		expect(all.steps.find((x) => x.step_id === s1)?.reached).toBe(2);
		expect(all.steps.find((x) => x.step_id === s2)?.reached).toBe(2);
		const old = await funnelStats(db, aid, { from: '2000-01-01', to: '2000-01-02' });
		expect(old.steps).toEqual([]);
		const junk = await funnelStats(db, aid, { from: 'yesterday' });
		expect(junk.steps.length).toBe(2);
		expect(
			predecessors([
				{ id: 1, position: 0, parent_step_id: null, branch_label: null },
				{ id: 2, position: 1, parent_step_id: null, branch_label: null },
				{ id: 3, position: 0, parent_step_id: 2, branch_label: 'yes' }
			])
		).toEqual(new Map([[2, 1], [3, 2]]));
	});
});
