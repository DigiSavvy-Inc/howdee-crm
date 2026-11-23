import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { archivePageCtx } from '$lib/server/archive-public';
import { PUBLIC_PAGE_HEADERS } from '$lib/server/public-csp';
import { renderIndexPage } from '$lib/server/newsletter-archive';

/** #481: Newsletter archive index — published issues newest first, 20 per page (?page=N).
 *  Public (PUBLIC_PREFIXES), GET only; 404 while the archive is off. */
export const GET: RequestHandler = async (event) => {
	const db = getDB(event);
	const raw = event.url.searchParams.get('page');
	const page = raw === null ? 1 : Number(raw);
	const html = await renderIndexPage(db, page, await archivePageCtx(event));
	if (!html) throw error(404, 'Not found');
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...PUBLIC_PAGE_HEADERS } // #531
	});
};
