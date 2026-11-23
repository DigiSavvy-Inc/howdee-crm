// Pipeline (#206): stages, one card per contact, and a history row for every add / stage
// move / remove. No SvelteKit imports on purpose — the automation engine and the Data API
// (#205 part 2) call these directly with their own `Actor`.
import { isStageColor, type StageColor, type StageKind } from '$lib/pipeline';
import { firePipelineStageTriggers } from './pipeline-trigger';

export type ActorKind = 'user' | 'automation' | 'api' | 'system';
/** Who did it. `id` = users.id for 'user', automations.id for 'automation', api_keys.id for 'api'. */
export type Actor = { kind: ActorKind; id?: number | null };

export type Stage = {
	id: number;
	pipeline_id: number;
	name: string;
	color: string | null;
	position: number;
	kind: StageKind;
	created_at: string;
};

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const NAME_MAX = 40;
const NOTE_MAX = 2000;

async function getStage(db: D1Database, id: number): Promise<Stage | null> {
	return db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').bind(id).first<Stage>();
}

export async function listStages(db: D1Database): Promise<Stage[]> {
	const rows = await db.prepare('SELECT * FROM pipeline_stages ORDER BY position, id').all<Stage>();
	return rows.results;
}

/** The first stage (by position) of a kind — "Mark won" / "Mark lost" target. */
export async function stageOfKind(db: D1Database, kind: StageKind): Promise<Stage | null> {
	return db
		.prepare('SELECT * FROM pipeline_stages WHERE kind = ? ORDER BY position, id LIMIT 1')
		.bind(kind)
		.first<Stage>();
}

function cleanName(name: unknown): string | null {
	const n = String(name ?? '').trim().slice(0, NAME_MAX);
	return n || null;
}

export async function createStage(
	db: D1Database,
	input: { name: string; color?: string | null; kind?: StageKind }
): Promise<Result<{ id: number }>> {
	const name = cleanName(input.name);
	if (!name) return { ok: false, error: 'Stage name is required.' };
	const color: StageColor = isStageColor(input.color) ? input.color : 'muted';
	const kind: StageKind = input.kind === 'won' || input.kind === 'lost' ? input.kind : 'open';
	const row = await db
		.prepare(
			`INSERT INTO pipeline_stages (name, color, kind, position)
			 VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM pipeline_stages))
			 RETURNING id`
		)
		.bind(name, color, kind)
		.first<{ id: number }>();
	return { ok: true, id: row!.id };
}

async function openStageCount(db: D1Database): Promise<number> {
	const r = await db.prepare("SELECT COUNT(*) AS n FROM pipeline_stages WHERE kind = 'open'").first<{ n: number }>();
	return r?.n ?? 0;
}

export async function updateStage(
	db: D1Database,
	id: number,
	input: { name?: string; color?: string | null; kind?: StageKind }
): Promise<Result> {
	const stage = await getStage(db, id);
	if (!stage) return { ok: false, error: 'Stage not found.' };
	const name = input.name === undefined ? stage.name : cleanName(input.name);
	if (!name) return { ok: false, error: 'Stage name is required.' };
	const color = input.color === undefined ? stage.color : isStageColor(input.color) ? input.color : 'muted';
	let kind = stage.kind;
	if (input.kind !== undefined) {
		if (!['open', 'won', 'lost'].includes(input.kind)) return { ok: false, error: 'Unknown stage kind.' };
		kind = input.kind;
	}
	if (stage.kind === 'open' && kind !== 'open' && (await openStageCount(db)) <= 1) {
		return { ok: false, error: 'The pipeline needs at least one open stage.' };
	}
	await db
		.prepare('UPDATE pipeline_stages SET name = ?, color = ?, kind = ? WHERE id = ?')
		.bind(name, color, kind, id)
		.run();
	return { ok: true };
}

