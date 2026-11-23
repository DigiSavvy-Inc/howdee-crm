// OpenAI-compatible Chat Completions provider (#696): plain fetch + SSE, like ./anthropic.ts
// (no SDK). Covers OpenAI, OpenRouter, Google's and Cloudflare Workers AI's OpenAI-compatible
// endpoints and local servers, through a configurable base URL (`POST <base>/chat/completions`).
//
// It translates in both directions so the rest of the app only ever sees the provider-neutral
// shapes in ./provider.ts (what ai_messages.content stores):
//   history → request: text → `content`; tool_use → `tool_calls` (arguments = JSON text);
//     tool_result → a `role: 'tool'` message; thinking blocks are Anthropic-only and dropped.
//   stream → events: `delta.content` → text, `delta.tool_calls[i]` pieces → tool_use blocks,
//     `usage` (stream_options.include_usage) → Usage (cached prompt tokens → cacheRead),
//     finish_reason stop / tool_calls / length → end_turn / tool_use / max_tokens.
// The key goes only into the Authorization header and is never logged; errors carry the
// HTTP status and the provider's message with the key scrubbed out.

import { REASONING_EFFORTS } from '$lib/ai-providers';
import type { Usage } from '$lib/ai-models';
import type { SseMessage } from '$lib/sse';
import { DEFAULT_MAX_TOKENS, parseSse } from './anthropic';
import { scrubKey } from './key';
import type { AiProvider, ChatMessage, ContentBlock, ProviderEvent, StreamRequest } from './provider';

type OaMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: OaToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };
type OaToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/** The model name for the API: an `openai:` registry id loses its prefix. */
export function openAiModelName(id: string): string {
	return id.startsWith('openai:') ? id.slice('openai:'.length) : id;
}

/** Provider-neutral history → Chat Completions messages (exported for tests). */
export function toOpenAiMessages(system: string, messages: ChatMessage[]): OaMessage[] {
	const out: OaMessage[] = [];
	if (system) out.push({ role: 'system', content: system });
	for (const m of messages) {
		if (m.role === 'assistant') {
			const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
			const calls: OaToolCall[] = m.content
				.filter((b) => b.type === 'tool_use')
				.map((b): OaToolCall => {
					const u = b as Extract<ContentBlock, { type: 'tool_use' }>;
					return { id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } };
				});
			if (!text && !calls.length) continue; // e.g. a thinking-only turn
			out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
			continue;
		}
		// User turns: tool results first (they answer the previous assistant turn), then any text.
		for (const b of m.content) {
			if (b.type === 'tool_result') {
				const content = b.is_error ? `Error: ${b.content}` : b.content;
				out.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
			}
		}
		const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
		if (text) out.push({ role: 'user', content: text });
	}
	return out;
}

function isOpenAiHost(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === 'api.openai.com';
	} catch {
		return false;
	}
}

/** The JSON body for POST <base>/chat/completions (exported for tests). */
export function openAiBody(req: StreamRequest, baseUrl: string): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: openAiModelName(req.model),
		stream: true,
		stream_options: { include_usage: true },
		messages: toOpenAiMessages(req.system, req.messages)
	};
	// OpenAI's own API wants max_completion_tokens; other compatible servers take max_tokens.
	body[isOpenAiHost(baseUrl) ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens ?? DEFAULT_MAX_TOKENS;
	if (req.tools.length) {
		body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
	}
	// Effort is offered only for models marked `reasoning` (their efforts = REASONING_EFFORTS).
	if (req.effort && (REASONING_EFFORTS as readonly string[]).includes(req.effort)) body.reasoning_effort = req.effort;
	return body;
}

const STOP_REASONS: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

type ToolPart = { id: string; name: string; json: string; started: boolean };

