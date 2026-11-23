// Scoring reads for Reports and the dashboard (#468, part 3 of #465). Read-only: nothing here
// writes, recomputes or imports the engine. Archived contacts are left out (day-to-day views);
// a contact without a contact_scores row counts as 0.

import { bandFor, parseBands, type Band } from '$lib/scoring';

const DAY_MS = 86_400_000;

export type ScoreRef = { id: number; slug: string; name: string; bands: Band[]; decay_mode: string };

/** Active scores in settings order. */
export async function activeScores(db: D1Database): Promise<ScoreRef[]> {
	const res = await db
		.prepare(`SELECT id, slug, name, bands, decay_mode FROM score_defs WHERE status = 'active' ORDER BY position, id`)
		.all<{ id: number; slug: string; name: string; bands: string | null; decay_mode: string }>();
	return (res.results ?? []).map((s) => ({ id: s.id, slug: s.slug, name: s.name, bands: parseBands(s.bands), decay_mode: s.decay_mode }));
}

/** The active score with this slug, else the first active score (null when none is active). */
export async function pickScore(db: D1Database, slug: string | null | undefined): Promise<ScoreRef | null> {
	const scores = await activeScores(db);
	return scores.find((s) => s.slug === slug) ?? scores[0] ?? null;
}

// --- distribution ----------------------------------------------------------------------

export type DistributionRow = { label: string; range: string; min: number; contacts: number; share: number | null };

/** Distinct values with how many active contacts hold each (no row = 0). */
async function valueCounts(db: D1Database, scoreId: number): Promise<{ value: number; n: number }[]> {
	const res = await db
		.prepare(
			`SELECT COALESCE(cs.value, 0) AS value, COUNT(*) AS n
			 FROM contacts c LEFT JOIN contact_scores cs ON cs.contact_id = c.id AND cs.score_id = ?
			 WHERE c.archived_at IS NULL
			 GROUP BY COALESCE(cs.value, 0)`
		)
		.bind(scoreId)
		.all<{ value: number; n: number }>();
	return res.results ?? [];
}

export const NO_BAND = 'No band';

/** Band rows highest first (+ "No band" for values under the lowest band), or 10-point buckets ascending. */
export function distributionRows(counts: { value: number; n: number }[], bands: Band[]): DistributionRow[] {
	const total = counts.reduce((sum, c) => sum + c.n, 0);
	if (!total) return [];
	const share = (n: number) => Math.round((n / total) * 1000) / 10;
	if (bands.length) {
		const byLabel = new Map<string, number>();
		for (const c of counts) {
			const label = bandFor(c.value, bands) ?? NO_BAND;
			byLabel.set(label, (byLabel.get(label) ?? 0) + c.n);
		}
		const rows: DistributionRow[] = bands.map((band, i) => {
			const next = bands[i - 1];
			const range = next ? `${band.min}–${next.min - 1}` : `${band.min}+`;
			const n = byLabel.get(band.label) ?? 0;
			return { label: band.label, range, min: band.min, contacts: n, share: share(n) };
		});
		const below = byLabel.get(NO_BAND) ?? 0;
		if (below) {
			const lowest = bands[bands.length - 1].min;
			rows.push({ label: NO_BAND, range: `under ${lowest}`, min: Number.NEGATIVE_INFINITY, contacts: below, share: share(below) });
		}
		return rows;
	}
	const buckets = new Map<number, number>();
	for (const c of counts) {
		const start = Math.floor(c.value / 10) * 10;
		buckets.set(start, (buckets.get(start) ?? 0) + c.n);
	}
	const starts = [...buckets.keys()];
	const lo = Math.min(...starts);
	const hi = Math.max(...starts);
	const rows: DistributionRow[] = [];
	for (let start = lo; start <= hi; start += 10) {
		const n = buckets.get(start) ?? 0;
		rows.push({ label: `${start}–${start + 9}`, range: `${start}–${start + 9}`, min: start, contacts: n, share: share(n) });
	}
	return rows;
}

export type TopContact = { contact_id: number; email: string; name: string | null; value: number; band: string | null };

export async function scoreDistribution(
	db: D1Database,
	score: ScoreRef,
	top = 25
): Promise<{ rows: DistributionRow[]; total: number; top: TopContact[] }> {
	const counts = await valueCounts(db, score.id);
	const rows = distributionRows(counts, score.bands);
	const total = counts.reduce((sum, c) => sum + c.n, 0);
	const res = await db
		.prepare(
			`SELECT c.id AS contact_id, c.email,
			        COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '')) AS name,
			        cs.value AS value
			 FROM contact_scores cs JOIN contacts c ON c.id = cs.contact_id
			 WHERE cs.score_id = ? AND c.archived_at IS NULL AND cs.value != 0
			 ORDER BY cs.value DESC, c.id
			 LIMIT ?`
		)
		.bind(score.id, top)
		.all<Omit<TopContact, 'band'>>();
	return {
		rows,
		total,
		top: (res.results ?? []).map((r) => ({ ...r, band: bandFor(r.value, score.bands) }))
	};
}

