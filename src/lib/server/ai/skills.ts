// Assistant skills (#302): operator-authored instruction documents in `ai_skills`
// (migration 0079). Always-on bodies go into every system prompt; on-demand skills are only
// listed there by name + description and fetched with the load_skill tool. Disabled skills
// are invisible to the assistant. Order everywhere = sort, then name, so the prompt is
// deterministic (prompt caching) and only changes when a skill does.

import type { SkillInput, SkillMode } from '$lib/ai-skills';
import { normalizeSkillName } from '$lib/ai-skills';

export type SkillRow = {
	id: number;
	name: string;
	description: string;
	body: string;
	mode: SkillMode;
	enabled: number;
	sort: number;
	created_by: number | null;
	updated_by: number | null;
	created_at: string;
	updated_at: string;
	updated_by_login: string | null;
};

const SELECT = `SELECT s.*, u.github_login AS updated_by_login
	FROM ai_skills s LEFT JOIN users u ON u.id = s.updated_by`;
const ORDER = 'ORDER BY s.sort, s.name';

export async function listSkills(db: D1Database): Promise<SkillRow[]> {
	return (await db.prepare(`${SELECT} ${ORDER}`).all<SkillRow>()).results;
}

export async function getSkill(db: D1Database, id: number): Promise<SkillRow | null> {
	return db.prepare(`${SELECT} WHERE s.id = ?`).bind(id).first<SkillRow>();
}

export type PromptSkills = {
	always: { name: string; body: string }[];
	onDemand: { name: string; description: string }[];
};

/** The enabled skills the system prompt needs, in prompt order. */
export async function promptSkills(db: D1Database): Promise<PromptSkills> {
	const rows = (
		await db
			.prepare(`SELECT name, description, body, mode FROM ai_skills WHERE enabled = 1 ORDER BY sort, name`)
			.all<{ name: string; description: string; body: string; mode: SkillMode }>()
	).results;
	return {
		always: rows.filter((r) => r.mode === 'always').map((r) => ({ name: r.name, body: r.body })),
		onDemand: rows.filter((r) => r.mode === 'on_demand').map((r) => ({ name: r.name, description: r.description }))
	};
}

/** load_skill: an enabled skill by name (case-insensitive), else null. */
export async function enabledSkillByName(db: D1Database, name: string): Promise<{ name: string; description: string; body: string; mode: SkillMode } | null> {
	const n = normalizeSkillName(name);
	if (!n) return null;
	return db
		.prepare(`SELECT name, description, body, mode FROM ai_skills WHERE name = ? COLLATE NOCASE AND enabled = 1`)
		.bind(n)
		.first();
}

/** Names of enabled skills (for load_skill's "unknown skill" error). */
export async function enabledSkillNames(db: D1Database): Promise<string[]> {
	return (await db.prepare(`SELECT name FROM ai_skills WHERE enabled = 1 ORDER BY sort, name`).all<{ name: string }>()).results.map((r) => r.name);
}

async function nameTaken(db: D1Database, name: string, exceptId: number | null): Promise<boolean> {
	const row = await db
		.prepare(`SELECT id FROM ai_skills WHERE name = ? COLLATE NOCASE AND id != ?`)
		.bind(name, exceptId ?? 0)
		.first<{ id: number }>();
	return !!row;
}

const TAKEN = (name: string) => `A skill named "${name}" already exists.`;

export async function createSkill(db: D1Database, s: SkillInput, userId: number | null): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
	if (await nameTaken(db, s.name, null)) return { ok: false, error: TAKEN(s.name) };
	try {
		const row = await db
			.prepare(
				`INSERT INTO ai_skills (name, description, body, mode, enabled, sort, created_by, updated_by)
				 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM ai_skills), ?, ?) RETURNING id`
			)
			.bind(s.name, s.description, s.body, s.mode, s.enabled ? 1 : 0, userId, userId)
			.first<{ id: number }>();
		return { ok: true, id: row!.id };
	} catch (e) {
		if (e instanceof Error && /UNIQUE/i.test(e.message)) return { ok: false, error: TAKEN(s.name) };
		throw e;
	}
}

export async function updateSkill(db: D1Database, id: number, s: SkillInput, userId: number | null): Promise<{ ok: true } | { ok: false; error: string }> {
	if (await nameTaken(db, s.name, id)) return { ok: false, error: TAKEN(s.name) };
	try {
		const r = await db
			.prepare(
				`UPDATE ai_skills SET name = ?, description = ?, body = ?, mode = ?, enabled = ?, updated_by = ?,
				 updated_at = datetime('now') WHERE id = ?`
			)
			.bind(s.name, s.description, s.body, s.mode, s.enabled ? 1 : 0, userId, id)
			.run();
		return r.meta.changes ? { ok: true } : { ok: false, error: 'That skill no longer exists.' };
	} catch (e) {
		if (e instanceof Error && /UNIQUE/i.test(e.message)) return { ok: false, error: TAKEN(s.name) };
		throw e;
	}
}

export async function setSkillEnabled(db: D1Database, id: number, enabled: boolean, userId: number | null): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE ai_skills SET enabled = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
		.bind(enabled ? 1 : 0, userId, id)
		.run();
	return !!r.meta.changes;
}

/** A copy named "<name>-copy" (then -copy-2, …), disabled, placed right after the original. */
export async function duplicateSkill(db: D1Database, id: number, userId: number | null): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
	const src = await getSkill(db, id);
	if (!src) return { ok: false, error: 'That skill no longer exists.' };
	let name = `${src.name}-copy`.slice(0, 64);
	for (let i = 2; (await nameTaken(db, name, null)) && i < 100; i++) name = `${src.name.slice(0, 55)}-copy-${i}`;
	const created = await createSkill(db, { name, description: src.description, body: src.body, mode: src.mode, enabled: false }, userId);
	if (!created.ok) return created;
	await placeAfter(db, created.id, id);
	return created;
}

export async function deleteSkill(db: D1Database, id: number): Promise<boolean> {
	const r = await db.prepare(`DELETE FROM ai_skills WHERE id = ?`).bind(id).run();
	return !!r.meta.changes;
}

/** Rewrite sort as 1..n in the given (complete) id order. */
async function writeOrder(db: D1Database, ids: number[]): Promise<void> {
	if (!ids.length) return;
	await db.batch(ids.map((id, i) => db.prepare(`UPDATE ai_skills SET sort = ? WHERE id = ?`).bind(i + 1, id)));
}

async function orderedIds(db: D1Database): Promise<number[]> {
	return (await db.prepare(`SELECT id FROM ai_skills ORDER BY sort, name`).all<{ id: number }>()).results.map((r) => r.id);
}

async function placeAfter(db: D1Database, id: number, afterId: number): Promise<void> {
	const ids = (await orderedIds(db)).filter((x) => x !== id);
	const at = ids.indexOf(afterId);
	ids.splice(at < 0 ? ids.length : at + 1, 0, id);
	await writeOrder(db, ids);
}

/** Move one skill up (-1) or down (+1) in the order. False when it can't move. */
export async function moveSkill(db: D1Database, id: number, dir: -1 | 1): Promise<boolean> {
	const ids = await orderedIds(db);
	const i = ids.indexOf(id);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= ids.length) return false;
	[ids[i], ids[j]] = [ids[j], ids[i]];
	await writeOrder(db, ids);
	return true;
}
