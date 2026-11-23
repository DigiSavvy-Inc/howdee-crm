// #332: multi-group campaign audiences — include several lists / segments (union, one email
// per contact) and optionally exclude others. Stored in `campaign_audiences` (migration 0089);
// `campaigns.list_id` mirrors the first include. A campaign with no rows falls back to its
// legacy `list_id`, so campaigns written before 0089 (or by code that only sets list_id)
// resolve exactly as before. Imports nothing that sends or schedules (the assistant and the
// Data API read through it).
import { memberIds, recipientsForList, type ListRow, type SendableRow } from './segments';
import { audienceLabel, type AudienceGroup, type AudienceView } from '$lib/campaign-audience';
import { optedOutIds } from './topics';

export type Audience = { include: number[]; exclude: number[] };

export const MAX_AUDIENCE_GROUPS = 20;
export const EMPTY_AUDIENCE: Audience = { include: [], exclude: [] };

function ids(raw: unknown[]): number[] {
	const out: number[] = [];
	for (const v of raw) {
		const n = typeof v === 'number' ? v : Number(v);
		if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
	}
	return out.slice(0, MAX_AUDIENCE_GROUPS);
}

/** De-duplicated, capped; a group both included and excluded is excluded. */
export function normalizeAudience(a: { include?: unknown[]; exclude?: unknown[] }): Audience {
	const exclude = ids(a.exclude ?? []);
	return { include: ids(a.include ?? []).filter((id) => !exclude.includes(id)), exclude };
}

/** Compose fields: `include_id` / `exclude_id` (repeated); a bare `list_id` still works. */
export function audienceFromForm(data: FormData): Audience {
	const include = data.getAll('include_id');
	if (!include.length && data.get('list_id')) include.push(data.get('list_id')!);
	return normalizeAudience({ include, exclude: data.getAll('exclude_id') });
}

export const sameAudience = (a: Audience, b: Audience) =>
	a.include.join(',') === b.include.join(',') && a.exclude.join(',') === b.exclude.join(',');

/** Only groups compose offers (lists and segments) that still exist, order kept. */
export async function existingGroups(db: D1Database, a: Audience): Promise<{ audience: Audience; missing: number[] }> {
	const all = [...a.include, ...a.exclude];
	if (!all.length) return { audience: EMPTY_AUDIENCE, missing: [] };
	const rows = await db
		.prepare("SELECT id FROM lists WHERE kind IN ('list', 'segment') AND id IN (SELECT value FROM json_each(?))")
		.bind(JSON.stringify(all))
		.all<{ id: number }>();
	const ok = new Set(rows.results.map((r) => r.id));
	return {
		audience: { include: a.include.filter((id) => ok.has(id)), exclude: a.exclude.filter((id) => ok.has(id)) },
		missing: all.filter((id) => !ok.has(id))
	};
}

type AudienceRow = { campaign_id: number; list_id: number; mode: string };

function fromRows(rows: AudienceRow[], legacyListId: number | null | undefined): Audience {
	if (!rows.length) return legacyListId ? { include: [legacyListId], exclude: [] } : { include: [], exclude: [] };
	return {
		include: rows.filter((r) => r.mode === 'include').map((r) => r.list_id),
		exclude: rows.filter((r) => r.mode === 'exclude').map((r) => r.list_id)
	};
}

/** A campaign's audience (legacy `list_id` when it has no rows). */
export async function readAudience(db: D1Database, campaignId: number, legacyListId?: number | null): Promise<Audience> {
	const rows = await db
		.prepare('SELECT campaign_id, list_id, mode FROM campaign_audiences WHERE campaign_id = ? ORDER BY position, rowid')
		.bind(campaignId)
		.all<AudienceRow>();
	if (!rows.results.length && legacyListId === undefined) {
		const c = await db.prepare('SELECT list_id FROM campaigns WHERE id = ?').bind(campaignId).first<{ list_id: number | null }>();
		return fromRows([], c?.list_id);
	}
	return fromRows(rows.results, legacyListId);
}

/** Audiences of many campaigns at once (rows carry their legacy list_id). */
export async function readAudiences(db: D1Database, campaigns: { id: number; list_id: number | null }[]): Promise<Map<number, Audience>> {
	const out = new Map<number, Audience>();
	if (!campaigns.length) return out;
	const byCampaign = new Map<number, AudienceRow[]>();
	for (let i = 0; i < campaigns.length; i += 500) {
		const rows = await db
			.prepare(
				`SELECT campaign_id, list_id, mode FROM campaign_audiences
				 WHERE campaign_id IN (SELECT value FROM json_each(?)) ORDER BY campaign_id, position, rowid`
			)
			.bind(JSON.stringify(campaigns.slice(i, i + 500).map((c) => c.id)))
			.all<AudienceRow>();
		for (const r of rows.results) {
			const list = byCampaign.get(r.campaign_id) ?? [];
			list.push(r);
			byCampaign.set(r.campaign_id, list);
		}
	}
	for (const c of campaigns) out.set(c.id, fromRows(byCampaign.get(c.id) ?? [], c.list_id));
	return out;
}

