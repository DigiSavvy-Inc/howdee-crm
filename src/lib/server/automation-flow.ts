// #397: server side of the automation flow capabilities — the per-pass timeline, wait-until
// evaluation, exit goals, the frequency cap, status history and triggers recorded while paused.
// No engine / send / enroll imports here, so the write layer and read paths can use it.

import { localParts, localToUtc, sqliteUtc } from './businessdays';
import { compileSegment, parseRules } from './segment-query';
import { classifyProxyOpen } from './engagement';
import { containsSql } from './sql-match';
import { stepShortTitle } from '$lib/automation-action-labels';
import {
	FREQUENCY_CAP_OFF,
	FREQUENCY_CAP_PREFIX,
	normalizeFrequencyCap,
	parseHHMM,
	parseLocalDateTime,
	type ExitKind,
	type ExitRule,
	type FrequencyCap,
	type TimelineEvent,
	type WaitSpec
} from '$lib/automation-flow';

type PassRef = { id: number; automation_id: number; contact_id: number };

// ── Timeline ──────────────────────────────────────────────────────────────────────────────

/** Append one event to a pass's timeline. Best-effort: a log write never fails the engine. */
export async function logEvent(
	db: D1Database,
	e: PassRef,
	stepId: number | null,
	kind: string,
	detail: string | null = null
): Promise<void> {
	try {
		await db
			.prepare(
				'INSERT INTO automation_enrollment_events (enrollment_id, automation_id, contact_id, step_id, kind, detail) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.bind(e.id, e.automation_id, e.contact_id, stepId, kind, detail === null ? null : detail.slice(0, 300))
			.run();
	} catch {
		/* best-effort */
	}
}

/** `enrolled` events for passes just created (their current step = the entry step). */
export async function logEnrolled(db: D1Database, enrollmentIds: number[]): Promise<void> {
	for (let i = 0; i < enrollmentIds.length; i += 500) {
		try {
			await db
				.prepare(
					`INSERT INTO automation_enrollment_events (enrollment_id, automation_id, contact_id, step_id, kind)
					 SELECT e.id, e.automation_id, e.contact_id, e.current_step_id, 'enrolled'
					 FROM automation_enrollments e WHERE e.id IN (SELECT value FROM json_each(?))`
				)
				.bind(JSON.stringify(enrollmentIds.slice(i, i + 500)))
				.run();
		} catch {
			/* best-effort */
		}
	}
}

/** Every event of these passes, oldest first, grouped by pass. */
export async function timelineFor(db: D1Database, enrollmentIds: number[]): Promise<Map<number, TimelineEvent[]>> {
	const out = new Map<number, TimelineEvent[]>();
	for (let i = 0; i < enrollmentIds.length; i += 200) {
		const rows = await db
			.prepare(
				`SELECT enrollment_id, step_id, kind, detail, at FROM automation_enrollment_events
				 WHERE enrollment_id IN (SELECT value FROM json_each(?)) ORDER BY id`
			)
			.bind(JSON.stringify(enrollmentIds.slice(i, i + 200)))
			.all<TimelineEvent & { enrollment_id: number }>();
		for (const r of rows.results) {
			const list = out.get(r.enrollment_id) ?? [];
			list.push({ step_id: r.step_id, kind: r.kind, detail: r.detail, at: r.at });
			out.set(r.enrollment_id, list);
		}
	}
	return out;
}

/** Short titles of the steps a timeline mentions (deleted steps are left out). */
export async function stepTitles(db: D1Database, stepIds: number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	const ids = [...new Set(stepIds.filter((n) => Number.isInteger(n) && n > 0))];
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await db
			.prepare(
				`SELECT id, type, subject, tag_action, tag_name, gate_kind, gate_name, gate_rules, split_pct, action_kind, wait_config
				 FROM automation_steps WHERE id IN (SELECT value FROM json_each(?))`
			)
			.bind(JSON.stringify(ids.slice(i, i + 500)))
			.all<Parameters<typeof stepShortTitle>[0] & { id: number }>();
		for (const r of rows.results) out.set(r.id, stepShortTitle(r));
	}
	return out;
}

