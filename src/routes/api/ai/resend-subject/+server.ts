import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { providerOf, type Usage } from '$lib/ai-models';
import { aiResendSubjectOn, recordSubjectSuggestion, resendSubjectModel, suggestResendSubject, takeAiSubjectSlot } from '$lib/server/ai-subject';
import { getAssistantConfig, spendCheck } from '$lib/server/ai/config';
import { openAiKeyProblem, resolveProviderKey } from '$lib/server/ai/key';
import { providerFor } from '$lib/server/ai/providers';

// "Suggest with Claude" for a resend subject (#246). Session-gated by hooks.server.ts
// (not a PUBLIC_PREFIX); body { subject } → { subject } for the form field. The person
// still edits/saves it — nothing here stores the subject on the campaign.
//
// Who may use it: any signed-in user while Settings → General's toggle is on (unchanged; it does
// not need assistant access). #748: the assistant's spend caps apply before the call, and each
// answered call is recorded (model, tokens, cost; never the subject or the suggestion) like a
// Draft reply, so it counts toward those caps.
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
		// #748: for the OpenAI-compatible provider, the same reason Test key gives (key for another
		// address, secret pinned to another host, base URL not usable).
		const error =
			providerOf(model) === 'anthropic'
				? 'No Anthropic API key is set (Settings → Assistant).'
				: (await openAiKeyProblem(db, event.platform?.env)) || 'No key is set for the OpenAI-compatible provider (Settings → Assistant).';
		return json({ error }, { status: 503 });
	}

	let subject = '';
	try {
		const body = (await event.request.json()) as { subject?: unknown };
		subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
	} catch {
		subject = '';
	}
	if (!subject || subject.length > 500) return json({ error: 'A subject is required.' }, { status: 400 });

	const cfg = await getAssistantConfig(db);
	const spend = await spendCheck(db, cfg, user.id);
	if (!spend.ok) return json({ error: spend.message, reason: 'cap' }, { status: 429 });

	if (!takeAiSubjectSlot(user.id)) {
		return json({ error: 'Too many suggestions this hour. Try again later.' }, { status: 429 });
	}

	const provider = providerOf(model) === 'anthropic' ? undefined : await providerFor(db, event.platform?.env, cfg, model);
	const seen: { usage: Usage | null } = { usage: null };
	const suggestion = await suggestResendSubject(subject, { apiKey, model, provider, onUsage: (u) => (seen.usage = u) });
	if (seen.usage) await recordSubjectSuggestion(db, { userId: user.id, model, usable: !!suggestion, usage: seen.usage });
	if (!suggestion) return json({ error: "Couldn't get a suggestion" }, { status: 502 });
	return json({ subject: suggestion });
};
