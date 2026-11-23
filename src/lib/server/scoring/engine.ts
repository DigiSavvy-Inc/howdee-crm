// Contact scoring engine (#466) — `runScoringJob` rides the heartbeat tick, after the
// engagement job. Every step is bounded per tick:
//   1. Ingest   ≤ INGEST_BATCH new rows per source table (watermarks in app_state
//               `scoring_watermarks`), matched against every active event rule of every
//               active score → ledger rows (INSERT OR IGNORE on score_points_once).
//   2. Expiry   ledger rows whose `expires_at` passed since the last sweep mark their
//               contact × score dirty (`scoring_expired_at`); rows are never deleted.
//   3. Conditions once per 24 h (`scoring_conditions_at`) and right after a condition rule
//               is saved: one CONDITION_CHUNK of contacts (by id) per tick, adding / removing
//               the rule's `condition` ledger row (state `scoring_condition_run`).
//   4. Cache    ≤ CACHE_BATCH dirty contact_scores rows recomputed; half-life scores are
//               all marked dirty once per 24 h (`scoring_decay_at`) so decay keeps moving.
//   5. Rebuild  (`rebuildScore`) drops a score's earned rows and rewinds the watermarks to
//               365 days of history; ingest replays it over the following ticks. The two
//               seeded scores get one on the first tick (`scoring_seeded_rebuild`).
//
// No imports from send / postmark / the automation engine (tests/mcp.test.ts and
// tests/ai-no-send.test.ts walk imports; #465 2/3 exposes reads through the assistant).
// #467: the cache step records value / band changes of scores a `score_changed` automation
// watches in `score_change_events`; the tick drains them (src/lib/server/score-trigger.ts).
// #552: changes the assistant caused are recorded `quiet` and never enroll anyone — directly
// (computePairs / markPairsDirty `{ quiet }`) or through points earned from source rows it
// wrote (`withQuietScoreSources` → score_quiet_sources).

import { compileRule, type SegmentRule } from '$lib/server/segment-query';
import { proxyOpenSql } from '$lib/server/engagement';
import { hardBounceSql } from '$lib/server/bounce-filter';
import { CLICK_LINK_SQL } from '$lib/server/event-detail';
import {
	SOURCE_TABLES,
	bandFor,
	eventTypeDef,
	parseBands,
	parseFilter,
	type DecayMode,
	type EventType,
	type RuleFilter,
	type SourceTable
} from '$lib/scoring';
import { normalizeRuleSet } from '$lib/condition-rules';
import { evaluateRuleSet } from '$lib/form-logic';
import type { AnswerValue } from '$lib/forms';

export const INGEST_BATCH = 500;
export const CACHE_BATCH = 300;
export const CONDITION_CHUNK = 1000;
export const EXPIRY_BATCH = 1000;
export const HISTORY_DAYS = 365;
const DAY_MS = 86_400_000;
const JSON_CHUNK = 500;

export const STATE_KEYS = {
	watermarks: 'scoring_watermarks',
	expiredAt: 'scoring_expired_at',
	expiredId: 'scoring_expired_id',
	conditionsAt: 'scoring_conditions_at',
	conditionRun: 'scoring_condition_run',
	decayAt: 'scoring_decay_at',
	seededRebuild: 'scoring_seeded_rebuild',
	lastRun: 'scoring_last_run'
} as const;

// ---------------------------------------------------------------------------
// app_state helpers
// ---------------------------------------------------------------------------

async function getState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string | null }>();
	return row?.value ?? null;
}

function setStateStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value);
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
	await setStateStmt(db, key, value).run();
}