// ── Funnel ────────────────────────────────────────────────────────────────────────────────

export type FunnelRow = { step_id: number; reached: number; exited: number };
export type FunnelRange = { from?: string | null; to?: string | null };

/** 'YYYY-MM-DD' or null. */
export function cleanDay(s: string | null | undefined): string | null {
	const v = String(s ?? '').trim();
	return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

/**
 * "Reached step" per step = distinct passes with an `enrolled` / `reached` event there, and
 * "exited by goal" = passes that left on a goal while at that step — both within the range
 * (UTC days, inclusive). Plus the automation-wide goal exits by kind.
 */
export async function funnelStats(
	db: D1Database,
	automationId: number,
	range: FunnelRange = {}
): Promise<{ steps: FunnelRow[]; goals: { kind: string; n: number }[] }> {
	const from = cleanDay(range.from);
	const to = cleanDay(range.to);
	const where = ['automation_id = ?'];
	const binds: unknown[] = [automationId];
	if (from) {
		where.push('at >= ?');
		binds.push(`${from} 00:00:00`);
	}
	if (to) {
		where.push('at <= ?');
		binds.push(`${to} 23:59:59`);
	}
	const w = where.join(' AND ');
	const rows = await db
		.prepare(
			`SELECT step_id,
			        COUNT(DISTINCT CASE WHEN kind IN ('enrolled', 'reached') THEN enrollment_id END) AS reached,
			        COUNT(DISTINCT CASE WHEN kind = 'exit' THEN enrollment_id END) AS exited
			 FROM automation_enrollment_events WHERE ${w} AND step_id IS NOT NULL
			 GROUP BY step_id`
		)
		.bind(...binds)
		.all<FunnelRow>();
	const goals = await db
		.prepare(
			`SELECT substr(detail, 6) AS kind, COUNT(DISTINCT enrollment_id) AS n
			 FROM automation_enrollment_events WHERE ${w} AND kind = 'exit' AND detail LIKE 'goal:%'
			 GROUP BY substr(detail, 6) ORDER BY n DESC`
		)
		.bind(...binds)
		.all<{ kind: string; n: number }>();
	return { steps: rows.results, goals: goals.results };
}

/**
 * Each step's predecessor in canvas order — the previous step in its lane, else the branch /
 * wait it sits under. Used for "conversion from the previous step".
 */
export function predecessors(steps: { id: number; position: number; parent_step_id: number | null; branch_label: string | null }[]): Map<number, number> {
	const out = new Map<number, number>();
	const lanes = new Map<string, typeof steps>();
	for (const s of steps) {
		const key = `${s.parent_step_id ?? ''}:${s.branch_label ?? ''}`;
		lanes.set(key, [...(lanes.get(key) ?? []), s]);
	}
	for (const lane of lanes.values()) {
		lane.sort((a, b) => a.position - b.position);
		lane.forEach((s, i) => {
			if (i > 0) out.set(s.id, lane[i - 1].id);
			else if (s.parent_step_id !== null) out.set(s.id, s.parent_step_id);
		});
	}
	return out;
}

// ── Wait-until ────────────────────────────────────────────────────────────────────────────

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** A `date` wait's target instant for a contact who started waiting at `start`. */
export function waitDateTarget(w: WaitSpec, start: Date, tz: string): Date {
	if (w.at) {
		const p = parseLocalDateTime(w.at);
		if (p) return localToUtc(p.y, p.m, p.d, p.hour, p.minute, 0, tz);
		return start;
	}
	const hm = parseHHMM(w.time) ?? { hour: 9, minute: 0 };
	const parts = localParts(start, tz);
	// Local noon as a UTC anchor so stepping days can't skip a date around DST.
	const anchor = new Date(Date.UTC(parts.y, parts.m - 1, parts.day, 12, 0, 0));
	for (let i = 0; i < 9; i++) {
		const wd = anchor.getUTCDay();
		const ok = w.day === 'weekday' || !w.day ? wd >= 1 && wd <= 5 : wd === DOW[w.day];
		if (ok) {
			const t = localToUtc(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate(), hm.hour, hm.minute, 0, tz);
			if (t.getTime() > start.getTime()) return t;
		}
		anchor.setUTCDate(anchor.getUTCDate() + 1);
	}
	return start;
}

/**
 * #627: a `field_date` wait's target instant from the contact's stored value, or null when the
 * value is missing / unreadable (counts as passed). The value is 'YYYY-MM-DD' (an ISO date-time's
 * date part is accepted). `on` = that day at `time`; days / weeks shift the calendar date; hours
 * shift the instant.
 */
export function fieldDateTarget(w: WaitSpec, value: unknown, tz: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(String(value ?? '').trim());
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const probe = new Date(Date.UTC(y, mo - 1, d, 12));
	if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
	const hm = parseHHMM(w.time) ?? { hour: 9, minute: 0 };
	const sign = w.relation === 'before' ? -1 : w.relation === 'after' ? 1 : 0;
	const n = (w.offset ?? 0) * sign;
	if (w.unit === 'hours') {
		return new Date(localToUtc(y, mo, d, hm.hour, hm.minute, 0, tz).getTime() + n * 3600_000);
	}
	probe.setUTCDate(probe.getUTCDate() + n * (w.unit === 'weeks' ? 7 : 1));
	return localToUtc(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), hm.hour, hm.minute, 0, tz);
}

