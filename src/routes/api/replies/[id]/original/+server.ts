import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { replyOriginalHtml } from '$lib/server/conversations';

// GET /api/replies/:id/original (#380) — a captured reply's original HTML, fetched only when
// "View original" is opened. Session-gated (not in PUBLIC_PREFIXES). `{ html }`; the client
// renders it with originalSrcdoc in a sandbox="" iframe, never in the page DOM.
export const GET: RequestHandler = async (event) => {
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid id.' }, { status: 400 });
	const html = await replyOriginalHtml(getDB(event), id);
	if (html == null) return json({ error: 'No original for this message.' }, { status: 404 });
	return json({ html }, { headers: { 'Cache-Control': 'private, no-store' } });
};
