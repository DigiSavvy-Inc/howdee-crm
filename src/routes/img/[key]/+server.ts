import type { RequestHandler } from '@sveltejs/kit';
import { serveMedia } from '$lib/server/media-serve';

/** Serve uploaded media from R2 (#61). Public (in PUBLIC_PREFIXES) — email clients and
 *  hosted-page visitors fetch images without a session. Keys are random UUIDs. */
export const GET: RequestHandler = (event) => serveMedia(event.platform?.env?.MEDIA, String(event.params.key ?? ''));
