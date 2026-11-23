import { json, type RequestHandler } from '@sveltejs/kit';
import { setFeedback, type Feedback } from '$lib/server/ai/threads';

// thumbs up / down on an assistant answer (#310). Body { value: 'up' | 'down' | null } (null clears).
// Session-gated; only the user's own assistant messages — anything else → 404.
export const POST: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return json({ error: 'Message not found.' }, { status: 404 });

	let raw: unknown;
	try {
		raw = ((await event.request.json()) as { value?: unknown } | null)?.value;
	} catch {
		raw = undefined;
	}
	const value: Feedback | null | undefined = raw === 'up' ? 1 : raw === 'down' ? -1 : raw === null ? null : undefined;
	if (value === undefined) return json({ error: "value must be 'up', 'down' or null." }, { status: 400 });

	if (!(await setFeedback(db, id, user.id, value))) return json({ error: 'Message not found.' }, { status: 404 });
	return json({ id, feedback: value });
};