// --- movers ----------------------------------------------------------------------------

export type Mover = {
	contact_id: number;
	email: string;
	name: string | null;
	value: number;
	delta: number;
	top_rule: string | null;
	top_rule_points: number | null;
};

/** ISO bounds of a 7 / 30 / 90-day range ending now (score_points times are ISO). */
export function scoreRange(days: number, now: Date): { from: string; to: string } {
	return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() };
}

// A ledger row's signed change in (from, to]: earned in the range and still live at `to`
// counts its points; earned before and expired in the range counts minus its points.
// Rows of inactive rules don't count toward a value, so they are left out too.
const CHANGE_SQL = `CASE
		WHEN p.earned_at > ?1 AND p.earned_at <= ?2 AND (p.expires_at IS NULL OR p.expires_at > ?2) THEN p.points
		WHEN p.earned_at <= ?1 AND p.expires_at > ?1 AND p.expires_at <= ?2 THEN -p.points
		ELSE 0 END`;
const LEDGER_FROM = `FROM score_points p
	LEFT JOIN score_rules r ON r.id = p.rule_id
	JOIN contacts c ON c.id = p.contact_id AND c.archived_at IS NULL
	WHERE p.score_id = ?3 AND (p.rule_id IS NULL OR r.active = 1)
	  AND ((p.earned_at > ?1 AND p.earned_at <= ?2) OR (p.expires_at > ?1 AND p.expires_at <= ?2))`;

export const MANUAL_LABEL = 'Manual adjustments';

export async function scoreMovers(
	db: D1Database,
	score: ScoreRef,
	days: number,
	now: Date,
	limit = 100
): Promise<{ rows: Mover[]; total: number }> {
	const { from, to } = scoreRange(days, now);
	const deltas = await db
		.prepare(
			`SELECT p.contact_id AS contact_id, SUM(${CHANGE_SQL}) AS delta ${LEDGER_FROM}
			 GROUP BY p.contact_id HAVING delta != 0`
		)
		.bind(from, to, score.id)
		.all<{ contact_id: number; delta: number }>();
	const all = (deltas.results ?? []).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.contact_id - b.contact_id);
	const page = all.slice(0, limit);
	if (!page.length) return { rows: [], total: 0 };
	const ids = JSON.stringify(page.map((m) => m.contact_id));
	const [contacts, perRule] = await Promise.all([
		db
			.prepare(
				`SELECT c.id, c.email,
				        COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '')) AS name,
				        COALESCE(cs.value, 0) AS value
				 FROM contacts c LEFT JOIN contact_scores cs ON cs.contact_id = c.id AND cs.score_id = ?
				 WHERE c.id IN (SELECT value FROM json_each(?))`
			)
			.bind(score.id, ids)
			.all<{ id: number; email: string; name: string | null; value: number }>(),
		db
			.prepare(
				`SELECT p.contact_id AS contact_id, p.rule_id AS rule_id, r.label AS label, r.kind AS kind, r.event_type AS event_type,
				        SUM(${CHANGE_SQL}) AS delta ${LEDGER_FROM} AND p.contact_id IN (SELECT value FROM json_each(?4))
				 GROUP BY p.contact_id, p.rule_id`
			)
			.bind(from, to, score.id, ids)
			.all<{ contact_id: number; rule_id: number | null; label: string | null; kind: string | null; event_type: string | null; delta: number }>()
	]);
	const byId = new Map((contacts.results ?? []).map((c) => [c.id, c]));
	const best = new Map<number, { label: string; delta: number }>();
	const deltaOf = new Map(page.map((m) => [m.contact_id, m.delta]));
	for (const r of perRule.results ?? []) {
		const sign = Math.sign(deltaOf.get(r.contact_id) ?? 0);
		if (!r.delta || Math.sign(r.delta) !== sign) continue;
		const current = best.get(r.contact_id);
		if (!current || Math.abs(r.delta) > Math.abs(current.delta)) best.set(r.contact_id, { label: ruleLabel(r), delta: r.delta });
	}
	return {
		total: all.length,
		rows: page.map((m) => {
			const c = byId.get(m.contact_id);
			const rule = best.get(m.contact_id);
			return {
				contact_id: m.contact_id,
				email: c?.email ?? '',
				name: c?.name ?? null,
				value: c?.value ?? 0,
				delta: m.delta,
				top_rule: rule?.label ?? null,
				top_rule_points: rule?.delta ?? null
			};
		})
	};
}

