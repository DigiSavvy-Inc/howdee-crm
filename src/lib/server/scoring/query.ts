// Scores as filters and reads (#467): the SQL clauses shared by segment rules
// (segment-query.ts `compileRule`, so also automation entry rules + Condition steps) and the
// /contacts filters, plus the read helpers the pickers, the Data API, the assistant and MCP
// use. A contact with no `contact_scores` row reads as value 0 / no band.
//
// Imports nothing from the engine (segment-query.ts — which the engine imports — imports this).

import { parseBands } from '$lib/scoring';

export type Clause = { clause: string; binds: unknown[] };

const OPS: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=' };
export const SCORE_VALUE_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'between'] as const;

const valueExpr = (idExpr: string) =>
	`COALESCE((SELECT cs.value FROM contact_scores cs WHERE cs.contact_id = ${idExpr} AND cs.score_id = ?), 0)`;

/** The contact's cached value of `scoreId` compared with `n` (between = lo..hi inclusive). */
export function scoreValueClause(scoreId: number, op: string, n: number, idExpr = 'c.id', n2?: number): Clause | null {
	if (!Number.isInteger(scoreId) || scoreId <= 0 || !Number.isFinite(n)) return null;
	if (op === 'between') {
		if (n2 === undefined || !Number.isFinite(n2)) return null;
		return { clause: `${valueExpr(idExpr)} BETWEEN ? AND ?`, binds: [scoreId, Math.min(n, n2), Math.max(n, n2)] };
	}
	const sql = OPS[op];
	if (!sql) return null;
	return { clause: `${valueExpr(idExpr)} ${sql} ?`, binds: [scoreId, n] };
}

