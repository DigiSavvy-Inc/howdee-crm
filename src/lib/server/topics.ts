// #414: subscription topics (lists with kind = 'list' AND public_topic = 1) — what the
// preference page shows, the topic an email belongs to, and topic opt-outs
// (`topic_optouts`) that every send path for that topic honours. Imports nothing that sends.
import { topicDisplay, topicWarnings, type TopicWarning } from '$lib/topics';
import type { Audience } from './campaign-audience';
import { activeContactSql } from './active-audience';

export type TopicRow = {
	id: number;
	name: string;
	topic_label: string | null;
	topic_blurb: string | null;
	topic_order: number | null;
	origin: string | null;
};

export type PublicTopic = { id: number; label: string; blurb: string | null; subscribed: boolean };

const TOPIC_WHERE = "l.kind = 'list' AND l.public_topic = 1";
const TOPIC_ORDER = 'ORDER BY l.topic_order IS NULL, l.topic_order, COALESCE(l.topic_label, l.name) COLLATE NOCASE, l.id';

/** #448: every topic list for an operator picker (rule builders, Contacts filter) — the
 *  subscriber-facing label, else the list name. */
export async function topicPicker(db: D1Database): Promise<{ id: number; label: string }[]> {
	return (await topicRows(db)).map((t) => ({ id: t.id, label: (t.topic_label ?? '').trim() || t.name }));
}

/** Every topic list, in page order (incl. ones the page skips). */
export async function topicRows(db: D1Database): Promise<TopicRow[]> {
	const rows = await db
		.prepare(`SELECT l.id, l.name, l.topic_label, l.topic_blurb, l.topic_order, l.origin FROM lists l WHERE ${TOPIC_WHERE} ${TOPIC_ORDER}`)
		.all<TopicRow>();
	return rows.results;
}

/** The topics a subscriber sees (label + blurb, never name / description), each marked
 *  `subscribed` when the contact is a member. `contactId` null = nobody (all unticked). */
export async function publicTopics(db: D1Database, contactId: number | null): Promise<PublicTopic[]> {
	const rows = await db
		.prepare(
			`SELECT l.id, l.name, l.topic_label, l.topic_blurb,
			        EXISTS (SELECT 1 FROM list_members lm WHERE lm.list_id = l.id AND lm.contact_id = ?) AS subscribed
			 FROM lists l WHERE ${TOPIC_WHERE} ${TOPIC_ORDER}`
		)
		.bind(contactId ?? -1)
		.all<{ id: number; name: string; topic_label: string | null; topic_blurb: string | null; subscribed: number }>();
	const out: PublicTopic[] = [];
	for (const r of rows.results) {
		const d = topicDisplay(r);
		if (d) out.push({ id: r.id, label: d.label, blurb: d.blurb, subscribed: !!r.subscribed });
	}
	return out;
}

export type TopicAdminRow = TopicRow & { members: number; label: string | null; warnings: TopicWarning[] };

/** Settings → Unsubscribe page → Topics: every topic list with its member count + warnings. */
export async function topicAdminRows(db: D1Database): Promise<TopicAdminRow[]> {
	const rows = await db
		.prepare(
			`SELECT l.id, l.name, l.topic_label, l.topic_blurb, l.topic_order, l.origin,
			        (SELECT COUNT(*) FROM list_members lm JOIN contacts c ON c.id = lm.contact_id
			         WHERE lm.list_id = l.id AND ${activeContactSql('c')}) AS members
			 FROM lists l WHERE ${TOPIC_WHERE} ${TOPIC_ORDER}`
		)
		.all<TopicRow & { members: number }>();
	return rows.results.map((r) => ({ ...r, label: topicDisplay(r)?.label ?? null, warnings: topicWarnings(r) }));
}

/** Drag-to-reorder: topic_order = position for the given ids (topic lists only). */
export async function reorderTopics(db: D1Database, ids: number[]): Promise<void> {
	const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
	if (!clean.length) return;
	await db.batch(
		clean.map((id, i) => db.prepare(`UPDATE lists SET topic_order = ? WHERE id = ? AND kind = 'list' AND public_topic = 1`).bind(i, id))
	);
}

async function isTopic(db: D1Database, id: number): Promise<boolean> {
	return !!(await db.prepare(`SELECT 1 FROM lists l WHERE l.id = ? AND ${TOPIC_WHERE}`).bind(id).first());
}

/** The topic an email belongs to: an explicit choice (> 0), none (0), or automatic (null) =
 *  the first included group when it is a topic list. */
export async function resolveTopicId(db: D1Database, explicit: number | null | undefined, audience: Audience | null): Promise<number | null> {
	if (explicit != null) return explicit > 0 ? explicit : null;
	const first = audience?.include[0];
	return first && (await isTopic(db, first)) ? first : null;
}

/** A stored campaign's topic: its own choice, else its automation's (step sends), else the
 *  first included group when that is a topic list. */
