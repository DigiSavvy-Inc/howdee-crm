import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { DISABLED_SNIPPET, renderTrackingSnippet } from '$lib/tracking-snippet';

/**
 * Site tracking snippet (#152): `GET /t.js?k=<site_key>`. Public (PUBLIC_PREFIXES).
 * 404 for an unknown key; a disabled site gets a no-op `/* tracking disabled *\/` so a
 * tag left on the site doesn't throw. The beacon origin is the origin this was served
 * from. Cached an hour by browsers/CDN, with an ETag for cheap revalidation.
 */
export const GET: RequestHandler = async (event) => {
	const key = event.url.searchParams.get('k') ?? '';
	const site =
		key && key.length <= 100
			? await getDB(event)
					.prepare('SELECT site_key, enabled FROM tracking_sites WHERE site_key = ?')
					.bind(key)
					.first<{ site_key: string; enabled: number }>()
			: null;
	if (!site) {
		return new Response('/* unknown site key */\n', {
			status: 404,
			headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }
		});
	}

	const body = site.enabled
		? renderTrackingSnippet({ siteKey: site.site_key, endpoint: event.url.origin })
		: DISABLED_SNIPPET;
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
	const etag = `"${[...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
	const headers = {
		'content-type': 'application/javascript; charset=utf-8',
		'cache-control': 'public, max-age=3600',
		etag,
		'access-control-allow-origin': '*'
	};

	const inm = event.request.headers.get('if-none-match');
	if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { headers });
};