/** Statements that replace a campaign's audience and keep `list_id` = the first include. */
export function audienceStatements(db: D1Database, campaignId: number, a: Audience): D1PreparedStatement[] {
	const stmts = [db.prepare('DELETE FROM campaign_audiences WHERE campaign_id = ?').bind(campaignId)];
	const ins = db.prepare('INSERT OR IGNORE INTO campaign_audiences (campaign_id, list_id, mode, position) VALUES (?, ?, ?, ?)');
	a.include.forEach((id, i) => stmts.push(ins.bind(campaignId, id, 'include', i)));
	a.exclude.forEach((id, i) => stmts.push(ins.bind(campaignId, id, 'exclude', i)));
	stmts.push(db.prepare('UPDATE campaigns SET list_id = ? WHERE id = ?').bind(a.include[0] ?? null, campaignId));
	return stmts;
}

export async function writeAudience(db: D1Database, campaignId: number, a: Audience): Promise<void> {
	await db.batch(audienceStatements(db, campaignId, a));
}

async function listRows(db: D1Database, idList: number[]): Promise<ListRow[]> {
	if (!idList.length) return [];
	const rows = await db
		.prepare('SELECT id, kind, rules FROM lists WHERE id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(idList))
		.all<ListRow>();
	const byId = new Map(rows.results.map((r) => [r.id, r]));
	return idList.map((id) => byId.get(id)).filter((r): r is ListRow => !!r);
}

/** Every member (any subscription state) of the excluded groups. */
async function excludedIds(db: D1Database, exclude: number[]): Promise<Set<number>> {
	const out = new Set<number>();
	for (const list of await listRows(db, exclude)) for (const id of await memberIds(db, list)) out.add(id);
	return out;
}

/** Send recipients: the union of the included groups (one row per contact) minus every member
 *  of an excluded group. Subscribed / archived rules are recipientsForList's, unchanged. */
export async function recipientsForAudience(db: D1Database, a: Audience, opts: { topicId?: number | null } = {}): Promise<SendableRow[]> {
	const seen = new Map<number, SendableRow>();
	for (const id of a.include) {
		for (const r of await recipientsForList(db, id, opts)) if (!seen.has(r.id)) seen.set(r.id, r);
	}
	if (seen.size && a.exclude.length) for (const id of await excludedIds(db, a.exclude)) seen.delete(id);
	return [...seen.values()];
}

/** Contact ids of every member of the included groups (any subscription state) — for the
 *  pre-send "who was left out" stats. */
export async function includedMemberIds(db: D1Database, a: Audience): Promise<number[]> {
	const out = new Set<number>();
	for (const list of await listRows(db, a.include)) for (const id of await memberIds(db, list)) out.add(id);
	return [...out];
}

/** How many contacts a send would reach now (same rules as recipientsForAudience). */
export async function audienceCount(db: D1Database, a: Audience, opts: { topicId?: number | null } = {}): Promise<number> {
	const seen = new Set<number>();
	for (const list of await listRows(db, a.include)) for (const id of await memberIds(db, list, true)) seen.add(id);
	if (seen.size && a.exclude.length) for (const id of await excludedIds(db, a.exclude)) seen.delete(id);
	// #414: contacts who opted out of the email's topic are left out too.
	if (seen.size && opts.topicId) for (const id of await optedOutIds(db, [...seen], opts.topicId)) seen.delete(id);
	return seen.size;
}

/** Group names for display; unknown (deleted) ids are dropped. */
export async function audienceViews(db: D1Database, audiences: Audience[]): Promise<AudienceView[]> {
	const all = [...new Set(audiences.flatMap((a) => [...a.include, ...a.exclude]))];
	const byId = new Map<number, AudienceGroup>();
	for (let i = 0; i < all.length; i += 500) {
		const rows = await db
			.prepare('SELECT id, name, kind FROM lists WHERE id IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(all.slice(i, i + 500)))
			.all<AudienceGroup>();
		for (const r of rows.results) byId.set(r.id, r);
	}
	const pick = (idList: number[]) => idList.map((id) => byId.get(id)).filter((g): g is AudienceGroup => !!g);
	return audiences.map((a) => ({ include: pick(a.include), exclude: pick(a.exclude) }));
}

/** "Customers + Newsletter, excluding VIP" for the campaigns whose audience is more than one
 *  group (single-group campaigns are left out — their list name is the label already). */
export async function multiGroupLabels(db: D1Database, campaigns: { id: number; list_id: number | null }[]): Promise<Map<number, string>> {
	const map = await readAudiences(db, campaigns.filter((c) => c.list_id != null));
	const multi = [...map].filter(([, a]) => a.include.length > 1 || a.exclude.length);
	const views = await audienceViews(db, multi.map(([, a]) => a));
	return new Map(multi.map(([id], i) => [id, audienceLabel(views[i])]));
}

export async function audienceView(db: D1Database, a: Audience): Promise<AudienceView> {
	return (await audienceViews(db, [a]))[0];
}
