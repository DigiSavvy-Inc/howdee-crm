import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { archivePageCtx } from '$lib/server/archive-public';
import { PUBLIC_PAGE_HEADERS } from '$lib/server/public-csp';
import { validArchiveSlug } from '$lib/newsletter-archive';
import { renderIssuePage } from '$lib/server/newsletter-archive';

/** #481: one published issue as a web page. Unknown, unpublished or unsent slugs — and every
 *  slug while the archive is off — 404. Public (PUBLIC_PREFIXES), GET only. */
export const GET: RequestHandler = async (event) => {
	const slug = String(event.params.slug ?? '').toLowerCase();
	if (!validArchiveSlug(slug)) throw error(404, 'Not found');
	const db = getDB(event);
	const html = await renderIssuePage(db, slug, await archivePageCtx(event));
	if (!html) throw error(404, 'Not found');
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...PUBLIC_PAGE_HEADERS } // #531
	});
};
