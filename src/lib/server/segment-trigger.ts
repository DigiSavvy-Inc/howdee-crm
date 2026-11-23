// #413: "Added to segment" for rule-based (dynamic) segments. Nothing ever adds a contact to
// one — there are no list_members rows — so autoEnroll never fires for them. Instead the
// heartbeat polls: for every active or paused `list_added` automation whose trigger list is a
// dynamic segment, it compares the segment's current members with the stored snapshot
// (`segment_trigger_members`, migration 0103). New entrants go through enroll() (re-entry and
// #412's entry conditions apply) or, for a paused automation, into automation_pending_triggers
// (#397). Contacts who left are dropped from the snapshot, so coming back is a new entry.
//
// No snapshot yet for this segment (`segment_trigger_state`) = take a baseline and enroll
// nobody: the people already in the segment were not "added". The activate action does this
// up front and can offer to enroll them; the tick does it for any other activation path.
//
// At most SEGMENT_TRIGGER_CAP entrants per tick across all automations. Entrants over the cap
// are left out of the snapshot, so the next tick sees them as new again and takes them then.

import { enroll } from './automations';
import { recordPendingTriggers } from './automation-flow';
import { parseRules, segmentMembershipSql, type SegmentRules } from './segment-query';

export const SEGMENT_TRIGGER_CAP = 2000;
const IN_CHUNK = 500;

type Tracked = { id: number; status: string; list_id: number; rules: SegmentRules };

export type SegmentTriggerSummary = {
	automations: number;
	baselined: number;
	entered: number;
	enrolled: number;
	pending: number;
	left: number;
	/** Automations with entrants held back by the cap (taken next tick). */
	deferred: number;
};

/** The dynamic segment an automation's trigger points at, or null (any other trigger). */
export async function segmentTriggerOf(
	db: D1Database,
	automationId: number
): Promise<{ list_id: number; name: string; rules: SegmentRules } | null> {
	const row = await db
		.prepare(
			`SELECT l.id, l.name, l.rules FROM automations a JOIN lists l ON l.id = a.trigger_list_id
			 WHERE a.id = ? AND a.trigger_type = 'list_added' AND l.kind = 'segment' AND l.rules IS NOT NULL`
		)
		.bind(automationId)
		.first<{ id: number; name: string; rules: string }>();
	const rules = parseRules(row?.rules);
	return row && rules ? { list_id: row.id, name: row.name, rules } : null;
}

function membersSql(rules: SegmentRules): { sql: string; params: unknown[] } {
	const m = segmentMembershipSql(rules, 'c.id');
	return { sql: `SELECT c.id FROM contacts c WHERE ${m.sql}`, params: m.params };
}

