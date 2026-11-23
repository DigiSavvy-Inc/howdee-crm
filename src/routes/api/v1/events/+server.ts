import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination, parseJson } from '$lib/server/api-v1';

// GET /api/v1/events — tracking events (read scope). Read-only: events are ingested from
// Postmark webhooks, never written via the API.
// Filters: contact_id, campaign_id, type (delivery|open|click|bounce|spam|unsubscribe),
//          since, until (recorded_at). Paging: limit (default 50, max 200), offset.
type EventRow = {
	id: number;
	type: string;
	contact_id: number | null;
	campaign_id: number | null;
	recipient_id: number | null;
	message_id: string | null;
	detail: string | null;
	recorded_at: string;
	email: string | null;
};

export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const db = getDB(event);
	const url = event.url;
	const { limit, offset } = parsePaging(url);

	const where: string[] = [];
	const binds: unknown[] = [];

	const contactId = Number(url.searchParams.get('contact_id'));
	if (url.searchParams.has('contact_id')) {
		if (!Number.isInteger(contactId) || contactId <= 0) return apiError(400, 'Invalid contact_id.');
		where.push('e.contact_id = ?');
		binds.push(contactId);
	}
	const campaignId = Number(url.searchParams.get('campaign_id'));
	if (url.searchParams.has('campaign_id')) {
		if (!Number.isInteger(campaignId) || campaignId <= 0) return apiError(400, 'Invalid campaign_id.');
		where.push('e.campaign_id = ?');
		binds.push(campaignId);
	}
	const type = url.searchParams.get('type')?.trim();
	if (type) {
		where.push('e.type = ?');
		binds.push(type);
	}
	const since = url.searchParams.get('since')?.trim();
	if (since) {
		where.push('e.recorded_at >= ?');
		binds.push(since);
	}
	const until = url.searchParams.get('until')?.trim();
	if (until) {
		where.push('e.recorded_at <= ?');
		binds.push(until);
	}

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

	const totalRow = await db
		.prepare(`SELECT COUNT(*) AS n FROM events e ${whereSql}`)
		.bind(...binds)
		.first<{ n: number }>();
	const total = totalRow?.n ?? 0;

	const rows = await db
		.prepare(
			`SELECT e.id, e.type, e.contact_id, e.campaign_id, e.recipient_id, e.message_id,
			        e.detail, e.recorded_at, ct.email
			 FROM events e LEFT JOIN contacts ct ON ct.id = e.contact_id
			 ${whereSql}
			 ORDER BY e.recorded_at DESC, e.id DESC
			 LIMIT ? OFFSET ?`
		)
		.bind(...binds, limit, offset)
		.all<EventRow>();

	const data = rows.results.map((e) => ({
		id: e.id,
		type: e.type,
		contact_id: e.contact_id,
		email: e.email,
		campaign_id: e.campaign_id,
		recipient_id: e.recipient_id,
		message_id: e.message_id,
		detail: parseJson(e.detail),
		recorded_at: e.recorded_at
	}));

	return apiData(data, buildPagination(limit, offset, total));
};
