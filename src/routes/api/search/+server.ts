import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { siteSearch } from '$lib/server/site-search';

// Site-wide search (#477) for the Cmd/Ctrl+K palette. Session-gated by hooks.server.ts (not a
// PUBLIC_PREFIX), like the other /api typeahead routes. `?q=` (required, ≤ 100 chars used),
// `?limit=` per group (default 5, max 10).
export const GET: RequestHandler = async (event) => {
	if (!event.locals?.user) error(401, 'Sign in first');
	const q = (event.url.searchParams.get('q') ?? '').trim();
	if (!q) error(400, 'q is required');
	const limit = Number(event.url.searchParams.get('limit') ?? 5);
	const result = await siteSearch(getDB(event), q, limit);
	return json(result, { headers: { 'cache-control': 'private, no-store' } });
};
