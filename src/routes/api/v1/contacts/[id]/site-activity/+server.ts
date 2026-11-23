import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { SITE_EVENT_SELECT, serializeSiteEvent, type SiteEventApiRow } from '$lib/server/site-events-api';

// GET /api/v1/contacts/:id/site-activity — one contact's site tracking rows (#154, read
// scope): pageviews and custom events (beacon + server-side), newest first. Optional `kind`
// (pageview|event). Paging: limit (default 50, max 200), offset. 404 if the contact doesn't exist.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(400, 'Invalid contact id.');

	const db = getDB(event);
	const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
	if (!contact) return apiError(404, 'Contact not found.');

	const { limit, offset } = parsePaging(event.url);
	const where = ['se.contact_id = ?'];
	const binds: unknown[] = [id];
	const kind = event.url.searchParams.get('kind')?.trim();
	if (kind) {
		if (kind !== 'pageview' && kind !== 'event') return apiError(400, 'Invalid kind (pageview|event).');
		where.push('se.kind = ?');
		binds.push(kind);
	}
	const whereSql = `WHERE ${where.join(' AND ')}`;

	const total =
		(await db.prepare(`SELECT COUNT(*) AS n FROM site_events se ${whereSql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
	const rows = await db
		.prepare(`${SITE_EVENT_SELECT} ${whereSql} ORDER BY se.occurred_at DESC, se.id DESC LIMIT ? OFFSET ?`)
		.bind(...binds, limit, offset)
		.all<SiteEventApiRow>();

	return apiData(rows.results.map(serializeSiteEvent), buildPagination(limit, offset, total));
};