/** A `window` wait: null when `now` is inside the window, else when it next opens. */
export function windowNextOpen(w: WaitSpec, now: Date, tz: string): Date | null {
	const s = parseHHMM(w.start) ?? { hour: 9, minute: 0 };
	const e = parseHHMM(w.end) ?? { hour: 17, minute: 0 };
	const dayOk = (wd: number) => w.days === 'every' || (wd >= 1 && wd <= 5);
	const p = localParts(now, tz);
	const mins = p.hour * 60 + p.minute;
	if (dayOk(p.weekday) && mins >= s.hour * 60 + s.minute && mins < e.hour * 60 + e.minute) return null;
	const anchor = new Date(Date.UTC(p.y, p.m - 1, p.day, 12, 0, 0));
	for (let i = 0; i < 9; i++) {
		if (dayOk(anchor.getUTCDay())) {
			const t = localToUtc(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate(), s.hour, s.minute, 0, tz);
			if (t.getTime() > now.getTime()) return t;
		}
		anchor.setUTCDate(anchor.getUTCDate() + 1);
	}
	return new Date(now.getTime() + 3600_000);
}

/** Has an `event` wait's event happened for this pass (since `since`, for reply / visit)? */
export async function waitEventHappened(db: D1Database, w: WaitSpec, e: PassRef, since: string): Promise<boolean> {
	if (w.event === 'opened' || w.event === 'clicked') {
		// "The previous email" = the latest email this pass was sent.
		const r = await db
			.prepare(`SELECT id FROM recipients WHERE enrollment_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1`)
			.bind(e.id)
			.first<{ id: number }>();
		if (!r) return false;
		if (w.event === 'clicked') {
			return !!(await db.prepare(`SELECT 1 FROM events WHERE recipient_id = ? AND type = 'click' LIMIT 1`).bind(r.id).first());
		}
		const rows = await db
			.prepare(
				`SELECT ev.type, ev.detail, ev.recorded_at,
				        (SELECT MIN(d.recorded_at) FROM events d WHERE d.recipient_id = ev.recipient_id AND d.type = 'delivery') AS delivered_at
				 FROM events ev WHERE ev.recipient_id = ? AND ev.type IN ('open', 'click') ORDER BY ev.type = 'click' DESC LIMIT 50`
			)
			.bind(r.id)
			.all<{ type: string; detail: string | null; recorded_at: string; delivered_at: string | null }>();
		// Apple Mail / prefetch auto-opens don't count (the opened condition's rule, #395).
		return rows.results.some((x) => {
			if (x.type === 'click') return true;
			let detail: unknown = {};
			try {
				detail = x.detail ? JSON.parse(x.detail) : {};
			} catch {
				/* truncated */
			}
			return !classifyProxyOpen(detail, x.delivered_at, x.recorded_at);
		});
	}
	if (w.event === 'replied') {
		return !!(await db.prepare('SELECT 1 FROM replies WHERE contact_id = ? AND received_at >= ? LIMIT 1').bind(e.contact_id, since).first());
	}
	if (w.event === 'visited') {
		return !!(await db
			.prepare(
				`SELECT 1 FROM site_events WHERE contact_id = ? AND kind = 'pageview' AND ${containsSql('path')} AND occurred_at >= ? LIMIT 1`
			)
			.bind(e.contact_id, w.path ?? '', since) // #485: no LIKE pattern cap (URLs run long)
			.first());
	}
	return false;
}

