// Suggestions engine (#712) — the heartbeat's rules pass. Runs the rules, inserts new
// suggestions, refreshes open ones whose evidence changed, closes ones whose condition is gone
// and reopens snoozed ones that are due. No model call, nothing sent, scheduled, activated or
// enrolled (tests/suggestions-712.test.ts walks the imports).
//
//   - Off (the default) = no work at all.
//   - At most one full pass an hour (`suggestions_rules_at`; a settings save deletes it).
//   - ≤ SUGGESTIONS_TICK_CAP writes per tick; a pass that runs out stores the rule it was on
//     (`suggestions_pass`) and the next tick re-runs that rule — rows already written are no-ops.
//   - ≤ `daily_cap` new rows per UTC day (`suggestions_daily`).
//   - Done / Dismiss (closed by a person or an API key) keep that subject + rule quiet for
//     `cooldown_days`, unless the evidence hash changes. A row closed by the rules doesn't.
//   - Closed rows are pruned after 180 days, never before the start of the current UTC month.

import { RULE_KEYS, RULE_KIND, type RuleKey, type SuggestionsConfig } from '$lib/suggestions';
import { listedThreads, type Conversation } from '../conversations';
import { DAILY_KEY, PASS_KEY, RULES_AT_KEY, deleteState, getState, getSuggestionsConfig, setState } from './config';
import { evidenceHash, runRule, sqlStamp, type Candidate, type RuleContext } from './rules';

export const SUGGESTIONS_TICK_CAP = 200;
export const RULES_PASS_INTERVAL_MS = 3_600_000;
export const PRUNE_AFTER_DAYS = 180;
const PRUNE_BATCH = 500;

export type SuggestionsTick = {
	off?: true;
	skipped?: 'not_due';
	created: number;
	updated: number;
	closed: number;
	reopened: number;
	cooldown: number;
	capped: number;
	pruned: number;
	rules: RuleKey[];
	pass_complete: boolean;
};

type LiveRow = {
	id: number;
	subject_type: string;
	subject_id: number;
	status: 'open' | 'snoozed';
	snooze_until: string | null;
	input_hash: string;
	assigned_user_id: number | null;
};

