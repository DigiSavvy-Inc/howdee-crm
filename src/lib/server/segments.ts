import { compileSegment, parseRules } from './segment-query';
import { activeContactSql, segmentAudienceSql } from './active-audience';

// Membership resolution (#66) — one place that knows whether a list/segment is
// hand-picked (list_members) or dynamic (rules computed against the live contact set).

export type ListRow = { id: number; kind: string; rules?: string | null };

/** Columns every send recipient needs (incl. tags + meta for conditional content). */
export const RECIPIENT_COLS = `c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.meta,
	(SELECT GROUP_CONCAT(l.name) FROM list_members lm2 JOIN lists l ON l.id = lm2.list_id
	   WHERE lm2.contact_id = c.id AND l.kind = 'tag') AS tags`;

export type SendableRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
	meta: string | null;
	tags: string | null;
};

/** #414: leaves out contacts who opted out of the email's topic on the preference page. */
const NOT_OPTED_OUT = 'AND NOT EXISTS (SELECT 1 FROM topic_optouts t WHERE t.contact_id = c.id AND t.list_id = ?)';

/** Subscribed, non-archived (#280) recipients for a list/segment — dynamic segments resolved from rules.
 *  `topicId` (#414): the email's topic — anyone with a topic opt-out for it is left out. */
export async function recipientsForList(db: D1Database, listId: number, opts: { topicId?: number | null } = {}): Promise<SendableRow[]> {
	const list = await db
		.prepare("SELECT id, kind, rules FROM lists WHERE id = ?")
		.bind(listId)
		.first<ListRow>();
	if (!list) return [];
	const topic = opts.topicId ? NOT_OPTED_OUT : '';
	const topicBind = opts.topicId ? [opts.topicId] : [];

	const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
	if (rules) {
		const c = compileSegment(rules);
		const sql = `SELECT ${RECIPIENT_COLS} FROM contacts c WHERE c.id IN (${c.sql}) AND c.subscribed = 1 AND c.archived_at IS NULL ${topic}`;
		return (await db.prepare(sql).bind(...c.binds, ...topicBind).all<SendableRow>()).results;
	}
	const sql = `SELECT ${RECIPIENT_COLS} FROM contacts c
		JOIN list_members lm ON lm.contact_id = c.id
		WHERE lm.list_id = ? AND c.subscribed = 1 AND c.archived_at IS NULL ${topic}`;
	return (await db.prepare(sql).bind(listId, ...topicBind).all<SendableRow>()).results;
}

/** Contact ids in a list/segment (for enrollment). `subscribedOnly` filters. Archived
 *  contacts (#280) are never members (dynamic segments exclude them in compileSegment). */
export async function memberIds(db: D1Database, list: ListRow, subscribedOnly = false): Promise<number[]> {
	const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
	const sub = subscribedOnly ? ' AND c.subscribed = 1' : '';
	if (rules) {
		const c = compileSegment(rules);
		const rows = await db.prepare(c.sql + sub).bind(...c.binds).all<{ id: number }>();
		return rows.results.map((r) => r.id);
	}
	const rows = await db
		.prepare(`SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE lm.list_id = ? AND c.archived_at IS NULL${sub}`)
		.bind(list.id)
		.all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

/** #705: the "N contacts" of a group — the active audience (not archived, subscribed or pending;
 *  a rules segment that asks about subscription counts what its rules match). A view count:
 *  sends and enrolment use `recipientsForList` / `memberIds`. */
export async function activeMemberCount(db: D1Database, list: ListRow): Promise<number> {
	const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
	if (rules) {
		const c = compileSegment(rules);
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE c.id IN (${c.sql}) AND ${segmentAudienceSql(rules, 'c')}`)
			.bind(...c.binds)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE lm.list_id = ? AND ${activeContactSql('c')}`)
		.bind(list.id)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** #705: `ids` (members of `list`) narrowed to the active audience, order kept — for "people" reads. */
export async function activeOnly(db: D1Database, list: ListRow, ids: number[]): Promise<number[]> {
	if (!ids.length) return ids;
	const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
	const keep = new Set<number>();
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await db
			.prepare(`SELECT c.id FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?)) AND ${segmentAudienceSql(rules, 'c')}`)
			.bind(JSON.stringify(ids.slice(i, i + 500)))
			.all<{ id: number }>();
		for (const r of rows.results) keep.add(r.id);
	}
	return ids.filter((id) => keep.has(id));
}

/** Subscribed-member count for a list/segment (dynamic computed). */
export async function memberCount(db: D1Database, list: ListRow): Promise<number> {
	const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
	if (rules) {
		const c = compileSegment(rules);
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM (${c.sql} AND c.subscribed = 1)`)
			.bind(...c.binds)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM list_members lm JOIN contacts c ON c.id = lm.contact_id
			 WHERE lm.list_id = ? AND c.subscribed = 1 AND c.archived_at IS NULL`
		)
		.bind(list.id)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
