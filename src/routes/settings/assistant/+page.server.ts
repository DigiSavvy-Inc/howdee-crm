import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { listUsers } from '$lib/server/users';
import {
	KEY_STORE_MISSING,
	OPENAI_KEY_FORM_STALE,
	OpenAiHostChangedError,
	adoptOpenAiKeyHost,
	anthropicKeyInfo,
	cleanAnthropicKey,
	cleanOpenAiKey,
	keyStoreReady,
	openAiKeyInfo,
	openAiNoKeyMessage,
	removeAnthropicKey,
	removeOpenAiKey,
	resolveAnthropicKey,
	resolveOpenAiKey,
	savedOpenAiBaseUrl,
	setAnthropicKey,
	setOpenAiKey,
	testAnthropicKey,
	testOpenAiKey
} from '$lib/server/ai/key';
import { AI_FEATURES, OPENAI_DEFAULT_BASE_URL, baseUrlHost, baseUrlProblem, maskUrlCredentials, modelLinesText, parseModelLines } from '$lib/ai-providers';
import { modelCatalog } from '$lib/server/ai/providers';
import {
	ASSISTANT_ACCESS,
	CODE_PERMISSIONS,
	getAssistantConfig,
	saveAssistantConfig,
	setAllowCode,
	setAllowDelete,
	spentMicros,
	usageByUserMonth,
	usageInsights,
	utcMonthStart
} from '$lib/server/ai/config';

// Settings → Assistant (#287), admin-only (load AND every action). The key is pasted here
// (#297, sealed with MAIL_TOKEN_KEY) or the Worker secret ANTHROPIC_API_KEY (the fallback).
// Only where it comes from and the in-app key's last 4 characters reach the page — never
// the value, and no failure payload carries the submitted key.

// #292: the people the "Only selected people" checklist offers — active users only.
async function accessUsers(db: D1Database) {
	return (await listUsers(db))
		.filter((u) => !u.disabled_at)
		.map((u) => ({ id: u.id, login: u.github_login, name: u.name, role: u.role }));
}

export const load: PageServerLoad = async (event) => {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
	const db = getDB(event);
	const [config, usage, insights, monthSpent, users, key, openaiKey, savedBaseUrl] = await Promise.all([
		getAssistantConfig(db),
		usageByUserMonth(db),
		usageInsights(db), // #310: per model, top tools, cost per turn, feedback (30 days)
		spentMicros(db, utcMonthStart(new Date())),
		accessUsers(db),
		anthropicKeyInfo(db, event.platform?.env),
		openAiKeyInfo(db, event.platform?.env),
		savedOpenAiBaseUrl(db)
	]);
	// #696: every model the install knows (built-in + the OpenAI-compatible ones), as plain data.
	const models = modelCatalog(config).map((m) => ({
		id: m.id,
		label: m.label,
		provider: m.provider ?? 'anthropic',
		tools: m.tools !== false,
		efforts: [...m.efforts],
		price: m.price ? { input: m.price.input, output: m.price.output } : null
	}));
	return {
		config,
		keySet: key.source !== null,
		key,
		openaiKey,
		openaiModelsText: modelLinesText(config.openai.models),
		openaiDefaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
		// #748: a saved base URL that is no longer accepted (e.g. plain http), shown as text so the
		// admin can see what to fix and prefilled in the form. null when the saved URL is usable. A user
		// name / password in it never leaves the server (`https://***@host/path`).
		openaiStoredBaseUrl:
			openaiKey.baseUrlUnusable && savedBaseUrl
				? { value: maskUrlCredentials(savedBaseUrl), problem: baseUrlProblem(savedBaseUrl), http: /^http:/i.test(savedBaseUrl) }
				: null,
		models,
		usage,
		insights,
		monthSpent,
		users
	};
};

