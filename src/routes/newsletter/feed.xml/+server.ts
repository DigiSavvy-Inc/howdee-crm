import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { archivePageCtx } from '$lib/server/archive-public';
import { renderFeed } from '$lib/server/newsletter-archive';

/** #481: RSS 2.0 of the latest 20 published issues (title, link, date, preheader). */
export const GET: RequestHandler = async (event) => {
	const xml = await renderFeed(getDB(event), await archivePageCtx(event));
	if (!xml) throw error(404, 'Not found');
	return new Response(xml, {
		headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
	});
};
