import { json, type RequestHandler } from '@sveltejs/kit';
import { listThreads } from '$lib/server/ai/threads';

// The signed-in user's own assistant conversations, newest first (#287).
export const GET: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });
	const rows = await listThreads(db, user.id);
	return json({
		threads: rows.map((t) => ({
			id: t.id,
			title: t.title,
			model: t.model,
			effort: t.effort,
			updated_at: t.updated_at,
			cost_micros: t.cost_micros
		}))
	});
};