export const actions: Actions = {
	setKey: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { keyError: 'Admins only.' });
		const env = event.platform?.env;
		if (!keyStoreReady(env)) return fail(400, { keyError: KEY_STORE_MISSING });
		const cleaned = cleanAnthropicKey(String((await event.request.formData()).get('key') ?? ''));
		if (!cleaned.ok) return fail(400, { keyError: cleaned.error });
		const { last4 } = await setAnthropicKey(getDB(event), env, cleaned.key, event.locals.user.id);
		return { keySaved: last4 };
	},

	removeKey: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { keyError: 'Admins only.' });
		const db = getDB(event);
		const removed = await removeAnthropicKey(db);
		return { keyRemoved: removed, fallback: !!(await resolveAnthropicKey(db, event.platform?.env)) };
	},

	// Calls GET /v1/models with the key in effect (in-app, else the secret).
	testKey: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { keyError: 'Admins only.' });
		const key = await resolveAnthropicKey(getDB(event), event.platform?.env);
		if (!key) return fail(400, { keyError: 'No key is set.' });
		// Global fetch, NOT event.fetch: SvelteKit's event.fetch adds browser-context headers
		// (Origin), so Anthropic treats the call as a browser CORS request and demands
		// 'anthropic-dangerous-direct-browser-access'. Never send that header from the server.
		const result = await testAnthropicKey(key, fetch);
		return result.ok ? { keyTest: 'ok' as const } : fail(400, { keyTestError: result.error });
	},

	// #696: the OpenAI-compatible provider — base URL, label and its models (one per line).
	saveProvider: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { providerError: 'Admins only.' });
		const db = getDB(event);
		const form = await event.request.formData();
		const baseUrl = String(form.get('base_url') ?? '').trim();
		const urlProblem = baseUrlProblem(baseUrl);
		if (urlProblem) return fail(400, { providerError: urlProblem });
		const parsed = parseModelLines(String(form.get('models') ?? ''));
		if (parsed.problems.length) return fail(400, { providerError: parsed.problems.join(' ') });
		// #748: a key follows its host. Order matters, so no other request can bind the key to the new
		// host in between: (1) a key with no host yet is bound to the base URL stored before this save;
		// (2) when the host changes, the key is removed; (3) only then is the new config written.
		// The old host comes from the stored value as it is (an unusable URL has no host, so any new
		// URL removes the key), never from the cleaned config, which reads an unusable URL as blank.
		await adoptOpenAiKeyHost(db);
		const oldHost = baseUrlHost(await savedOpenAiBaseUrl(db));
		let providerKeyCleared = false;
		if (baseUrlHost(baseUrl) !== oldHost) providerKeyCleared = await removeOpenAiKey(db);
		const current = await getAssistantConfig(db);
		// The only save that may change the stored base URL (#748); every other save keeps it as stored.
		const saved = await saveAssistantConfig(
			db,
			{ ...current, openai: { baseUrl, label: String(form.get('label') ?? ''), models: parsed.models } },
			{ setBaseUrl: true }
		);
		return { providerSaved: true, providerKeyCleared, config: saved };
	},

	setProviderKey: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { providerKeyError: 'Admins only.' });
		const env = event.platform?.env;
		if (!keyStoreReady(env)) return fail(400, { providerKeyError: 'In-app keys need the MAIL_TOKEN_KEY Worker secret. Ask your operator to set it, or use the OPENAI_API_KEY secret.' });
		const form = await event.request.formData();
		const cleaned = cleanOpenAiKey(String(form.get('key') ?? ''));
		if (!cleaned.ok) return fail(400, { providerKeyError: cleaned.error });
		const db = getDB(event);
		// #748: the key is bound to the saved base URL's host, so it must be the host the page showed.
		const shownHost = String(form.get('base_host') ?? '').trim().toLowerCase();
		const savedHost = baseUrlHost(await savedOpenAiBaseUrl(db));
		if (!savedHost) return fail(400, { providerKeyError: openAiNoKeyMessage({ host: null, hostMismatch: false, workerSecretBlocked: false, pinnedHost: '' }) });
		// A form without the host it was shown for (an old page, a hand-made post): not a host change.
		if (!shownHost) return fail(400, { providerKeyError: OPENAI_KEY_FORM_STALE });
		try {
			const { last4 } = await setOpenAiKey(db, env, cleaned.key, event.locals.user.id, { expectHost: shownHost });
			return { providerKeySaved: last4 };
		} catch (e) {
			if (e instanceof OpenAiHostChangedError) return fail(409, { providerKeyError: e.message });
			throw e;
		}
	},

	removeProviderKey: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { providerKeyError: 'Admins only.' });
		const db = getDB(event);
		const removed = await removeOpenAiKey(db);
		return { providerKeyRemoved: removed, providerFallback: !!(await resolveOpenAiKey(db, event.platform?.env)) };
	},

	// GET <base>/models with the key in effect for that address (#748). Global fetch, like testKey.
	testProviderKey: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { providerKeyError: 'Admins only.' });
		const db = getDB(event);
		const env = event.platform?.env;
		const cfg = await getAssistantConfig(db);
		const baseUrl = cfg.openai.baseUrl || OPENAI_DEFAULT_BASE_URL;
		const key = await resolveOpenAiKey(db, env, baseUrl);
		if (!key) return fail(400, { providerKeyError: openAiNoKeyMessage(await openAiKeyInfo(db, env, baseUrl)) });
		const result = await testOpenAiKey(key, baseUrl, fetch);
		return result.ok ? { providerKeyTest: 'ok' as const } : fail(400, { providerKeyTestError: result.error });
	},

	save: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
		const db = getDB(event);
		const form = await event.request.formData();
		const allowed = form.getAll('allowed').map(String);
		if (!allowed.length) return fail(400, { error: 'Allow at least one model.' });
		const monthly = Number(form.get('monthly_cap'));
		const daily = Number(form.get('daily_cap'));
		const retention = Number(form.get('retention_days'));
		if (!Number.isFinite(monthly) || monthly < 0 || !Number.isFinite(daily) || daily < 0) {
			return fail(400, { error: 'Spend caps must be 0 or more.' });
		}
		if (!Number.isInteger(retention) || retention < 1) return fail(400, { error: 'Keep history for at least 1 day.' });
		const access = String(form.get('access') ?? '');
		if (!(ASSISTANT_ACCESS as string[]).includes(access)) return fail(400, { error: 'Choose who can use the assistant.' });
		// Only ids of active users count; the list is kept (unused) when access isn't 'selected'.
		const known = new Set((await accessUsers(db)).map((u) => u.id));
		const userIds = form.getAll('user').map(Number).filter((id) => known.has(id));
		if (access === 'selected' && !userIds.length) {
			return fail(400, { accessError: 'Tick at least one person, or choose Off or Everyone signed in.' });
		}
		// Permissions (#322 addendum) have their own form (setPermissions); keep them as stored.
		const current = await getAssistantConfig(db);
		// #696: per-feature models ride on this form when it carries them; else kept as stored.
		const featureModels = form.has('feature_models_field')
			? Object.fromEntries(AI_FEATURES.map((f) => [f, String(form.get(`feature_${f}`) ?? '')]).filter(([, v]) => v))
			: current.featureModels;
		const saved = await saveAssistantConfig(db, {
			openai: current.openai,
			featureModels,
			allowDelete: current.allowDelete,
			allowCode: current.allowCode,
			draftReply: current.draftReply,
			editorAsk: current.editorAsk,
			access,
			allowedUserIds: userIds,
			allowedModels: allowed,
			defaultModel: String(form.get('default_model') ?? ''),
			defaultEffort: String(form.get('default_effort') ?? ''),
			monthlyCapUsd: monthly,
			dailyUserCapUsd: daily,
			retentionDays: retention
		});
		return { saved: true, config: saved };
	},

	// #322 addendum: Permissions → "Allow the assistant to delete contacts" (default off).
	// #327: "Code & snippets" (off / admins / everyone, default off). Each real change writes an
	// audit row naming who made it (dashboard activity feed).
	setPermissions: async (event) => {
		const user = event.locals.user;
		if (user?.role !== 'admin') return fail(403, { permissionsError: 'Admins only.' });
		const form = await event.request.formData();
		const allow = form.get('allow_delete') === 'on';
		const code = form.has('allow_code') ? String(form.get('allow_code')) : (await getAssistantConfig(getDB(event))).allowCode;
		if (!(CODE_PERMISSIONS as string[]).includes(code)) return fail(400, { permissionsError: 'Choose who the assistant may write code for.' });
		const db = getDB(event);
		const del = await setAllowDelete(db, allow, user);
		const codeRes = await setAllowCode(db, code as (typeof CODE_PERMISSIONS)[number], user);
		// #387: "Draft reply in Conversations" (default on). Only a form that carries the field changes it.
		let config = codeRes.config;
		let draftChanged = false;
		if (form.has('draft_reply_field')) {
			const draftReply = form.get('draft_reply') === 'on';
			draftChanged = config.draftReply !== draftReply;
			if (draftChanged) config = await saveAssistantConfig(db, { ...config, draftReply });
		}
		// #679: "Ask AI in the editor" (default on). Same rule: only a form carrying the field changes it.
		let askChanged = false;
		if (form.has('editor_ask_field')) {
			const editorAsk = form.get('editor_ask') === 'on';
			askChanged = config.editorAsk !== editorAsk;
			if (askChanged) config = await saveAssistantConfig(db, { ...config, editorAsk });
		}
		return { permissionsSaved: true, permissionsChanged: del.changed || codeRes.changed || draftChanged || askChanged, config };
	}
};