function ruleLabel(r: { rule_id: number | null; label: string | null; kind?: string | null; event_type?: string | null }): string {
	if (r.rule_id == null) return MANUAL_LABEL;
	return r.label?.trim() || r.event_type || r.kind || `Rule #${r.rule_id}`;
}

// --- rule activity ---------------------------------------------------------------------

export type RuleActivityRow = {
	rule_id: number | null;
	rule: string;
	kind: string;
	active: boolean;
	rule_points: number | null;
	awarded: number;
	awards: number;
	contacts: number;
	share: number | null;
};

/** One row per rule of the score (+ manual / automation rows when any): points earned in the range. */
export async function scoreRuleActivity(db: D1Database, score: ScoreRef, days: number, now: Date): Promise<RuleActivityRow[]> {
	const { from, to } = scoreRange(days, now);
	const [rules, earned] = await Promise.all([
		db
			.prepare(`SELECT id, label, kind, event_type, points, active FROM score_rules WHERE score_id = ? ORDER BY position, id`)
			.bind(score.id)
			.all<{ id: number; label: string; kind: string; event_type: string | null; points: number; active: number }>(),
		db
			.prepare(
				`SELECT p.rule_id AS rule_id, SUM(p.points) AS awarded, COUNT(*) AS awards, COUNT(DISTINCT p.contact_id) AS contacts
				 FROM score_points p JOIN contacts c ON c.id = p.contact_id AND c.archived_at IS NULL
				 WHERE p.score_id = ? AND p.earned_at > ? AND p.earned_at <= ?
				 GROUP BY p.rule_id`
			)
			.bind(score.id, from, to)
			.all<{ rule_id: number | null; awarded: number; awards: number; contacts: number }>()
	]);
	const byRule = new Map((earned.results ?? []).map((e) => [e.rule_id, e]));
	const rows: Omit<RuleActivityRow, 'share'>[] = (rules.results ?? []).map((r) => {
		const e = byRule.get(r.id);
		return {
			rule_id: r.id,
			rule: ruleLabel({ rule_id: r.id, label: r.label, kind: r.kind, event_type: r.event_type }),
			kind: r.kind === 'condition' ? 'Condition' : 'Event',
			active: r.active === 1,
			rule_points: r.points,
			awarded: e?.awarded ?? 0,
			awards: e?.awards ?? 0,
			contacts: e?.contacts ?? 0
		};
	});
	const manual = byRule.get(null);
	if (manual) {
		rows.push({ rule_id: null, rule: MANUAL_LABEL, kind: 'Manual', active: true, rule_points: null, awarded: manual.awarded, awards: manual.awards, contacts: manual.contacts });
	}
	const totalAbs = rows.reduce((sum, r) => sum + Math.abs(r.awarded), 0);
	return rows.map((r) => ({ ...r, share: totalAbs ? Math.round((Math.abs(r.awarded) / totalAbs) * 1000) / 10 : null }));
}

// --- dashboard -------------------------------------------------------------------------

export type ScoreOverview = {
	slug: string;
	name: string;
	total: number;
	bands: { label: string; contacts: number; share: number | null }[];
	moved: number;
};

export const BAND_MOVE_DAYS = 7;

/** One line per active score: band counts and contacts whose band changed in the last 7 days. */
export async function scoresOverview(db: D1Database, now: Date = new Date()): Promise<ScoreOverview[]> {
	const scores = await activeScores(db);
	const since = new Date(now.getTime() - BAND_MOVE_DAYS * DAY_MS).toISOString();
	return Promise.all(
		scores.map(async (score) => {
			const [counts, changed] = await Promise.all([
				valueCounts(db, score.id),
				db
					.prepare(
						`SELECT cs.value AS value, cs.prev_value AS prev_value
						 FROM contact_scores cs JOIN contacts c ON c.id = cs.contact_id AND c.archived_at IS NULL
						 WHERE cs.score_id = ? AND cs.changed_at >= ? AND cs.prev_value IS NOT NULL`
					)
					.bind(score.id, since)
					.all<{ value: number; prev_value: number }>()
			]);
			const moved = score.bands.length
				? (changed.results ?? []).filter((r) => bandFor(r.value, score.bands) !== bandFor(r.prev_value, score.bands)).length
				: 0;
			return {
				slug: score.slug,
				name: score.name,
				total: counts.reduce((sum, c) => sum + c.n, 0),
				bands: distributionRows(counts, score.bands).map((r) => ({ label: r.label, contacts: r.contacts, share: r.share })),
				moved
			};
		})
	);
}
