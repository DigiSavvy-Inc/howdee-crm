// #72/#73: shared helpers for the /api/v1 Data API — auth gate, response envelopes,
// pagination, and resource serialization. Keep route handlers thin and consistent.
import { json, type RequestEvent } from '@sveltejs/kit';
import { authenticateApiKey, type ApiScope, type ApiKeyRow } from '$lib/server/api-keys';
import { compileSegment, parseRules } from '$lib/server/segment-query';

/** Gate a request on an API key with at least `scope`. Returns the key, or a ready Response. */
export async function requireKey(
	event: RequestEvent,
	scope: ApiScope
): Promise<{ key: ApiKeyRow } | { response: Response }> {
	const res = await authenticateApiKey(event, scope);
	if (!res.ok) return { response: apiError(res.status, res.error) };
	return { key: res.key };
}

/** A `{ data }` (or `{ data, pagination }`) success envelope. */
export function apiData(data: unknown, pagination?: Pagination): Response {
	return json(pagination ? { data, pagination } : { data });
}

/** A `{ error }` envelope with the given status. */
export function apiError(status: number, error: string): Response {
	return json({ error }, { status });
}

export type Pagination = { limit: number; offset: number; total: number; has_more: boolean };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Parse `limit`/`offset` query params, clamped to sane bounds. Floor BEFORE the >0 check —
 * `?limit=0.5` must fall back to the default, not become LIMIT 0 (which, combined with
 * has_more, would send a paginating client into an infinite empty-page loop). */
export function parsePaging(url: URL): { limit: number; offset: number } {
	const rawLimit = Math.floor(Number(url.searchParams.get('limit')));
	const rawOffset = Math.floor(Number(url.searchParams.get('offset')));
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
	const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
	return { limit, offset };
}

export function buildPagination(limit: number, offset: number, total: number): Pagination {
	return { limit, offset, total, has_more: offset + limit < total };
}

/** Parse a boolean query param: true/1/yes → true, false/0/no → false, else undefined. */
export function parseBool(v: string | null): boolean | undefined {
	if (v == null) return undefined;
	const s = v.trim().toLowerCase();
	if (['true', '1', 'yes'].includes(s)) return true;
	if (['false', '0', 'no'].includes(s)) return false;
	return undefined;
}

/** Safely parse a JSON column (e.g. contacts.meta, events.detail); never throws. */
export function parseJson(s: string | null): unknown {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** GROUP_CONCAT uses '\n' as a separator (names may contain commas); split back to an array. */
export function splitNames(s: string | null): string[] {
	return s ? s.split('\n').filter(Boolean) : [];
}

// ---- Contact serialization ----------------------------------------------------------------

export type ContactRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
	company_id?: number | null;
	subscribed: number;
	source: string | null;
	created_at: string;
	archived_at?: string | null; // #280
	meta: string | null;
	tags?: string | null;
	lists?: string | null;
	engagement_tier?: string | null;
	engagement_score?: number | null;
	engagement_tier_auto?: string | null; // #460
	engagement_tier_override?: string | null;
	engagement_tier_override_until?: string | null;
	scores_json?: string | null; // #467: JSON [{id, slug, value, band}] of the active scores
};

export type ContactScoreValue = { id: number; slug: string; value: number; band: string | null };

/** #467: `scores_json` (CONTACT_GROUPS_SQL) → the active scores' values; junk → []. */
function parseScores(raw: string | null | undefined): ContactScoreValue[] {
	const v = parseJson(raw ?? null);
	if (!Array.isArray(v)) return [];
	// `p` = the score's Settings position (json_group_array has no ORDER BY): sort, then drop it.
	return v
		.filter((x) => x && typeof x === 'object' && Number.isInteger(x.id))
		.sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0) || a.id - b.id)
		.map((x) => ({ id: x.id, slug: String(x.slug ?? ''), value: Number(x.value ?? 0), band: x.band ?? null }));
}

export type SerializedContact = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
	company_id: number | null;
	subscribed: boolean;
	source: string | null;
	created_at: string;
	archived_at: string | null; // #280: NULL = active
	tags: string[];
	lists: string[];
	meta: unknown;
	tier: string; // engagement tier (#114)
	score: number; // engagement score 0–100, rounded (#114)
	tier_auto: string; // #460: the computed tier underneath an override (= tier when none)
	tier_override: string | null; // #460: null = automatic
	tier_override_until: string | null; // #460: ISO; null = until cleared (or no override)
	scores: ContactScoreValue[]; // #467: every active named score (no row = 0 / no band)
};

export function serializeContact(r: ContactRow): SerializedContact {
	return {
		id: r.id,
		email: r.email,
		name: r.name,
		first_name: r.first_name,
		last_name: r.last_name,
		company: r.company,
		company_id: r.company_id ?? null,
		subscribed: !!r.subscribed,
		source: r.source,
		created_at: r.created_at,
		archived_at: r.archived_at ?? null,
		tags: splitNames(r.tags ?? null),
		lists: splitNames(r.lists ?? null),
		meta: parseJson(r.meta),
		tier: r.engagement_tier ?? 'new',
		score: Math.round(r.engagement_score ?? 0),
		tier_auto: r.engagement_tier_auto ?? r.engagement_tier ?? 'new',
		tier_override: r.engagement_tier_override ?? null,
		tier_override_until: r.engagement_tier_override ? (r.engagement_tier_override_until ?? null) : null,
		scores: parseScores(r.scores_json)
	};
}

