import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { providerOf } from '$lib/ai-models';
import { aiResendSubjectOn, resendSubjectModel, suggestResendSubject, takeAiSubjectSlot } from '$lib/server/ai-subject';
import { getAssistantConfig } from '$lib/server/ai/config';
import { resolveProviderKey } from '$lib/server/ai/key';
import { providerFor } from '$lib/server/ai/providers';

// "Suggest with Claude" for a resend subject (#246). Session-gated by hooks.server.ts
// (not a PUBLIC_PREFIX); body { subject } → { subject } for the form field. The person
// still edits/saves it — nothing here stores anything.
export const POST: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });

	const db = getDB(event);
	if (!(await aiResendSubjectOn(db))) {
		return json({ error: 'Claude subject suggestions are turned off (Settings → General).' }, { status: 403 });
	}
	// #696: the model from Settings → Assistant → Models (default Claude Haiku) and its provider's key.
	const model = await resendSubjectModel(db);
	if (!model) return json({ error: 'The resend subject model is no longer allowed (Settings → Assistant).' }, { status: 503 });
	const apiKey = await resolveProviderKey(db, event.platform?.env, providerOf(model));
	if (!apiKey) {
		const which = providerOf(model) === 'anthropic' ? 'No Anthropic API key is set' : 'No key is set for the OpenAI-compatible provider';
		return json({ error: `${which} (Settings → Assistant).` }, { status: 503 });
	}

	let subject = '';
	try {
		const body = (await event.request.json()) as { subject?: unknown };
		subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
	} catch {
		subject = '';
	}
	if (!subject || subject.length > 500) return json({ error: 'A subject is required.' }, { status: 400 });

	if (!takeAiSubjectSlot(user.id)) {
		return json({ error: 'Too many suggestions this hour. Try again later.' }, { status: 429 });
	}

	const provider = providerOf(model) === 'anthropic' ? undefined : await providerFor(db, event.platform?.env, await getAssistantConfig(db), model);
	const suggestion = await suggestResendSubject(subject, { apiKey, model, provider });
	if (!suggestion) return json({ error: "Couldn't get a suggestion" }, { status: 502 });
	return json({ subject: suggestion });
};
