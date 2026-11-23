// #467 (Scoring 2/3): scores as segment rules + /contacts filters, the `score_changed`
// trigger (fires on a crossing / band entry, not on every recompute), the `adjust_score`
// action (an `automation` ledger row), the bulk "Adjust score", the Data API, the assistant
// tools and their MCP wrappers.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

const spies = vi.hoisted(() => ({ sendBatch: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({ ...(await orig<object>()), sendBatch: spies.sendBatch }));

import { ruleIncomplete, ruleKindGroups } from '../src/lib/condition-rules';
import { CONDITION_FIELDS, validateRule, validateScore } from '../src/lib/scoring';
import { compileSegment } from '../src/lib/server/segment-query';
import { contactsOrder, contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { createScore } from '../src/lib/server/scoring/store';
import { addScorePoints } from '../src/lib/server/scoring/contact';
import { scoreLeaders, scoresForContacts } from '../src/lib/server/scoring/query';
import { processScoreTriggers } from '../src/lib/server/score-trigger';
import {
	normalizeAdjustScore,
	normalizeScoreTriggerConfig,
	scoreChangeMatches,
	scoreTriggerText,
	adjustScoreTitle
} from '../src/lib/score-trigger';
import { stepShortTitle } from '../src/lib/automation-action-labels';
import { addStep, createAutomation, createFromSpec, readSpec, setReentry, setTrigger } from '../src/lib/server/automation-write';
import { tick } from '../src/lib/server/automations';
import { resolveSelection, runBulk } from '../src/lib/server/contact-bulk';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { GET as listScoresApi } from '../src/routes/api/v1/scores/+server';
import { GET as contactScoresGet } from '../src/routes/api/v1/contacts/[id]/scores/+server';
import { POST as adjustPost } from '../src/routes/api/v1/contacts/[id]/scores/[scoreId]/adjust/+server';
import { GET as getContactApi } from '../src/routes/api/v1/contacts/[id]/+server';
import { GET as discovery } from '../src/routes/api/v1/+server';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';
import { actionForUser, undoAction } from '../src/lib/server/ai/actions';
import { MCP_TOOLS } from '../src/lib/server/mcp/tools';

const db = (env as any).DB as D1Database;
const engineCfg = { token: 'x', secret: 's', baseUrl: 'https://app.test', stream: 'broadcast' };
const actor = { kind: 'user' as const, id: 1 };
let seq = 0;

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}
async function contact(): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email) VALUES (?) RETURNING id', `s${++seq}-${Date.now()}@score467.test`)).id;
}
async function makeScore(bands = '[{"label":"Hot","min":50},{"label":"Warm","min":10}]'): Promise<number> {
	const v = validateScore({ name: `Interest ${++seq}`, decay_mode: 'none', bands });
	if (!v.ok) throw new Error(v.error);
	const r = await createScore(db, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}
const add = (ids: number[], scoreId: number, points: number) => addScorePoints(db, ids, scoreId, { points, expires_days: null, source_type: 'manual' });
async function matches(rule: Record<string, string>): Promise<number[]> {
	const c = compileSegment({ match: 'all', rules: [rule as any] });
	return (await db.prepare(c.sql).bind(...c.binds).all<{ id: number }>()).results.map((r) => r.id);
}
const dueNow = () => db.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', '-1 minute') WHERE status = 'active'`).run();

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) => msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` })));
	await db.batch([
		db.prepare('DELETE FROM score_change_events'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('UPDATE campaigns SET automation_step_id = NULL'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations')
	]);
});

// ── rules + filters ─────────────────────────────────────────────────────────────────────

describe('score rules', () => {
	it('are a Scores group in the picker, but not inside a score’s own conditions', () => {
		const groups = ruleKindGroups({ automation: false });
		expect(groups.find((g) => g.group === 'Scores')!.kinds.map((k) => k.field)).toEqual(['score_value', 'score_band']);
		expect(CONDITION_FIELDS).not.toContain('score_value');
		const r = validateRule({ kind: 'condition', points: 5, rules: { match: 'all', rules: [{ field: 'score_value', op: 'gt', value: '1', value2: '1' }] } });
		expect(r.ok).toBe(false);
	});

	it('need a score and a value (two for between)', () => {
		expect(ruleIncomplete({ field: 'score_value', op: 'gt', value: '5' })).toBe('a score');
		expect(ruleIncomplete({ field: 'score_value', op: 'gt', value: '', value2: '1' })).toBe('a number');
		expect(ruleIncomplete({ field: 'score_value', op: 'between', value: '5', value2: '1' })).toBe('two numbers');
		expect(ruleIncomplete({ field: 'score_value', op: 'between', value: '5:9', value2: '1' })).toBeNull();
		expect(ruleIncomplete({ field: 'score_band', op: 'is', value: '', value2: '1' })).toBe('a band');
	});

	it('compile against contact_scores — a missing row is 0 / no band', async () => {
		const sid = await makeScore();
		const [hot, warm, none] = [await contact(), await contact(), await contact()];
		await add([hot], sid, 60);
		await add([warm], sid, 20);
		const s = String(sid);
		const mine = (ids: number[]) => ids.filter((i) => [hot, warm, none].includes(i)).sort((a, b) => a - b);
		expect(mine(await matches({ field: 'score_value', op: 'gte', value: '50', value2: s }))).toEqual([hot]);
		expect(mine(await matches({ field: 'score_value', op: 'lt', value: '1', value2: s }))).toEqual([none]);
		expect(mine(await matches({ field: 'score_value', op: 'eq', value: '0', value2: s }))).toEqual([none]);
		expect(mine(await matches({ field: 'score_value', op: 'between', value: '10:59', value2: s }))).toEqual([warm]);
		expect(mine(await matches({ field: 'score_band', op: 'is', value: 'hot', value2: s }))).toEqual([hot]);
		expect(mine(await matches({ field: 'score_band', op: 'not', value: 'Hot', value2: s }))).toEqual([warm, none].sort((a, b) => a - b));
		// Malformed → the rule is skipped (no clause), never an error.
		expect(compileSegment({ match: 'all', rules: [{ field: 'score_value', op: 'gt', value: 'x', value2: s }] }).binds).toEqual([]);
	});

	it('/contacts filters score=<id>:<op>:<n> and band=<id>:<label>, and sort score:<id>', async () => {
		const sid = await makeScore();
		const [a, b] = [await contact(), await contact()];
		await add([a], sid, 70);
		await add([b], sid, 15);
		const run = async (qs: string) => {
			const f = parseContactsFilter(new URLSearchParams(qs));
			const { where, params } = contactsWhere(f);
			const { orderExpr } = contactsOrder(new URLSearchParams(`sort=score:${sid}&dir=desc`));
			return (await db.prepare(`SELECT id FROM contacts ${where} ORDER BY ${orderExpr}`).bind(...params).all<{ id: number }>()).results
				.map((r) => r.id)
				.filter((id) => id === a || id === b);
		};
		expect(await run(`score=${sid}:gt:10`)).toEqual([a, b]);
		expect(await run(`score=${sid}:between:10:20`)).toEqual([b]);
		expect(await run(`band=${sid}:Hot`)).toEqual([a]);
		expect(parseContactsFilter(new URLSearchParams('score=junk')).score).toBeNull();
		expect(contactsOrder(new URLSearchParams('sort=score:1;drop')).sort).toBe('created_at');
	});
});

// ── trigger ─────────────────────────────────────────────────────────────────────────────

describe('score_changed trigger', () => {
	it('config validation, matching and text', () => {
		expect(normalizeScoreTriggerConfig({ mode: 'crosses_above', threshold: 5 }).ok).toBe(false);
		expect(normalizeScoreTriggerConfig({ score_id: 1, mode: 'crosses_above' }).ok).toBe(false);
		expect(normalizeScoreTriggerConfig({ score_id: 1, mode: 'enters_band' }).ok).toBe(false);
		const up = { score_id: 1, mode: 'crosses_above' as const, threshold: 50, band: null };
		const ch = (o: number, n: number, ob: string | null = null, nb: string | null = null) => ({ score_id: 1, old_value: o, new_value: n, old_band: ob, new_band: nb });
		expect(scoreChangeMatches(up, ch(40, 55))).toBe(true);
		expect(scoreChangeMatches(up, ch(55, 60))).toBe(false); // already above
		expect(scoreChangeMatches({ ...up, mode: 'crosses_below' }, ch(55, 40))).toBe(true);
		expect(scoreChangeMatches({ ...up, mode: 'enters_band', band: 'Hot' }, ch(40, 55, 'Warm', 'Hot'))).toBe(true);
		expect(scoreChangeMatches({ ...up, mode: 'enters_band', band: 'Hot' }, ch(55, 60, 'Hot', 'Hot'))).toBe(false);
		expect(scoreTriggerText(up, () => 'Lead score')).toBe('When Lead score rises to 50 or more');
	});

	async function scoreFlow(cfg: Record<string, unknown>, status: 'active' | 'paused' = 'active'): Promise<number> {
		const created = await createAutomation(db, { name: `Score flow ${++seq}` }, actor);
		if (!created.ok) throw new Error(created.error);
		const aid = created.data.automation_id;
		const t = await setTrigger(db, aid, { type: 'score_changed', ...cfg } as any, actor);
		if (!t.ok) throw new Error(t.error);
		await setReentry(db, aid, { reentry: 'multiple' }, actor);
		const step = await addStep(db, aid, { type: 'tag', fields: { tag_action: 'add', tag_name: `scored-${seq}` } }, actor);
		if (!step.ok) throw new Error(step.error);
		await db.prepare('UPDATE automations SET status = ? WHERE id = ?').bind(status, aid).run();
		return aid;
	}
	const passes = (aid: number) => db.prepare('SELECT contact_id FROM automation_enrollments WHERE automation_id = ?').bind(aid).all<{ contact_id: number }>();

	it('refuses an unknown score or band on save', async () => {
		const created = await createAutomation(db, { name: 'Bad' }, actor);
		const aid = (created as any).data.automation_id;
		expect((await setTrigger(db, aid, { type: 'score_changed', score_id: 999999, mode: 'any_change' } as any, actor)).ok).toBe(false);
		const sid = await makeScore();
		expect((await setTrigger(db, aid, { type: 'score_changed', score_id: sid, mode: 'enters_band', band: 'Nope' } as any, actor)).ok).toBe(false);
		const ok = await setTrigger(db, aid, { type: 'score_changed', score_id: sid, mode: 'enters_band', band: 'hot' } as any, actor);
		expect(ok.ok).toBe(true);
		const spec = await readSpec(db, aid);
		expect((spec as any).data.trigger).toMatchObject({ type: 'score_changed', score_id: sid, mode: 'enters_band', band: 'Hot' });
	});

	it('fires once when the score crosses the value, not on every recompute', async () => {
		const sid = await makeScore();
		const aid = await scoreFlow({ score_id: sid, mode: 'crosses_above', threshold: 50 });
		const c = await contact();
		await add([c], sid, 30);
		await processScoreTriggers(db);
		expect((await passes(aid)).results).toEqual([]);

		await add([c], sid, 30); // 30 → 60: crosses 50
		const r = await processScoreTriggers(db);
		expect(r).toMatchObject({ enrolled: 1 });
		expect((await passes(aid)).results.map((p) => p.contact_id)).toEqual([c]);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM score_change_events')).n).toBe(0); // drained

		// Still above (60 → 70) and a recompute without a change: nothing new.
		await dueNow();
		await tick(db, engineCfg);
		await add([c], sid, 10);
		await processScoreTriggers(db);
		expect((await passes(aid)).results.length).toBe(1);
		const ev = await one<{ detail: string }>("SELECT detail FROM automation_enrollment_events WHERE kind = 'trigger:score_changed'");
		expect(ev.detail).toBe('30 → 60 (Hot)');
	});

	it('fires on band entry; a paused flow records pending triggers; unwatched scores record nothing', async () => {
		const sid = await makeScore();
		const aid = await scoreFlow({ score_id: sid, mode: 'enters_band', band: 'Warm' });
		const c = await contact();
		await add([c], sid, 15);
		await processScoreTriggers(db);
		expect((await passes(aid)).results.map((p) => p.contact_id)).toEqual([c]);

		const sid2 = await makeScore();
		const paused = await scoreFlow({ score_id: sid2, mode: 'any_change' }, 'paused');
		await add([c], sid2, 5);
		await processScoreTriggers(db);
		expect((await passes(paused)).results).toEqual([]);
		expect(await one('SELECT contact_id, source FROM automation_pending_triggers WHERE automation_id = ?', paused)).toEqual({ contact_id: c, source: `score:${sid2}` });

		const unwatched = await makeScore();
		await add([c], unwatched, 5);
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM score_change_events WHERE score_id = ?', unwatched)).n).toBe(0);
	});
});

// ── action ──────────────────────────────────────────────────────────────────────────────

describe('adjust_score action', () => {
	it('validates on save and round-trips through the spec', async () => {
		expect(normalizeAdjustScore({ score_id: 1, points: 0 }).ok).toBe(false);
		expect(normalizeAdjustScore({ score_id: 1, points: 5, expires_days: 0 }).ok).toBe(false);
		const created = await createAutomation(db, { name: 'V' }, actor);
		const aid = (created as any).data.automation_id;
		expect((await addStep(db, aid, { type: 'action', fields: { action: { kind: 'adjust_score', score_id: 999999, points: 5 } } }, actor)).ok).toBe(false);
		const sid = await makeScore();
		const r = await createFromSpec(db, { name: 'Spec adjust', trigger: { type: 'manual' }, steps: [{ type: 'action', action: { kind: 'adjust_score', score_id: sid, points: -3, expires_days: 30 } }] }, actor);
		expect(r.ok).toBe(true);
		const spec = await readSpec(db, (r as any).data.automation_id);
		expect((spec as any).data.steps[0].action).toEqual({ kind: 'adjust_score', score_id: sid, points: -3, expires_days: 30 });
		expect(stepShortTitle({ type: 'action', action_kind: 'adjust_score', action_config: JSON.stringify({ score_id: sid, points: 5, expires_days: null }) })).toBe('Adjust score by +5');
		expect(adjustScoreTitle({ score_id: sid, points: 5, expires_days: 30 }, 'Email interest')).toBe('Adjust Email interest by +5 · expires in 30 days');
	});

	it('writes an automation ledger row and records “Adjusted <score> by +5”', async () => {
		const sid = await makeScore();
		const name = (await one<{ name: string }>('SELECT name FROM score_defs WHERE id = ?', sid)).name;
		const created = await createAutomation(db, { name: `Adjust ${++seq}` }, actor);
		const aid = (created as any).data.automation_id;
		const step = await addStep(db, aid, { type: 'action', fields: { action: { kind: 'adjust_score', score_id: sid, points: 5, expires_days: 30 } } }, actor);
		expect(step.ok).toBe(true);
		await db.prepare(`UPDATE automations SET status = 'active' WHERE id = ?`).bind(aid).run();
		const c = await contact();
		const { enroll } = await import('../src/lib/server/automations');
		await enroll(db, aid, [c]);
		await dueNow();
		await tick(db, engineCfg);
		const e = await one<{ id: number; status: string }>('SELECT id, status FROM automation_enrollments WHERE automation_id = ?', aid);
		expect(e.status).toBe('completed');
		expect((await one<{ label: string }>('SELECT label FROM automation_branch_hits WHERE enrollment_id = ?', e.id)).label).toBe(`Adjusted ${name} by +5`);
		const led = await one<{ points: number; source_type: string; source_id: string; expires_at: string | null }>(
			'SELECT points, source_type, source_id, expires_at FROM score_points WHERE score_id = ? AND contact_id = ?',
			sid,
			c
		);
		expect(led).toMatchObject({ points: 5, source_type: 'automation', source_id: `${aid}:${(step as any).data.step_id}:${e.id}` });
		expect(led.expires_at).toBeTruthy();
		expect((await one<{ value: number }>('SELECT value FROM contact_scores WHERE contact_id = ? AND score_id = ?', c, sid)).value).toBe(5);
	});
});

// ── bulk, reads ─────────────────────────────────────────────────────────────────────────

describe('bulk Adjust score + reads', () => {
	it('adds manual rows for the selection and recomputes inline', async () => {
		const sid = await makeScore();
		const [a, b] = [await contact(), await contact()];
		const sel = await resolveSelection(db, { ids: [a, b] });
		if (!sel.ok) throw new Error(sel.error);
		const out = await runBulk(db, sel, { action: 'adjust_score', scoreId: sid, points: 12, expires_days: null, note: 'event', by: 'jdoe' });
		expect(out).toMatchObject({ ok: true, affected: 2 });
		const map = await scoresForContacts(db, [a]);
		expect(map.get(a)!.find((s) => s.id === sid)).toMatchObject({ value: 12, band: 'Warm' });
		expect((await one<{ note: string }>('SELECT note FROM score_points WHERE contact_id = ? AND score_id = ?', a, sid)).note).toBe('event · bulk by @jdoe');
		expect((await scoreLeaders(db, sid, { band: 'warm' })).map((l) => l.contact_id).sort()).toEqual([a, b].sort());
	});
});

// ── Data API ────────────────────────────────────────────────────────────────────────────

async function makeKey(scope: ApiScope): Promise<{ token: string; id: number }> {
	const k = await generateApiKey();
	const r = await one<{ id: number }>(
		'INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?) RETURNING id',
		'scores',
		k.tokenHash,
		k.prefix,
		k.last4,
		scope
	);
	return { token: k.token, id: r.id };
}
function apiEv(path: string, token: string | null, params: Record<string, string> = {}, body?: unknown) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }),
		platform: { env },
		url,
		params
	} as any;
}
const json = async (r: Response) => JSON.parse(await r.text());

describe('Data API', () => {
	it('lists scores, a contact’s scores, adjusts (read_write only) and serializes scores on contacts', async () => {
		const sid = await makeScore();
		const c = await contact();
		const read = await makeKey('read');
		const rw = await makeKey('read_write');

		expect((await listScoresApi(apiEv('/api/v1/scores', null))).status).toBe(401);
		const list = await json(await listScoresApi(apiEv('/api/v1/scores', read.token)));
		expect(list.data.find((s: any) => s.id === sid)).toMatchObject({ bands: [{ label: 'Hot', min: 50 }, { label: 'Warm', min: 10 }], rule_count: 0 });

		const params = { id: String(c), scoreId: String(sid) };
		expect((await adjustPost(apiEv(`/api/v1/contacts/${c}/scores/${sid}/adjust`, read.token, params, { points: 5 }))).status).toBe(403);
		expect((await adjustPost(apiEv(`/api/v1/contacts/${c}/scores/${sid}/adjust`, null, params, { points: 5 }))).status).toBe(401);
		expect((await adjustPost(apiEv(`/api/v1/contacts/${c}/scores/${sid}/adjust`, rw.token, params, { points: 0 }))).status).toBe(400);
		expect((await adjustPost(apiEv(`/api/v1/contacts/999999/scores/${sid}/adjust`, rw.token, { id: '999999', scoreId: String(sid) }, { points: 5 }))).status).toBe(404);
		const adj = await json(await adjustPost(apiEv(`/api/v1/contacts/${c}/scores/${sid}/adjust`, rw.token, params, { points: 55, note: 'demo booked' })));
		expect(adj.data).toMatchObject({ value: 55, band: 'Hot' });
		const led = await one<{ source_type: string; note: string }>('SELECT source_type, note FROM score_points WHERE contact_id = ? AND score_id = ?', c, sid);
		expect(led).toEqual({ source_type: 'manual', note: `api:${rw.id} demo booked` });

		const mine = await json(await contactScoresGet(apiEv(`/api/v1/contacts/${c}/scores`, read.token, { id: String(c) })));
		const s = mine.data.scores.find((x: any) => x.id === sid);
		expect(s).toMatchObject({ value: 55, band: 'Hot' });
		expect(s.history[0]).toMatchObject({ points: 55, source_type: 'manual', reason: 'Manual adjustment' });
		expect((await contactScoresGet(apiEv('/api/v1/contacts/999999/scores', read.token, { id: '999999' }))).status).toBe(404);

		const got = await json(await getContactApi(apiEv(`/api/v1/contacts/${c}`, read.token, { id: String(c) })));
		expect(got.data.scores.find((x: any) => x.id === sid)).toEqual({ id: sid, slug: expect.any(String), value: 55, band: 'Hot' });

		const d = await json(await discovery(apiEv('/api/v1', read.token)));
		expect(d.resources.scores).toEqual({ read: true, adjust: false });
		const d2 = await json(await discovery(apiEv('/api/v1', rw.token)));
		expect(d2.resources.scores).toEqual({ read: true, adjust: true });
	});
});

// ── assistant + MCP ─────────────────────────────────────────────────────────────────────

describe('assistant + MCP', () => {
	const LOGIN = `score467-${Date.now()}`;
	let userId = 0;
	beforeAll(async () => {
		userId = (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, LOGIN)).id;
	});
	const user = () => ({ id: userId, github_login: LOGIN, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false }) as any;

	it('registers three reads + one write, also wrapped as MCP reads', () => {
		const tier = (n: string) => TOOLS.find((t) => t.name === n)?.tier;
		expect([tier('list_scores'), tier('get_contact_scores'), tier('get_score_leaders'), tier('add_score_points')]).toEqual(['read', 'read', 'read', 'write']);
		for (const n of ['list_scores', 'get_contact_scores', 'get_score_leaders']) expect(MCP_TOOLS.find((t) => t.name === n)).toMatchObject({ group: 'read' });
		expect(MCP_TOOLS.find((t) => t.name === 'add_score_points')).toBeUndefined();
	});

	it('reads by slug / email, adds points and Undo removes them', async () => {
		const sid = await makeScore();
		const slug = (await one<{ slug: string }>('SELECT slug FROM score_defs WHERE id = ?', sid)).slug;
		const c = await contact();
		const email = (await one<{ email: string }>('SELECT email FROM contacts WHERE id = ?', c)).email;
		const threadId = await createThread(db, userId, modelInfo('claude-sonnet-5-5')!.id, 'medium', 'test');
		const ctx: ToolContext = { db, user: user(), baseUrl: 'https://app.test', now: new Date(), threadId };

		const list = await runTool(ctx, 'list_scores', {});
		expect(JSON.parse(list.content).scores.some((s: any) => s.id === sid)).toBe(true);

		const w = await runTool(ctx, 'add_score_points', { contact_id: c, score: slug, points: 20, note: 'webinar' }, TOOLS, `tu_${++seq}`);
		expect(w.action).toMatchObject({ status: 'applied', tool: 'add_score_points' });
		const mine = JSON.parse((await runTool(ctx, 'get_contact_scores', { email })).content);
		expect(mine.scores.find((s: any) => s.id === sid)).toMatchObject({ value: 20, band: 'Warm' });
		const leaders = JSON.parse((await runTool(ctx, 'get_score_leaders', { score: sid, band: 'Warm' })).content);
		expect(leaders.contacts.map((l: any) => l.contact_id)).toContain(c);
		expect((await runTool(ctx, 'get_score_leaders', { score: 'no-such-score' })).ok).toBe(false);
		expect((await runTool(ctx, 'add_score_points', { contact_id: c, score: sid, points: 0 }, TOOLS, `tu_${++seq}`)).ok).toBe(false);

		const action = await actionForUser(db, w.action!.id, userId);
		expect(await undoAction(ctx, action!, toolByName('add_score_points') as WriteTool)).toMatchObject({ ok: true });
		expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM score_points WHERE contact_id = ? AND score_id = ?', c, sid)).n).toBe(0);
		expect((await one<{ value: number }>('SELECT value FROM contact_scores WHERE contact_id = ? AND score_id = ?', c, sid)).value).toBe(0);
	});
});
