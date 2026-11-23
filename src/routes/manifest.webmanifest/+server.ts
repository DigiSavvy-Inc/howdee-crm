import type { RequestHandler } from './$types';
import { brandingFor, buildManifest } from '$lib/server/branding';

// Dynamic PWA manifest (#188): name / short_name / icons follow Settings → Branding.
// Public (PUBLIC_PREFIXES) — browsers fetch it without credentials. Short cache so a
// branding change reaches installed apps within minutes.
export const GET: RequestHandler = async (event) => {
	const manifest = buildManifest(await brandingFor(event));
	return new Response(JSON.stringify(manifest), {
		headers: {
			'Content-Type': 'application/manifest+json; charset=utf-8',
			'Cache-Control': 'public, max-age=300'
		}
	});
};
