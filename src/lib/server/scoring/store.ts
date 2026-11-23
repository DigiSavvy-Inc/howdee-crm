// Contact scoring (#466) — score + rule CRUD for Settings → Scoring. Validation lives in
// universal $lib/scoring; the engine (./engine) is told what to recompute.

import {
	SCORE_LIMITS,
	slugify,
	type DecayMode,
	type RuleInput,
	type ScoreInput,
	type ScoreStatus
} from '$lib/scoring';
import { markRuleContactsDirty, markScoreDirty, processConditions, queueConditionRules } from './engine';

export type ScoreRow = {
	id: number;
	name: string;
	slug: string;
	description: string;
	status: ScoreStatus;
	decay_mode: DecayMode;
	half_life_days: number | null;
	bands: string | null;
	position: number;
	is_default: number;
	created_at: string;
	updated_at: string;
};

export type ScoreListRow = ScoreRow & { rule_count: number; nonzero: number; dirty: number };

export type RuleRow = {
	id: number;
	score_id: number;
	kind: 'event' | 'condition';
	label: string;
	event_type: string | null;
	filter: string | null;
	rules: string | null;
	points: number;
	expires_days: number | null;
	max_per_day: number | null;
	once: number;
	active: number;
	position: number;
	/** #621: when the rule was added (NULL for rules from before migration 0125). */
	created_at: string | null;
};

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function listScores(db: D1Database): Promise<ScoreListRow[]> {
	const res = await db
		.prepare(
			`SELECT d.*,
				(SELECT COUNT(*) FROM score_rules r WHERE r.score_id = d.id) AS rule_count,
				(SELECT COUNT(*) FROM contact_scores cs WHERE cs.score_id = d.id AND cs.value != 0) AS nonzero,
				(SELECT COUNT(*) FROM contact_scores cs WHERE cs.score_id = d.id AND cs.dirty = 1) AS dirty
			 FROM score_defs d ORDER BY d.position, d.id`
		)
		.all<ScoreListRow>();
	return res.results;
}

export async function getScore(db: D1Database, id: number): Promise<ScoreRow | null> {
	return db.prepare('SELECT * FROM score_defs WHERE id = ?').bind(id).first<ScoreRow>();
}

export async function listRules(db: D1Database, scoreId: number): Promise<RuleRow[]> {
	const res = await db
		.prepare('SELECT * FROM score_rules WHERE score_id = ? ORDER BY position, id')
		.bind(scoreId)
		.all<RuleRow>();
	return res.results;
}

export async function getRule(db: D1Database, id: number): Promise<RuleRow | null> {
	return db.prepare('SELECT * FROM score_rules WHERE id = ?').bind(id).first<RuleRow>();
}

async function uniqueSlug(db: D1Database, name: string, exceptId: number | null): Promise<string> {
	const base = slugify(name);
	for (let i = 1; i < 100; i++) {
		const slug = i === 1 ? base : `${base}-${i}`;
		const row = await db.prepare('SELECT id FROM score_defs WHERE slug = ?').bind(slug).first<{ id: number }>();
		if (!row || row.id === exceptId) return slug;
	}
	return `${base}-${Date.now()}`;
}

function bandsJson(input: ScoreInput): string | null {
	return input.bands.length ? JSON.stringify(input.bands) : null;
}

export async function createScore(db: D1Database, input: ScoreInput): Promise<Result<{ id: number }>> {
	const n = await db.prepare('SELECT COUNT(*) AS n FROM score_defs').first<{ n: number }>();
	if ((n?.n ?? 0) >= SCORE_LIMITS.maxScores) return { ok: false, error: `At most ${SCORE_LIMITS.maxScores} scores.` };
	const slug = await uniqueSlug(db, input.name, null);
	const row = await db
		.prepare(
			`INSERT INTO score_defs (name, slug, description, status, decay_mode, half_life_days, bands, position)
			 VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM score_defs))
			 RETURNING id`
		)
		.bind(input.name, slug, input.description, input.status, input.decay_mode, input.half_life_days, bandsJson(input))
		.first<{ id: number }>();
	return { ok: true, id: row!.id };
}

