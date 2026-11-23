// The assistant's model catalogue (#287) — the ONE place for model ids, which effort
// levels each model accepts, the Messages API parameter that carries effort, and prices.
//
// #696: a registry across providers. `MODELS` holds the built-in Claude models (provider
// `anthropic`, id = the bare Anthropic id, which is what older rows and configs store).
// Models of other providers are added per install in Settings → Assistant (an
// OpenAI-compatible endpoint, see `$lib/ai-providers`) and passed to `modelInfo` as `extra`;
// their id is namespaced (`openai:<model name>`). Every model declares tool support,
// streaming, effort levels and prices; a model without `price` is unpriced (its calls are
// counted at 0 and shown as "unpriced", never as free).
// Universal (no server imports): the panel uses it to hide unsupported effort levels and
// the server uses it to validate requests and price usage.
//
// Effort is sent as `output_config: { effort }` on POST /v1/messages (EFFORT_PARAM below).
// A model with no effort levels gets no `output_config` at all (no current model is like
// that, but the path stays: effortFor returns null and the UI hides the effort picker).
//
// Models: https://platform.claude.com/docs/en/about-claude/models/overview (checked 2026-11-22).
// Fable 5.2 (#695) is the newest Fable; Fable 5.1 is still served (not deprecated), so it stays
// listed for saved settings, threads and jobs that name it.
//
// Effort: https://platform.claude.com/docs/en/build-with-claude/effort (checked 2026-11-22).
// All five models accept low / medium / high / xhigh / max. The app offers only
// Low / Medium / High / Max, so `xhigh` is deliberately left out of EFFORT_LEVELS.
//
// Prices: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-22).
// `cacheWrite` is the 5-minute cache write rate. Only Haiku 5.5 has a long-prompt tier; the
// others price the full 1M context at the standard rate.
//
// Thinking: adaptive thinking is always on for Fable 5.2 and Opus 5.5, so requests send no
// forced `tool_choice` and no custom temperature (see anthropic.ts).

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };

/** Request body path for effort: `{ [EFFORT_PARAM.object]: { [EFFORT_PARAM.key]: effort } }`. */
export const EFFORT_PARAM = { object: 'output_config', key: 'effort' } as const;

/** #696: the providers behind the AiProvider interface (server: ai/providers.ts). */
export const PROVIDERS = ['anthropic', 'openai'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<ProviderId, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI-compatible' };

export type ModelInfo = {
	/** Anthropic models: the bare Anthropic id. Other providers: `<provider>:<model name>`. */
	id: string;
	label: string;
	/** #696: missing = 'anthropic' (the built-in entries). */
	provider?: ProviderId;
	/** #696: the model name sent to the provider's API; missing = `id`. */
	apiModel?: string;
	/** #696: tool use (function calling). Missing = true. Features that need tools hide models without it. */
	tools?: boolean;
	/** #696: streamed responses. Missing = true (every adapter streams). */
	streaming?: boolean;
	efforts: readonly Effort[]; // empty = the model takes no effort setting
	/** US dollars per million tokens (= micro-dollars per token). Missing = unpriced (#696). */
	price?: Price;
	/** Higher rates for a response whose prompt (input + cache read + cache write tokens) exceeds `aboveTokens`. */
	longPrompt?: { aboveTokens: number; price: Price };
};

/** US dollars per million tokens (= micro-dollars per token). */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const PROVIDER = 'anthropic';

export const MODELS: readonly ModelInfo[] = [
	{
		id: 'claude-fable-5-2',
		label: 'Claude Fable 5.2',
		efforts: EFFORT_LEVELS,
		price: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }
	},
	{
		id: 'claude-fable-5-1',
		label: 'Claude Fable 5.1',
		efforts: EFFORT_LEVELS,
		price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }
	},
	{
		id: 'claude-opus-5-5',
		label: 'Claude Opus 5.5',
		efforts: EFFORT_LEVELS,
		price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
	},
	{
		id: 'claude-sonnet-5-5',
		label: 'Claude Sonnet 5.5',
		efforts: EFFORT_LEVELS,
		price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
	},
	{
		id: 'claude-haiku-5-5',
		label: 'Claude Haiku 5.5',
		efforts: EFFORT_LEVELS,
		// Prompts up to 100k tokens; above that the longPrompt rates apply.
		price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
		longPrompt: { aboveTokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } }
	}
];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT: Effort = 'medium';

/**
 * A model by id. `extra` = the install's models of other providers (#696, from the assistant
 * config: `catalogExtra(cfg)` on the server). A namespaced Anthropic id
 * (`anthropic:claude-opus-5-5`) finds the bare entry.
 */
export function modelInfo(id: string | null | undefined, extra: readonly ModelInfo[] = []): ModelInfo | null {
	if (!id) return null;
	const bare = id.startsWith(`${PROVIDER}:`) ? id.slice(PROVIDER.length + 1) : id;
	return MODELS.find((m) => m.id === bare) ?? extra.find((m) => m.id === id) ?? null;
}

/** The built-in models plus the install's others (#696). */
export function allModels(extra: readonly ModelInfo[] = []): ModelInfo[] {
	return [...MODELS, ...extra.filter((m) => !MODELS.some((b) => b.id === m.id))];
}

export function providerOf(m: Pick<ModelInfo, 'provider'>): ProviderId {
	return m.provider ?? 'anthropic';
}

/** #696: whether the model can call tools (the assistant chat, scheduled jobs and Ask AI need it). */
export function supportsTools(m: Pick<ModelInfo, 'tools'>): boolean {
	return m.tools !== false;
}

/** #696: false = no known price; costs are recorded as 0 and shown as "unpriced". */
export function isPriced(m: Pick<ModelInfo, 'price'>): boolean {
	return !!m.price;
}

/** The model name for the provider's API (#696). */
export function apiModelName(m: Pick<ModelInfo, 'id' | 'apiModel'>): string {
	return m.apiModel ?? m.id;
}

/** Namespaced id, e.g. `anthropic:claude-opus-5-5` / `openai:gpt-5.1` (#696). */
export function namespacedModel(id: string, provider: ProviderId = PROVIDER): string {
	return id.includes(':') ? id : `${provider}:${id}`;
}

export function isEffort(v: unknown): v is Effort {
	return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * The effort to actually use for a model: the requested one when the model supports it,
 * else the model's closest supported level to `medium`, else null (no effort setting).
 */
export function effortFor(model: ModelInfo, requested: unknown): Effort | null {
	if (!model.efforts.length) return null;
	if (isEffort(requested) && model.efforts.includes(requested)) return requested;
	return model.efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : model.efforts[0];
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** The rates for one API response: the long-prompt tier when the prompt is over its threshold. */
export function priceFor(model: ModelInfo, u: Usage): Price | null {
	const promptTokens = u.input + u.cacheRead + u.cacheWrite;
	return model.longPrompt && promptTokens > model.longPrompt.aboveTokens ? model.longPrompt.price : (model.price ?? null);
}

/** Cost of one API response in micro-dollars (rounded up so a tiny call never costs 0).
 *  An unpriced model (#696) gives 0: check `isPriced` before showing it as a cost. */
export function costMicros(model: ModelInfo, u: Usage): number {
	const p = priceFor(model, u);
	if (!p) return 0;
	const raw = u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite;
	return Math.ceil(raw);
}

/** "$0.04" style money from micro-dollars. */
export function formatMicros(micros: number): string {
	const usd = micros / 1_000_000;
	if (usd > 0 && usd < 0.01) return '<$0.01';
	return `$${usd.toFixed(2)}`;
}
