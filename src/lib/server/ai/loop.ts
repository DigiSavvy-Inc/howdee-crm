// The server-side agentic loop (#287): model → stream text → on tool_use run the handler →
// append tool_result → repeat until the model ends its turn. Caps per turn: MAX_TOOL_CALLS
// tool calls and TURN_DEADLINE_MS wall time; `signal` (the browser's Stop) aborts.
// Every model response and every tool_result batch is handed to `persist` so the stored
// history always stays a valid Messages API conversation (each tool_use gets a result).
// #301: a write tool's card is emitted as an `action` event; a write that needs approval
// emits `pending` and ends the turn (stopReason 'pending') with its tool call unanswered —
// the answer is stored when the user approves or cancels (ai/actions.ts, ai/chat.ts).

import { costMicros, type Effort, type ModelInfo, type Usage } from '$lib/ai-models';
import type { ActionCard } from '$lib/assistant-actions';
import type { AiProvider, ChatMessage, ContentBlock, ProviderEvent, ToolResultBlock, ToolUseBlock } from './provider';
import { runTool, toolDefinitions } from './tools';
import type { Tool, ToolContext } from './tools/types';

export const MAX_TOOL_CALLS = 25;
export const TURN_DEADLINE_MS = 3 * 60 * 1000;

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_limit' | 'deadline' | 'aborted' | 'error' | string;

export type LoopEvent =
	| { type: 'text'; text: string }
	| { type: 'tool_start'; id: string; name: string }
	| { type: 'tool_done'; id: string; name: string; ok: boolean; summary: string; count: number | null; error?: string }
	| { type: 'action'; action: ActionCard }
	| { type: 'pending'; action: ActionCard }
	| { type: 'usage'; usage: Usage; costMicros: number }
	| { type: 'error'; message: string }
	| { type: 'done'; stopReason: StopReason; toolCalls: number; costMicros: number; usage: Usage };

export type PersistedMessage =
	| { role: 'assistant'; content: ContentBlock[]; usage: Usage; costMicros: number }
	| { role: 'tool'; content: ToolResultBlock[] };

export type LoopOptions = {
	provider: AiProvider;
	model: ModelInfo;
	effort: Effort | null;
	system: string;
	messages: ChatMessage[]; // history, ending with the new user message
	tools: Tool[];
	ctx: ToolContext;
	emit: (e: LoopEvent) => void;
	/** Returns the stored message id (write tools record it on their ai_actions row). */
	persist: (m: PersistedMessage) => Promise<number | void>;
	signal?: AbortSignal;
	maxToolCalls?: number;
	deadlineMs?: number;
	maxTokens?: number;
};

const LIMIT_TEXT: Record<string, string> = {
	tool_limit: `Stopped: this turn reached the limit of ${MAX_TOOL_CALLS} tool calls.`,
	deadline: 'Stopped: this turn ran longer than 3 minutes.',
	aborted: 'Stopped.'
};
const PENDING_TEXT = 'waiting for the user to approve an earlier action in this turn. Call it again after that if it is still needed.';

