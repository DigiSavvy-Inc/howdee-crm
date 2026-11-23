import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { conversationsFor } from '$lib/server/conversations';

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/v1/contacts/:id/conversations (#158, read scope) — the contact's conversations
// (app sends, captured replies, synced Gmail), newest activity first, paged. 404 if the
// contact doesn't exist.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid contact id.');

	const db = getDB(event);
	const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(id).first<{ id: number }>();
	if (!contact) return apiError(404, 'Contact not found.');

	const { limit, offset } = parsePaging(event.url);
	const all = await conversationsFor(db, id);
	return apiData(all.slice(offset, offset + limit), buildPagination(limit, offset, all.length));
};
