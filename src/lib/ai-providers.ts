// AI providers other than Anthropic (#696), universal (Settings → Assistant uses it in the
// browser, the server to normalise the stored config). One adapter so far: an
// OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Google's and Cloudflare
// Workers AI's OpenAI-compatible URLs, a local server) at a configurable base URL.
//
// The install's models of that provider are typed in by an admin, one per line:
//   <model name> | <label> | <flags> | <input $/M> | <output $/M>
// flags = comma separated `tools`, `reasoning` (sends `reasoning_effort`), `no-tools`.
// Label, flags and prices are optional; a model without both prices is unpriced.
// Stored in the assistant config (app_state `ai_assistant_config`); the key lives in
// integration_secrets (provider OPENAI_SECRET_PROVIDER), never here.

import { supportsTools, type Effort, type ModelInfo, type Price } from './ai-models';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_MODEL_PREFIX = 'openai:';
export const OPENAI_MODELS_MAX = 20;
export const OPENAI_NAME_MAX = 120;
export const OPENAI_LABEL_MAX = 60;
export const OPENAI_BASE_URL_MAX = 300;
/** The effort levels a `reasoning` model takes (sent as `reasoning_effort`; Max isn't offered). */
export const REASONING_EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

export type CustomModel = {
	name: string; // the API model name, e.g. gpt-5.1 or meta-llama/llama-4-maverick
	label: string;
	tools: boolean;
	reasoning: boolean;
	/** US dollars per million tokens; null = unpriced. */
	price: { input: number; output: number } | null;
};

export type OpenAiConfig = {
	/** '' = OPENAI_DEFAULT_BASE_URL. */
	baseUrl: string;
	/** Shown next to the models, e.g. "OpenRouter". '' = "OpenAI-compatible". */
	label: string;
	models: CustomModel[];
};

export const OPENAI_DEFAULTS: OpenAiConfig = { baseUrl: '', label: '', models: [] };

/** The OpenAI API's host: the only one the OPENAI_API_KEY Worker secret goes to unless the
 *  operator names another in OPENAI_BASE_URL_HOST (#748). */
export const OPENAI_DEFAULT_HOST = 'api.openai.com';
/** Hosts a base URL may use plain http for: a model server on this machine (#748). */
export const LOCAL_HTTP_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** '' when the URL is usable, else the reason. https (http only for localhost), no credentials,
 *  no query or fragment. */
export function baseUrlProblem(raw: string): string {
	const v = raw.trim();
	if (!v) return '';
	if (v.length > OPENAI_BASE_URL_MAX) return 'That base URL is too long.';
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		return 'The base URL must be a full URL, e.g. https://api.openai.com/v1.';
	}
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(u.hostname.toLowerCase()))) {
		return 'The base URL must start with https:// (http:// only for localhost, 127.0.0.1 or [::1]).';
	}
	if (u.username || u.password) return "The base URL can't contain a user name or password. Put the key in the key field.";
	if (u.search || u.hash) return "The base URL can't have a query string or #fragment.";
	return '';
}

/**
 * A stored URL as it may be shown: any user name / password replaced by `***`
 * (`https://user:pw@host/v1` → `https://***@host/v1`, #748). The authority is read the way the URL
 * parser does (after `scheme:` and its slashes or backslashes, up to the first / ? # or \, the
 * userinfo ending at its last @). Anything else is returned unchanged.
 */
export function maskUrlCredentials(raw: string): string {
	// No slash after the scheme (`user:pw@host`, `https:user:pw@host`): mask from the start, scheme too.
	const start = /^[a-z][a-z0-9+.-]*:[\\/]+/i.exec(raw)?.[0].length ?? 0;
	const rest = raw.slice(start);
	const end = rest.search(/[/?#\\]/);
	const authority = end === -1 ? rest : rest.slice(0, end);
	const at = authority.lastIndexOf('@');
	if (at === -1) return raw;
	return `${raw.slice(0, start)}***${rest.slice(at)}`;
}

/**
 * The host (lowercase, with a non-default port) a base URL sends requests to: blank = the OpenAI
 * default host; null when the URL isn't usable (#748). A key is only sent to the host it was saved for.
 */
export function baseUrlHost(raw: unknown): string | null {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v) return OPENAI_DEFAULT_HOST;
	if (baseUrlProblem(v)) return null;
	try {
		return new URL(v).host.toLowerCase();
	} catch {
		return null;
	}
}

/** A host as the operator may write it (bare host, host:port or a URL) in `baseUrlHost`'s form; '' when unusable. */
export function cleanHostSetting(raw: unknown): string {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v) return '';
	try {
		const u = new URL(v.includes('://') ? v : `https://${v}`);
		if (u.username || u.password) return '';
		return u.host.toLowerCase();
	} catch {
		return '';
	}
}

/** The base URL without a trailing slash; blank or unusable = the OpenAI default. */
export function cleanBaseUrl(raw: unknown): string {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v || baseUrlProblem(v)) return '';
	return v.replace(/\/+$/, '');
}

function priceNum(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(String(v).replace(/^\$/, '').trim());
	return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null;
}