export async function campaignTopicId(db: D1Database, campaignId: number): Promise<number | null> {
	const c = await db
		.prepare(
			`SELECT c.topic_list_id, c.list_id, a.topic_list_id AS automation_topic
			 FROM campaigns c LEFT JOIN automations a ON a.id = c.automation_id WHERE c.id = ?`
		)
		.bind(campaignId)
		.first<{ topic_list_id: number | null; list_id: number | null; automation_topic: number | null }>();
	if (!c) return null;
	if (c.topic_list_id != null) return c.topic_list_id > 0 ? c.topic_list_id : null;
	if (c.automation_topic) return c.automation_topic;
	const first = await db
		.prepare(`SELECT list_id FROM campaign_audiences WHERE campaign_id = ? AND mode = 'include' ORDER BY position, rowid LIMIT 1`)
		.bind(campaignId)
		.first<{ list_id: number }>();
	const id = first?.list_id ?? c.list_id;
	return id && (await isTopic(db, id)) ? id : null;
}

/** A topic's public label (null when the page would skip it). */
export async function topicLabel(db: D1Database, id: number | null): Promise<string | null> {
	if (!id) return null;
	const r = await db
		.prepare(`SELECT l.name, l.topic_label, l.topic_blurb FROM lists l WHERE l.id = ? AND ${TOPIC_WHERE}`)
		.bind(id)
		.first<{ name: string; topic_label: string | null; topic_blurb: string | null }>();
	return r ? (topicDisplay(r)?.label ?? null) : null;
}

/** Ids (of `ids`) that opted out of `topicId`. */
export async function optedOutIds(db: D1Database, ids: number[], topicId: number | null): Promise<Set<number>> {
	const out = new Set<number>();
	if (!topicId || !ids.length) return out;
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await db
			.prepare('SELECT contact_id FROM topic_optouts WHERE list_id = ? AND contact_id IN (SELECT value FROM json_each(?))')
			.bind(topicId, JSON.stringify(ids.slice(i, i + 500)))
			.all<{ contact_id: number }>();
		for (const r of rows.results) out.add(r.contact_id);
	}
	return out;
}

/** Drop the rows whose contact opted out of `topicId`. */
export async function withoutOptedOut<T extends { id: number | null }>(db: D1Database, rows: T[], topicId: number | null): Promise<T[]> {
	if (!topicId || !rows.length) return rows;
	const out = await optedOutIds(db, rows.map((r) => r.id).filter((id): id is number => id != null), topicId);
	return out.size ? rows.filter((r) => r.id == null || !out.has(r.id)) : rows;
}

export async function contactOptedOut(db: D1Database, contactId: number, topicId: number | null): Promise<boolean> {
	if (!topicId) return false;
	return !!(await db.prepare('SELECT 1 FROM topic_optouts WHERE contact_id = ? AND list_id = ?').bind(contactId, topicId).first());
}

/**
 * Save the preference page's topic choices for one contact (`keep` = ticked topic ids).
 * Ticked → member, opt-out removed. Unticked and a member before → membership removed and
 * an opt-out written (so segments that include them skip this topic too). Unticked and not a
 * member → left as it was. Returns the ticked topic ids that exist.
 */
export async function saveTopicChoices(db: D1Database, contactId: number, topicIds: number[], keep: Set<number>): Promise<number[]> {
	return (await saveTopicChanges(db, contactId, topicIds, keep)).kept;
}

/**
 * `saveTopicChoices` plus what really changed (#444): `optedOut` = topics they were in and
 * unticked, `optedIn` = ticked topics they weren't in (or had opted out of). The "Subscription
 * changes" trigger fires from these (`saveTopicChoicesAndFire` in subscription-trigger.ts —
 * this module stays free of the engine, campaign-audience imports it).
 */
export async function saveTopicChanges(
	db: D1Database,
	contactId: number,
	topicIds: number[],
	keep: Set<number>
): Promise<{ kept: number[]; optedOut: number[]; optedIn: number[] }> {
	const kept: number[] = [];
	const stmts: D1PreparedStatement[] = [];
	// #444: what the contact had before, so only a real change is reported.
	const before = topicIds.length
		? await db
				.prepare(
					`SELECT l.value AS id,
					        EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.value AND m.contact_id = ?) AS member,
					        EXISTS (SELECT 1 FROM topic_optouts o WHERE o.list_id = l.value AND o.contact_id = ?) AS optout
					 FROM json_each(?) l`
				)
				.bind(contactId, contactId, JSON.stringify(topicIds))
				.all<{ id: number; member: number; optout: number }>()
		: { results: [] };
	const was = new Map(before.results.map((r) => [Number(r.id), r]));
	for (const id of topicIds) {
		if (keep.has(id)) {
			kept.push(id);
			stmts.push(db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(id, contactId));
			stmts.push(db.prepare('DELETE FROM topic_optouts WHERE contact_id = ? AND list_id = ?').bind(contactId, id));
		} else {
			// Only a topic they were in counts as unticked — the INSERT runs before the DELETE.
			stmts.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO topic_optouts (contact_id, list_id)
						 SELECT ?, ? WHERE EXISTS (SELECT 1 FROM list_members WHERE list_id = ? AND contact_id = ?)`
					)
					.bind(contactId, id, id, contactId)
			);
			stmts.push(db.prepare('DELETE FROM list_members WHERE list_id = ? AND contact_id = ?').bind(id, contactId));
		}
	}
	if (stmts.length) await db.batch(stmts);
	const optedOut: number[] = [];
	const optedIn: number[] = [];
	for (const id of topicIds) {
		const w = was.get(id);
		if (keep.has(id) && (!w?.member || w.optout)) optedIn.push(id);
		else if (!keep.has(id) && w?.member) optedOut.push(id);
	}
	return { kept, optedOut, optedIn };
}
