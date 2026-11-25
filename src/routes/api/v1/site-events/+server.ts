import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { containsSql } from '$lib/server/sql-match';
import {
	SITE_EVENT_SELECT,
	parseApiTime,
	resolveSiteParam,
	serializeSiteEvent,
	type SiteEventApiRow
} from '$lib/server/site-events-api';

// GET /api/v1/site-events — site tracking rows across contacts (#154, read scope).
// Filters: since / until (occurred_at; ISO-8601 or YYYY-MM-DD[ HH:MM:SS], UTC), path
// (contains), site (id, domain, name or site_key), kind (pageview|event), name (exact event
// name), contact_id. Newest first. Paging: limit (default 50, max 200), offset.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const db = getDB(event);
	const p = event.url.searchParams;
	const { limit, offset } = parsePaging(event.url);
	const where: string[] = [];
	const binds: unknown[] = [];

	for (const [key, op] of [
		['since', '>='],
		['until', '<=']
	] as const) {
		const t = parseApiTime(p.get(key));
		if (t === null) return apiError(400, `Invalid ${key}.`);
		if (t) {
			where.push(`se.occurred_at ${op} ?`);
			binds.push(t);
		}
	}
	const path = p.get('path')?.trim();
	if (path) {
		where.push(containsSql("COALESCE(se.path, '')")); // #485: paths run past LIKE's 50-byte cap
		binds.push(path);
	}
	const site = p.get('site')?.trim();
	if (site) {
		const siteId = await resolveSiteParam(db, site);
		if (!siteId) return apiError(404, 'Unknown site.');
		where.push('se.site_id = ?');
		binds.push(siteId);
	}
	const kind = p.get('kind')?.trim();
	if (kind) {
		if (kind !== 'pageview' && kind !== 'event') return apiError(400, 'Invalid kind (pageview|event).');
		where.push('se.kind = ?');
		binds.push(kind);
	}
	const name = p.get('name')?.trim();
	if (name) {
		where.push('se.name = ?');
		binds.push(name);
	}
	if (p.has('contact_id')) {
		const cid = Number(p.get('contact_id'));
		if (!Number.isInteger(cid) || cid <= 0) return apiError(400, 'Invalid contact_id.');
		where.push('se.contact_id = ?');
		binds.push(cid);
	}

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const total =
		(await db.prepare(`SELECT COUNT(*) AS n FROM site_events se ${whereSql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
	const rows = await db
		.prepare(`${SITE_EVENT_SELECT} ${whereSql} ORDER BY se.occurred_at DESC, se.id DESC LIMIT ? OFFSET ?`)
		.bind(...binds, limit, offset)
		.all<SiteEventApiRow>();

	return apiData(rows.results.map(serializeSiteEvent), buildPagination(limit, offset, total));
};