/** Subscribed members right now — what the activate confirm offers to enroll. */
export async function segmentEligibleCount(db: D1Database, rules: SegmentRules): Promise<number> {
	const m = membersSql(rules);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE subscribed = 1 AND id IN (${m.sql})`)
		.bind(...m.params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Whether a snapshot of this segment already exists (an earlier activation took one). */
export async function segmentBaselineExists(db: D1Database, automationId: number, listId: number): Promise<boolean> {
	const state = await db
		.prepare('SELECT list_id FROM segment_trigger_state WHERE automation_id = ?')
		.bind(automationId)
		.first<{ list_id: number }>();
	return state?.list_id === listId;
}

/** Snapshot the segment's current members without enrolling anyone, unless a snapshot for
 *  this same segment already exists (then it is kept, so entrants aren't swallowed). Returns
 *  true when a fresh baseline was taken. */
export async function ensureSegmentBaseline(
	db: D1Database,
	automationId: number,
	listId: number,
	rules: SegmentRules
): Promise<boolean> {
	if (await segmentBaselineExists(db, automationId, listId)) return false;
	const m = membersSql(rules);
	await db.batch([
		db.prepare('DELETE FROM segment_trigger_members WHERE automation_id = ?').bind(automationId),
		db
			.prepare(`INSERT OR IGNORE INTO segment_trigger_members (automation_id, contact_id) SELECT ?, id FROM (${m.sql})`)
			.bind(automationId, ...m.params),
		db
			.prepare(
				`INSERT INTO segment_trigger_state (automation_id, list_id, baselined_at) VALUES (?, ?, datetime('now'))
				 ON CONFLICT(automation_id) DO UPDATE SET list_id = excluded.list_id, baselined_at = excluded.baselined_at`
			)
			.bind(automationId, listId)
	]);
	return true;
}

/** Heartbeat: poll every tracked automation's segment, enroll (or record) new entrants. */
export async function processSegmentTriggers(db: D1Database): Promise<SegmentTriggerSummary> {
	const summary: SegmentTriggerSummary = { automations: 0, baselined: 0, entered: 0, enrolled: 0, pending: 0, left: 0, deferred: 0 };
	const rows = await db
		.prepare(
			`SELECT a.id, a.status, l.id AS list_id, l.rules FROM automations a JOIN lists l ON l.id = a.trigger_list_id
			 WHERE a.status IN ('active', 'paused') AND a.trigger_type = 'list_added' AND l.kind = 'segment' AND l.rules IS NOT NULL
			 ORDER BY a.id`
		)
		.all<{ id: number; status: string; list_id: number; rules: string }>();
	const tracked: Tracked[] = [];
	for (const r of rows.results) {
		const rules = parseRules(r.rules);
		if (rules) tracked.push({ id: r.id, status: r.status, list_id: r.list_id, rules });
	}

	// Snapshots of automations no longer tracked (trigger changed, set back to draft) go, so a
	// later switch back starts from a fresh baseline instead of a stale one.
	const keep = JSON.stringify(tracked.map((t) => t.id));
	await db.batch([
		db.prepare('DELETE FROM segment_trigger_members WHERE automation_id NOT IN (SELECT value FROM json_each(?))').bind(keep),
		db.prepare('DELETE FROM segment_trigger_state WHERE automation_id NOT IN (SELECT value FROM json_each(?))').bind(keep)
	]);

	let budget = SEGMENT_TRIGGER_CAP;
	for (const t of tracked) {
		summary.automations++;
		if (await ensureSegmentBaseline(db, t.id, t.list_id, t.rules)) {
			summary.baselined++;
			continue;
		}
		const m = membersSql(t.rules);
		const left = await db
			.prepare(`DELETE FROM segment_trigger_members WHERE automation_id = ? AND contact_id NOT IN (${m.sql})`)
			.bind(t.id, ...m.params)
			.run();
		summary.left += left.meta.changes ?? 0;

		// One past the budget, to know whether anyone was held back.
		const entrants = (
			await db
				.prepare(
					`SELECT id FROM (${m.sql}) WHERE id NOT IN (SELECT contact_id FROM segment_trigger_members WHERE automation_id = ?)
					 ORDER BY id LIMIT ?`
				)
				.bind(...m.params, t.id, Math.max(0, budget) + 1)
				.all<{ id: number }>()
		).results.map((r) => r.id);
		const take = entrants.slice(0, Math.max(0, budget));
		if (entrants.length > take.length) summary.deferred++;
		if (take.length === 0) continue;
		budget -= take.length;
		summary.entered += take.length;

		if (t.status === 'paused') {
			await recordPendingTriggers(db, t.id, take, 'segment_entered');
			summary.pending += take.length;
		} else {
			summary.enrolled += (await enroll(db, t.id, take)).enrolled;
		}
		// Everyone taken is now "seen", whether enroll() took them or not (unsubscribed,
		// entry conditions, re-entry) — same as a list add that enrolls nobody.
		for (let i = 0; i < take.length; i += IN_CHUNK) {
			await db
				.prepare(
					`INSERT OR IGNORE INTO segment_trigger_members (automation_id, contact_id)
					 SELECT ?, value FROM json_each(?)`
				)
				.bind(t.id, JSON.stringify(take.slice(i, i + IN_CHUNK)))
				.run();
		}
	}
	return summary;
}