async function getJson<T>(db: D1Database, key: string): Promise<T | null> {
	const raw = await getState(db, key);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → ISO; unparseable → `fallback`. */
export function toIso(s: string | null | undefined, fallback: Date): string {
	if (!s) return fallback.toISOString();
	const t = new Date(s.includes('T') ? s : s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')).getTime();
	return Number.isFinite(t) ? new Date(t).toISOString() : fallback.toISOString();
}

function chunks<T>(xs: T[], n = JSON_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
}

// ---------------------------------------------------------------------------
// Dirty marking
// ---------------------------------------------------------------------------

export type Pair = [contactId: number, scoreId: number];

function uniquePairs(pairs: Pair[]): Pair[] {
	const seen = new Set<string>();
	const out: Pair[] = [];
	for (const p of pairs) {
		const k = `${p[0]}:${p[1]}`;
		if (!seen.has(k)) {
			seen.add(k);
			out.push(p);
		}
	}
	return out;
}

/**
 * Upsert contact_scores rows as dirty for each contact × score. `quiet` (#552) = the change was
 * caused by the assistant: the next recompute records its change as quiet, so no
 * `score_changed` automation enrolls from it. The flag stays set until that recompute.
 */
export async function markPairsDirty(db: D1Database, pairs: Pair[], now: Date = new Date(), opts: { quiet?: boolean } = {}): Promise<void> {
	const uniq = uniquePairs(pairs);
	if (!uniq.length) return;
	await db.batch(
		chunks(uniq).map((c) =>
			db
				.prepare(
					`INSERT INTO contact_scores (contact_id, score_id, value, updated_at, dirty, trigger_quiet)
					 SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), 0, ?, 1, ? FROM json_each(?) j WHERE true
					 ON CONFLICT(contact_id, score_id) DO UPDATE SET dirty = 1, trigger_quiet = MAX(trigger_quiet, excluded.trigger_quiet)`
				)
				.bind(now.toISOString(), opts.quiet ? 1 : 0, JSON.stringify(c))
		)
	);
}

/** Every contact with a ledger row from this rule → dirty (rule edited, toggled or deleted). */
export async function markRuleContactsDirty(db: D1Database, ruleId: number, now: Date = new Date()): Promise<void> {
	await db
		.prepare(
			`INSERT INTO contact_scores (contact_id, score_id, value, updated_at, dirty)
			 SELECT DISTINCT contact_id, score_id, 0, ?, 1 FROM score_points WHERE rule_id = ?
			 ON CONFLICT(contact_id, score_id) DO UPDATE SET dirty = 1`
		)
		.bind(now.toISOString(), ruleId)
		.run();
}

export async function markScoreDirty(db: D1Database, scoreId: number): Promise<void> {
	await db.prepare('UPDATE contact_scores SET dirty = 1 WHERE score_id = ? AND dirty = 0').bind(scoreId).run();
}

// ---------------------------------------------------------------------------
// 1. Ingest
// ---------------------------------------------------------------------------

/** One source row, normalised. `types` = the event types it can satisfy. */
export type SourceRow = {
	id: number;
	contact_id: number | null;
	at: string;
	types: EventType[];
	campaign_id?: number | null;
	automation_id?: number | null;
	url?: string | null;
	hard?: boolean;
	name?: string | null;
	stage_id?: number | null;
	list_id?: number | null;
	key_id?: number | null;
	/** #621: a CRM form submission's form and answers. */
	form_id?: number | null;
	answers?: Record<string, AnswerValue>;
};

/** The timestamp column per source (rebuild's 365-day start). */
const TS_COL: Record<SourceTable, string> = {
	events: 'recorded_at',
	replies: 'received_at',
	webhook_events: 'created_at',
	form_submissions: 'created_at',
	site_events: 'occurred_at',
	pipeline_history: 'created_at',
	automation_enrollment_events: 'at',
	list_members: 'added_at'
};
const ID_COL: Record<SourceTable, string> = {
	events: 'id',
	replies: 'id',
	webhook_events: 'id',
	form_submissions: 'id',
	site_events: 'id',
	pipeline_history: 'id',
	automation_enrollment_events: 'id',
	list_members: 'rowid'
};

function num(v: unknown): number | null {
	return v === null || v === undefined ? null : Number(v);
}

/** Up to `limit` rows after `after` (id order), normalised. */
export async function readSource(db: D1Database, source: SourceTable, after: number, limit: number, now: Date): Promise<SourceRow[]> {
	switch (source) {
		case 'events': {
			const res = await db
				.prepare(
					`SELECT ev.id, ev.contact_id, ev.type, ev.recorded_at AS at, ev.campaign_id, cp.automation_id,
						CASE WHEN ev.type = 'open' THEN ${proxyOpenSql('ev')} ELSE 0 END AS proxy,
						CASE WHEN ev.type = 'click' THEN ${CLICK_LINK_SQL('ev')} END AS url,
						CASE WHEN ev.type = 'bounce' AND ${hardBounceSql('ev')} THEN 1 ELSE 0 END AS hard
					 FROM events ev LEFT JOIN campaigns cp ON cp.id = ev.campaign_id
					 WHERE ev.id > ? ORDER BY ev.id LIMIT ?`
				)
				.bind(after, limit)
				.all<{
					id: number;
					contact_id: number | null;
					type: string;
					at: string;
					campaign_id: number | null;
					automation_id: number | null;
					proxy: number;
					url: string | null;
					hard: number;
				}>();
			return res.results.map((r) => {
				const types: EventType[] =
					r.type === 'open'
						? [r.proxy ? 'email_open_proxy' : 'email_open']
						: r.type === 'click'
							? ['email_click']
							: r.type === 'bounce'
								? ['email_bounce']
								: r.type === 'spam'
									? ['email_spam']
									: r.type === 'unsubscribe'
										? ['unsubscribe']
										: [];
				return {
					id: r.id,
					contact_id: num(r.contact_id),
					at: toIso(r.at, now),
					types,
					campaign_id: num(r.campaign_id),
					automation_id: num(r.automation_id),
					url: r.url,
					hard: !!r.hard
				};
			});
		}
		case 'replies': {
			const res = await db
				.prepare('SELECT id, contact_id, received_at AS at FROM replies WHERE id > ? ORDER BY id LIMIT ?')
				.bind(after, limit)
				.all<{ id: number; contact_id: number | null; at: string }>();
			return res.results.map((r) => ({ id: r.id, contact_id: num(r.contact_id), at: toIso(r.at, now), types: ['email_reply'] }));
		}
		case 'webhook_events': {
			// Joined by email; archived contacts don't earn form points.
			const res = await db
				.prepare(
					`SELECT w.id, w.status, w.key_id, w.created_at AS at,
						(SELECT c.id FROM contacts c WHERE c.email = LOWER(TRIM(w.email)) AND c.archived_at IS NULL) AS contact_id
					 FROM webhook_events w WHERE w.id > ? ORDER BY w.id LIMIT ?`
				)
				.bind(after, limit)
				.all<{ id: number; status: string; key_id: number | null; at: string; contact_id: number | null }>();
			return res.results.map((r) => ({
				id: r.id,
				contact_id: num(r.contact_id),
				at: toIso(r.at, now),
				types: r.status === 'added' || r.status === 'updated' ? ['form_submit'] : [],
				key_id: num(r.key_id)
			}));
		}
		case 'form_submissions': {
			// #621: CRM forms. Only a submission that wrote a contact (added / updated) earns points;
			// anonymous, spam and rejected rows never do. Archived contacts don't earn form points.
			const res = await db
				.prepare(
					`SELECT s.id, s.form_id, s.status, s.answers, s.created_at AS at,
						(SELECT c.id FROM contacts c WHERE c.id = s.contact_id AND c.archived_at IS NULL) AS contact_id
					 FROM form_submissions s WHERE s.id > ? ORDER BY s.id LIMIT ?`
				)
				.bind(after, limit)
				.all<{ id: number; form_id: number; status: string; answers: string | null; at: string; contact_id: number | null }>();
			return res.results.map((r) => {
				let answers: Record<string, AnswerValue> = {};
				try {
					const v = r.answers ? JSON.parse(r.answers) : {};
					if (v && typeof v === 'object' && !Array.isArray(v)) answers = v;
				} catch {
					// unreadable answers — only rules without answer conditions match
				}
				const accepted = (r.status === 'added' || r.status === 'updated') && r.contact_id != null;
				return {
					id: r.id,
					contact_id: num(r.contact_id),
					at: toIso(r.at, now),
					types: accepted ? ['crm_form_submit'] : [],
					form_id: num(r.form_id),
					answers
				};
			});
		}
		case 'site_events': {
			const res = await db
				.prepare('SELECT id, contact_id, kind, name, path, occurred_at AS at FROM site_events WHERE id > ? ORDER BY id LIMIT ?')
				.bind(after, limit)
				.all<{ id: number; contact_id: number; kind: string; name: string; path: string | null; at: string }>();
			return res.results.map((r) => ({
				id: r.id,
				contact_id: num(r.contact_id),
				at: toIso(r.at, now),
				types: r.kind === 'pageview' ? ['site_pageview'] : r.kind === 'event' ? ['site_event'] : [],
				url: r.path,
				name: r.name
			}));
		}
		case 'pipeline_history': {
			const res = await db
				.prepare('SELECT id, contact_id, from_stage_id, to_stage_id, created_at AS at FROM pipeline_history WHERE id > ? ORDER BY id LIMIT ?')
				.bind(after, limit)
				.all<{ id: number; contact_id: number; from_stage_id: number | null; to_stage_id: number | null; at: string }>();
			return res.results.map((r) => ({
				id: r.id,
				contact_id: num(r.contact_id),
				at: toIso(r.at, now),
				// A stage change (or an add); not a removal, not a stage deletion's system row (from = to).
				types: r.to_stage_id != null && r.from_stage_id !== r.to_stage_id ? ['pipeline_stage_entered'] : [],
				stage_id: num(r.to_stage_id)
			}));
		}
		case 'automation_enrollment_events': {
			const res = await db
				.prepare('SELECT id, contact_id, automation_id, kind, at FROM automation_enrollment_events WHERE id > ? ORDER BY id LIMIT ?')
				.bind(after, limit)
				.all<{ id: number; contact_id: number; automation_id: number; kind: string; at: string }>();
			return res.results.map((r) => ({
				id: r.id,
				contact_id: num(r.contact_id),
				at: toIso(r.at, now),
				types: r.kind === 'completed' ? ['automation_completed'] : [],
				automation_id: num(r.automation_id)
			}));
		}
		case 'list_members': {
			const res = await db
				.prepare('SELECT rowid AS id, contact_id, list_id, added_at AS at FROM list_members WHERE rowid > ? ORDER BY rowid LIMIT ?')
				.bind(after, limit)
				.all<{ id: number; contact_id: number; list_id: number; at: string }>();
			return res.results.map((r) => ({
				id: r.id,
				contact_id: num(r.contact_id),
				at: toIso(r.at, now),
				types: ['list_added'],
				list_id: num(r.list_id)
			}));
		}
	}
}

/** Does a source row satisfy an event rule's type + filter? */
export function ruleMatches(eventType: EventType, filter: RuleFilter, row: SourceRow): boolean {
	if (!row.types.includes(eventType)) return false;
	if (eventType === 'email_bounce' && !filter.any && !row.hard) return false;
	if (filter.campaign_id != null && row.campaign_id !== filter.campaign_id) return false;
	if (filter.automation_id != null && row.automation_id !== filter.automation_id) return false;
	if (filter.url_contains && !(row.url ?? '').toLowerCase().includes(filter.url_contains.toLowerCase())) return false;
	if (filter.key_id != null && row.key_id !== filter.key_id) return false;
	if (filter.name && (row.name ?? '').toLowerCase() !== filter.name.toLowerCase()) return false;
	if (filter.stage_id != null && row.stage_id !== filter.stage_id) return false;
	// One pipeline today (pipeline_stages.pipeline_id is fixed at 1).
	if (filter.pipeline_id != null && filter.pipeline_id !== 1) return false;
	if (filter.list_id != null && row.list_id !== filter.list_id) return false;
	if (filter.form_id != null && row.form_id !== filter.form_id) return false;
	if (filter.answers && !evaluateRuleSet(filter.answers, row.answers ?? {})) return false;
	return true;
}

type ActiveEventRule = {
	id: number;
	score_id: number;
	event_type: EventType;
	filter: RuleFilter;
	points: number;
	expires_days: number | null;
	max_per_day: number | null;
	once: boolean;
	decay_mode: DecayMode;
	/** #621: when the rule was saved (NULL for rules from before 0125). */
	created_at: string | null;
};

async function activeEventRules(db: D1Database): Promise<ActiveEventRule[]> {
	const res = await db
		.prepare(
			`SELECT r.id, r.score_id, r.event_type, r.filter, r.points, r.expires_days, r.max_per_day, r.once, r.created_at, d.decay_mode
			 FROM score_rules r JOIN score_defs d ON d.id = r.score_id
			 WHERE d.status = 'active' AND r.active = 1 AND r.kind = 'event'
			 ORDER BY r.score_id, r.position, r.id`
		)
		.all<{
			id: number;
			score_id: number;
			event_type: string;
			filter: string | null;
			points: number;
			expires_days: number | null;
			max_per_day: number | null;
			once: number;
			decay_mode: DecayMode;
			created_at: string | null;
		}>();
	const out: ActiveEventRule[] = [];
	for (const r of res.results) {
		if (!eventTypeDef(r.event_type)) continue;
		out.push({
			id: r.id,
			score_id: r.score_id,
			event_type: r.event_type as EventType,
			filter: parseFilter(r.filter),
			points: r.points,
			expires_days: r.expires_days,
			max_per_day: r.max_per_day,
			once: !!r.once,
			decay_mode: r.decay_mode,
			created_at: r.created_at ?? null
		});
	}
	return out;
}

type LedgerRow = { s: number; r: number; c: number; p: number; t: string; i: string; e: string; x: string | null };

type Inserted = { contact_id: number; score_id: number; source_id: string };

/** Insert ledger rows (INSERT OR IGNORE), returning the rows actually inserted (pair + source id). */
async function insertLedger(db: D1Database, rows: LedgerRow[]): Promise<Inserted[]> {
	if (!rows.length) return [];
	const results = await db.batch<Inserted>(
		chunks(rows).map((c) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO score_points (score_id, rule_id, contact_id, points, source_type, source_id, earned_at, expires_at)
					 SELECT json_extract(j.value, '$.s'), json_extract(j.value, '$.r'), json_extract(j.value, '$.c'), json_extract(j.value, '$.p'),
						json_extract(j.value, '$.t'), json_extract(j.value, '$.i'), json_extract(j.value, '$.e'), json_extract(j.value, '$.x')
					 FROM json_each(?) j
					 RETURNING contact_id, score_id, source_id`
				)
				.bind(JSON.stringify(c))
		)
	);
	const out: Inserted[] = [];
	for (const r of results) out.push(...(r.results ?? []));
	return out;
}

/** #552: which of these source row ids the assistant wrote (score_quiet_sources). */
async function quietSourceIds(db: D1Database, source: SourceTable, ids: number[]): Promise<Set<string>> {
	const out = new Set<string>();
	for (const part of chunks(ids)) {
		const res = await db
			.prepare('SELECT source_id FROM score_quiet_sources WHERE source_type = ? AND source_id IN (SELECT value FROM json_each(?))')
			.bind(source, JSON.stringify(part))
			.all<{ source_id: number }>();
		for (const r of res.results) out.add(String(r.source_id));
	}
	return out;
}

/** Quiet-source marks live as long as a rebuild can replay their rows (365 days + a margin). */
export const QUIET_SOURCE_KEEP_DAYS = HISTORY_DAYS + 5;

/**
 * #552: run an assistant write (or its Undo) and remember the scoring source rows it added —
 * new `list_members` rows (tags, lists, segments, company groups) and `pipeline_history` rows —
 * so points the engine later awards for them are quiet (no `score_changed` enrollment). Rows
 * are found by id above the maxima read before the write, so another write landing in the same
 * moment may be marked too (it then fires no score trigger — the safe side). Never throws on
 * its own account.
 */
export async function withQuietScoreSources<T>(db: D1Database, run: () => Promise<T>, now: Date = new Date()): Promise<T> {
	let before: { lm: number; ph: number } | null = null;
	try {
		before = await db
			.prepare('SELECT (SELECT COALESCE(MAX(rowid), 0) FROM list_members) AS lm, (SELECT COALESCE(MAX(id), 0) FROM pipeline_history) AS ph')
			.first<{ lm: number; ph: number }>();
	} catch (e) {
		console.error('quiet score source read failed:', e);
	}
	try {
		return await run();
	} finally {
		if (before) {
			try {
				const at = now.toISOString();
				await db.batch([
					db
						.prepare(
							`INSERT OR IGNORE INTO score_quiet_sources (source_type, source_id, created_at) SELECT 'list_members', rowid, ? FROM list_members WHERE rowid > ?`
						)
						.bind(at, before.lm),
					db
						.prepare(
							`INSERT OR IGNORE INTO score_quiet_sources (source_type, source_id, created_at) SELECT 'pipeline_history', id, ? FROM pipeline_history WHERE id > ?`
						)
						.bind(at, before.ph)
				]);
			} catch (e) {
				console.error('quiet score source marking failed:', e);
			}
		}
	}
}

function expiresAt(rule: ActiveEventRule, earnedIso: string): string | null {
	if (rule.decay_mode !== 'expire' || !rule.expires_days) return null;
	return new Date(Date.parse(earnedIso) + rule.expires_days * DAY_MS).toISOString();
}

/** Turn one batch of source rows into ledger rows for one rule, honouring `once` / `max_per_day`. */
async function awardsFor(db: D1Database, source: SourceTable, rule: ActiveEventRule, rows: SourceRow[]): Promise<LedgerRow[]> {
	// #621: a CRM form rule never pays for submissions made before it was saved (a Rebuild or the
	// first 365-day read of form_submissions would otherwise back-date points).
	// Submission times are whole seconds, so the rule's time is compared to the second.
	const since =
		rule.event_type === 'crm_form_submit' && rule.created_at ? Math.floor(Date.parse(rule.created_at) / 1000) * 1000 : NaN;
	const candidates = rows.filter(
		(row) =>
			row.contact_id &&
			ruleMatches(rule.event_type, rule.filter, row) &&
			!(Number.isFinite(since) && Date.parse(row.at) < since)
	);
	if (!candidates.length) return [];
	const make = (row: SourceRow): LedgerRow => ({
		s: rule.score_id,
		r: rule.id,
		c: row.contact_id!,
		p: rule.points,
		t: source,
		i: String(row.id),
		e: row.at,
		x: expiresAt(rule, row.at)
	});
	if (!rule.once && !rule.max_per_day) return candidates.map(make);

	// What this rule already gave these contacts (for once: any row; for max: rows on these days).
	const contacts = [...new Set(candidates.map((c) => c.contact_id!))];
	const days = [...new Set(candidates.map((c) => c.at.slice(0, 10)))];
	const existing: { contact_id: number; source_type: string; source_id: string; day: string }[] = [];
	for (const part of chunks(contacts)) {
		const res = await db
			.prepare(
				`SELECT contact_id, source_type, source_id, substr(earned_at, 1, 10) AS day FROM score_points
				 WHERE score_id = ? AND rule_id = ? AND contact_id IN (SELECT value FROM json_each(?))
				 ${rule.once ? '' : 'AND substr(earned_at, 1, 10) IN (SELECT value FROM json_each(?))'}`
			)
			.bind(...(rule.once ? [rule.score_id, rule.id, JSON.stringify(part)] : [rule.score_id, rule.id, JSON.stringify(part), JSON.stringify(days)]))
			.all<{ contact_id: number; source_type: string; source_id: string; day: string }>();
		existing.push(...res.results);
	}
	const have = new Set(existing.map((e) => `${e.source_type}:${e.source_id}:${e.contact_id}`));
	const hasAny = new Set(existing.map((e) => e.contact_id));
	const perDay = new Map<string, number>();
	for (const e of existing) perDay.set(`${e.contact_id}:${e.day}`, (perDay.get(`${e.contact_id}:${e.day}`) ?? 0) + 1);

	const out: LedgerRow[] = [];
	for (const row of candidates) {
		const cid = row.contact_id!;
		if (have.has(`${source}:${row.id}:${cid}`)) continue; // already in the ledger (a replay)
		if (rule.once) {
			if (hasAny.has(cid)) continue;
			hasAny.add(cid);
			out.push(make(row));
			continue;
		}
		const k = `${cid}:${row.at.slice(0, 10)}`;
		const n = perDay.get(k) ?? 0;
		if (n >= rule.max_per_day!) continue;
		perDay.set(k, n + 1);
		out.push(make(row));
	}
	return out;
}

export type Watermarks = Partial<Record<SourceTable, number>>;

export async function getWatermarks(db: D1Database): Promise<Watermarks> {
	return (await getJson<Watermarks>(db, STATE_KEYS.watermarks)) ?? {};
}

export async function setWatermarks(db: D1Database, wm: Watermarks): Promise<void> {
	await setState(db, STATE_KEYS.watermarks, JSON.stringify(wm));
}

/** The watermark that replays `days` of history: one below the lowest row id dated within it
 *  (none in the window → the newest id, so nothing old is read). */
export async function historyWatermark(db: D1Database, source: SourceTable, now: Date, days = HISTORY_DAYS): Promise<number> {
	const since = new Date(now.getTime() - days * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
	const id = ID_COL[source];
	const row = await db
		.prepare(`SELECT MIN(${id}) AS lo, (SELECT MAX(${id}) FROM ${source}) AS hi FROM ${source} WHERE ${TS_COL[source]} >= ?`)
		.bind(since)
		.first<{ lo: number | null; hi: number | null }>();
	if (row?.lo != null) return row.lo - 1;
	return row?.hi ?? 0;
}

/** Ingest one batch of one source. Returns rows read, ledger rows inserted, and the touched pairs. */
export async function ingestSource(
	db: D1Database,
	source: SourceTable,
	wm: Watermarks,
	rules: ActiveEventRule[],
	now: Date
): Promise<{ read: number; awarded: number; pairs: Pair[]; quietPairs: Pair[] }> {
	const after = wm[source] ?? (await historyWatermark(db, source, now));
	const rows = await readSource(db, source, after, INGEST_BATCH, now);
	if (!rows.length) {
		wm[source] = after;
		return { read: 0, awarded: 0, pairs: [], quietPairs: [] };
	}
	const ledger: LedgerRow[] = [];
	for (const rule of rules) {
		if (eventTypeDef(rule.event_type)?.source !== source) continue;
		ledger.push(...(await awardsFor(db, source, rule, rows)));
	}
	const inserted = await insertLedger(db, ledger);
	// #552: points earned from a row the assistant wrote → the pair is recomputed quietly.
	const quiet = inserted.length ? await quietSourceIds(db, source, [...new Set(inserted.map((r) => Number(r.source_id)))]) : new Set<string>();
	const pairs: Pair[] = [];
	const quietPairs: Pair[] = [];
	for (const r of inserted) (quiet.has(String(r.source_id)) ? quietPairs : pairs).push([r.contact_id, r.score_id]);
	wm[source] = rows[rows.length - 1].id;
	return { read: rows.length, awarded: inserted.length, pairs, quietPairs };
}

// ---------------------------------------------------------------------------
// 2. Expiry
// ---------------------------------------------------------------------------

async function sweepExpired(db: D1Database, now: Date): Promise<number> {
	const lastAt = (await getState(db, STATE_KEYS.expiredAt)) ?? '1970-01-01T00:00:00.000Z';
	const lastId = Number(await getState(db, STATE_KEYS.expiredId)) || 0;
	const nowIso = now.toISOString();
	const res = await db
		.prepare(
			`SELECT id, contact_id, score_id, expires_at FROM score_points
			 WHERE expires_at IS NOT NULL AND (expires_at > ? OR (expires_at = ? AND id > ?)) AND expires_at <= ?
			 ORDER BY expires_at, id LIMIT ?`
		)
		.bind(lastAt, lastAt, lastId, nowIso, EXPIRY_BATCH)
		.all<{ id: number; contact_id: number; score_id: number; expires_at: string }>();
	const rows = res.results;
	await markPairsDirty(
		db,
		rows.map((r) => [r.contact_id, r.score_id] as Pair),
		now
	);
	const full = rows.length === EXPIRY_BATCH;
	const last = rows[rows.length - 1];
	await db.batch([
		setStateStmt(db, STATE_KEYS.expiredAt, full ? last.expires_at : nowIso),
		setStateStmt(db, STATE_KEYS.expiredId, full ? String(last.id) : '0')
	]);
	return rows.length;
}

// ---------------------------------------------------------------------------
// 3. Conditions
// ---------------------------------------------------------------------------

export type ConditionRun = { rule_ids: number[]; after: number; pending: number[] };

/** Queue a condition rule for evaluation over every contact (after a save). */
export async function queueConditionRules(db: D1Database, ruleIds: number[]): Promise<void> {
	if (!ruleIds.length) return;
	const run = await getJson<ConditionRun>(db, STATE_KEYS.conditionRun);
	const next: ConditionRun = run
		? { ...run, pending: [...new Set([...(run.pending ?? []), ...ruleIds])] }
		: { rule_ids: [...new Set(ruleIds)], after: 0, pending: [] };
	await setState(db, STATE_KEYS.conditionRun, JSON.stringify(next));
}

/** A condition rule set → `SELECT c.id … WHERE …` for contacts in (lo, hi], or null when a rule
 *  can't compile (an incomplete / unknown rule matches nobody — never everybody). */
export function conditionSql(rulesJson: string | null): { sql: string; binds: unknown[] } | null {
	let raw: unknown = null;
	try {
		raw = rulesJson ? JSON.parse(rulesJson) : null;
	} catch {
		return null;
	}
	const set = normalizeRuleSet(raw);
	if (!set) return null;
	const parts: string[] = [];
	const binds: unknown[] = [];
	for (const r of set.rules) {
		const c = compileRule(r as SegmentRule);
		if (!c) return null;
		parts.push(`(${c.clause})`);
		binds.push(...c.binds);
	}
	const where = parts.join(set.match === 'any' ? ' OR ' : ' AND ');
	return { sql: `SELECT c.id FROM contacts c WHERE c.archived_at IS NULL AND (${where}) AND c.id > ? AND c.id <= ?`, binds };
}

export type ConditionStep = { rules: number; contacts: number; added: number; removed: number; done: boolean };

/** One chunk of a condition run. Starts the daily run when none is going. */
export async function processConditions(db: D1Database, now: Date): Promise<ConditionStep | null> {
	let run = await getJson<ConditionRun>(db, STATE_KEYS.conditionRun);
	if (!run) {
		const last = Date.parse((await getState(db, STATE_KEYS.conditionsAt)) ?? '');
		if (Number.isFinite(last) && now.getTime() - last < DAY_MS) return null;
		const ids = await db
			.prepare(
				`SELECT r.id FROM score_rules r JOIN score_defs d ON d.id = r.score_id
				 WHERE r.kind = 'condition' AND r.active = 1 AND d.status = 'active' ORDER BY r.id`
			)
			.all<{ id: number }>();
		await setState(db, STATE_KEYS.conditionsAt, now.toISOString());
		if (!ids.results.length) return null;
		run = { rule_ids: ids.results.map((r) => r.id), after: 0, pending: [] };
	}

	const page = await db
		.prepare('SELECT id FROM contacts WHERE id > ? AND archived_at IS NULL ORDER BY id LIMIT ?')
		.bind(run.after, CONDITION_CHUNK)
		.all<{ id: number }>();
	const lo = run.after;
	const last = page.results.length === CONDITION_CHUNK;
	const hi = last ? page.results[page.results.length - 1].id : Number.MAX_SAFE_INTEGER;

	const rules = run.rule_ids.length
		? (
				await db
					.prepare(
						`SELECT r.id, r.score_id, r.points, r.rules FROM score_rules r JOIN score_defs d ON d.id = r.score_id
						 WHERE r.id IN (SELECT value FROM json_each(?)) AND r.kind = 'condition' AND r.active = 1 AND d.status = 'active'`
					)
					.bind(JSON.stringify(run.rule_ids))
					.all<{ id: number; score_id: number; points: number; rules: string | null }>()
			).results
		: [];

	let added = 0;
	let removed = 0;
	const touched: Pair[] = [];
	const nowIso = now.toISOString();
	for (const rule of rules) {
		const q = conditionSql(rule.rules);
		const match = q ? (await db.prepare(q.sql).bind(...q.binds, lo, hi).all<{ id: number }>()).results.map((r) => r.id) : [];
		const have = (
			await db
				.prepare(
					`SELECT contact_id FROM score_points WHERE score_id = ? AND rule_id = ? AND source_type = 'condition' AND contact_id > ? AND contact_id <= ?`
				)
				.bind(rule.score_id, rule.id, lo, hi)
				.all<{ contact_id: number }>()
		).results.map((r) => r.contact_id);
		const haveSet = new Set(have);
		const matchSet = new Set(match);
		const add = match.filter((id) => !haveSet.has(id));
		const remove = have.filter((id) => !matchSet.has(id));
		if (add.length) {
			await insertLedger(
				db,
				add.map((c) => ({ s: rule.score_id, r: rule.id, c, p: rule.points, t: 'condition', i: String(rule.id), e: nowIso, x: null }))
			);
		}
		for (const part of chunks(remove)) {
			await db
				.prepare(
					`DELETE FROM score_points WHERE score_id = ? AND rule_id = ? AND source_type = 'condition' AND contact_id IN (SELECT value FROM json_each(?))`
				)
				.bind(rule.score_id, rule.id, JSON.stringify(part))
				.run();
		}
		added += add.length;
		removed += remove.length;
		for (const c of [...add, ...remove]) touched.push([c, rule.score_id]);
	}
	await markPairsDirty(db, touched, now);

	let next: ConditionRun | null;
	if (last) next = { ...run, after: hi };
	else next = run.pending?.length ? { rule_ids: run.pending, after: 0, pending: [] } : null;
	if (next) await setState(db, STATE_KEYS.conditionRun, JSON.stringify(next));
	else await db.prepare('DELETE FROM app_state WHERE key = ?').bind(STATE_KEYS.conditionRun).run();
	return { rules: rules.length, contacts: page.results.length, added, removed, done: !next };
}

// ---------------------------------------------------------------------------
// 4. Cache
// ---------------------------------------------------------------------------

type ScoreMeta = { decay_mode: DecayMode; half_life_days: number | null; bands: string | null };

/**
 * Recompute the given contact × score values now (also used inline by the manual adjust).
 * `quiet` (#552): the assistant's recompute — its changes never fire `score_changed` (a pair
 * flagged by markPairsDirty({ quiet }) is quiet either way; the flag is cleared here).
 */
export async function computePairs(db: D1Database, pairs: Pair[], now: Date = new Date(), opts: { quiet?: boolean } = {}): Promise<number> {
	const uniq = uniquePairs(pairs);
	if (!uniq.length) return 0;
	const nowIso = now.toISOString();

	// Contacts that no longer exist lose their score rows (contact_id has no FK). An existence
	// check — archived contacts keep their scores.
	const contactIds = [...new Set(uniq.map((p) => p[0]))];
	const existing = new Set<number>();
	for (const part of chunks(contactIds)) {
		const res = await db
			.prepare('SELECT c.id FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(part))
			.all<{ id: number }>();
		for (const r of res.results) existing.add(r.id);
	}
	const gone = contactIds.filter((id) => !existing.has(id));
	for (const part of chunks(gone)) {
		await db.batch([
			db.prepare('DELETE FROM score_points WHERE contact_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(part)),
			db.prepare('DELETE FROM contact_scores WHERE contact_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(part))
		]);
	}
	const live = uniq.filter((p) => existing.has(p[0]));
	if (!live.length) return 0;

	const scoreIds = [...new Set(live.map((p) => p[1]))];
	const metaRes = await db
		.prepare('SELECT id, decay_mode, half_life_days, bands FROM score_defs WHERE id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(scoreIds))
		.all<ScoreMeta & { id: number }>();
	const meta = new Map(metaRes.results.map((m) => [m.id, m]));
	const values = new Map<string, number>();

	const halfPairs = live.filter((p) => meta.get(p[1])?.decay_mode === 'half_life');
	const sumPairs = live.filter((p) => meta.get(p[1]) && meta.get(p[1])!.decay_mode !== 'half_life');
	const where = `FROM score_points p
		JOIN json_each(?) j ON p.contact_id = json_extract(j.value, '$[0]') AND p.score_id = json_extract(j.value, '$[1]')
		LEFT JOIN score_rules r ON r.id = p.rule_id
		WHERE (p.expires_at IS NULL OR p.expires_at > ?) AND (p.rule_id IS NULL OR r.active = 1)`;
	for (const part of chunks(sumPairs)) {
		const res = await db
			.prepare(`SELECT p.contact_id AS c, p.score_id AS s, SUM(p.points) AS v ${where} GROUP BY p.contact_id, p.score_id`)
			.bind(JSON.stringify(part), nowIso)
			.all<{ c: number; s: number; v: number }>();
		for (const r of res.results) values.set(`${r.c}:${r.s}`, r.v);
	}
	for (const part of chunks(halfPairs)) {
		const res = await db
			.prepare(
				`SELECT p.contact_id AS c, p.score_id AS s, p.earned_at AS t, SUM(p.points) AS v ${where} GROUP BY p.contact_id, p.score_id, p.earned_at`
			)
			.bind(JSON.stringify(part), nowIso)
			.all<{ c: number; s: number; t: string; v: number }>();
		const acc = new Map<string, number>();
		for (const r of res.results) {
			const hl = meta.get(r.s)?.half_life_days || 1;
			const ageDays = Math.max(0, (now.getTime() - Date.parse(r.t)) / DAY_MS);
			const k = `${r.c}:${r.s}`;
			acc.set(k, (acc.get(k) ?? 0) + r.v * Math.pow(0.5, ageDays / hl));
		}
		for (const [k, v] of acc) values.set(k, v);
	}

	const updates = live.map((p) => {
		const v = Math.round(values.get(`${p[0]}:${p[1]}`) ?? 0);
		return { c: p[0], s: p[1], v, b: bandFor(v, parseBands(meta.get(p[1])?.bands)) };
	});
	await recordScoreChanges(db, updates, nowIso, !!opts.quiet);
	await db.batch(
		chunks(updates).map((part) =>
			db
				.prepare(
					`UPDATE contact_scores AS cs SET
						prev_value = CASE WHEN cs.value != u.v THEN cs.value ELSE cs.prev_value END,
						changed_at = CASE WHEN cs.value != u.v THEN ? ELSE cs.changed_at END,
						value = u.v, band = u.b, updated_at = ?, dirty = 0, trigger_quiet = 0
					 FROM (SELECT json_extract(value, '$.c') AS c, json_extract(value, '$.s') AS s, json_extract(value, '$.v') AS v,
							json_extract(value, '$.b') AS b FROM json_each(?)) AS u
					 WHERE cs.contact_id = u.c AND cs.score_id = u.s`
				)
				.bind(nowIso, nowIso, JSON.stringify(part))
		)
	);
	return updates.length;
}

/** Score ids an active or paused `score_changed` automation watches (#467). */
async function watchedScoreIds(db: D1Database): Promise<Set<number>> {
	const res = await db
		.prepare(
			`SELECT DISTINCT CAST(json_extract(trigger_config, '$.score_id') AS INTEGER) AS id FROM automations
			 WHERE trigger_type = 'score_changed' AND status IN ('active', 'paused') AND json_valid(trigger_config)`
		)
		.all<{ id: number | null }>();
	return new Set(res.results.map((r) => r.id).filter((n): n is number => !!n));
}

/**
 * #467: before the cache rows are overwritten, append a `score_change_events` row for each
 * contact × score whose value or band is about to change — only for scores a `score_changed`
 * automation watches. The heartbeat drains them into enroll() right after this job
 * (src/lib/server/score-trigger.ts); the engine never imports the automation engine.
 * Best-effort: a failure here never stops the recompute.
 * #552: a change is `quiet` when this recompute is the assistant's or the pair was flagged
 * (`trigger_quiet`); the drain skips quiet rows, so the assistant never enrolls anyone.
 */
async function recordScoreChanges(
	db: D1Database,
	updates: { c: number; s: number; v: number; b: string | null }[],
	nowIso: string,
	quiet: boolean
): Promise<void> {
	try {
		const watched = await watchedScoreIds(db);
		if (!watched.size) return;
		const mine = updates.filter((u) => watched.has(u.s));
		if (!mine.length) return;
		const before = new Map<string, { value: number; band: string | null; q: number }>();
		for (const part of chunks(mine.map((u) => [u.c, u.s]))) {
			const res = await db
				.prepare(
					`SELECT cs.contact_id AS c, cs.score_id AS s, cs.value, cs.band, cs.trigger_quiet AS q FROM contact_scores cs
					 JOIN json_each(?) j ON cs.contact_id = json_extract(j.value, '$[0]') AND cs.score_id = json_extract(j.value, '$[1]')`
				)
				.bind(JSON.stringify(part))
				.all<{ c: number; s: number; value: number; band: string | null; q: number }>();
			for (const r of res.results) before.set(`${r.c}:${r.s}`, { value: r.value, band: r.band, q: r.q });
		}
		const changes = mine
			.map((u) => ({ u, old: before.get(`${u.c}:${u.s}`) ?? { value: 0, band: null, q: 0 } }))
			.filter(({ u, old }) => old.value !== u.v || (old.band ?? '') !== (u.b ?? ''))
			.map(({ u, old }) => ({ c: u.c, s: u.s, ov: old.value, nv: u.v, ob: old.band, nb: u.b, q: quiet || old.q ? 1 : 0 }));
		if (!changes.length) return;
		await db.batch(
			chunks(changes).map((part) =>
				db
					.prepare(
						`INSERT INTO score_change_events (contact_id, score_id, old_value, new_value, old_band, new_band, created_at, quiet)
						 SELECT json_extract(j.value, '$.c'), json_extract(j.value, '$.s'), json_extract(j.value, '$.ov'), json_extract(j.value, '$.nv'),
							json_extract(j.value, '$.ob'), json_extract(j.value, '$.nb'), ?, json_extract(j.value, '$.q') FROM json_each(?) j`
					)
					.bind(nowIso, JSON.stringify(part))
			)
		);
	} catch (e) {
		console.error('score change recording failed:', e);
	}
}

async function drainCache(db: D1Database, now: Date): Promise<{ computed: number; remaining: number }> {
	const res = await db
		.prepare('SELECT contact_id, score_id FROM contact_scores WHERE dirty = 1 LIMIT ?')
		.bind(CACHE_BATCH)
		.all<{ contact_id: number; score_id: number }>();
	const pairs = res.results.map((r) => [r.contact_id, r.score_id] as Pair);
	const computed = await computePairs(db, pairs, now);
	const left = await db.prepare('SELECT COUNT(*) AS n FROM contact_scores WHERE dirty = 1').first<{ n: number }>();
	return { computed, remaining: left?.n ?? 0 };
}

async function decayTick(db: D1Database, now: Date): Promise<boolean> {
	const last = Date.parse((await getState(db, STATE_KEYS.decayAt)) ?? '');
	if (Number.isFinite(last) && now.getTime() - last < DAY_MS) return false;
	await db.batch([
		db.prepare(
			`UPDATE contact_scores SET dirty = 1 WHERE dirty = 0
			 AND score_id IN (SELECT id FROM score_defs WHERE status = 'active' AND decay_mode = 'half_life')`
		),
		setStateStmt(db, STATE_KEYS.decayAt, now.toISOString())
	]);
	return true;
}

// ---------------------------------------------------------------------------
// 5. Rebuild
// ---------------------------------------------------------------------------

/**
 * Drop a score's earned ledger rows (manual / automation rows stay), mark its contacts dirty,
 * rewind every source's watermark to 365 days of history (never forward — another rebuild in
 * progress keeps its place) and queue its condition rules. Ingest replays across ticks;
 * replaying is idempotent for the other scores (the unique ledger index).
 */
export async function rebuildScore(db: D1Database, scoreId: number, now: Date = new Date()): Promise<void> {
	await db.batch([
		db.prepare(`DELETE FROM score_points WHERE score_id = ? AND source_type NOT IN ('manual', 'automation')`).bind(scoreId),
		db.prepare('UPDATE contact_scores SET dirty = 1 WHERE score_id = ?').bind(scoreId)
	]);
	const wm = await getWatermarks(db);
	for (const source of SOURCE_TABLES) {
		const start = await historyWatermark(db, source, now);
		wm[source] = wm[source] == null ? start : Math.min(wm[source]!, start);
	}
	await setWatermarks(db, wm);
	const conds = await db
		.prepare(`SELECT id FROM score_rules WHERE score_id = ? AND kind = 'condition' AND active = 1`)
		.bind(scoreId)
		.all<{ id: number }>();
	await queueConditionRules(
		db,
		conds.results.map((r) => r.id)
	);
}

/** Rows left to read per source (the score page's rebuild progress). */
export async function ingestBacklog(db: D1Database): Promise<Record<SourceTable, number>> {
	const wm = await getWatermarks(db);
	const out = {} as Record<SourceTable, number>;
	const rows = await db.batch<{ n: number }>(
		SOURCE_TABLES.map((s) => db.prepare(`SELECT COUNT(*) AS n FROM ${s} WHERE ${ID_COL[s]} > ?`).bind(wm[s] ?? 0))
	);
	SOURCE_TABLES.forEach((s, i) => (out[s] = wm[s] == null ? 0 : (rows[i].results?.[0]?.n ?? 0)));
	return out;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export type ScoringJobResult = {
	ingested: Partial<Record<SourceTable, number>>;
	awarded: number;
	expired: number;
	conditions: ConditionStep | null;
	decay: boolean;
	computed: number;
	remaining: number;
	seededRebuild: boolean;
};

export async function runScoringJob(db: D1Database, now: Date = new Date()): Promise<ScoringJobResult> {
	// First tick after the migration: replay a year of history into the seeded defaults.
	let seededRebuild = false;
	if (!(await getState(db, STATE_KEYS.seededRebuild))) {
		const defaults = await db.prepare('SELECT id FROM score_defs WHERE is_default = 1').all<{ id: number }>();
		for (const d of defaults.results) await rebuildScore(db, d.id, now);
		await setState(db, STATE_KEYS.seededRebuild, now.toISOString());
		seededRebuild = true;
	}

	const rules = await activeEventRules(db);
	const wm = await getWatermarks(db);
	const ingested: Partial<Record<SourceTable, number>> = {};
	let awarded = 0;
	const touched: Pair[] = [];
	const quietTouched: Pair[] = [];
	for (const source of SOURCE_TABLES) {
		const r = await ingestSource(db, source, wm, rules, now);
		if (r.read) ingested[source] = r.read;
		awarded += r.awarded;
		touched.push(...r.pairs);
		quietTouched.push(...r.quietPairs);
	}
	await setWatermarks(db, wm);
	await markPairsDirty(db, touched, now);
	await markPairsDirty(db, quietTouched, now, { quiet: true });
	await db
		.prepare('DELETE FROM score_quiet_sources WHERE created_at < ?')
		.bind(new Date(now.getTime() - QUIET_SOURCE_KEEP_DAYS * DAY_MS).toISOString())
		.run();

	const expired = await sweepExpired(db, now);
	const conditions = await processConditions(db, now);
	const decay = await decayTick(db, now);
	const { computed, remaining } = await drainCache(db, now);

	await setState(db, STATE_KEYS.lastRun, JSON.stringify({ at: now.toISOString(), awarded, computed, remaining }));
	return { ingested, awarded, expired, conditions, decay, computed, remaining, seededRebuild };
}

/** The last run (Settings → Scoring). */
export async function lastScoringRun(db: D1Database): Promise<{ at: string; awarded: number; computed: number; remaining: number } | null> {
	return getJson(db, STATE_KEYS.lastRun);
}
