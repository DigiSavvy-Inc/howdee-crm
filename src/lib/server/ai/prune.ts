// Assistant history retention (#310, Phase 4 of #71). Run by the heartbeat tick once per
// 24 h (stamp `app_state.ai_prune_at`, set only when a pass finished), batched like
// pruneSiteEvents:
//   - a thread whose last message (`updated_at`) is older than Settings → Assistant →
//     History (retentionDays, default 180) loses its messages, then the thread row goes;
//     whole threads only, so a kept thread is always a valid Messages API history;
//   - `ai_job_runs` started before the same cutoff;
//   - `ai_actions` (the write audit / undo store) are kept AI_ACTIONS_KEEP_DAYS (365) days.
//     They CASCADE off their thread, so a thread with a younger action keeps its (empty)
//     row until the action ages out — listThreads hides threads with no messages.
// The cutoff never reaches into the current UTC month: spend caps (spentMicros) sum this
// month's messages and job runs, so a short retention can't reset the monthly cap.

import { getAssistantConfig, utcMonthStart } from './config';

export const AI_PRUNE_KEY = 'ai_prune_at';
export const AI_PRUNE_BATCH = 500;
export const AI_ACTIONS_KEEP_DAYS = 365;

export type AiPruneResult = { ran: boolean; messages: number; threads: number; jobRuns: number; actions: number; done: boolean };

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD HH:MM:SS' (SQLite datetime, UTC). */
function sqlTime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** The history cutoff: `now - retentionDays`, but never later than the start of this UTC month. */
export function historyCutoff(now: Date, retentionDays: number): string {
	const byRetention = sqlTime(now.getTime() - retentionDays * DAY_MS);
	const monthStart = utcMonthStart(now);
	return byRetention < monthStart ? byRetention : monthStart;
}

export async function pruneAssistantHistory(
	db: D1Database,
	opts: { now?: Date; retentionDays?: number; batch?: number; force?: boolean } = {}
): Promise<AiPruneResult> {
	const now = opts.now ?? new Date();
	const batch = opts.batch ?? AI_PRUNE_BATCH;

	if (!opts.force) {
		const last = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(AI_PRUNE_KEY).first<{ value: string | null }>();
		const at = last?.value ? Date.parse(last.value) : NaN;
		if (Number.isFinite(at) && now.getTime() - at < DAY_MS) return { ran: false, messages: 0, threads: 0, jobRuns: 0, actions: 0, done: true };
	}

	const retentionDays = opts.retentionDays ?? (await getAssistantConfig(db)).retentionDays;
	const cutoff = historyCutoff(now, retentionDays);
	const actionsCutoff = sqlTime(now.getTime() - AI_ACTIONS_KEEP_DAYS * DAY_MS);

	const changes = (r: D1Result) => r.meta.changes ?? 0;
	const messages = changes(
		await db
			.prepare(
				`DELETE FROM ai_messages WHERE id IN (
				   SELECT m.id FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id
				   WHERE t.updated_at < ? LIMIT ?)`
			)
			.bind(cutoff, batch)
			.run()
	);
	const actions = changes(
		await db.prepare('DELETE FROM ai_actions WHERE id IN (SELECT id FROM ai_actions WHERE created_at < ? LIMIT ?)').bind(actionsCutoff, batch).run()
	);
	const threads = changes(
		await db
			.prepare(
				`DELETE FROM ai_threads WHERE id IN (
				   SELECT t.id FROM ai_threads t
				   WHERE t.updated_at < ?
				     AND NOT EXISTS (SELECT 1 FROM ai_messages m WHERE m.thread_id = t.id)
				     AND NOT EXISTS (SELECT 1 FROM ai_actions a WHERE a.thread_id = t.id)
				   LIMIT ?)`
			)
			.bind(cutoff, batch)
			.run()
	);
	const jobRuns = changes(
		await db.prepare('DELETE FROM ai_job_runs WHERE id IN (SELECT id FROM ai_job_runs WHERE started_at < ? LIMIT ?)').bind(cutoff, batch).run()
	);

	// A full batch anywhere means more may be left: leave the stamp so the next tick continues.
	const done = messages < batch && actions < batch && threads < batch && jobRuns < batch;
	if (done) {
		await db
			.prepare(
				`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(AI_PRUNE_KEY, now.toISOString())
			.run();
	}
	return { ran: true, messages, threads, jobRuns, actions, done };
}
