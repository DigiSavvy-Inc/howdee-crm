import { json, type RequestHandler } from '@sveltejs/kit';
import { cardsForThread } from '$lib/server/ai/actions';
import { displayMessages, threadForUser } from '$lib/server/ai/threads';

// One of the signed-in user's assistant conversations (#287); someone else's → 404.
export const GET: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });
	const id = Number(event.params.id);
	const thread = Number.isInteger(id) && id > 0 ? await threadForUser(db, id, user.id) : null;
	if (!thread) return json({ error: 'Conversation not found.' }, { status: 404 });
	return json({
		thread: {
			id: thread.id,
			title: thread.title,
			model: thread.model,
			effort: thread.effort,
			cost_micros: thread.cost_micros,
			tokens: thread.total_input_tokens + thread.total_output_tokens
		},
		messages: await displayMessages(db, thread.id),
		actions: await cardsForThread(db, thread.id) // #301: the action cards, rehydrated
	});
};
