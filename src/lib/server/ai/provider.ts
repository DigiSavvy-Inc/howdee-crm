// AI provider interface (#287, #696). Implementations: ./anthropic.ts (Claude, the default)
// and ./openai-compat.ts (OpenAI-compatible Chat Completions); ./providers.ts picks one per model.
// These shapes are provider-neutral: every adapter translates its API to and from them.
// They match the Anthropic Messages API for historical reasons (ai_messages.content stores
// them, and rows written before #696 keep loading unchanged); `thinking` / `redacted_thinking`
// are Anthropic-only and other adapters drop them from the history they send.
// How to add a provider: docs/ai-providers.md.

import type { Effort, Usage } from '$lib/ai-models';

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string };
export type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock;

export type ChatMessage = { role: 'user' | 'assistant'; content: ContentBlock[] };

export type ToolDefinition = {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	/** #679: stream the tool's input as it is written (only Ask AI's `editor_ask` sets it). */
	eager_input_streaming?: boolean;
};

export type StreamRequest = {
	model: string;
	effort: Effort | null;
	system: string;
	messages: ChatMessage[];
	tools: ToolDefinition[];
	maxTokens?: number;
	/** #679: also emit `tool_input` events with each streamed piece of a tool's JSON input. */
	toolInputDeltas?: boolean;
	signal?: AbortSignal;
};

/** Normalised stream events. Exactly one `done` or `error` ends every stream. */
export type ProviderEvent =
	| { type: 'text'; text: string }
	| { type: 'tool_use_start'; id: string; name: string }
	| { type: 'tool_input'; id: string; json: string } // only with `toolInputDeltas` (#679)
	// `invalidToolInput` (#679): ids of tool_use blocks whose streamed JSON didn't parse (their
	// `input` is {}); only present when there is one, and never part of `content`.
	| { type: 'done'; content: ContentBlock[]; stopReason: string | null; usage: Usage; invalidToolInput?: string[] }
	| { type: 'error'; message: string; status?: number };

export interface AiProvider {
	stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
}
