// Contact scoring (#466) — the contact page's Scores card: one row per active score with the
// cached value, band, last change and the newest ledger rows; plus the admin "Adjust" write.

import { parseBands, type AdjustInput } from '$lib/scoring';
import { computePairs, markPairsDirty } from './engine';

export const HISTORY_ROWS = 20;

export type ScoreHistoryRow = {
	id: number;
	points: number;
	rule_label: string | null;
	rule_kind: string | null;
	event_type: string | null;
	source_type: string;
	source_id: string;
	earned_at: string;
	expires_at: string | null;
	expired: boolean;
	note: string | null;
	/** #621: a CRM form submission row: the form it came from (NULL once the form is gone). */
	form_id: number | null;
	form_name: string | null;
};

export type ContactScore = {
	score_id: number;
	name: string;
	slug: string;
	description: string;
	value: number;
	band: string | null;
	prev_value: number | null;
	changed_at: string | null;
	pending: boolean;
	has_bands: boolean;
	history: ScoreHistoryRow[];
};

export async function contactScores(db: D1Database, contactId: number, now: Date = new Date()): Promise<ContactScore[]> {
	const scores = await db
		.prepare(
			`SELECT d.id AS score_id, d.name, d.slug, d.description, d.bands, cs.value, cs.band, cs.prev_value, cs.changed_at, cs.dirty
			 FROM score_defs d LEFT JOIN contact_scores cs ON cs.score_id = d.id AND cs.contact_id = ?
			 WHERE d.status = 'active' ORDER BY d.position, d.id`
		)
		.bind(contactId)
		.all<{
			score_id: number;
			name: string;
			slug: string;
			description: string;
			bands: string | null;
			value: number | null;
			band: string | null;
			prev_value: number | null;
			changed_at: string | null;
			dirty: number | null;
		}>();
	if (!scores.results.length) return [];
	const hist = await db
		.prepare(
			`SELECT * FROM (
				SELECT p.id, p.score_id, p.points, p.source_type, p.source_id, p.earned_at, p.expires_at, p.note,
					r.label AS rule_label, r.kind AS rule_kind, r.event_type, f.id AS form_id, f.name AS form_name,
					ROW_NUMBER() OVER (PARTITION BY p.score_id ORDER BY p.earned_at DESC, p.id DESC) AS rn
				FROM score_points p LEFT JOIN score_rules r ON r.id = p.rule_id
					LEFT JOIN form_submissions fs ON p.source_type = 'form_submissions' AND fs.id = CAST(p.source_id AS INTEGER)
					LEFT JOIN forms f ON p.source_type = 'form_submissions'
						AND f.id = COALESCE(fs.form_id, CASE WHEN json_valid(r.filter) THEN json_extract(r.filter, '$.form_id') END)
				WHERE p.contact_id = ?
			) WHERE rn <= ? ORDER BY score_id, rn`
		)
		.bind(contactId, HISTORY_ROWS)
		.all<Omit<ScoreHistoryRow, 'expired'> & { score_id: number }>();
	const nowIso = now.toISOString();
	const byScore = new Map<number, ScoreHistoryRow[]>();
	for (const h of hist.results) {
		const list = byScore.get(h.score_id) ?? [];
		list.push({
			id: h.id,
			points: h.points,
			rule_label: h.rule_label,
			rule_kind: h.rule_kind,
			event_type: h.event_type,
			source_type: h.source_type,
			source_id: h.source_id,
			earned_at: h.earned_at,
			expires_at: h.expires_at,
			expired: !!h.expires_at && h.expires_at <= nowIso,
			note: h.note,
			form_id: h.form_id ?? null,
			form_name: h.form_name ?? null
		});
		byScore.set(h.score_id, list);
	}
	return scores.results.map((s) => ({
		score_id: s.score_id,
		name: s.name,
		slug: s.slug,
		description: s.description,
		value: s.value ?? 0,
		band: s.band,
		prev_value: s.prev_value,
		changed_at: s.changed_at,
		pending: !!s.dirty,
		has_bands: parseBands(s.bands).length > 0,
		history: byScore.get(s.score_id) ?? []
	}));
}