/** Set the stage order to `ids` (must name every stage exactly once). */
export async function reorderStages(db: D1Database, ids: number[]): Promise<Result> {
	const stages = await listStages(db);
	const known = new Set(stages.map((s) => s.id));
	if (ids.length !== stages.length || new Set(ids).size !== ids.length || !ids.every((i) => known.has(i))) {
		return { ok: false, error: 'Stage order is out of date — reload and try again.' };
	}
	await db.batch(ids.map((sid, i) => db.prepare('UPDATE pipeline_stages SET position = ? WHERE id = ?').bind(i, sid)));
	return { ok: true };
}

/** Move a stage one place up (-1) or down (+1) — the button/keyboard fallback for drag. */
export async function nudgeStage(db: D1Database, id: number, delta: -1 | 1): Promise<Result> {
	const ids = (await listStages(db)).map((s) => s.id);
	const i = ids.indexOf(id);
	if (i < 0) return { ok: false, error: 'Stage not found.' };
	const j = i + delta;
	if (j < 0 || j >= ids.length) return { ok: true };
	[ids[i], ids[j]] = [ids[j]!, ids[i]!];
	return reorderStages(db, ids);
}

/** Delete a stage. Cards in it (and history that points at it) move to `moveTo`, which is
 *  required when the stage has cards. The last open stage can't be deleted. */
export async function deleteStage(db: D1Database, id: number, moveTo: number | null): Promise<Result<{ moved: number }>> {
	const stage = await getStage(db, id);
	if (!stage) return { ok: false, error: 'Stage not found.' };
	if (stage.kind === 'open' && (await openStageCount(db)) <= 1) {
		return { ok: false, error: "The last open stage can't be deleted." };
	}
	const cards = await db
		.prepare('SELECT COUNT(*) AS n FROM pipeline_cards WHERE stage_id = ?')
		.bind(id)
		.first<{ n: number }>();
	const n = cards?.n ?? 0;
	if (moveTo === id) return { ok: false, error: 'Pick a different stage to move cards to.' };
	if (moveTo != null && !(await getStage(db, moveTo))) return { ok: false, error: 'Destination stage not found.' };
	if (n > 0 && moveTo == null) return { ok: false, error: 'This stage has cards — pick a stage to move them to.' };

	const stmts: D1PreparedStatement[] = [];
	if (moveTo != null) {
		// One 'system' history row per moved card. Rows never point at the deleted stage
		// (they're rewritten to the destination below), so the stage name goes in the note.
		stmts.push(
			db
				.prepare(
					`INSERT INTO pipeline_history (contact_id, from_stage_id, to_stage_id, actor_kind, actor_id, note)
					 SELECT contact_id, ?1, ?1, 'system', NULL, ?2 FROM pipeline_cards WHERE stage_id = ?3 ORDER BY position, id`
				)
				.bind(moveTo, `Moved here when stage “${stage.name}” was deleted.`.slice(0, NOTE_MAX), id)
		);
		// Moved cards land after the destination's existing cards, keeping their own order.
		stmts.push(
			db
				.prepare(
					`UPDATE pipeline_cards
					 SET stage_id = ?1,
					     position = position + 1 + (SELECT COALESCE(MAX(position), -1) FROM pipeline_cards WHERE stage_id = ?1),
					     updated_at = datetime('now')
					 WHERE stage_id = ?2`
				)
				.bind(moveTo, id),
			db.prepare('UPDATE pipeline_history SET from_stage_id = ? WHERE from_stage_id = ?').bind(moveTo, id),
			db.prepare('UPDATE pipeline_history SET to_stage_id = ? WHERE to_stage_id = ?').bind(moveTo, id)
		);
	}
	stmts.push(db.prepare('DELETE FROM pipeline_stages WHERE id = ?').bind(id));
	await db.batch(stmts);
	return { ok: true, moved: n };
}

// ---- cards ----

export type CardOpts = {
	value?: number | null;
	note?: string | null;
	owner?: number | null;
};

/** Parse a form/API value field: '' → null, '1,200' / '$1200' → 1200, junk → undefined. */
export function parseValue(v: unknown): number | null | undefined {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
	const s = String(v).replace(/[$,\s]/g, '');
	if (!s) return null;
	if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
	const n = Math.round(Number(s));
	return n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}

