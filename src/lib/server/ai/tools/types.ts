// Assistant tool contract (#287). One module per area under ./ ; each tool calls existing
// server modules (no forked logic). Read tools have a `handler`; write tools (#301) have
// `plan` (validate + scope, no writes), `apply` (write, report before/after) and `undo`
// (replay `before`, refusing when the record changed since). The same registry is meant to
// back a future MCP server and an agent-facing Data API.

import type { FieldChange } from '$lib/assistant-actions';
import type { SessionUser } from '../../users';
import type { PostmarkCreds } from '../../contact-bulk';
import type { MxLookup } from '../../hygiene';
import type { Effort, ModelInfo } from '$lib/ai-models';
import type { AiProvider } from '../provider';

export type ToolTier = 'read' | 'write' | 'approve';

export type ToolContext = {
	db: D1Database;
	user: SessionUser; // the signed-in user the assistant acts as
	baseUrl: string; // app origin, for links back to records
	now: Date;
	/** Set by the loop for write tools: the thread and the assistant message holding the call. */
	threadId?: number;
	messageId?: number | null;
	/** #322: Postmark credentials for unsubscribe (optional suppression) and the resubscribe guard. */
	postmark?: PostmarkCreds;
	/** #322: MX lookup for the hygiene checks (tests pass a stub; default = DoH). */
	mxLookup?: MxLookup;
	/** #389: the chat's provider + model, for suggest_report's own model call. Unset in jobs. */
	ai?: { provider: AiProvider; model: ModelInfo; effort: Effort | null };
};

export type JsonSchema = Record<string, unknown>;

type ToolBase = {
	name: string;
	description: string;
	input_schema: JsonSchema;
	/** Short "what it looked at" line for the panel's activity row. */
	summarize?: (input: Record<string, unknown>) => string;
};

export type ReadTool = ToolBase & {
	tier: 'read';
	handler: (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;
};

/** What a write would touch — decides whether it needs the user's approval first.
 *  `approve` (#309) asks first regardless of the count (e.g. replacing a draft's whole body,
 *  editing a paused automation that still has contacts in it). */
export type WritePlan = {
	count: number;
	sample: string[];
	summary: string;
	approve?: boolean;
	/** #322: the exact effect and warnings, shown on the card while it waits for Approve. */
	notes?: string[];
};

/** What a write did. `before` / `after` are stored in ai_actions and handed back to `undo`. */
export type WriteOutcome = {
	summary: string; // "Tagged 12 with “warm-lead”"
	before: unknown;
	after: unknown;
	changes?: FieldChange[];
	url?: string | null;
	result?: Record<string, unknown>; // extra facts for the model
	/** #322: warnings shown on the card after the change (e.g. address hygiene). */
	notes?: string[];
	/** #322: false = no Undo (a delete; an unsubscribe also suppressed in Postmark). */
	undoable?: boolean;
};

export type WriteTool = ToolBase & {
	/** 'approve' always asks first; 'write' asks only above APPROVE_OVER contacts. */
	tier: 'write' | 'approve';
	plan: (ctx: ToolContext, input: Record<string, unknown>) => Promise<WritePlan>;
	apply: (ctx: ToolContext, input: Record<string, unknown>) => Promise<WriteOutcome>;
	/** Throws UndoRefused when the record no longer matches `after`. */
	undo: (ctx: ToolContext, before: unknown, after: unknown) => Promise<void>;
	/** #322 addendum: a setting can turn the tool off. Returns the refusal message, or null when
	 *  allowed. Checked when the call runs (../actions.ts runWrite), again on Approve
	 *  (resolvePending — the setting may have changed since the card was shown), and for a
	 *  call to a tool left out of the request's tool list (../tools/index.ts runTool). */
	gate?: (ctx: ToolContext) => Promise<string | null>;
};

export type Tool = ReadTool | WriteTool;

/** A write touching more than this many contacts waits for Approve / Cancel. */
export const APPROVE_OVER = 25;

/** A tool's own validation failure — surfaced to the model as an is_error tool_result. */
export class ToolInputError extends Error {}

/** Undo can't run (the record changed since, or is gone) — the message is shown as is. */
export class UndoRefused extends Error {}

export function isWriteTool(t: Tool): t is WriteTool {
	return t.tier !== 'read';
}

export function intArg(input: Record<string, unknown>, key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | null {
	const raw = input[key];
	if (raw === undefined || raw === null || raw === '') {
		if (opts.required) throw new ToolInputError(`"${key}" is required.`);
		return null;
	}
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isInteger(n)) throw new ToolInputError(`"${key}" must be a whole number.`);
	if (opts.min !== undefined && n < opts.min) throw new ToolInputError(`"${key}" must be at least ${opts.min}.`);
	if (opts.max !== undefined && n > opts.max) return opts.max;
	return n;
}

export function strArg(input: Record<string, unknown>, key: string, max = 200): string {
	const raw = input[key];
	if (raw === undefined || raw === null) return '';
	return String(raw).trim().slice(0, max);
}

export function limitArg(input: Record<string, unknown>, dflt = 25, max = 100): number {
	return intArg(input, 'limit', { min: 1, max }) ?? dflt;
}

export const LIMIT_PROP = { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows (default 25).' };