// ── Exit goals ────────────────────────────────────────────────────────────────────────────

/** The first exit rule this pass meets, or null. Reply and stage count only after enrollment;
 *  tag and segment are the contact's state right now. A deleted list / stage never matches. */
export async function goalHit(
	db: D1Database,
	rules: ExitRule[],
	e: { contact_id: number; enrolled_at: string }
): Promise<ExitKind | null> {
	for (const rule of rules) {
		if (rule.kind === 'reply') {
			const hit = await db
				.prepare('SELECT 1 FROM replies WHERE contact_id = ? AND received_at >= ? LIMIT 1')
				.bind(e.contact_id, e.enrolled_at)
				.first();
			if (hit) return 'reply';
		} else if (rule.kind === 'tag') {
			const hit = await db
				.prepare(
					`SELECT 1 FROM list_members lm JOIN lists l ON l.id = lm.list_id
					 WHERE lm.contact_id = ? AND l.kind = 'tag' AND l.name = ? COLLATE NOCASE LIMIT 1`
				)
				.bind(e.contact_id, rule.tag)
				.first();
			if (hit) return 'tag';
		} else if (rule.kind === 'segment') {
			const list = await db.prepare('SELECT id, kind, rules FROM lists WHERE id = ?').bind(rule.list_id).first<{ id: number; kind: string; rules: string | null }>();
			if (!list) continue;
			const segRules = list.kind === 'segment' ? parseRules(list.rules) : null;
			let hit: unknown;
			if (segRules) {
				const compiled = compileSegment(segRules);
				hit = await db.prepare(`SELECT 1 FROM (${compiled.sql}) WHERE id = ? LIMIT 1`).bind(...compiled.binds, e.contact_id).first();
			} else {
				hit = await db.prepare('SELECT 1 FROM list_members WHERE list_id = ? AND contact_id = ? LIMIT 1').bind(list.id, e.contact_id).first();
			}
			if (hit) return 'segment';
		} else if (rule.kind === 'stage') {
			const hit = await db
				.prepare('SELECT 1 FROM pipeline_history WHERE contact_id = ? AND to_stage_id = ? AND created_at >= ? LIMIT 1')
				.bind(e.contact_id, rule.stage_id, e.enrolled_at)
				.first();
			if (hit) return 'stage';
		}
	}
	return null;
}

// ── Frequency cap ─────────────────────────────────────────────────────────────────────────

const CAP_KEY = 'automation_frequency_cap';

export async function getFrequencyCap(db: D1Database): Promise<FrequencyCap> {
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(CAP_KEY).first<{ value: string }>();
		return row?.value ? normalizeFrequencyCap(JSON.parse(row.value)) : FREQUENCY_CAP_OFF;
	} catch {
		return FREQUENCY_CAP_OFF;
	}
}

export async function setFrequencyCap(db: D1Database, cap: FrequencyCap): Promise<FrequencyCap> {
	const clean = normalizeFrequencyCap(cap);
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(CAP_KEY, JSON.stringify(clean))
		.run();
	return clean;
}

/**
 * Would one more automation email break the cap for this contact? Counts the timeline's
 * `sent` events (every automation) in the last 24 h / 7 days. Null = send; else when the
 * oldest counted send ages out of the window, and the reason for `last_error`.
 */
