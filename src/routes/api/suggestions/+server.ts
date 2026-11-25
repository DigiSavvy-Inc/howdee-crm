import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { suggestionViewer } from '$lib/server/suggestions/visibility';
import { panelSuggestions } from '$lib/server/suggestions/panel';

// Suggestions panel (#714): the cards for the signed-in user's panel (team rows + their own).
// Session-gated (hooks.server.ts; not a PUBLIC_PREFIX). Feature off / not open to this user → 403.
export const GET: RequestHandler = async (event) => {
	if (!event.locals?.user) error(401, 'Sign in first');
	const db = getDB(event);
	const viewer = await suggestionViewer(db, event.locals.user);
	if (!viewer) error(403, 'Suggestions are off');
	const items = await panelSuggestions(db, viewer);
	return json({ items, count: items.length }, { headers: { 'cache-control': 'private, no-store' } });
};