function historyStmt(db: D1Database, contactId: number, from: number | null, to: number | null, actor: Actor, note?: string | null) {
	return db
		.prepare(
			`INSERT INTO pipeline_history (contact_id, from_stage_id, to_stage_id, actor_kind, actor_id, note)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(contactId, from, to, actor.kind, actor.id ?? null, note ? String(note).slice(0, NOTE_MAX) : null);
}

type CardRow = { id: number; contact_id: number; stage_id: number; position: number };

/** #207: a card entered `stageId` (added, or moved from another stage) — fire the
 *  "Enters a pipeline stage" automation trigger. Best-effort: never fails the move. A stage
 *  deletion's bulk move (deleteStage) is not an entry and doesn't come through here. */
async function stageEntered(db: D1Database, contactId: number, stageId: number, actor: Actor): Promise<void> {
	try {
		await firePipelineStageTriggers(db, contactId, stageId, actor);
	} catch {
		/* best-effort — a trigger failure must never undo or fail the move */
	}
}

async function getCard(db: D1Database, contactId: number): Promise<CardRow | null> {
	return db
		.prepare('SELECT id, contact_id, stage_id, position FROM pipeline_cards WHERE contact_id = ?')
		.bind(contactId)
		.first<CardRow>();
}

/** Put a contact on the board. Already there → treated as a move to `stageId` (plus any
 *  value/note/owner given). */
export async function addToPipeline(
	db: D1Database,
	contactId: number,
	stageId: number,
	actor: Actor,
	opts: CardOpts = {},
	flags: { triggers?: boolean } = {} // false: don't fire stage-entered automations (the assistant, #301)
): Promise<Result<{ created: boolean }>> {
	if (!(await getStage(db, stageId))) return { ok: false, error: 'Stage not found.' };
	const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
	if (!contact) return { ok: false, error: 'Contact not found.' };

	const ins = await db
		.prepare(
			`INSERT INTO pipeline_cards (contact_id, stage_id, value, note, owner_user_id, position, entered_stage_at)
			 VALUES (?1, ?2, ?3, ?4, ?5,
			         (SELECT COALESCE(MAX(position), -1) + 1 FROM pipeline_cards WHERE stage_id = ?2),
			         datetime('now'))
			 ON CONFLICT(contact_id) DO NOTHING`
		)
		.bind(contactId, stageId, opts.value ?? null, opts.note ? opts.note.slice(0, NOTE_MAX) : null, opts.owner ?? null)
		.run();
	if (ins.meta.changes) {
		await historyStmt(db, contactId, null, stageId, actor).run();
		if (flags.triggers ?? true) await stageEntered(db, contactId, stageId, actor);
		return { ok: true, created: true };
	}
	const moved = await moveCard(db, contactId, stageId, actor, { triggers: flags.triggers });
	if (!moved.ok) return moved;
	const upd = await updateCard(db, contactId, opts);
	if (!upd.ok) return upd;
	return { ok: true, created: false };
}

/** Move a card to `stageId` (optionally to index `position` within that column, 0-based).
 *  A stage change stamps `entered_stage_at` and writes history; a same-column reorder doesn't. */
export async function moveCard(
	db: D1Database,
	contactId: number,
	stageId: number,
	actor: Actor,
	opts: { position?: number; note?: string | null; triggers?: boolean } = {}
): Promise<Result<{ changed: boolean }>> {
	const card = await getCard(db, contactId);
	if (!card) return { ok: false, error: 'Contact is not in the pipeline.' };
	if (!(await getStage(db, stageId))) return { ok: false, error: 'Stage not found.' };
	const stageChanged = card.stage_id !== stageId;
	if (!stageChanged && opts.position === undefined) return { ok: true, changed: false };

	const others = await db
		.prepare('SELECT id FROM pipeline_cards WHERE stage_id = ? AND id != ? ORDER BY position, id')
		.bind(stageId, card.id)
		.all<{ id: number }>();
	const order = others.results.map((r) => r.id);
	const at =
		opts.position === undefined || !Number.isFinite(opts.position)
			? order.length
			: Math.max(0, Math.min(order.length, Math.floor(opts.position)));
	order.splice(at, 0, card.id);

	const stmts: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE pipeline_cards
				 SET stage_id = ?1, updated_at = datetime('now'),
				     entered_stage_at = CASE WHEN stage_id = ?1 THEN entered_stage_at ELSE datetime('now') END
				 WHERE id = ?2`
			)
			.bind(stageId, card.id),
		...order.map((id, i) => db.prepare('UPDATE pipeline_cards SET position = ? WHERE id = ?').bind(i, id))
	];
	if (stageChanged) stmts.push(historyStmt(db, contactId, card.stage_id, stageId, actor, opts.note));
	await db.batch(stmts);
	if (stageChanged && (opts.triggers ?? true)) await stageEntered(db, contactId, stageId, actor);
	return { ok: true, changed: stageChanged };
}

