import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { AI_PRUNE_KEY, historyCutoff, pruneAssistantHistory } from '../src/lib/server/ai/prune';
import { appendMessage, createThread, displayMessages, listThreads, setFeedback } from '../src/lib/server/ai/threads';
import { usageInsights } from '../src/lib/server/ai/config';
import { threadToItems, applyEvent, type ChatItem } from '../src/lib/assistant-view';
import { POST as feedbackPOST } from '../src/routes/api/assistant/messages/[id]/feedback/+server';

// #310 (Phase 4 of #71): the retention prune (boundaries, month floor, ai_actions kept 365
// days, job runs, batching + the daily stamp) and thumbs up / down feedback on answers.

const db = (env as any).DB as D1Database;
const NOW = new Date('2026-10-21T12:00:00Z');
const DAY = 86_400_000;
const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ago = (days: number, extraMs = 0) => sql(NOW.getTime() - days * DAY + extraMs);

let alice: { id: number; github_login: string };
let bob: { id: number; github_login: string };

async function makeUser(login: string) {
	const r = await db.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member') RETURNING id`).bind(login).first<{ id: number }>();
	return { id: r!.id, github_login: login };
}

/** A thread last updated at `at`, with one user + one assistant message created then. */
async function threadAt(userId: number, at: string, title = 'old'): Promise<number> {
	const t = await db
		.prepare(`INSERT INTO ai_threads (user_id, title, model, created_at, updated_at) VALUES (?, ?, 'claude-sonnet-5-5', ?, ?) RETURNING id`)
		.bind(userId, title, at, at)
		.first<{ id: number }>();
	await db
		.prepare(`INSERT INTO ai_messages (thread_id, role, content, created_at) VALUES (?, 'user', '[]', ?), (?, 'assistant', '[]', ?)`)
		.bind(t!.id, at, t!.id, at)
		.run();
	return t!.id;
}
const exists = async (table: string, id: number) => !!(await db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).bind(id).first());
const messageCount = async (threadId: number) => (await db.prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id = ?').bind(threadId).first<{ n: number }>())!.n;

beforeAll(async () => {
	alice = await makeUser(`prune-alice-${Date.now()}`);
	bob = await makeUser(`prune-bob-${Date.now()}`);
});

describe('retention prune (#310)', () => {
	beforeEach(async () => {
		await db.prepare('DELETE FROM ai_actions').run();
		await db.prepare('DELETE FROM ai_messages').run();
		await db.prepare('DELETE FROM ai_threads').run();
		await db.prepare('DELETE FROM ai_job_runs').run();
		await db.prepare('DELETE FROM app_state WHERE key = ?').bind(AI_PRUNE_KEY).run();
	});

	it('cutoff = now − retention days, never later than the start of this UTC month', () => {
		expect(historyCutoff(NOW, 180)).toBe(ago(180));
		expect(historyCutoff(NOW, 1)).toBe('2026-10-01 00:00:00');
		expect(historyCutoff(NOW, 20)).toBe('2026-10-01 00:00:00');
		expect(historyCutoff(NOW, 21)).toBe('2026-09-30 12:00:00');
	});

	it('deletes threads + messages last updated before the cutoff; one second later survives', async () => {
		const cutoff = historyCutoff(NOW, 180);
		const old = await threadAt(alice.id, ago(180, -1000));
		const atCutoff = await threadAt(alice.id, cutoff);
		const recent = await threadAt(alice.id, ago(10));

		const r = await pruneAssistantHistory(db, { now: NOW, retentionDays: 180 });
		expect(r).toMatchObject({ ran: true, messages: 2, threads: 1, done: true });
		expect(await exists('ai_threads', old)).toBe(false);
		expect(await messageCount(old)).toBe(0);
		expect(await exists('ai_threads', atCutoff)).toBe(true);
		expect(await messageCount(atCutoff)).toBe(2);
		expect(await exists('ai_threads', recent)).toBe(true);
	});

	it('reads the retention setting when none is passed (default 180 days)', async () => {
		const old = await threadAt(alice.id, ago(181));
		const kept = await threadAt(alice.id, ago(179));
		await pruneAssistantHistory(db, { now: NOW });
		expect(await exists('ai_threads', old)).toBe(false);
		expect(await exists('ai_threads', kept)).toBe(true);
	});

	it('never prunes this month (spend caps), even with a 1-day retention', async () => {
		const thisMonth = await threadAt(alice.id, '2026-10-01 00:00:00');
		const lastMonth = await threadAt(alice.id, '2026-09-30 23:59:59');
		await pruneAssistantHistory(db, { now: NOW, retentionDays: 1 });
		expect(await exists('ai_threads', thisMonth)).toBe(true);
		expect(await exists('ai_threads', lastMonth)).toBe(false);
	});

	it('keeps ai_actions for 365 days: the thread loses its messages, stays hidden, then goes', async () => {
		const young = await threadAt(alice.id, ago(200), 'young action');
		const action = await db
			.prepare(`INSERT INTO ai_actions (thread_id, user_id, tool, status, created_at) VALUES (?, ?, 'add_tag', 'applied', ?) RETURNING id`)
			.bind(young, alice.id, ago(200))
			.first<{ id: number }>();
		const aged = await threadAt(alice.id, ago(366), 'aged action');
		const agedAction = await db
			.prepare(`INSERT INTO ai_actions (thread_id, user_id, tool, status, created_at) VALUES (?, ?, 'add_tag', 'applied', ?) RETURNING id`)
			.bind(aged, alice.id, ago(366))
			.first<{ id: number }>();

		const r = await pruneAssistantHistory(db, { now: NOW, retentionDays: 180 });
		expect(r).toMatchObject({ actions: 1, threads: 1 });
		expect(await messageCount(young)).toBe(0);
		expect(await exists('ai_threads', young)).toBe(true);
		expect(await exists('ai_actions', action!.id)).toBe(true);
		expect(await exists('ai_actions', agedAction!.id)).toBe(false);
		expect(await exists('ai_threads', aged)).toBe(false);
		// The emptied thread doesn't show in the history list.
		expect((await listThreads(db, alice.id)).map((t) => t.id)).not.toContain(young);

		// A year after the action, the next pass removes both.
		const later = new Date(NOW.getTime() + 170 * DAY);
		await pruneAssistantHistory(db, { now: later, retentionDays: 180, force: true });
		expect(await exists('ai_actions', action!.id)).toBe(false);
		expect(await exists('ai_threads', young)).toBe(false);
	});

	it('prunes ai_job_runs started before the cutoff', async () => {
		const run = (at: string) =>
			db.prepare(`INSERT INTO ai_job_runs (user_id, status, started_at) VALUES (?, 'ok', ?) RETURNING id`).bind(alice.id, at).first<{ id: number }>();
		const old = await run(ago(181));
		const kept = await run(ago(179));
		const r = await pruneAssistantHistory(db, { now: NOW, retentionDays: 180 });
		expect(r.jobRuns).toBe(1);
		expect(await exists('ai_job_runs', old!.id)).toBe(false);
		expect(await exists('ai_job_runs', kept!.id)).toBe(true);
	});

	it('runs once per 24 h; a full batch leaves the stamp unset so the next tick continues', async () => {
		for (let i = 0; i < 3; i++) await threadAt(alice.id, ago(300 + i));
		const first = await pruneAssistantHistory(db, { now: NOW, retentionDays: 180, batch: 4 });
		expect(first).toMatchObject({ ran: true, messages: 4, done: false });
		expect(await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(AI_PRUNE_KEY).first()).toBeNull();

		const second = await pruneAssistantHistory(db, { now: NOW, retentionDays: 180, batch: 4 });
		expect(second).toMatchObject({ ran: true, messages: 2, done: true });
		expect((await db.prepare('SELECT COUNT(*) AS n FROM ai_threads').first<{ n: number }>())!.n).toBe(0);

		const third = await pruneAssistantHistory(db, { now: new Date(NOW.getTime() + 3_600_000), retentionDays: 180 });
		expect(third.ran).toBe(false);
		const nextDay = await pruneAssistantHistory(db, { now: new Date(NOW.getTime() + DAY + 1000), retentionDays: 180 });
		expect(nextDay.ran).toBe(true);
	});
});

describe('answer feedback (#310)', () => {
	let threadId: number;
	let answerId: number;
	let userMsgId: number;

	beforeAll(async () => {
		threadId = await createThread(db, alice.id, 'claude-sonnet-5-5', 'medium', 'feedback');
		userMsgId = await appendMessage(db, threadId, { role: 'user', content: [{ type: 'text', text: 'How did my campaign do?' }] });
		await appendMessage(db, threadId, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'list_campaigns', input: {} }], model: 'claude-sonnet-5-5' });
		await appendMessage(db, threadId, { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '[]' }] });
		answerId = await appendMessage(db, threadId, { role: 'assistant', content: [{ type: 'text', text: 'Fine.' }], model: 'claude-sonnet-5-5' });
	});

	const event = (id: number | string, user: { id: number; github_login: string } | null, body: unknown) =>
		({
			params: { id: String(id) },
			locals: { user: user ? { ...user, role: 'member' } : null },
			platform: { env },
			request: new Request(`https://app.test/api/assistant/messages/${id}/feedback`, { method: 'POST', body: JSON.stringify(body) })
		}) as any;

	it('stores, changes and clears feedback on the user’s own assistant message', async () => {
		expect(await setFeedback(db, answerId, alice.id, -1)).toBe(true);
		let row = await db.prepare('SELECT feedback, feedback_at FROM ai_messages WHERE id = ?').bind(answerId).first<{ feedback: number; feedback_at: string | null }>();
		expect(row).toMatchObject({ feedback: -1 });
		expect(row!.feedback_at).toBeTruthy();

		expect(await setFeedback(db, answerId, alice.id, 1)).toBe(true);
		expect((await displayMessages(db, threadId)).find((m) => m.id === answerId)).toMatchObject({ kind: 'assistant', feedback: 1 });

		expect(await setFeedback(db, answerId, alice.id, null)).toBe(true);
		row = await db.prepare('SELECT feedback, feedback_at FROM ai_messages WHERE id = ?').bind(answerId).first();
		expect(row).toEqual({ feedback: null, feedback_at: null });
	});

	it('refuses someone else’s message and non-assistant rows', async () => {
		expect(await setFeedback(db, answerId, bob.id, 1)).toBe(false);
		expect(await setFeedback(db, userMsgId, alice.id, 1)).toBe(false);
		expect(await setFeedback(db, 999_999, alice.id, 1)).toBe(false);
	});

	it('POST /api/assistant/messages/:id/feedback', async () => {
		expect((await feedbackPOST(event(answerId, null, { value: 'up' }))).status).toBe(401);
		expect((await feedbackPOST(event(answerId, alice, { value: 'maybe' }))).status).toBe(400);
		expect((await feedbackPOST(event(answerId, bob, { value: 'up' }))).status).toBe(404);
		expect((await feedbackPOST(event('abc', alice, { value: 'up' }))).status).toBe(404);
		const ok = await feedbackPOST(event(answerId, alice, { value: 'down' }));
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ id: answerId, feedback: -1 });
		expect((await db.prepare('SELECT feedback FROM ai_messages WHERE id = ?').bind(answerId).first<{ feedback: number }>())!.feedback).toBe(-1);
		expect(await (await feedbackPOST(event(answerId, alice, { value: null }))).json()).toEqual({ id: answerId, feedback: null });
	});

	it('the panel item points at the turn’s last assistant row and carries its feedback', async () => {
		await setFeedback(db, answerId, alice.id, 1);
		const items = threadToItems((await displayMessages(db, threadId)) as any);
		expect(items.at(-1)).toMatchObject({ kind: 'assistant', messageId: answerId, feedback: 1 });

		// While streaming, the `message` event sets the id (the last one wins).
		const live: Extract<ChatItem, { kind: 'assistant' }> = { kind: 'assistant', text: '', tools: [], costMicros: 0, tokens: 0, streaming: true };
		applyEvent(live, { type: 'message', id: 7 });
		applyEvent(live, { type: 'message', id: 9 });
		expect(live.messageId).toBe(9);
	});

	it('shows in the usage insights (counts + recent thumbs down)', async () => {
		await setFeedback(db, answerId, alice.id, -1);
		const u = await usageInsights(db, 30);
		expect(u.feedback.down).toBeGreaterThanOrEqual(1);
		expect(u.recentDown.find((d) => d.message_id === answerId)).toMatchObject({ title: 'feedback', github_login: alice.github_login });
		expect(u.topTools.find((t) => t.name === 'list_campaigns')).toMatchObject({ calls: 1 });
		expect(u.byModel.find((m) => m.model === 'claude-sonnet-5-5')!.calls).toBeGreaterThanOrEqual(2);
		expect(u.turns).toBeGreaterThanOrEqual(1);
	});
});