/** Turn Chat Completions SSE chunks into provider events, assembling the final content. */
export async function* assembleOpenAiStream(messages: AsyncIterable<SseMessage>, opts: { toolInputDeltas?: boolean } = {}): AsyncGenerator<ProviderEvent> {
	let text = '';
	const tools: ToolPart[] = [];
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let stopReason: string | null = null;
	let finished = false;
	for await (const m of messages) {
		const data = m.data.trim();
		if (data === '[DONE]') {
			finished = true;
			break;
		}
		let d: any;
		try {
			d = JSON.parse(data);
		} catch {
			continue;
		}
		if (d?.error) {
			const msg = typeof d.error === 'string' ? d.error : d.error?.message;
			yield { type: 'error', message: String(msg ?? 'The model returned an error.') };
			return;
		}
		if (d?.usage && typeof d.usage === 'object') {
			const cached = Number(d.usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
			const prompt = Number(d.usage.prompt_tokens ?? 0) || 0;
			usage.input = Math.max(0, prompt - cached);
			usage.cacheRead = cached;
			usage.output = Number(d.usage.completion_tokens ?? 0) || 0;
		}
		for (const choice of Array.isArray(d?.choices) ? d.choices : []) {
			const delta = choice?.delta ?? {};
			if (typeof delta.content === 'string' && delta.content) {
				text += delta.content;
				yield { type: 'text', text: delta.content };
			}
			for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
				const idx = Number.isInteger(tc?.index) ? tc.index : tools.length;
				const t = (tools[idx] ??= { id: '', name: '', json: '', started: false });
				if (typeof tc?.id === 'string' && tc.id) t.id = tc.id;
				if (typeof tc?.function?.name === 'string') t.name += tc.function.name;
				if (!t.started && t.name) {
					if (!t.id) t.id = `call_${idx}`;
					t.started = true;
					yield { type: 'tool_use_start', id: t.id, name: t.name };
				}
				const piece = tc?.function?.arguments;
				if (typeof piece === 'string' && piece) {
					t.json += piece;
					if (opts.toolInputDeltas && t.started) yield { type: 'tool_input', id: t.id, json: piece };
				}
			}
			if (typeof choice?.finish_reason === 'string' && choice.finish_reason) stopReason = STOP_REASONS[choice.finish_reason] ?? choice.finish_reason;
		}
	}
	// Some servers end the stream without `[DONE]`; a finish_reason is enough then.
	if (!finished && !stopReason) {
		yield { type: 'error', message: 'The response ended early.' };
		return;
	}
	const content: ContentBlock[] = [];
	const invalid: string[] = [];
	if (text) content.push({ type: 'text', text });
	tools.forEach((t, i) => {
		if (!t || !t.name) return;
		const id = /^[A-Za-z0-9_-]{1,64}$/.test(t.id) ? t.id : `call_${i}`;
		let input: unknown = {};
		try {
			input = t.json.trim() ? JSON.parse(t.json) : {};
		} catch {
			invalid.push(id);
		}
		if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
		content.push({ type: 'tool_use', id, name: t.name, input });
	});
	if (content.some((b) => b.type === 'tool_use') && stopReason !== 'tool_use') stopReason = 'tool_use';
	yield invalid.length ? { type: 'done', content, stopReason, usage, invalidToolInput: invalid } : { type: 'done', content, stopReason, usage };
}

export function openAiCompatProvider(o: { apiKey: string; baseUrl: string }, doFetch: typeof fetch = fetch): AiProvider {
	const base = o.baseUrl.replace(/\/+$/, '');
	return {
		async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
			if (!o.apiKey) {
				yield { type: 'error', message: 'No key is set for the OpenAI-compatible provider (Settings → Assistant).', status: 503 };
				return;
			}
			let res: Response;
			try {
				res = await doFetch(`${base}/chat/completions`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
					body: JSON.stringify(openAiBody(req, base)),
					redirect: 'manual',
					signal: req.signal
				});
			} catch (e) {
				const aborted = req.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
				yield { type: 'error', message: aborted ? 'Stopped.' : 'Could not reach the model.' };
				return;
			}
			if (!res.ok || !res.body) {
				let message = `The model API answered HTTP ${res.status}.`;
				try {
					const j = (await res.json()) as { error?: { message?: string } | string };
					const detail = typeof j?.error === 'string' ? j.error : j?.error?.message;
					if (detail) message = `${message} ${scrubKey(String(detail), o.apiKey).slice(0, 300)}`;
				} catch {
					/* body not JSON */
				}
				console.error(`assistant: model call failed: HTTP ${res.status}`);
				yield { type: 'error', message, status: res.status };
				return;
			}
			try {
				yield* assembleOpenAiStream(parseSse(res.body), { toolInputDeltas: req.toolInputDeltas });
			} catch (e) {
				const aborted = req.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
				yield { type: 'error', message: aborted ? 'Stopped.' : 'The response stream failed.' };
			}
		}
	};
}