export async function removeFromPipeline(
	db: D1Database,
	contactId: number,
	actor: Actor,
	note?: string | null
): Promise<Result<{ removed: boolean }>> {
	const card = await getCard(db, contactId);
	if (!card) return { ok: true, removed: false };
	await db.batch([
		db.prepare('DELETE FROM pipeline_cards WHERE id = ?').bind(card.id),
		historyStmt(db, contactId, card.stage_id, null, actor, note)
	]);
	return { ok: true, removed: true };
}

/** Edit value / note / owner. Key-present semantics: an omitted key is left alone, null clears. */
export async function updateCard(db: D1Database, contactId: number, opts: CardOpts): Promise<Result> {
	const sets: string[] = [];
	const binds: (string | number | null)[] = [];
	if (opts.value !== undefined) {
		sets.push('value = ?');
		binds.push(opts.value);
	}
	if (opts.note !== undefined) {
		sets.push('note = ?');
		binds.push(opts.note ? opts.note.slice(0, NOTE_MAX) : null);
	}
	if (opts.owner !== undefined) {
		if (opts.owner != null) {
			const u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(opts.owner).first();
			if (!u) return { ok: false, error: 'Owner not found.' };
		}
		sets.push('owner_user_id = ?');
		binds.push(opts.owner);
	}
	if (!sets.length) return { ok: true };
	const res = await db
		.prepare(`UPDATE pipeline_cards SET ${sets.join(', ')}, updated_at = datetime('now') WHERE contact_id = ?`)
		.bind(...binds, contactId)
		.run();
	if (!res.meta.changes) return { ok: false, error: 'Contact is not in the pipeline.' };
	return { ok: true };
}

// ---- reads ----

export type BoardCard = {
	id: number;
	contact_id: number;
	stage_id: number;
	stage_position: number;
	name: string;
	email: string;
	company: string | null;
	value: number | null;
	note: string | null;
	owner_user_id: number | null;
	owner_login: string | null;
	owner_name: string | null;
	position: number;
	entered_stage_at: string;
	days_in_stage: number;
	last_activity_at: string | null;
};

export type BoardStage = Stage & { cards: BoardCard[]; count: number; total: number };

const CARD_SELECT = `
	SELECT pc.id, pc.contact_id, pc.stage_id, s.position AS stage_position,
	       COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), c.email) AS name,
	       c.email, c.company, pc.value, pc.note, pc.owner_user_id,
	       u.github_login AS owner_login, u.name AS owner_name,
	       pc.position, pc.entered_stage_at,
	       CAST(MAX(0, julianday('now') - julianday(pc.entered_stage_at)) AS INTEGER) AS days_in_stage,
	       MAX(COALESCE((SELECT MAX(e.recorded_at) FROM events e WHERE e.contact_id = c.id), ''),
	           COALESCE((SELECT MAX(r.received_at) FROM replies r WHERE r.contact_id = c.id), '')) AS last_activity_at
	FROM pipeline_cards pc
	JOIN contacts c ON c.id = pc.contact_id
	JOIN pipeline_stages s ON s.id = pc.stage_id
	LEFT JOIN users u ON u.id = pc.owner_user_id`;

/** Board filter: `owner` = a user id, or 'none' for unassigned. `q` matches name/email/company. */
export type BoardFilter = { owner?: number | 'none' | null; q?: string | null };

