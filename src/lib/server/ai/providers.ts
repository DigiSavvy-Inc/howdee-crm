// The provider registry (#696): one place that turns a model into an AiProvider, so every AI
// feature (chat, scheduled jobs, Ask AI, Draft reply, account briefs, the report builder,
// resend subjects) reaches a model the same way. Adding a provider = an adapter implementing
// AiProvider (./provider.ts), a key in ./key.ts, an entry in PROVIDERS ($lib/ai-models) and a
// case here — see docs/ai-providers.md.

import { allModels, providerOf, type ModelInfo, type ProviderId } from '$lib/ai-models';
import { OPENAI_DEFAULT_BASE_URL, openAiModelInfos } from '$lib/ai-providers';
import { anthropicProvider } from './anthropic';
import { resolveProviderKey } from './key';
import { openAiCompatProvider } from './openai-compat';
import type { AiProvider } from './provider';
import type { AssistantConfig } from './config';

/** The install's models of other providers, for `modelInfo(id, catalogExtra(cfg))`. */
export function catalogExtra(cfg: Pick<AssistantConfig, 'openai'>): ModelInfo[] {
	return openAiModelInfos(cfg.openai ?? { baseUrl: '', label: '', models: [] });
}

/** Every model the install knows (built-in + its others). */
export function modelCatalog(cfg: Pick<AssistantConfig, 'openai'>): ModelInfo[] {
	return allModels(catalogExtra(cfg));
}

/** The provider adapter for `model`, with that provider's key (in-app, else Worker secret). */
export async function providerFor(
	db: D1Database | null | undefined,
	platformEnv: unknown,
	cfg: Pick<AssistantConfig, 'openai'>,
	model: Pick<ModelInfo, 'provider'>,
	doFetch: typeof fetch = fetch
): Promise<AiProvider> {
	const id = providerOf(model);
	const key = await resolveProviderKey(db, platformEnv, id);
	if (id === 'openai') return openAiCompatProvider({ apiKey: key, baseUrl: cfg.openai?.baseUrl || OPENAI_DEFAULT_BASE_URL }, doFetch);
	return anthropicProvider(key, doFetch);
}

/** Which providers have a key (in-app or Worker secret). */
export async function configuredProviders(db: D1Database | null | undefined, platformEnv: unknown): Promise<Set<ProviderId>> {
	const out = new Set<ProviderId>();
	const [anthropic, openai] = await Promise.all([resolveProviderKey(db, platformEnv, 'anthropic'), resolveProviderKey(db, platformEnv, 'openai')]);
	if (anthropic) out.add('anthropic');
	if (openai) out.add('openai');
	return out;
}