/** Add a manual ledger row (± points, optional expiry, note) and recompute that contact now. */
export async function adjustScore(
	db: D1Database,
	contactId: number,
	scoreId: number,
	input: AdjustInput,
	by: string | null,
	now: Date = new Date()
): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
	const score = await db.prepare('SELECT id FROM score_defs WHERE id = ?').bind(scoreId).first<{ id: number }>();
	if (!score) return { ok: false, error: 'That score no longer exists.' };
	const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first<{ id: number }>();
	if (!contact) return { ok: false, error: 'That contact no longer exists.' };
	const earned = now.toISOString();
	const expires = input.expires_days ? new Date(now.getTime() + input.expires_days * 86_400_000).toISOString() : null;
	const note = [input.note, by ? `by @${by}` : ''].filter(Boolean).join(' · ') || null;
	await db
		.prepare(
			`INSERT INTO score_points (score_id, rule_id, contact_id, points, source_type, source_id, earned_at, expires_at, note)
			 VALUES (?, NULL, ?, ?, 'manual', ?, ?, ?, ?)`
		)
		.bind(scoreId, contactId, input.points, `${earned}-${crypto.randomUUID().slice(0, 8)}`, earned, expires, note)
		.run();
	await markPairsDirty(db, [[contactId, scoreId]], now);
	await computePairs(db, [[contactId, scoreId]], now);
	const row = await db
		.prepare('SELECT value FROM contact_scores WHERE contact_id = ? AND score_id = ?')
		.bind(contactId, scoreId)
		.first<{ value: number }>();
	return { ok: true, value: row?.value ?? 0 };
}

/** Above this many contacts the recompute is left to the heartbeat (marked dirty), like #460's tier override. */
export const INLINE_RECOMPUTE_MAX = 200;

export type AddPointsInput = {
	points: number;
	expires_days: number | null;
	note?: string | null;
	/** 'manual' (people, the API, the assistant) or 'automation' (an Adjust score step). */
	source_type: 'manual' | 'automation';
	/** Per contact; default a unique manual id. */
	sourceId?: (contactId: number) => string;
	/** #552: the assistant's change — never fires a `score_changed` automation. */
	quiet?: boolean;
};

/**
 * #467: one ledger row per contact (± points, optional expiry) for one score, then recompute —
 * inline for ≤ INLINE_RECOMPUTE_MAX contacts, else marked dirty for the heartbeat. Unknown /
 * deleted contacts are skipped. Returns the contacts written and, when inline, their new values.
 */
export async function addScorePoints(
	db: D1Database,
	contactIds: number[],
	scoreId: number,
	input: AddPointsInput,
	now: Date = new Date()
): Promise<{ ok: true; affected: number; inline: boolean; values: Map<number, number> } | { ok: false; error: string }> {
	const score = await db.prepare('SELECT id FROM score_defs WHERE id = ?').bind(scoreId).first<{ id: number }>();
	if (!score) return { ok: false, error: 'That score no longer exists.' };
	const want = [...new Set(contactIds)].filter((n) => Number.isInteger(n) && n > 0);
	const ids: number[] = [];
	for (let i = 0; i < want.length; i += 500) {
		const res = await db
			.prepare('SELECT id FROM contacts WHERE id IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(want.slice(i, i + 500)))
			.all<{ id: number }>();
		ids.push(...res.results.map((r) => r.id));
	}
	const values = new Map<number, number>();
	if (!ids.length) return { ok: true, affected: 0, inline: true, values };
	const earned = now.toISOString();
	const expires = input.expires_days ? new Date(now.getTime() + input.expires_days * 86_400_000).toISOString() : null;
	const tag = `${earned}-${crypto.randomUUID().slice(0, 8)}`;
	const rows = ids.map((c) => ({ c, i: input.sourceId ? input.sourceId(c) : `${tag}-${c}` }));
	for (let i = 0; i < rows.length; i += 500) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO score_points (score_id, rule_id, contact_id, points, source_type, source_id, earned_at, expires_at, note)
				 SELECT ?, NULL, json_extract(j.value, '$.c'), ?, ?, json_extract(j.value, '$.i'), ?, ?, ? FROM json_each(?) j`
			)
			.bind(scoreId, input.points, input.source_type, earned, expires, input.note || null, JSON.stringify(rows.slice(i, i + 500)))
			.run();
	}
	const pairs = ids.map((c) => [c, scoreId] as [number, number]);
	await markPairsDirty(db, pairs, now, { quiet: input.quiet });
	const inline = ids.length <= INLINE_RECOMPUTE_MAX;
	if (inline) {
		await computePairs(db, pairs, now, { quiet: input.quiet });
		const res = await db
			.prepare('SELECT contact_id, value FROM contact_scores WHERE score_id = ? AND contact_id IN (SELECT value FROM json_each(?))')
			.bind(scoreId, JSON.stringify(ids))
			.all<{ contact_id: number; value: number }>();
		for (const r of res.results) values.set(r.contact_id, r.value);
	}
	return { ok: true, affected: ids.length, inline, values };
}