export async function boardData(db: D1Database, filter: BoardFilter = {}): Promise<{ stages: BoardStage[]; count: number; total: number }> {
	const where: string[] = [];
	const binds: (string | number)[] = [];
	if (filter.owner === 'none') where.push('pc.owner_user_id IS NULL');
	else if (typeof filter.owner === 'number') {
		where.push('pc.owner_user_id = ?');
		binds.push(filter.owner);
	}
	const q = (filter.q ?? '').trim().slice(0, 100);
	if (q) {
		const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
		where.push(
			`(c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\'
			  OR TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) LIKE ? ESCAPE '\\')`
		);
		binds.push(like, like, like, like);
	}
	const [stages, cards] = await Promise.all([
		listStages(db),
		db
			.prepare(`${CARD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.position, pc.position, pc.id`)
			.bind(...binds)
			.all<BoardCard>()
	]);
	const byStage = new Map<number, BoardCard[]>();
	for (const card of cards.results) {
		if (!card.last_activity_at) card.last_activity_at = null;
		const list = byStage.get(card.stage_id) ?? [];
		list.push(card);
		byStage.set(card.stage_id, list);
	}
	const out = stages.map((s) => {
		const list = byStage.get(s.id) ?? [];
		return { ...s, cards: list, count: list.length, total: list.reduce((a, c) => a + (c.value ?? 0), 0) };
	});
	return {
		stages: out,
		count: cards.results.length,
		total: out.reduce((a, s) => a + s.total, 0)
	};
}

export type HistoryRow = {
	id: number;
	from_stage_id: number | null;
	to_stage_id: number | null;
	from_name: string | null;
	to_name: string | null;
	actor_kind: ActorKind;
	actor_id: number | null;
	actor_label: string | null;
	note: string | null;
	created_at: string;
};

export async function historyFor(db: D1Database, contactId: number, limit = 5): Promise<HistoryRow[]> {
	const rows = await db
		.prepare(
			`SELECT h.id, h.from_stage_id, h.to_stage_id, fs.name AS from_name, ts.name AS to_name,
			        h.actor_kind, h.actor_id, h.note, h.created_at,
			        CASE h.actor_kind
			          WHEN 'user' THEN (SELECT '@' || github_login FROM users WHERE id = h.actor_id)
			          WHEN 'automation' THEN (SELECT name FROM automations WHERE id = h.actor_id)
			          ELSE NULL END AS actor_label
			 FROM pipeline_history h
			 LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id
			 LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id
			 WHERE h.contact_id = ?
			 ORDER BY h.id DESC LIMIT ?`
		)
		.bind(contactId, limit)
		.all<HistoryRow>();
	return rows.results;
}

/** The contact's card (with its stage) + recent history, for the contact page. */
export async function cardFor(
	db: D1Database,
	contactId: number,
	historyLimit = 5
): Promise<{ card: (BoardCard & { stage_name: string; stage_color: string | null; stage_kind: StageKind }) | null; history: HistoryRow[] }> {
	const card = await db
		.prepare(
			`SELECT * FROM (${CARD_SELECT} WHERE pc.contact_id = ?) x
			 JOIN (SELECT id AS sid, name AS stage_name, color AS stage_color, kind AS stage_kind FROM pipeline_stages) st
			   ON st.sid = x.stage_id`
		)
		.bind(contactId)
		.first<BoardCard & { stage_name: string; stage_color: string | null; stage_kind: StageKind }>();
	if (card && !card.last_activity_at) card.last_activity_at = null;
	return { card: card ?? null, history: await historyFor(db, contactId, historyLimit) };
}

/** Active users, for the owner pickers. */
export async function ownerOptions(db: D1Database): Promise<{ id: number; github_login: string; name: string | null }[]> {
	const rows = await db
		.prepare('SELECT id, github_login, name FROM users WHERE disabled_at IS NULL ORDER BY github_login COLLATE NOCASE')
		.all<{ id: number; github_login: string; name: string | null }>();
	return rows.results;
}
