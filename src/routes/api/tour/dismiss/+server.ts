import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { markTourDismissed } from '$lib/server/users';

// #104: dismiss the first-run product tour (Finish/Skip/×/Esc) so it doesn't auto-open
// again. Session-gated by hooks.server.ts (not a PUBLIC_PREFIX) — the explicit guard below
// is just for tests / defense-in-depth.
export const POST: RequestHandler = async (event) => {
	if (!event.locals.user) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	const db = getDB(event);
	await markTourDismissed(db, event.locals.user.id);
	return json({ ok: true });
};
