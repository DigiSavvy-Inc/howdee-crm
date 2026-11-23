// Anthropic Messages API provider (#287): plain fetch + hand-rolled SSE parsing (no SDK —
// Workers-native). The key comes from `resolveAnthropicKey` (./key.ts, #297: in-app key,
// else ANTHROPIC_API_KEY) and is never logged. Prompt caching: one cache breakpoint on the last tool
// definition and one on the system prompt (tools → system is the cache prefix order).

import { ANTHROPIC_URL } from '../ai-subject';
import { EFFORT_PARAM, type Usage } from '$lib/ai-models';
import { SseBuffer, type SseMessage } from '$lib/sse';
import type { AiProvider, ContentBlock, ProviderEvent, StreamRequest } from './provider';

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 8192;

/** Split an SSE byte stream into `{ event, data }` messages. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseBuffer();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			yield* sse.push(decoder.decode(value, { stream: true }));
		}
		yield* sse.push(decoder.decode());
		yield* sse.flush();
	} finally {
		reader.releaseLock();
	}
}

type Partial =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; json: string }
	| { type: 'thinking'; thinking: string; signature: string }
	| { type: 'redacted_thinking'; data: string }
	| { type: 'other' };

/** Turn Anthropic SSE messages into provider events, assembling the final content blocks. */
export async function* assembleAnthropicStream(messages: AsyncIterable<SseMessage>, opts: { toolInputDeltas?: boolean } = {}): AsyncGenerator<ProviderEvent> {
	const blocks: Partial[] = [];
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let stopReason: string | null = null;
	let finished = false;
	for await (const m of messages) {
		let d: any;
		try {
			d = JSON.parse(m.data);
		} catch {
			continue;
		}
		const type = d?.type ?? m.event;
		if (type === 'message_start') {
			const u = d.message?.usage ?? {};
			usage.input = u.input_tokens ?? 0;
			usage.output = u.output_tokens ?? 0;
			usage.cacheRead = u.cache_read_input_tokens ?? 0;
			usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
		} else if (type === 'content_block_start') {
			const b = d.content_block ?? {};
			const idx = Number(d.index ?? blocks.length);
			if (b.type === 'text') blocks[idx] = { type: 'text', text: b.text ?? '' };
			else if (b.type === 'tool_use') {
				blocks[idx] = { type: 'tool_use', id: String(b.id), name: String(b.name), json: '' };
				yield { type: 'tool_use_start', id: String(b.id), name: String(b.name) };
			} else if (b.type === 'thinking') blocks[idx] = { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' };
			else if (b.type === 'redacted_thinking') blocks[idx] = { type: 'redacted_thinking', data: b.data ?? '' };
			else blocks[idx] = { type: 'other' };
		} else if (type === 'content_block_delta') {
			const b = blocks[Number(d.index)];
			const delta = d.delta ?? {};
			if (!b) continue;
			if (delta.type === 'text_delta' && b.type === 'text') {
				b.text += delta.text ?? '';
				if (delta.text) yield { type: 'text', text: delta.text };
			} else if (delta.type === 'input_json_delta' && b.type === 'tool_use') {
				b.json += delta.partial_json ?? '';
				if (opts.toolInputDeltas && delta.partial_json) yield { type: 'tool_input', id: b.id, json: delta.partial_json };
			}
			else if (delta.type === 'thinking_delta' && b.type === 'thinking') b.thinking += delta.thinking ?? '';
			else if (delta.type === 'signature_delta' && b.type === 'thinking') b.signature += delta.signature ?? '';
		} else if (type === 'message_delta') {
			if (d.delta?.stop_reason !== undefined) stopReason = d.delta.stop_reason;
			const u = d.usage ?? {};
			if (typeof u.output_tokens === 'number') usage.output = u.output_tokens;
			if (typeof u.input_tokens === 'number') usage.input = u.input_tokens;
			if (typeof u.cache_read_input_tokens === 'number') usage.cacheRead = u.cache_read_input_tokens;
			if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWrite = u.cache_creation_input_tokens;
		} else if (type === 'message_stop') {
			finished = true;
			break;
		} else if (type === 'error') {
			yield { type: 'error', message: String(d.error?.message ?? 'The model returned an error.') };
			return;
		}
	}
	if (!finished) {
		yield { type: 'error', message: 'The response ended early.' };
		return;
	}
	const content: ContentBlock[] = [];
	// #679: a tool input that doesn't parse still becomes {} in `content` (the assistant loop
	// stores and replays it), but its id is reported on the done event so Ask AI can refuse it.
	const invalid: string[] = [];
	for (const b of blocks) {
		if (!b || b.type === 'other') continue;
		if (b.type === 'tool_use') {
			let input: unknown = {};
			try {
				input = b.json.trim() ? JSON.parse(b.json) : {};
			} catch {
				input = {};
				invalid.push(b.id);
			}
			content.push({ type: 'tool_use', id: b.id, name: b.name, input });
		} else if (b.type === 'text') {
			if (b.text) content.push({ type: 'text', text: b.text });
		} else content.push(b);
	}
	yield invalid.length ? { type: 'done', content, stopReason, usage, invalidToolInput: invalid } : { type: 'done', content, stopReason, usage };
}

/** The JSON body for POST /v1/messages (exported for tests). */
export function anthropicBody(req: StreamRequest): Record<string, unknown> {
	const tools = req.tools.map((t, i) =>
		i === req.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : { ...t }
	);
	const body: Record<string, unknown> = {
		model: req.model,
		max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
		stream: true,
		system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
		messages: req.messages
	};
	// #389 (report builder), #387 (Draft reply) and #388 (account briefs) call without tools; the API wants no empty list then.
	if (tools.length) body.tools = tools;
	// No `tool_choice` (#679): current models refuse a forced tool, so the default (auto) applies
	// and Ask AI's prompt asks for its one tool. A tool's own fields (e.g. `eager_input_streaming`)
	// pass through the spread above.
	if (req.effort) body[EFFORT_PARAM.object] = { [EFFORT_PARAM.key]: req.effort };
	return body;
}

export function anthropicProvider(apiKey: string, doFetch: typeof fetch = fetch): AiProvider {
	return {
		async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
			let res: Response;
			try {
				res = await doFetch(ANTHROPIC_URL, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-api-key': apiKey,
						'anthropic-version': ANTHROPIC_VERSION
					},
					body: JSON.stringify(anthropicBody(req)),
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
					const j = (await res.json()) as { error?: { message?: string } };
					if (j?.error?.message) message = `${message} ${j.error.message}`;
				} catch {
					/* body not JSON */
				}
				console.error(`assistant: model call failed: HTTP ${res.status}`);
				yield { type: 'error', message, status: res.status };
				return;
			}
			try {
				yield* assembleAnthropicStream(parseSse(res.body), { toolInputDeltas: req.toolInputDeltas });
			} catch (e) {
				const aborted = req.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
				yield { type: 'error', message: aborted ? 'Stopped.' : 'The response stream failed.' };
			}
		}
	};
}
