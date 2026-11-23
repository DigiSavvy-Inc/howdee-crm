import { error, type RequestHandler } from '@sveltejs/kit';
import { serveBrandingLogo, serveMedia } from '$lib/server/media-serve';

/** #491: the archive's images under /newsletter/img/… — the same R2 objects as /img/[key] and
 *  /img/branding/[file], so the public host (example.com/newsletter) never links to the CRM.
 *  Works on every host. */
export const GET: RequestHandler = async (event) => {
	const bucket = event.platform?.env?.MEDIA;
	const rest = String(event.params.rest ?? '');
	// `return await`, not a bare `return`: the helpers can reject before their first await, and handing
	// that already-rejected promise straight back leaves it unhandled for a tick (workerd reports it).
	if (rest.startsWith('branding/')) return await serveBrandingLogo(bucket, rest.slice('branding/'.length));
	if (rest.includes('/')) throw error(404, 'Not found');
	return await serveMedia(bucket, rest);
};
