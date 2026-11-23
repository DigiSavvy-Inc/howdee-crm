import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { audienceCount, audienceFromForm } from '$lib/server/campaign-audience';
import { resolveTopicId } from '$lib/server/topics';
import { parseTopicChoice } from '$lib/topics';

// #332: compose's live recipient count for the chosen audience — union of the included lists /
// segments minus the excluded ones, subscribed and not archived (the send's own rules).
// #414: minus anyone who opted out of the email's topic (`topic_id`: '' automatic, 0 none).
// Session-gated (not in PUBLIC_PREFIXES); form fields `include_id` / `exclude_id` / `topic_id`.
export const POST: RequestHandler = async (event) => {
	let data: FormData;
	try {
		data = await event.request.formData();
	} catch {
		throw error(400, 'Expected form data.');
	}
	const db = getDB(event);
	const audience = audienceFromForm(data);
	const topicId = await resolveTopicId(db, parseTopicChoice(data.get('topic_id')), audience);
	const count = await audienceCount(db, audience, { topicId });
	return json({ count }, { headers: { 'cache-control': 'no-store' } });
};