/** The contact's band of `scoreId` is (or, negated, isn't) `label` — case-insensitive. */
export function scoreBandClause(scoreId: number, label: string, idExpr = 'c.id', negate = false): Clause | null {
	const l = label.trim();
	if (!Number.isInteger(scoreId) || scoreId <= 0 || !l) return null;
	const inner = `SELECT 1 FROM contact_scores cs WHERE cs.contact_id = ${idExpr} AND cs.score_id = ? AND LOWER(COALESCE(cs.band, '')) = LOWER(?)`;
	return { clause: negate ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`, binds: [scoreId, l] };
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────

/** One score for the pickers (RuleBuilder, filters, trigger / action drawers, the column). */
export type ScorePick = { id: number; name: string; slug: string; bands: string[] };

/** Active scores (or every score with `all`), in Settings order, with their band labels. */
export async function scorePicker(db: D1Database, opts: { all?: boolean } = {}): Promise<ScorePick[]> {
	try {
		const res = await db
			.prepare(`SELECT id, name, slug, bands FROM score_defs ${opts.all ? '' : "WHERE status = 'active'"} ORDER BY position, id`)
			.all<{ id: number; name: string; slug: string; bands: string | null }>();
		return res.results.map((s) => ({ id: s.id, name: s.name, slug: s.slug, bands: parseBands(s.bands).map((b) => b.label) }));
	} catch {
		return []; // before migration 0107
	}
}

export type ScoreDefinition = {
	id: number;
	name: string;
	slug: string;
	description: string;
	status: string;
	decay_mode: string;
	half_life_days: number | null;
	bands: { label: string; min: number }[];
	rule_count: number;
	is_default: boolean;
	created_at: string;
	updated_at: string;
};

/** Every score definition with its bands and rule count (Data API, assistant, MCP). */
export async function scoreDefinitions(db: D1Database): Promise<ScoreDefinition[]> {
	const res = await db
		.prepare(
			`SELECT d.*, (SELECT COUNT(*) FROM score_rules r WHERE r.score_id = d.id) AS rule_count
			 FROM score_defs d ORDER BY d.position, d.id`
		)
		.all<{
			id: number;
			name: string;
			slug: string;
			description: string;
			status: string;
			decay_mode: string;
			half_life_days: number | null;
			bands: string | null;
			rule_count: number;
			is_default: number;
			created_at: string;
			updated_at: string;
		}>();
	return res.results.map((d) => ({
		id: d.id,
		name: d.name,
		slug: d.slug,
		description: d.description,
		status: d.status,
		decay_mode: d.decay_mode,
		half_life_days: d.half_life_days,
		bands: parseBands(d.bands),
		rule_count: d.rule_count,
		is_default: !!d.is_default,
		created_at: d.created_at,
		updated_at: d.updated_at
	}));
}

/** A score by id, or by slug / name (case-insensitive) — the assistant and MCP take either. */
export async function findScore(db: D1Database, ref: string | number): Promise<{ id: number; name: string; slug: string; status: string; bands: string | null } | null> {
	const n = Number(ref);
	if (Number.isInteger(n) && n > 0) {
		return db.prepare('SELECT id, name, slug, status, bands FROM score_defs WHERE id = ?').bind(n).first();
	}
	const s = String(ref ?? '').trim();
	if (!s) return null;
	return db
		.prepare('SELECT id, name, slug, status, bands FROM score_defs WHERE slug = ? COLLATE NOCASE OR name = ? COLLATE NOCASE ORDER BY id LIMIT 1')
		.bind(s, s)
		.first();
}

export type ContactScoreBrief = { id: number; slug: string; name: string; value: number; band: string | null };

/** Active scores' values for many contacts (serializeContact); missing row = 0 / no band. */
export async function scoresForContacts(db: D1Database, contactIds: number[]): Promise<Map<number, ContactScoreBrief[]>> {
	const out = new Map<number, ContactScoreBrief[]>();
	const ids = [...new Set(contactIds)].filter((n) => Number.isInteger(n) && n > 0);
	if (!ids.length) return out;
	let defs: { id: number; slug: string; name: string }[];
	try {
		defs = (await db.prepare("SELECT id, slug, name FROM score_defs WHERE status = 'active' ORDER BY position, id").all<{ id: number; slug: string; name: string }>()).results;
	} catch {
		return out; // before migration 0107
	}
	if (!defs.length) {
		for (const id of ids) out.set(id, []);
		return out;
	}
	const vals = new Map<string, { value: number; band: string | null }>();
	for (let i = 0; i < ids.length; i += 500) {
		const res = await db
			.prepare(
				`SELECT contact_id, score_id, value, band FROM contact_scores
				 WHERE contact_id IN (SELECT value FROM json_each(?)) AND score_id IN (SELECT id FROM score_defs WHERE status = 'active')`
			)
			.bind(JSON.stringify(ids.slice(i, i + 500)))
			.all<{ contact_id: number; score_id: number; value: number; band: string | null }>();
		for (const r of res.results) vals.set(`${r.contact_id}:${r.score_id}`, { value: r.value, band: r.band });
	}
	for (const id of ids) {
		out.set(
			id,
			defs.map((d) => {
				const v = vals.get(`${id}:${d.id}`);
				return { id: d.id, slug: d.slug, name: d.name, value: v?.value ?? 0, band: v?.band ?? null };
			})
		);
	}
	return out;
}

export type ScoreLeader = { contact_id: number; email: string; name: string; value: number; band: string | null; changed_at: string | null };

/** The top `limit` (≤ 100) active, non-archived contacts by a score, optionally in one band. */
export async function scoreLeaders(db: D1Database, scoreId: number, opts: { limit?: number; band?: string | null } = {}): Promise<ScoreLeader[]> {
	const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 10)));
	const band = (opts.band ?? '').trim();
	const res = await db
		.prepare(
			`SELECT c.id AS contact_id, c.email, COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS name,
				cs.value, cs.band, cs.changed_at
			 FROM contact_scores cs JOIN contacts c ON c.id = cs.contact_id
			 WHERE cs.score_id = ? AND c.archived_at IS NULL ${band ? 'AND LOWER(COALESCE(cs.band, \'\')) = LOWER(?)' : ''}
			 ORDER BY cs.value DESC, c.id LIMIT ?`
		)
		.bind(...(band ? [scoreId, band, limit] : [scoreId, limit]))
		.all<ScoreLeader>();
	return res.results;
}