function cleanModel(raw: unknown): CustomModel | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const name = typeof r.name === 'string' ? r.name.trim() : '';
	if (!name || name.length > OPENAI_NAME_MAX || /[\s|]/.test(name)) return null;
	const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, OPENAI_LABEL_MAX) : name.slice(0, OPENAI_LABEL_MAX);
	const p = r.price && typeof r.price === 'object' ? (r.price as Record<string, unknown>) : null;
	const input = p ? priceNum(p.input) : null;
	const output = p ? priceNum(p.output) : null;
	return {
		name,
		label,
		tools: r.tools !== false,
		reasoning: r.reasoning === true,
		price: input !== null && output !== null ? { input, output } : null
	};
}

/** Lenient read of the stored / posted config (junk → defaults, bad models dropped, names unique). */
export function normalizeOpenAiConfig(raw: unknown): OpenAiConfig {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const seen = new Set<string>();
	const models: CustomModel[] = [];
	for (const m of Array.isArray(r.models) ? r.models : []) {
		const c = cleanModel(m);
		if (!c || seen.has(c.name)) continue;
		seen.add(c.name);
		models.push(c);
		if (models.length >= OPENAI_MODELS_MAX) break;
	}
	return {
		baseUrl: cleanBaseUrl(r.baseUrl),
		label: typeof r.label === 'string' ? r.label.trim().slice(0, OPENAI_LABEL_MAX) : '',
		models
	};
}

export type ParsedModels = { models: CustomModel[]; problems: string[] };

/** Parse the Settings textarea (one model per line, see the header). Blank and `#` lines are skipped. */
export function parseModelLines(text: string): ParsedModels {
	const models: CustomModel[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	const lines = text.split(/\r?\n/);
	lines.forEach((line, i) => {
		const t = line.trim();
		if (!t || t.startsWith('#')) return;
		const [name = '', label = '', flags = '', input = '', output = ''] = t.split('|').map((x) => x.trim());
		const n = i + 1;
		if (!name || /\s/.test(name)) return problems.push(`Line ${n}: the model name is missing or has spaces.`);
		if (name.length > OPENAI_NAME_MAX) return problems.push(`Line ${n}: the model name is too long.`);
		if (seen.has(name)) return problems.push(`Line ${n}: ${name} is listed twice.`);
		const flagList = flags.toLowerCase().split(',').map((f) => f.trim()).filter(Boolean);
		const unknown = flagList.filter((f) => !['tools', 'no-tools', 'reasoning'].includes(f));
		if (unknown.length) return problems.push(`Line ${n}: unknown flag ${unknown.join(', ')} (use tools, no-tools, reasoning).`);
		const pin = priceNum(input);
		const pout = priceNum(output);
		if ((input && pin === null) || (output && pout === null)) return problems.push(`Line ${n}: prices are dollars per million tokens, e.g. 1.25.`);
		if ((pin === null) !== (pout === null)) return problems.push(`Line ${n}: give both prices or neither (no prices = unpriced).`);
		seen.add(name);
		models.push({
			name,
			label: (label || name).slice(0, OPENAI_LABEL_MAX),
			tools: !flagList.includes('no-tools'),
			reasoning: flagList.includes('reasoning'),
			price: pin !== null && pout !== null ? { input: pin, output: pout } : null
		});
	});
	if (models.length > OPENAI_MODELS_MAX) problems.push(`At most ${OPENAI_MODELS_MAX} models.`);
	return { models: models.slice(0, OPENAI_MODELS_MAX), problems };
}

/** The textarea text for a stored list (round-trips through parseModelLines). */
export function modelLinesText(models: readonly CustomModel[]): string {
	return models
		.map((m) => {
			const flags = [m.tools ? 'tools' : 'no-tools', ...(m.reasoning ? ['reasoning'] : [])].join(',');
			const price = m.price ? ` | ${m.price.input} | ${m.price.output}` : '';
			return `${m.name} | ${m.label} | ${flags}${price}`;
		})
		.join('\n');
}

/** The registry entries (`ModelInfo`) for an install's OpenAI-compatible models. */
export function openAiModelInfos(cfg: OpenAiConfig): ModelInfo[] {
	return cfg.models.map((m): ModelInfo => {
		const price: Price | undefined = m.price ? { input: m.price.input, output: m.price.output, cacheRead: m.price.input, cacheWrite: m.price.input } : undefined;
		return {
			id: `${OPENAI_MODEL_PREFIX}${m.name}`,
			label: cfg.label ? `${m.label} (${cfg.label})` : m.label,
			provider: 'openai',
			apiModel: m.name,
			tools: m.tools,
			streaming: true,
			efforts: m.reasoning ? REASONING_EFFORTS : [],
			...(price ? { price } : {})
		};
	});
}

// ---- per-feature default models (#696) ----

/** The AI features with their own default model (Settings → Assistant → Models). */
export const AI_FEATURES = ['chat', 'jobs', 'editorAsk', 'draftReply', 'briefs', 'reports', 'resendSubject'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
	chat: 'Assistant chat',
	jobs: 'Scheduled jobs (new jobs)',
	editorAsk: 'Ask AI in the editor',
	draftReply: 'Draft reply',
	briefs: 'Account briefs',
	reports: 'Report builder ("Describe it")',
	resendSubject: 'Resend subject suggestions'
};

/** Features that call tools: models without tool support are hidden for them. */
export const TOOL_FEATURES: ReadonlySet<AiFeature> = new Set<AiFeature>(['chat', 'jobs', 'editorAsk']);

/** Whether `model` may be used for `feature` (tool support where the feature needs tools). */
export function modelFitsFeature(model: ModelInfo, feature: AiFeature): boolean {
	return !TOOL_FEATURES.has(feature) || supportsTools(model);
}
