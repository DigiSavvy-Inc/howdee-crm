// #552: the assistant never enrolls anyone — not even through a `score_changed` automation.
// Its add_score_points (and Undo) changes are recorded `quiet`; so are points the engine later
// awards for tag / list / pipeline rows an assistant write added (score_quiet_sources). The
// heartbeat drains quiet changes without enrolling. The score and its history change as usual.
// add_score_points also asks for Approve when a trigger segment reads that score (#535 guard), and
// so does a tag / list / pipeline write when an event rule turns it into points on such a score.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { SOURCE_TABLES, validateRule, validateScore } from '../src/lib/scoring';
import { createRule, createScore } from '../src/lib/server/scoring/store';
import { addScorePoints } from '../src/lib/server/scoring/contact';
import { markPairsDirty, runScoringJob, setWatermarks, type Watermarks } from '../src/lib/server/scoring/engine';
import { processScoreTriggers } from '../src/lib/server/score-trigger';
import { addStep, createAutomation, setReentry, setTrigger } from '../src/lib/server/automation-write';
import { TOOLS, runTool, toolByName } from '../src/lib/server/ai/tools';
import type { ToolContext, WriteTool } from '../src/lib/server/ai/tools/types';
import { actionForUser, undoAction } from '../src/lib/server/ai/actions';
import { createThread } from '../src/lib/server/ai/threads';
import { modelInfo } from '../src/lib/ai-models';

const db = (env as any).DB as D1Database;
const T = `q${Date.now()}`;
const actor = { kind: 'user' as const, id: 1 };
let seq = 0;
let userId = 0;
const automations: number[] = [];

