// "Let Claude suggest resend subjects" (#246). Opt-in: Settings → General writes
// app_state.ai_resend_subject = 'on' | 'off' (unset = off), and it only works when an
// Anthropic key is set — in Settings → Assistant or the ANTHROPIC_API_KEY secret (#297).
// A suggestion only ever fills a form field a person then saves — nothing here runs at send time (processScheduledResends sends the
// stored subject). The key is never logged.

import { modelInfo, providerOf, type ModelInfo } from '$lib/ai-models';
import { featureModel, getAssistantConfig, modelKeyProblem } from './ai/config';
import type { AiProvider } from './ai/provider';

export const AI_RESEND_SUBJECT_KEY = 'ai_resend_subject';
export const AI_SUBJECT_MODEL = 'claude-haiku-5-5';
export const AI_SUBJECT_TIMEOUT_MS = 10_000;
export const AI_SUBJECT_SYSTEM =
	"Lightly rewrite this email subject for a resend to people who didn't open it. Keep the meaning, voice and any merge tags such as {{first_name}} exactly. Max 80 characters. Return only the subject.";
/** A suggestion longer than this is rejected (the prompt asks for ≤ 80). */
export const AI_SUBJECT_MAX = 120;

export const ANTHROPIC_URL ='https://api.anthropic.com/v1/messages';

// `anthropicKey` (the ANTHROPIC_API_KEY secret alone) lives in ./ai/key.ts since #297.
export { anthropicKey } from './ai/key';

/** The Settings toggle (app_state). A failed read counts as off. */
export async function aiResendSubjectOn(db: D1Database): Promise<boolean> {
	try {
		const row = await db
			.prepare(`SELECT value FROM app_state WHERE key = ?`)
			.bind(AI_RESEND_SUBJECT_KEY)
			.first<{ value: string | null }>();
		return row?.value?.trim() === 'on';
	} catch {
		return false;
	}
}

/**
 * #696: the model for resend subjects — the Settings → Assistant → Models override when set,
 * else AI_SUBJECT_MODEL (Claude Haiku, as before #696). Null when the override is gone.
 */
export async function resendSubjectModel(db: D1Database): Promise<ModelInfo | null> {
	const cfg = await getAssistantConfig(db);
	if (!cfg.featureModels?.resendSubject) return modelInfo(AI_SUBJECT_MODEL) ?? { id: AI_SUBJECT_MODEL, label: AI_SUBJECT_MODEL, efforts: [] };
	return featureModel(cfg, 'resendSubject');
}

/** Toggle on AND the subject model's provider has a key — what the pages use to show the "Suggest" button. */
export async function aiResendSubjectAvailable(db: D1Database, platformEnv: unknown): Promise<boolean> {
	const model = await resendSubjectModel(db);
	return !!model && !(await modelKeyProblem(db, platformEnv, model)) && (await aiResendSubjectOn(db));
}

/** Every `{{…}}` construct in a subject (merge tags, conditionals), sorted — two
 *  subjects keep the same tags exactly when these lists are equal. */
export function mergeTagsOf(s: string): string[] {
	return (s.match(/\{\{[^{}]*\}\}/g) ?? []).sort();
}

/**
 * Clean a model reply into a subject, or null when it can't be used: newlines folded,
 * wrapping quotes stripped, then rejected when empty, over AI_SUBJECT_MAX characters, or
 * when any merge tag was dropped, changed or added.
 */
export function cleanSuggestion(raw: string, original: string): string | null {
	let s = raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
	const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;
	s = s.replace(QUOTES, '').trim();
	if (!s || s.length > AI_SUBJECT_MAX) return null;
	const want = mergeTagsOf(original);
	const got = mergeTagsOf(s);
	if (want.length !== got.length || want.some((t, i) => t !== got[i])) return null;
	return s;
}

/**
 * Ask Claude for a lightly rewritten resend subject. Returns null on any failure —
 * missing key, network error, non-2xx, timeout (default 10 s), or a reply that fails
 * `cleanSuggestion`. Never throws.
 */
export async function suggestResendSubject(
	original: string,
	opts: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; model?: ModelInfo; provider?: AiProvider }
): Promise<string | null> {
	const subject = original.trim();
	// #696: a model of another provider goes through the provider interface.
	if (opts.provider && opts.model && providerOf(opts.model) !== 'anthropic') return suggestViaProvider(subject, opts.provider, opts.model, opts.timeoutMs);
	if (!subject || !opts.apiKey) return null;
	const doFetch = opts.fetch ?? fetch;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? AI_SUBJECT_TIMEOUT_MS);
	try {
		const res = await doFetch(ANTHROPIC_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': opts.apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: opts.model && providerOf(opts.model) === 'anthropic' ? opts.model.id : AI_SUBJECT_MODEL,
				max_tokens: 200,
				system: AI_SUBJECT_SYSTEM,
				messages: [{ role: 'user', content: subject }]
			}),
			signal: ctrl.signal
		});
		if (!res.ok) {
			console.error(`resend subject suggestion failed: HTTP ${res.status}`);
			return null;
		}
		const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
		const text = (body.content ?? [])
			.filter((b) => b.type === 'text' && typeof b.text === 'string')
			.map((b) => b.text)
			.join('');
		return cleanSuggestion(text, subject);
	} catch (e) {
		console.error('resend subject suggestion failed:', e instanceof Error ? e.name : 'error');
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** The same request through any AiProvider (#696): streamed text, then `cleanSuggestion`. Never throws. */
async function suggestViaProvider(subject: string, provider: AiProvider, model: ModelInfo, timeoutMs?: number): Promise<string | null> {
	if (!subject) return null;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? AI_SUBJECT_TIMEOUT_MS);
	try {
		let text = '';
		for await (const e of provider.stream({
			model: model.id,
			effort: null,
			system: AI_SUBJECT_SYSTEM,
			messages: [{ role: 'user', content: [{ type: 'text', text: subject }] }],
			tools: [],
			maxTokens: 200,
			signal: ctrl.signal
		})) {
			if (e.type === 'error') {
				console.error(`resend subject suggestion failed${e.status ? `: HTTP ${e.status}` : ''}`);
				return null;
			}
			if (e.type === 'done') text = e.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
		}
		return cleanSuggestion(text, subject);
	} catch (e) {
		console.error('resend subject suggestion failed:', e instanceof Error ? e.name : 'error');
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// Per-user rate limit for the endpoint: 20 suggestions an hour. In-memory per isolate —
// approximate by design (isolates don't share memory), which is fine for a few operators.
export const AI_SUBJECT_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<number, number[]>();

/** Records a hit and returns true while `userId` is under the limit for the last hour. */
export function takeAiSubjectSlot(userId: number, now = Date.now()): boolean {
	const recent = (hits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
	if (recent.length >= AI_SUBJECT_RATE_LIMIT) {
		hits.set(userId, recent);
		return false;
	}
	recent.push(now);
	hits.set(userId, recent);
	return true;
}

/** Tests only: forget every recorded hit. */
export function resetAiSubjectRateLimit(): void {
	hits.clear();
}