/** Save a score's settings. Decay mode / half-life / bands changes recompute every contact. */
export async function updateScore(db: D1Database, id: number, input: ScoreInput): Promise<Result> {
	const before = await getScore(db, id);
	if (!before) return { ok: false, error: 'That score no longer exists.' };
	const slug = before.name === input.name ? before.slug : await uniqueSlug(db, input.name, id);
	await db
		.prepare(
			`UPDATE score_defs SET name = ?, slug = ?, description = ?, status = ?, decay_mode = ?, half_life_days = ?, bands = ?,
				updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
		)
		.bind(input.name, slug, input.description, input.status, input.decay_mode, input.half_life_days, bandsJson(input), id)
		.run();
	if (before.decay_mode !== input.decay_mode || before.half_life_days !== input.half_life_days || before.bands !== bandsJson(input)) {
		await markScoreDirty(db, id);
	}
	return { ok: true };
}

export async function setScoreStatus(db: D1Database, id: number, status: ScoreStatus): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE score_defs SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
		.bind(status, id)
		.run();
	if (!r.meta.changes) return false;
	if (status === 'active') {
		// Resumed: re-evaluate its conditions (they were skipped while paused).
		const conds = await db
			.prepare(`SELECT id FROM score_rules WHERE score_id = ? AND kind = 'condition' AND active = 1`)
			.bind(id)
			.all<{ id: number }>();
		await queueConditionRules(
			db,
			conds.results.map((c) => c.id)
		);
	}
	return true;
}

/** Delete a score with its rules, ledger and cache. */
export async function deleteScore(db: D1Database, id: number): Promise<boolean> {
	const res = await db.batch([
		db.prepare('DELETE FROM contact_scores WHERE score_id = ?').bind(id),
		db.prepare('DELETE FROM score_points WHERE score_id = ?').bind(id),
		db.prepare('DELETE FROM score_rules WHERE score_id = ?').bind(id),
		db.prepare('DELETE FROM score_defs WHERE id = ?').bind(id)
	]);
	return (res[3].meta.changes ?? 0) > 0;
}

function ruleBinds(input: RuleInput): unknown[] {
	return [
		input.label,
		input.event_type,
		input.filter ? JSON.stringify(input.filter) : null,
		input.rules ? JSON.stringify(input.rules) : null,
		input.points,
		input.expires_days,
		input.max_per_day,
		input.once ? 1 : 0,
		input.active ? 1 : 0
	];
}

/** Add a rule. A condition rule is queued and its first chunk evaluated at once. */
export async function createRule(db: D1Database, scoreId: number, input: RuleInput, now: Date = new Date()): Promise<Result<{ id: number }>> {
	if (!(await getScore(db, scoreId))) return { ok: false, error: 'That score no longer exists.' };
	const n = await db.prepare('SELECT COUNT(*) AS n FROM score_rules WHERE score_id = ?').bind(scoreId).first<{ n: number }>();
	if ((n?.n ?? 0) >= SCORE_LIMITS.maxRules) return { ok: false, error: `At most ${SCORE_LIMITS.maxRules} rules per score.` };
	const row = await db
		.prepare(
			`INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, active, position, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM score_rules WHERE score_id = ?), ?)
			 RETURNING id`
		)
		.bind(scoreId, input.kind, ...ruleBinds(input), scoreId, now.toISOString())
		.first<{ id: number }>();
	if (input.kind === 'condition' && input.active) {
		await queueConditionRules(db, [row!.id]);
		await processConditions(db, now);
	}
	return { ok: true, id: row!.id };
}

/**
 * Save a rule. The kind can't change. Event-rule edits apply to new points (Rebuild re-applies
 * them to history); a condition rule's held points take the new value at once and the rule is
 * re-evaluated. Toggling `active` recomputes its contacts (an inactive rule's points don't count).
 */
export async function updateRule(db: D1Database, ruleId: number, input: RuleInput, now: Date = new Date()): Promise<Result> {
	const before = await getRule(db, ruleId);
	if (!before) return { ok: false, error: 'That rule no longer exists.' };
	if (before.kind !== input.kind) return { ok: false, error: 'A rule can’t change between event and condition — add a new one.' };
	await db
		.prepare(
			`UPDATE score_rules SET label = ?, event_type = ?, filter = ?, rules = ?, points = ?, expires_days = ?, max_per_day = ?, once = ?, active = ?
			 WHERE id = ?`
		)
		.bind(...ruleBinds(input), ruleId)
		.run();
	// #621: a rule switched to "Submitted a CRM form" counts as new — no back-dated points.
	if (input.event_type === 'crm_form_submit' && before.event_type !== 'crm_form_submit') {
		await db.prepare('UPDATE score_rules SET created_at = ? WHERE id = ?').bind(now.toISOString(), ruleId).run();
	}
	if (input.kind === 'condition') {
		await db.prepare(`UPDATE score_points SET points = ? WHERE rule_id = ? AND source_type = 'condition'`).bind(input.points, ruleId).run();
	}
	if (input.kind === 'condition' || !!before.active !== input.active) await markRuleContactsDirty(db, ruleId, now);
	if (input.kind === 'condition' && input.active) {
		await queueConditionRules(db, [ruleId]);
		await processConditions(db, now);
	}
	return { ok: true };
}

/** Delete a rule and the points it gave (its contacts are recomputed). */
export async function deleteRule(db: D1Database, ruleId: number, now: Date = new Date()): Promise<boolean> {
	if (!(await getRule(db, ruleId))) return false;
	await markRuleContactsDirty(db, ruleId, now);
	await db.batch([
		db.prepare('DELETE FROM score_points WHERE rule_id = ?').bind(ruleId),
		db.prepare('DELETE FROM score_rules WHERE id = ?').bind(ruleId)
	]);
	return true;
}

/** Move a rule up (-1) or down (+1) within its score. */
export async function moveRule(db: D1Database, ruleId: number, dir: -1 | 1): Promise<boolean> {
	const rule = await getRule(db, ruleId);
	if (!rule) return false;
	const ids = (await listRules(db, rule.score_id)).map((r) => r.id);
	const i = ids.indexOf(ruleId);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= ids.length) return false;
	[ids[i], ids[j]] = [ids[j], ids[i]];
	await db.batch(ids.map((id, pos) => db.prepare('UPDATE score_rules SET position = ? WHERE id = ?').bind(pos, id)));
	return true;
}