async function one<R>(sql: string, ...binds: unknown[]): Promise<R> {
	return (await db.prepare(sql).bind(...binds).first<R>())!;
}
async function contact(): Promise<number> {
	return (await one<{ id: number }>('INSERT INTO contacts (email) VALUES (?) RETURNING id', `c-${T}-${++seq}@q552.test`)).id;
}
async function makeScore(): Promise<number> {
	const v = validateScore({ name: `Quiet ${T} ${++seq}`, decay_mode: 'none', bands: '[{"label":"Hot","min":50},{"label":"Warm","min":10}]' });
	if (!v.ok) throw new Error(v.error);
	const r = await createScore(db, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}
async function eventRule(scoreId: number, eventType: string, filter: Record<string, number>, points = 60): Promise<void> {
	const v = validateRule({ kind: 'event', event_type: eventType, points: String(points), filter: JSON.stringify(filter) }, 'none');
	if (!v.ok) throw new Error(v.error);
	const r = await createRule(db, scoreId, v.value);
	if (!r.ok) throw new Error(r.error);
}
async function scoreFlow(scoreId: number): Promise<number> {
	const created = await createAutomation(db, { name: `Score flow ${T} ${++seq}` }, actor);
	if (!created.ok) throw new Error(created.error);
	const aid = created.data.automation_id;
	const t = await setTrigger(db, aid, { type: 'score_changed', score_id: scoreId, mode: 'any_change' } as any, actor);
	if (!t.ok) throw new Error(t.error);
	await setReentry(db, aid, { reentry: 'multiple' }, actor);
	const step = await addStep(db, aid, { type: 'tag', fields: { tag_action: 'add', tag_name: `scored-${T}` } }, actor);
	if (!step.ok) throw new Error(step.error);
	await db.prepare(`UPDATE automations SET status = 'active' WHERE id = ?`).bind(aid).run();
	automations.push(aid);
	return aid;
}
const passes = async (aid: number) =>
	(await db.prepare('SELECT contact_id FROM automation_enrollments WHERE automation_id = ?').bind(aid).all<{ contact_id: number }>()).results.map((r) => r.contact_id);
const valueOf = async (cid: number, sid: number) =>
	db.prepare('SELECT value, prev_value, trigger_quiet FROM contact_scores WHERE contact_id = ? AND score_id = ?').bind(cid, sid).first<{ value: number; prev_value: number | null; trigger_quiet: number }>();

/** Only rows added from here on are read by the scoring ingest. */
async function watermarksToNow(): Promise<void> {
	const wm: Watermarks = {};
	for (const s of SOURCE_TABLES) {
		const col = s === 'list_members' ? 'rowid' : 'id';
		wm[s] = (await db.prepare(`SELECT COALESCE(MAX(${col}), 0) AS m FROM ${s}`).first<{ m: number }>())!.m;
	}
	await setWatermarks(db, wm);
}

/** What the heartbeat does for scores: the scoring job, then the score_changed drain. */
async function heartbeat() {
	await runScoringJob(db);
	return processScoreTriggers(db);
}

async function ctx(): Promise<ToolContext> {
	const threadId = await createThread(db, userId, modelInfo('claude-sonnet-5-5')!.id, 'medium', 'test');
	return {
		db,
		user: { id: userId, github_login: `${T}-u`, role: 'member', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any,
		baseUrl: 'https://app.test',
		now: new Date(),
		threadId,
		mxLookup: async () => 'ok'
	};
}
const call = (c: ToolContext, name: string, input: Record<string, unknown>) => runTool(c, name, input, TOOLS, `tu_${++seq}`);

beforeAll(async () => {
	userId = (await one<{ id: number }>(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`, `${T}-u`)).id;
	// The seeded rebuild / first runs out of the way, and no leftover change rows.
	await runScoringJob(db);
});

beforeEach(async () => {
	await processScoreTriggers(db);
	await db.prepare('DELETE FROM score_change_events').run();
});

afterAll(async () => {
	await db.prepare(`UPDATE automations SET status = 'draft' WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(automations)).run();
});

describe('add_score_points', () => {
	it('changes the score but never enrolls into a score_changed automation (apply and Undo)', async () => {
		const sid = await makeScore();
		const aid = await scoreFlow(sid);
		const c = await contact();
		const k = await ctx();

		const w = await call(k, 'add_score_points', { contact_id: c, score: sid, points: 60 });
		expect(w.action).toMatchObject({ status: 'applied' });
		expect(await valueOf(c, sid)).toMatchObject({ value: 60, trigger_quiet: 0 });
		expect(await one('SELECT quiet FROM score_change_events WHERE contact_id = ? AND score_id = ?', c, sid)).toEqual({ quiet: 1 });

		const r = await heartbeat();
		expect(r).toMatchObject({ enrolled: 0, matched: 0, quiet: 1 });
		expect(await passes(aid)).toEqual([]);
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM automation_pending_triggers WHERE automation_id = ?', aid)).toEqual({ n: 0 });
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM score_change_events')).toEqual({ n: 0 }); // drained

		const action = await actionForUser(db, w.action!.id, userId);
		expect(await undoAction(k, action!, toolByName('add_score_points') as WriteTool)).toMatchObject({ ok: true });
		expect(await valueOf(c, sid)).toMatchObject({ value: 0, prev_value: 60 });
		expect(await heartbeat()).toMatchObject({ enrolled: 0, quiet: 1 });
		expect(await passes(aid)).toEqual([]);
	});

	it('the same change made outside the assistant still enrolls', async () => {
		const sid = await makeScore();
		const aid = await scoreFlow(sid);
		const c = await contact();
		await addScorePoints(db, [c], sid, { points: 60, expires_days: null, source_type: 'manual' });
		expect(await heartbeat()).toMatchObject({ enrolled: 1, quiet: 0 });
		expect(await passes(aid)).toEqual([c]);
	});

	it('a deferred recompute (marked dirty, not computed inline) stays quiet', async () => {
		const sid = await makeScore();
		const aid = await scoreFlow(sid);
		const c = await contact();
		await db
			.prepare(`INSERT INTO score_points (score_id, rule_id, contact_id, points, source_type, source_id, earned_at) VALUES (?, NULL, ?, 60, 'manual', ?, ?)`)
			.bind(sid, c, `deferred-${T}`, new Date().toISOString())
			.run();
		await markPairsDirty(db, [[c, sid]], new Date(), { quiet: true });
		// A later, non-quiet dirty mark doesn't lift the flag before the recompute.
		await markPairsDirty(db, [[c, sid]]);
		expect(await valueOf(c, sid)).toMatchObject({ trigger_quiet: 1 });
		expect(await heartbeat()).toMatchObject({ enrolled: 0, quiet: 1 });
		expect(await valueOf(c, sid)).toMatchObject({ value: 60, trigger_quiet: 0 });
		expect(await passes(aid)).toEqual([]);
	});
});

describe('tag / list / pipeline writes that earn points through event rules', () => {
	it('assistant add_tag → points → no enrollment; a tag added elsewhere still enrolls', async () => {
		const sid = await makeScore();
		const tagName = `vip-${T}`;
		const tagId = (await one<{ id: number }>(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, tagName)).id;
		await eventRule(sid, 'list_added', { list_id: tagId });
		const aid = await scoreFlow(sid);
		const [a, b] = [await contact(), await contact()];
		await watermarksToNow();

		const w = await call(await ctx(), 'add_tag', { contact_id: a, tag: tagName });
		expect(w.action).toMatchObject({ status: 'applied' });
		const r1 = await heartbeat();
		expect(await valueOf(a, sid)).toMatchObject({ value: 60 }); // the points still count
		expect(r1).toMatchObject({ enrolled: 0, quiet: 1 });
		expect(await passes(aid)).toEqual([]);

		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(tagId, b).run();
		expect(await heartbeat()).toMatchObject({ enrolled: 1 });
		expect(await passes(aid)).toEqual([b]);
	});

	it('assistant add_to_list → no enrollment', async () => {
		const sid = await makeScore();
		const listId = (await one<{ id: number }>(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `List ${T} ${++seq}`)).id;
		await eventRule(sid, 'list_added', { list_id: listId });
		const aid = await scoreFlow(sid);
		const c = await contact();
		await watermarksToNow();
		expect((await call(await ctx(), 'add_to_list', { contact_id: c, list_id: listId })).action).toMatchObject({ status: 'applied' });
		expect(await heartbeat()).toMatchObject({ enrolled: 0, quiet: 1 });
		expect(await valueOf(c, sid)).toMatchObject({ value: 60 });
		expect(await passes(aid)).toEqual([]);
	});

	it('assistant add_pipeline_card → no enrollment', async () => {
		const sid = await makeScore();
		const stage = await one<{ id: number; name: string }>(`SELECT id, name FROM pipeline_stages WHERE kind = 'open' ORDER BY position LIMIT 1`);
		await eventRule(sid, 'pipeline_stage_entered', { stage_id: stage.id });
		const aid = await scoreFlow(sid);
		const c = await contact();
		await watermarksToNow();
		expect((await call(await ctx(), 'add_pipeline_card', { contact_id: c, stage: String(stage.id) })).action).toMatchObject({ status: 'applied' });
		expect(await one('SELECT COUNT(*) AS n FROM score_quiet_sources WHERE source_type = ?', 'pipeline_history')).not.toEqual({ n: 0 });
		expect(await heartbeat()).toMatchObject({ enrolled: 0, quiet: 1 });
		expect(await valueOf(c, sid)).toMatchObject({ value: 60 });
		expect(await passes(aid)).toEqual([]);
	});
});

describe('trigger-segment guard for score rules', () => {
	it('asks for Approve when a trigger segment reads this score; not for another score', async () => {
		const sid = await makeScore();
		const other = await makeScore();
		const seg = (
			await one<{ id: number }>(
				`INSERT INTO lists (name, kind, rules) VALUES (?, 'segment', ?) RETURNING id`,
				`Seg ${T} ${++seq}`,
				JSON.stringify({ match: 'all', rules: [{ field: 'score_band', op: 'is', value: 'Hot', value2: String(sid) }] })
			)
		).id;
		automations.push(
			(
				await one<{ id: number }>(
					`INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, 'active', 'list_added', ?) RETURNING id`,
					`Seg flow ${T} ${++seq}`,
					seg
				)
			).id
		);
		const c = await contact();
		const k = await ctx();

		const r = await call(k, 'add_score_points', { contact_id: c, score: sid, points: 60 });
		expect(r.pending).toBe(true);
		expect(r.action!.scope!.notes!.some((n: string) => /active automation/.test(n) && /1 of these contacts is not in it yet/.test(n))).toBe(true);
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM score_points WHERE contact_id = ? AND score_id = ?', c, sid)).toEqual({ n: 0 });

		const ok = await call(k, 'add_score_points', { contact_id: c, score: other, points: 60 });
		expect(ok.action).toMatchObject({ status: 'applied' });
	});
});

describe('trigger-segment guard for points a tag / list / pipeline write earns', () => {
	/** An active `list_added` automation whose dynamic segment reads `scoreId`. */
	async function scoreSegment(scoreId: number): Promise<void> {
		const seg = (
			await one<{ id: number }>(
				`INSERT INTO lists (name, kind, rules) VALUES (?, 'segment', ?) RETURNING id`,
				`Points seg ${T} ${++seq}`,
				JSON.stringify({ match: 'all', rules: [{ field: 'score_value', op: 'gte', value: '50', value2: String(scoreId) }] })
			)
		).id;
		automations.push(
			(
				await one<{ id: number }>(
					`INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES (?, 'active', 'list_added', ?) RETURNING id`,
					`Points flow ${T} ${++seq}`,
					seg
				)
			).id
		);
	}
	const tag = async (name: string) => (await one<{ id: number }>(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`, name)).id;

	it('assistant add_tag asks for Approve when an event rule on that tag feeds a score a trigger segment reads', async () => {
		const sid = await makeScore();
		const tagName = `feed-${T}-${++seq}`;
		const tagId = await tag(tagName);
		await eventRule(sid, 'list_added', { list_id: tagId });
		await scoreSegment(sid);
		const c = await contact();
		const { name } = await one<{ name: string }>('SELECT name FROM score_defs WHERE id = ?', sid);

		const r = await call(await ctx(), 'add_tag', { contact_id: c, tag: tagName });
		expect(r.pending).toBe(true);
		expect(
			r.action!.scope!.notes!.some(
				(n: string) => n.includes(`read the score “${name}”, which this change can add points to through a scoring rule`) && /1 of these contacts is not in it yet/.test(n)
			)
		).toBe(true);
		expect(await one<{ n: number }>('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', tagId, c)).toEqual({ n: 0 });
	});

	it('no Approve for that reason when no event rule on the tag feeds it, or the fed score is not read by a trigger segment', async () => {
		const sid = await makeScore();
		const other = await makeScore();
		const tagName = `nofeed-${T}-${++seq}`;
		const tagId = await tag(tagName);
		await eventRule(sid, 'list_added', { list_id: await tag(`elsewhere-${T}-${++seq}`) }); // a rule on another tag
		await scoreSegment(sid);
		const k = await ctx();

		const w1 = await call(k, 'add_tag', { contact_id: await contact(), tag: tagName });
		expect(w1.action).toMatchObject({ status: 'applied' });

		// The tag now feeds `other`, which no trigger segment reads.
		await eventRule(other, 'list_added', { list_id: tagId });
		const w2 = await call(k, 'add_tag', { contact_id: await contact(), tag: tagName });
		expect(w2.action).toMatchObject({ status: 'applied' });
	});
});
