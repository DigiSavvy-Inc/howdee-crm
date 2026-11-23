// #207 (part of #205): read-side SQL + serialization for the pipeline Data API
// (/api/v1/pipeline/*, /api/v1/contacts/:id/pipeline). Writes go through
// $lib/server/pipeline (addToPipeline / moveCard / updateCard / removeFromPipeline) —
// this module only reads and resolves request parameters.
import type { Stage } from '$lib/server/pipeline';

// ---- stages ----

export type ApiStage = {
	id: number;
	name: string;
	color: string | null;
	position: number;
	kind: string;
	card_count: number;
	total_value: number;
};

/** Every stage by position, with its card count and summed card value. */
export async function apiStages(db: D1Database): Promise<ApiStage[]> {
	const rows = await db
		.prepare(
			`SELECT s.id, s.name, s.color, s.position, s.kind,
			        COUNT(pc.id) AS card_count, COALESCE(SUM(pc.value), 0) AS total_value
			 FROM pipeline_stages s
			 LEFT JOIN pipeline_cards pc ON pc.stage_id = s.id
			 GROUP BY s.id
			 ORDER BY s.position, s.id`
		)
		.all<ApiStage>();
	return rows.results;
}

/** Resolve a stage by numeric id or by name (case-insensitive). null = unknown. */
export async function resolveStage(db: D1Database, ref: { id?: unknown; name?: unknown }): Promise<Stage | null> {
	if (ref.id !== undefined && ref.id !== null && ref.id !== '') {
		const id = Number(ref.id);
		if (!Number.isInteger(id) || id <= 0) return null;
		return db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').bind(id).first<Stage>();
	}
	const name = typeof ref.name === 'string' ? ref.name.trim() : '';
	if (!name) return null;
	return db
		.prepare('SELECT * FROM pipeline_stages WHERE name = ? COLLATE NOCASE ORDER BY position, id LIMIT 1')
		.bind(name)
		.first<Stage>();
}

/** A `?stage=` query value: all digits = id, anything else = name. */
export function stageRefFromParam(raw: string): { id?: string; name?: string } {
	const s = raw.trim();
	return /^\d+$/.test(s) ? { id: s } : { name: s };
}

/** Resolve an owner reference — a user id, a GitHub login (case-insensitive, optional `@`),
 *  or `none`/null (unassigned). Returns `undefined` when no such user exists. */
export async function resolveOwner(db: D1Database, raw: unknown): Promise<number | null | undefined> {
	if (raw === null) return null;
	if (typeof raw === 'number') {
		if (!Number.isInteger(raw) || raw <= 0) return undefined;
		const u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(raw).first<{ id: number }>();
		return u ? u.id : undefined;
	}
	if (typeof raw !== 'string') return undefined;
	const s = raw.trim();
	if (!s || s.toLowerCase() === 'none') return null;
	if (/^\d+$/.test(s)) return resolveOwner(db, Number(s));
	const u = await db
		.prepare('SELECT id FROM users WHERE github_login = ? COLLATE NOCASE')
		.bind(s.replace(/^@/, ''))
		.first<{ id: number }>();
	return u ? u.id : undefined;
}

// ---- cards ----

export type ApiCard = {
	id: number;
	contact_id: number;
	email: string;
	name: string;
	company: string | null;
	stage_id: number;
	stage_name: string;
	value: number | null;
	note: string | null;
	owner_user_id: number | null;
	owner_login: string | null;
	position: number;
	entered_stage_at: string;
	created_at: string;
	updated_at: string;
};

const API_CARD_FROM = `
	FROM pipeline_cards pc
	JOIN contacts c ON c.id = pc.contact_id
	JOIN pipeline_stages s ON s.id = pc.stage_id
	LEFT JOIN users u ON u.id = pc.owner_user_id`;

const API_CARD_SELECT = `
	SELECT pc.id, pc.contact_id, c.email,
	       COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), c.email) AS name,
	       c.company, pc.stage_id, s.name AS stage_name, pc.value, pc.note,
	       pc.owner_user_id, u.github_login AS owner_login,
	       pc.position, pc.entered_stage_at, pc.created_at, pc.updated_at
	${API_CARD_FROM}`;

export type CardListFilter = { stageId?: number; owner?: number | null };

/** One page of cards, ordered by stage position then card position. `owner: null` = unassigned. */
export async function apiCards(
	db: D1Database,
	filter: CardListFilter,
	limit: number,
	offset: number
): Promise<{ rows: ApiCard[]; total: number }> {
	const where: string[] = [];
	const binds: number[] = [];
	if (filter.stageId !== undefined) {
		where.push('pc.stage_id = ?');
		binds.push(filter.stageId);
	}
	if (filter.owner === null) where.push('pc.owner_user_id IS NULL');
	else if (filter.owner !== undefined) {
		where.push('pc.owner_user_id = ?');
		binds.push(filter.owner);
	}
	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const total =
		(await db.prepare(`SELECT COUNT(*) AS n ${API_CARD_FROM} ${whereSql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
	const rows = await db
		.prepare(`${API_CARD_SELECT} ${whereSql} ORDER BY s.position, s.id, pc.position, pc.id LIMIT ? OFFSET ?`)
		.bind(...binds, limit, offset)
		.all<ApiCard>();
	return { rows: rows.results, total };
}

export async function apiCardFor(db: D1Database, contactId: number): Promise<ApiCard | null> {
	return db.prepare(`${API_CARD_SELECT} WHERE pc.contact_id = ?`).bind(contactId).first<ApiCard>();
}

// ---- history ----

export type ApiHistoryRow = {
	id: number;
	from_stage_id: number | null;
	from_stage: string | null;
	to_stage_id: number | null;
	to_stage: string | null;
	actor_kind: string;
	actor_id: number | null;
	actor_label: string | null;
	note: string | null;
	created_at: string;
};

export const HISTORY_CAP = 200;

/** A contact's pipeline history, newest first. `actor_label`: @login for a user, the
 *  automation's name, the API key's label, else null. */
export async function apiHistoryFor(db: D1Database, contactId: number, limit = HISTORY_CAP): Promise<ApiHistoryRow[]> {
	const rows = await db
		.prepare(
			`SELECT h.id, h.from_stage_id, fs.name AS from_stage, h.to_stage_id, ts.name AS to_stage,
			        h.actor_kind, h.actor_id,
			        CASE h.actor_kind
			          WHEN 'user' THEN (SELECT '@' || github_login FROM users WHERE id = h.actor_id)
			          WHEN 'automation' THEN (SELECT name FROM automations WHERE id = h.actor_id)
			          WHEN 'api' THEN (SELECT label FROM api_keys WHERE id = h.actor_id)
			          ELSE NULL END AS actor_label,
			        h.note, h.created_at
			 FROM pipeline_history h
			 LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id
			 LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id
			 WHERE h.contact_id = ?
			 ORDER BY h.id DESC LIMIT ?`
		)
		.bind(contactId, Math.min(Math.max(1, limit), HISTORY_CAP))
		.all<ApiHistoryRow>();
	return rows.results;
}

/** The `{ card, history }` body of GET/POST /api/v1/contacts/:id/pipeline. */
export async function contactPipeline(db: D1Database, contactId: number): Promise<{ card: ApiCard | null; history: ApiHistoryRow[] }> {
	const [card, history] = await Promise.all([apiCardFor(db, contactId), apiHistoryFor(db, contactId)]);
	return { card, history };
}
