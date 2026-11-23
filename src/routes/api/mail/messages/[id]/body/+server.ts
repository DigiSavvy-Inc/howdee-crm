import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { loadMessageBody } from '$lib/server/mail-body';

// GET /api/mail/messages/:id/body (#158) — a synced Gmail message's body, for the expanded
// conversation view. Session-gated (not in PUBLIC_PREFIXES). `{ kind: 'text'|'html', body }`.
export const GET: RequestHandler = async (event) => {
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid id.' }, { status: 400 });
	const env = event.platform?.env;
	const res = await loadMessageBody(getDB(event), env ?? {}, id, { media: env?.MEDIA, fetch: event.fetch });
	if (!res.ok) return json({ error: res.error }, { status: res.status });
	return json(res.body, { headers: { 'Cache-Control': 'private, no-store' } });
};
