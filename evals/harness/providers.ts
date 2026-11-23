// Assistant evals (#391): providers around the real one.
//  - observe(): wraps any provider and keeps every request (tools offered, messages) and
//    every final response, so the harness can read tool calls, their results and the
//    transcript the same way for chat turns and scheduled jobs (whose loop is internal).
//  - replayProvider(): plays a recording (evals/recordings/<case>.json) back, one response
//    per model call — the offline CI subset. Refs in tool inputs are resolved to the
//    fixture's ids first, so a recording survives id changes.

import type { AiProvider, ChatMessage, ContentBlock, ProviderEvent, StreamRequest } from '../../src/lib/server/ai/provider';
import type { Usage } from '../../src/lib/ai-models';
import { resolveRefs } from '../../scripts/assistant-evals-lib.mjs';

export type Recording = { case: string; source?: string; model?: string; responses: { stop_reason: string | null; content: ContentBlock[] }[] };
export type Observed = {
	requests: { tools: string[]; messages: ChatMessage[] }[];
	responses: { content: ContentBlock[]; stopReason: string | null; usage: Usage }[];
	errors: string[];
};

export function observe(inner: AiProvider): { provider: AiProvider; seen: Observed } {
	const seen: Observed = { requests: [], responses: [], errors: [] };
	const provider: AiProvider = {
		async *stream(req: StreamRequest) {
			seen.requests.push({ tools: req.tools.map((t) => t.name), messages: structuredClone(req.messages) });
			for await (const ev of inner.stream(req)) {
				if (ev.type === 'done') seen.responses.push({ content: ev.content, stopReason: ev.stopReason, usage: ev.usage });
				if (ev.type === 'error') seen.errors.push(ev.message);
				yield ev;
			}
		}
	};
	return { provider, seen };
}

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function replayProvider(rec: Recording, refs: Record<string, number>): AiProvider {
	let i = 0;
	return {
		async *stream(): AsyncGenerator<ProviderEvent> {
			const r = rec.responses[i++];
			if (!r) {
				yield { type: 'error', message: `Recording for ${rec.case} has no response #${i} (re-record with --record).` };
				return;
			}
			const content = resolveRefs(r.content, refs) as ContentBlock[];
			for (const b of content) {
				if (b.type === 'text') yield { type: 'text', text: b.text };
				else if (b.type === 'tool_use') yield { type: 'tool_use_start', id: b.id, name: b.name };
			}
			yield { type: 'done', content, stopReason: r.stop_reason, usage: ZERO };
		}
	};
}