/**
 * A `?list=` membership WHERE fragment for the given list row. Dynamic segments (#66:
 * kind='segment' with rules, no list_members rows) resolve through the compiled rules —
 * the same path the rest of the app uses (segments.ts) — everything else via list_members.
 */
export function listMembershipWhere(list: { id: number; kind: string; rules?: string | null }): {
	sql: string;
	binds: unknown[];
} {
	const rules = list.kind === 'segment' ? parseRules(list.rules ?? null) : null;
	if (rules) {
		const c = compileSegment(rules);
		return { sql: `c.id IN (${c.sql})`, binds: c.binds };
	}
	return {
		sql: 'EXISTS (SELECT 1 FROM list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ?)',
		binds: [list.id]
	};
}

/**
 * Names of dynamic segments (#66) each of the given contacts matches, so serialized
 * `lists` arrays include them (they have no list_members rows). One query per dynamic
 * segment per request — the segment count is small in practice.
 */
export async function dynamicSegmentNames(
	db: D1Database,
	contactIds: number[]
): Promise<Map<number, string[]>> {
	const out = new Map<number, string[]>();
	if (contactIds.length === 0) return out;
	const segs = await db
		.prepare("SELECT id, name, rules FROM lists WHERE kind = 'segment' AND rules IS NOT NULL")
		.all<{ id: number; name: string; rules: string }>();
	if (segs.results.length === 0) return out;

	const wanted = new Set(contactIds);
	for (const seg of segs.results) {
		const rules = parseRules(seg.rules);
		if (!rules) continue; // malformed rules = hand-picked fallback elsewhere; skip here
		const c = compileSegment(rules);
		const rows = await db.prepare(c.sql).bind(...c.binds).all<{ id: number }>();
		for (const r of rows.results) {
			if (!wanted.has(r.id)) continue;
			const cur = out.get(r.id) ?? [];
			cur.push(seg.name);
			out.set(r.id, cur);
		}
	}
	return out;
}

/** Merge dynamic-segment names into serialized contacts' `lists` arrays (sorted, deduped). */
export function mergeDynamicLists(
	contacts: SerializedContact[],
	dyn: Map<number, string[]>
): SerializedContact[] {
	for (const c of contacts) {
		const extra = dyn.get(c.id);
		if (extra?.length) c.lists = [...new Set([...c.lists, ...extra])].sort();
	}
	return contacts;
}

/** Fetch + serialize a single contact by id (with tags/lists/meta), or null if absent. */
export async function loadContact(db: D1Database, id: number): Promise<SerializedContact | null> {
	const row = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.company_id, c.subscribed,
			        c.source, c.created_at, c.archived_at, c.meta, ${CONTACT_GROUPS_SQL}
			 FROM contacts c WHERE c.id = ?`
		)
		.bind(id)
		.first<ContactRow>();
	if (!row) return null;
	const contact = serializeContact(row);
	mergeDynamicLists([contact], await dynamicSegmentNames(db, [id]));
	return contact;
}

/**
 * SELECT fragment that adds `tags` + `lists` (newline-joined names) to a contact row, plus
 * the engagement `tier`/`score` (#114; `new`/0 until the rollup has a row) and the active
 * named scores as JSON (#467).
 */
export const CONTACT_GROUPS_SQL = `
	(SELECT GROUP_CONCAT(l.name, char(10)) FROM list_members lm JOIN lists l ON l.id = lm.list_id
	 WHERE lm.contact_id = c.id AND l.kind = 'tag') AS tags,
	(SELECT GROUP_CONCAT(l.name, char(10)) FROM list_members lm JOIN lists l ON l.id = lm.list_id
	 WHERE lm.contact_id = c.id AND l.kind IN ('list','segment','company')) AS lists,
	(SELECT ce.tier FROM contact_engagement ce WHERE ce.contact_id = c.id) AS engagement_tier,
	(SELECT ce.score FROM contact_engagement ce WHERE ce.contact_id = c.id) AS engagement_score,
	(SELECT ce.tier_auto FROM contact_engagement ce WHERE ce.contact_id = c.id) AS engagement_tier_auto,
	(SELECT ce.tier_override FROM contact_engagement ce WHERE ce.contact_id = c.id) AS engagement_tier_override,
	(SELECT ce.tier_override_until FROM contact_engagement ce WHERE ce.contact_id = c.id) AS engagement_tier_override_until,
	(SELECT json_group_array(json_object('id', d.id, 'slug', d.slug, 'value', COALESCE(cs.value, 0), 'band', cs.band, 'p', d.position))
	 FROM score_defs d LEFT JOIN contact_scores cs ON cs.score_id = d.id AND cs.contact_id = c.id
	 WHERE d.status = 'active') AS scores_json`;
