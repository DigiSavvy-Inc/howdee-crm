import { json, type RequestHandler } from '@sveltejs/kit';
import { providerOf, supportsTools } from '$lib/ai-models';
import { availability, featureModel, getAssistantConfig } from '$lib/server/ai/config';
import { configuredProviders, modelCatalog } from '$lib/server/ai/providers';

// What the assistant panel needs on open (#287): is it usable, and which models / effort
// levels to offer. Session-gated; never reveals the key, only whether it is set.
// #696: only allowed models whose provider has a key and that can use tools (the chat needs them).
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });
	const cfg = await getAssistantConfig(db);
	const [avail, ready] = await Promise.all([
		availability(db, cfg, event.platform?.env, event.locals.user),
		configuredProviders(db, event.platform?.env)
	]);
	const models = modelCatalog(cfg).filter((m) => cfg.allowedModels.includes(m.id) && supportsTools(m) && ready.has(providerOf(m)));
	// Before any key is set, list the allowed models as before (the panel shows "not set up").
	const offered = models.length || ready.size ? models : modelCatalog(cfg).filter((m) => cfg.allowedModels.includes(m.id) && supportsTools(m));
	const chatModel = featureModel(cfg, 'chat');
	return json({
		...avail,
		models: offered.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
		defaultModel: chatModel && offered.some((m) => m.id === chatModel.id) ? chatModel.id : (offered[0]?.id ?? cfg.defaultModel),
		defaultEffort: cfg.defaultEffort
	});
};
