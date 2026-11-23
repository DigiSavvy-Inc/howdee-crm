import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { parseBlocks, renderPageHtml } from '$lib/blocks';
import { PUBLIC_PAGE_HEADERS } from '$lib/server/public-csp';

/** Public hosted page (#59) — published pages only; drafts and unknown slugs 404.
 *  In PUBLIC_PREFIXES (no session), GET-only, renders server-side. */
export const GET: RequestHandler = async (event) => {
	const slug = String(event.params.slug ?? '').toLowerCase();
	const db = getDB(event);
	const page = await db
		.prepare('SELECT title, blocks FROM pages WHERE slug = ? AND published = 1')
		.bind(slug)
		.first<{ title: string; blocks: string }>();
	if (!page) throw error(404, 'Not found');

	return new Response(renderPageHtml(page.title, parseBlocks(page.blocks)), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'public, max-age=300', // pages change rarely; 5 min edge/browser cache
			...PUBLIC_PAGE_HEADERS // #531
		}
	});
};
