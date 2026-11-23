// #467: the "Score changes" (`score_changed`) automation trigger. The scoring engine's cache
// step (scoring/engine.ts `computePairs`) appends a `score_change_events` row whenever a
// watched score's value or band changes; the heartbeat drains them here right after
// `runScoringJob` (and the inline recomputes of the contact page / API / assistant / bulk
// adjust are picked up on the next tick). The engine can't call `enroll()` itself — it sits in
// the assistant / MCP import graph, which must never reach the automation engine.
//
// Matching (`scoreChangeMatches`) only fires on a real transition (crossing a value, entering
// a band, a change), never on every tick. Entry rules, re-entry and the one-active-pass rule
// apply through `enroll()`; paused automations record pending triggers (#397).
// #552: rows marked `quiet` (the assistant caused the change) are drained and dropped.

import { parseScoreTriggerConfig, scoreChangeMatches, type ScoreChange } from '$lib/score-trigger';
import { enroll } from './automations';
import { logEvent, recordPendingTriggers } from './automation-flow';

export const DRAIN_BATCH = 1000;

/** `quiet` = changes the assistant caused (#552), drained without matching. */
export type ScoreTriggerSummary = { events: number; matched: number; enrolled: number; pending: number; quiet?: number };

type EventRow = ScoreChange & { id: number; contact_id: number };

/** Match a batch of changes against every active / paused score_changed automation. */
export async function fireScoreTriggers(db: D1Database, events: EventRow[], now: Date = new Date()): Promise<ScoreTriggerSummary> {
	const summary: ScoreTriggerSummary = { events: events.length, matched: 0, enrolled: 0, pending: 0 };
	if (!events.length) return summary;
	const autos = await db
		.prepare(`SELECT id, status, trigger_config FROM automations WHERE status IN ('active', 'paused') AND trigger_type = 'score_changed' ORDER BY id`)
		.all<{ id: number; status: string; trigger_config: string | null }>();
	for (const a of autos.results) {
		const cfg = parseScoreTriggerConfig(a.trigger_config);
		const ids = [...new Set(events.filter((e) => scoreChangeMatches(cfg, e)).map((e) => e.contact_id))];
		if (!ids.length) continue;
		summary.matched += ids.length;
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, ids, `score:${cfg.score_id}`);
			summary.pending += ids.length;
			continue;
		}
		const r = await enroll(db, a.id, ids, { now });
		summary.enrolled += r.enrolled;
		if (!r.created.length) continue;
		const passes = await db
			.prepare('SELECT id, contact_id FROM automation_enrollments WHERE id IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(r.created))
			.all<{ id: number; contact_id: number }>();
		for (const p of passes.results) {
			const ev = events.find((e) => e.contact_id === p.contact_id && scoreChangeMatches(cfg, e));
			const detail = ev ? `${ev.old_value} → ${ev.new_value}${ev.new_band ? ` (${ev.new_band})` : ''}` : null;
			await logEvent(db, { id: p.id, automation_id: a.id, contact_id: p.contact_id }, null, 'trigger:score_changed', detail);
		}
	}
	return summary;
}

/** The tick step: read ≤ DRAIN_BATCH recorded changes (oldest first), fire, delete them. */
export async function processScoreTriggers(db: D1Database, now: Date = new Date()): Promise<ScoreTriggerSummary> {
	const res = await db
		.prepare(
			`SELECT id, contact_id, score_id, old_value, new_value, old_band, new_band, quiet FROM score_change_events ORDER BY id LIMIT ?`
		)
		.bind(DRAIN_BATCH)
		.all<EventRow & { quiet: number }>();
	const rows = res.results;
	if (!rows.length) return { events: 0, matched: 0, enrolled: 0, pending: 0, quiet: 0 };
	// Delete first: a failing automation must not replay the same changes forever.
	await db.prepare('DELETE FROM score_change_events WHERE id <= ?').bind(rows[rows.length - 1].id).run();
	// #552: a change the assistant caused never enrolls (nor records a pending trigger).
	const events = rows.filter((r) => !r.quiet);
	return { ...(await fireScoreTriggers(db, events, now)), events: rows.length, quiet: rows.length - events.length };
}