export async function frequencyHold(
	db: D1Database,
	contactId: number,
	cap: FrequencyCap,
	now: Date = new Date()
): Promise<{ until: string; reason: string } | null> {
	let until = 0;
	const reasons: string[] = [];
	const windows: [number | null, number, string][] = [
		[cap.per_day, 86400, '24 h'],
		[cap.per_week, 7 * 86400, '7 days']
	];
	for (const [limit, seconds, label] of windows) {
		if (!limit) continue;
		const since = sqliteUtc(new Date(now.getTime() - seconds * 1000));
		const rows = await db
			.prepare(`SELECT at FROM automation_enrollment_events WHERE contact_id = ? AND kind = 'sent' AND at > ? ORDER BY at DESC LIMIT ?`)
			.bind(contactId, since, limit)
			.all<{ at: string }>();
		if (rows.results.length < limit) continue;
		// The limit-th newest send has to age out before another one fits.
		const oldest = Date.parse(`${rows.results[limit - 1].at.replace(' ', 'T')}Z`);
		until = Math.max(until, oldest + seconds * 1000 + 1000);
		reasons.push(`${limit} per ${label}`);
	}
	if (!until) return null;
	const at = sqliteUtc(new Date(until));
	return { until: at, reason: `${FREQUENCY_CAP_PREFIX}: ${reasons.join(', ')} — waits until ${at.slice(0, 16)} UTC` };
}

// ── Status history + triggers while paused ────────────────────────────────────────────────

export type StatusChange = { id: number; from: string | null; to: string };

export async function logStatusChanges(db: D1Database, changes: StatusChange[], reason: string | null, userId: number | null): Promise<void> {
	if (!changes.length) return;
	const why = reason ? reason.trim().slice(0, 300) || null : null;
	const stmt = db.prepare('INSERT INTO automation_status_history (automation_id, from_status, to_status, reason, by_user_id) VALUES (?, ?, ?, ?, ?)');
	await db.batch(changes.map((c) => stmt.bind(c.id, c.from, c.to, why, userId)));
}

export type StatusHistoryRow = { id: number; from_status: string | null; to_status: string; reason: string | null; at: string; by_login: string | null };

export async function statusHistory(db: D1Database, automationId: number, limit = 50): Promise<StatusHistoryRow[]> {
	const rows = await db
		.prepare(
			`SELECT h.id, h.from_status, h.to_status, h.reason, h.at, u.github_login AS by_login
			 FROM automation_status_history h LEFT JOIN users u ON u.id = h.by_user_id
			 WHERE h.automation_id = ? ORDER BY h.id DESC LIMIT ?`
		)
		.bind(automationId, limit)
		.all<StatusHistoryRow>();
	return rows.results;
}

/** Record contacts that triggered a PAUSED automation (first trigger per contact kept). */
export async function recordPendingTriggers(db: D1Database, automationId: number, contactIds: number[], source: string): Promise<void> {
	const ids = [...new Set(contactIds.filter((n) => Number.isInteger(n) && n > 0))];
	for (let i = 0; i < ids.length; i += 500) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO automation_pending_triggers (automation_id, contact_id, source)
				 SELECT ?, c.id, ? FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?))`
			)
			.bind(automationId, source.slice(0, 60), JSON.stringify(ids.slice(i, i + 500)))
			.run();
	}
}

export async function pendingTriggerCount(db: D1Database, automationId: number): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) AS n FROM automation_pending_triggers WHERE automation_id = ?').bind(automationId).first<{ n: number }>();
	return row?.n ?? 0;
}

export async function pendingTriggerIds(db: D1Database, automationId: number): Promise<number[]> {
	const rows = await db
		.prepare('SELECT contact_id FROM automation_pending_triggers WHERE automation_id = ? ORDER BY id')
		.bind(automationId)
		.all<{ contact_id: number }>();
	return rows.results.map((r) => r.contact_id);
}

export async function clearPendingTriggers(db: D1Database, automationId: number): Promise<number> {
	const r = await db.prepare('DELETE FROM automation_pending_triggers WHERE automation_id = ?').bind(automationId).run();
	return r.meta.changes ?? 0;
}