export async function runTurn(o: LoopOptions): Promise<{ stopReason: StopReason; toolCalls: number; costMicros: number; usage: Usage }> {
	const maxToolCalls = o.maxToolCalls ?? MAX_TOOL_CALLS;
	const controller = new AbortController();
	let deadlineHit = false;
	const onAbort = () => controller.abort();
	if (o.signal?.aborted) controller.abort();
	o.signal?.addEventListener('abort', onAbort);
	const timer = setTimeout(() => {
		deadlineHit = true;
		controller.abort();
	}, o.deadlineMs ?? TURN_DEADLINE_MS);

	const messages = [...o.messages];
	const defs = toolDefinitions(o.tools);
	const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	let toolCalls = 0;
	const stopped = () => (deadlineHit ? 'deadline' : 'aborted');
	const finish = (stopReason: StopReason) => {
		if (LIMIT_TEXT[stopReason] && stopReason !== 'aborted') o.emit({ type: 'error', message: LIMIT_TEXT[stopReason] });
		o.emit({ type: 'done', stopReason, toolCalls, costMicros: cost, usage: total });
		return { stopReason, toolCalls, costMicros: cost, usage: total };
	};

	try {
		while (true) {
			if (controller.signal.aborted) return finish(stopped());
			let partial = '';
			let done: Extract<ProviderEvent, { type: 'done' }> | null = null;
			let failure: string | null = null;
			for await (const ev of o.provider.stream({
				model: o.model.id,
				effort: o.effort,
				system: o.system,
				messages,
				tools: defs,
				maxTokens: o.maxTokens,
				signal: controller.signal
			})) {
				if (ev.type === 'text') {
					partial += ev.text;
					o.emit({ type: 'text', text: ev.text });
				} else if (ev.type === 'tool_use_start') o.emit({ type: 'tool_start', id: ev.id, name: ev.name });
				else if (ev.type === 'done') done = ev;
				else if (ev.type === 'error') failure = ev.message;
				if (controller.signal.aborted) break;
			}
			if (!done || controller.signal.aborted) {
				// Keep what streamed so far (text only — an unfinished tool_use never ran).
				if (partial.trim()) {
					const content: ContentBlock[] = [{ type: 'text', text: partial }];
					const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
					await o.persist({ role: 'assistant', content, usage: zero, costMicros: 0 });
				}
				if (controller.signal.aborted) return finish(stopped());
				o.emit({ type: 'error', message: failure ?? 'The model did not answer.' });
				return finish('error');
			}

			const turnCost = costMicros(o.model, done.usage);
			cost += turnCost;
			total.input += done.usage.input;
			total.output += done.usage.output;
			total.cacheRead += done.usage.cacheRead;
			total.cacheWrite += done.usage.cacheWrite;
			o.emit({ type: 'usage', usage: done.usage, costMicros: turnCost });
			const messageId = await o.persist({ role: 'assistant', content: done.content, usage: done.usage, costMicros: turnCost });
			const ctx: ToolContext = { ...o.ctx, messageId: typeof messageId === 'number' ? messageId : null };
			messages.push({ role: 'assistant', content: done.content });

			const uses = done.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
			if (!uses.length) return finish(done.stopReason ?? 'end_turn');

			const results: ToolResultBlock[] = [];
			let stop: StopReason | null = null;
			for (const u of uses) {
				if (!stop && controller.signal.aborted) stop = stopped();
				if (!stop && toolCalls >= maxToolCalls) stop = 'tool_limit';
				if (stop) {
					const why = stop === 'pending' ? PENDING_TEXT : (LIMIT_TEXT[stop] ?? 'stopped');
					results.push({ type: 'tool_result', tool_use_id: u.id, content: `Not run: ${why}`, is_error: true });
					continue;
				}
				toolCalls += 1;
				const r = await runTool(ctx, u.name, u.input, o.tools, u.id);
				if (r.pending && r.action) {
					// No tool_result yet: approving / cancelling answers this call later.
					o.emit({ type: 'tool_done', id: u.id, name: u.name, ok: true, summary: r.summary, count: null });
					o.emit({ type: 'pending', action: r.action });
					stop = 'pending';
					continue;
				}
				if (r.action) o.emit({ type: 'action', action: r.action });
				results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
				o.emit({
					type: 'tool_done',
					id: u.id,
					name: u.name,
					ok: r.ok,
					summary: r.summary,
					count: r.count,
					...(r.ok ? {} : { error: r.content.slice(0, 200) })
				});
			}
			if (results.length) {
				await o.persist({ role: 'tool', content: results });
				messages.push({ role: 'user', content: results });
			}
			if (stop) return finish(stop);
		}
	} finally {
		clearTimeout(timer);
		o.signal?.removeEventListener('abort', onAbort);
	}
}

