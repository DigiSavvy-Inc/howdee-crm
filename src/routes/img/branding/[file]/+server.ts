import type { RequestHandler } from '@sveltejs/kit';
import { serveBrandingLogo } from '$lib/server/media-serve';

/** Serve the uploaded app logo (#188) from R2 `branding/…`. Public via the `/img` prefix
 *  (the login page and the PWA manifest need it without a session). */
export const GET: RequestHandler = (event) => serveBrandingLogo(event.platform?.env?.MEDIA, String(event.params.file ?? ''));