const keyOf = (t: string, id: number) => `${t}:${id}`;
const toMs = (at: string | null) => (at ? Date.parse(at.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z')) : NaN);

function emptyResult(): SuggestionsTick {
	return { created: 0, updated: 0, closed: 0, reopened: 0, cooldown: 0, capped: 0, pruned: 0, rules: [], pass_complete: false };
}

/** Delete closed rows older than 180 days — never ones closed this UTC month (spend sums). */
export async function pruneSuggestions(db: D1Database, now: Date): Promise<number> {
	const monthStart = `${now.toISOString().slice(0, 7)}-01 00:00:00`;
	const aged = sqlStamp(now, PRUNE_AFTER_DAYS * 86_400_000);
	const cutoff = aged < monthStart ? aged : monthStart;
	const res = await db
		.prepare(
			`DELETE FROM suggestions WHERE id IN (
			   SELECT id FROM suggestions WHERE status IN ('done', 'dismissed') AND closed_at IS NOT NULL
			      AND datetime(closed_at) < datetime(?) LIMIT ${PRUNE_BATCH})`
		)
		.bind(cutoff)
		.run();
	return res.meta?.changes ?? 0;
}

type Daily = { day: string; created: number };

async function readDaily(db: D1Database, now: Date): Promise<Daily> {
	const day = now.toISOString().slice(0, 10);
	try {
		const v = JSON.parse((await getState(db, DAILY_KEY)) ?? 'null');
		if (v && v.day === day && Number.isFinite(v.created)) return { day, created: v.created };
	} catch {
		/* unreadable → a fresh day */
	}
	return { day, created: 0 };
}

/**
 * Apply one rule's candidates. Returns false when the write budget ran out before the rule
 * (including its closes) was finished — the caller resumes this rule on the next tick.
 */
async function applyRule(
	db: D1Database,
	cfg: SuggestionsConfig,
	rule: RuleKey,
	candidates: Candidate[],
	now: Date,
	budget: { left: number },
	daily: Daily,
	res: SuggestionsTick
): Promise<boolean> {
	const nowSql = sqlStamp(now);
	const live = new Map<string, LiveRow>();
	for (const r of (
		await db
			.prepare(
				`SELECT id, subject_type, subject_id, status, snooze_until, input_hash, assigned_user_id
				   FROM suggestions WHERE rule = ? AND status IN ('open', 'snoozed')`
			)
			.bind(rule)
			.all<LiveRow>()
	).results)
		live.set(keyOf(r.subject_type, r.subject_id), r);

	// Latest person / API close per subject within the cooldown (its hash decides "new evidence").
	const recentClosed = new Map<string, string>();
	for (const r of (
		await db
			.prepare(
				`SELECT subject_type, subject_id, input_hash FROM suggestions
				  WHERE rule = ? AND status IN ('done', 'dismissed') AND closed_by IN ('user', 'api')
				    AND datetime(closed_at) >= datetime(?)
				  ORDER BY datetime(closed_at) DESC, id DESC`
			)
			.bind(rule, sqlStamp(now, cfg.cooldown_days * 86_400_000))
			.all<{ subject_type: string; subject_id: number; input_hash: string }>()
	).results) {
		const k = keyOf(r.subject_type, r.subject_id);
		if (!recentClosed.has(k)) recentClosed.set(k, r.input_hash);
	}

	// Oldest wait first, so the daily cap keeps the longest-waiting ones.
	const sorted = [...candidates].sort((a, b) => (toMs(a.since_at) || 0) - (toMs(b.since_at) || 0) || a.subject_id - b.subject_id);
	const seen = new Set<string>();
	const content = (c: Candidate) => [
		c.subject_label,
		JSON.stringify(c.evidence),
		c.title,
		c.why,
		JSON.stringify(c.action),
		c.assigned_user_id,
		c.since_at
	];

	for (const c of sorted) {
		const k = keyOf(c.subject_type, c.subject_id);
		if (seen.has(k)) continue;
		seen.add(k);
		const hash = await evidenceHash(c.evidence);
		const row = live.get(k);
		if (row) {
			const changed = row.input_hash !== hash || (row.assigned_user_id ?? null) !== c.assigned_user_id;
			const due = row.status === 'snoozed' && row.snooze_until != null && toMs(row.snooze_until) <= now.getTime();
			if (!changed && !due) continue;
			if (budget.left <= 0) return false;
			budget.left--;
			// New evidence resets the wording to the rule's (the AI layer rewrites it, #713).
			await db
				.prepare(
					`UPDATE suggestions SET subject_label = ?, evidence = ?, title = ?, why = ?, action = ?, assigned_user_id = ?,
					        since_at = ?, input_hash = ?,
					        draft_opening = CASE WHEN input_hash = ? THEN draft_opening ELSE NULL END,
					        model = CASE WHEN input_hash = ? THEN model ELSE NULL END,
					        status = CASE WHEN ? THEN 'open' ELSE status END,
					        snooze_until = CASE WHEN ? THEN NULL ELSE snooze_until END,
					        updated_at = ?
					  WHERE id = ?`
				)
				.bind(...content(c), hash, hash, hash, due ? 1 : 0, due ? 1 : 0, nowSql, row.id)
				.run();
			if (due) res.reopened++;
			else res.updated++;
			continue;
		}
		if (recentClosed.get(k) === hash) {
			res.cooldown++;
			continue;
		}
		if (daily.created >= cfg.daily_cap) {
			res.capped++;
			continue;
		}
		if (budget.left <= 0) return false;
		budget.left--;
		const ins = await db
			.prepare(
				`INSERT OR IGNORE INTO suggestions
				   (kind, subject_type, subject_id, rule, subject_label, evidence, title, why, action, assigned_user_id, since_at,
				    input_hash, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
			)
			.bind(c.kind, c.subject_type, c.subject_id, rule, ...content(c), hash, nowSql, nowSql)
			.run();
		if ((ins.meta?.changes ?? 0) > 0) {
			res.created++;
			daily.created++;
		}
	}

	// The condition is gone for every live row the rule didn't return.
	for (const [k, row] of live) {
		if (seen.has(k)) continue;
		if (budget.left <= 0) return false;
		budget.left--;
		await db
			.prepare(
				`UPDATE suggestions SET status = 'done', closed_by = 'rules', closed_by_user_id = NULL, closed_at = ?,
				        snooze_until = NULL, updated_at = ?
				  WHERE id = ? AND status IN ('open', 'snoozed')`
			)
			.bind(nowSql, nowSql, row.id)
			.run();
		res.closed++;
	}
	return true;
}

/**
 * One heartbeat step. `force` runs a pass even when the hourly one isn't due (tests); `cap`
 * overrides the per-tick write budget.
 */
export async function runSuggestions(
	db: D1Database,
	opts: { now?: Date; force?: boolean; cap?: number } = {}
): Promise<SuggestionsTick> {
	const cfg = await getSuggestionsConfig(db);
	const res = emptyResult();
	if (!cfg.enabled) return { ...res, off: true };
	const now = opts.now ?? new Date();

	let start = 0;
	let pass: { rule: number; started_at: string } | null = null;
	try {
		pass = JSON.parse((await getState(db, PASS_KEY)) ?? 'null');
	} catch {
		pass = null;
	}
	if (pass && Number.isInteger(pass.rule) && pass.rule >= 0 && pass.rule < RULE_KEYS.length) {
		start = pass.rule;
	} else {
		const last = await getState(db, RULES_AT_KEY);
		if (!opts.force && last && now.getTime() - toMs(last) < RULES_PASS_INTERVAL_MS) return { ...res, skipped: 'not_due' };
		res.pruned = await pruneSuggestions(db, now);
		pass = { rule: 0, started_at: sqlStamp(now) };
	}

	let threads: Promise<Conversation[]> | null = null;
	const ctx: RuleContext = { db, cfg, now, threads: () => (threads ??= listedThreads(db)) };
	const budget = { left: Math.max(1, opts.cap ?? SUGGESTIONS_TICK_CAP) };
	const daily = await readDaily(db, now);

	for (let i = start; i < RULE_KEYS.length; i++) {
		const rule = RULE_KEYS[i];
		// A rule or kind that is off makes nothing new and closes nothing (its rows are hidden).
		if (!cfg.rules[rule].on || !cfg.kinds[RULE_KIND[rule]]) continue;
		const candidates = await runRule(rule, ctx);
		const finished = await applyRule(db, cfg, rule, candidates, now, budget, daily, res);
		await setState(db, DAILY_KEY, JSON.stringify(daily));
		if (!finished) {
			await setState(db, PASS_KEY, JSON.stringify({ rule: i, started_at: pass.started_at }));
			return res;
		}
		res.rules.push(rule);
	}
	await deleteState(db, PASS_KEY);
	await setState(db, RULES_AT_KEY, sqlStamp(now));
	res.pass_complete = true;
	return res;
}
