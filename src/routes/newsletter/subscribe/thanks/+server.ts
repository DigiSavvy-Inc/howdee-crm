import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { archivePageCtx } from '$lib/server/archive-public';
import { PUBLIC_PAGE_HEADERS } from '$lib/server/public-csp';
import { renderSubscribeThanks } from '$lib/server/newsletter-archive';
import { finishFor } from '$lib/server/form-submit';

/** #587: after a sign-up from the archive — the chosen form's thank-you message and a link back
 *  (or a forward to the form's redirect). 404 while the archive is off or no form is chosen. */
export const GET: RequestHandler = async (event) => {
	const html = await renderSubscribeThanks(getDB(event), await archivePageCtx(event), finishFor);
	if (!html) throw error(404, 'Not found');
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...PUBLIC_PAGE_HEADERS }
	});
};
