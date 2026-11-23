// The assistant's write path (#301): every write lands in `ai_actions` (migration 0077) —
// the audit log and the undo store.
//
// Row shape:
//  - `input`  = { tool_use_id, args } — the model's call, so an approval can answer it later.
//  - `before` = the tool's before-state (what Undo replays).
//  - `after`  = { state, summary, url, changes } once applied (`state` = what Undo compares
//               against), or { summary, scope } while pending.
//  - `status` = applied | pending | approved (applied after Approve) | cancelled | undone | failed.
//
// Writes apply at once and show an Undo card. A write over APPROVE_OVER contacts, an
// 'approve'-tier tool, or a plan that asks for approval (#309) is stored `pending` and
// pauses the turn until Approve / Cancel.

import { actionIcon, canUndo, type ActionCard, type ActionStatus, type FieldChange } from '$lib/assistant-actions';
import type { ToolResultBlock } from './provider';
import { APPROVE_OVER, ToolInputError, UndoRefused, type ToolContext, type WriteOutcome, type WriteTool } from './tools/types';
import { withQuietScoreSources } from '../scoring/engine';

// #552: every assistant write and Undo runs inside withQuietScoreSources, so tag / list /
// pipeline rows it adds never earn points that enroll anyone through a `score_changed` trigger.
function applyQuiet(ctx: ToolContext, tool: WriteTool, args: Record<string, unknown>): Promise<WriteOutcome> {
	return withQuietScoreSources(ctx.db, () => tool.apply(ctx, args), ctx.now);
}

export type ActionRow = {
	id: number;
	thread_id: number;
	message_id: number | null;
	user_id: number | null;
	tool: string;
	input: string | null;
	status: ActionStatus;
	before: string | null;
	after: string | null;
	error: string | null;
	created_at: string;
	resolved_at: string | null;
};

type StoredAfter = {
	state?: unknown;
	summary?: string;
	url?: string | null;
	changes?: FieldChange[];
	scope?: { count: number; sample: string[]; notes?: string[] } | null;
	notes?: string[]; // #322
	noUndo?: boolean; // #322
};

function parse<T>(s: string | null, dflt: T): T {
	if (!s) return dflt;
	try {
		return (JSON.parse(s) as T) ?? dflt;
	} catch {
		return dflt;
	}
}

function inputOf(row: ActionRow): { tool_use_id: string; args: Record<string, unknown> } {
	const v = parse<{ tool_use_id?: unknown; args?: unknown }>(row.input, {});
	const args = v.args && typeof v.args === 'object' && !Array.isArray(v.args) ? (v.args as Record<string, unknown>) : {};
	return { tool_use_id: typeof v.tool_use_id === 'string' ? v.tool_use_id : '', args };
}

export function cardOf(row: ActionRow): ActionCard {
	const after = parse<StoredAfter>(row.after, {});
	return {
		id: row.id,
		tool: row.tool,
		tool_use_id: inputOf(row).tool_use_id,
		status: row.status,
		icon: actionIcon(row.tool),
		summary: after.summary ?? row.tool,
		url: after.url ?? null,
		changes: Array.isArray(after.changes) ? after.changes : [],
		scope: after.scope ?? null,
		error: row.error,
		notes: Array.isArray(after.notes) ? after.notes : [],
		noUndo: after.noUndo === true
	};
}

async function actionRow(db: D1Database, id: number): Promise<ActionRow | null> {
	return db.prepare('SELECT * FROM ai_actions WHERE id = ?').bind(id).first<ActionRow>();
}

/** One action, only for its own user (anyone else gets null → 404). */
export async function actionForUser(db: D1Database, id: number, userId: number): Promise<ActionRow | null> {
	return db.prepare('SELECT * FROM ai_actions WHERE id = ? AND user_id = ?').bind(id, userId).first<ActionRow>();
}

/** Every action of a thread, oldest first — the panel rehydrates its cards from these. */
export async function cardsForThread(db: D1Database, threadId: number): Promise<ActionCard[]> {
	const rows = await db.prepare('SELECT * FROM ai_actions WHERE thread_id = ? ORDER BY id').bind(threadId).all<ActionRow>();
	return rows.results.map(cardOf);
}

function errText(e: unknown, tool: string): string {
	if (e instanceof ToolInputError || e instanceof UndoRefused) return e.message;
	console.error(`assistant write ${tool} failed:`, e instanceof Error ? e.message : 'error');
	return `The ${tool} change failed.`;
}

function storedAfter(out: WriteOutcome): string {
	return JSON.stringify({
		state: out.after,
		summary: out.summary,
		url: out.url ?? null,
		changes: out.changes ?? [],
		...(out.notes?.length ? { notes: out.notes } : {}),
		...(out.undoable === false ? { noUndo: true } : {})
	} satisfies StoredAfter);
}

/** What the model gets back after a write. */
function resultContent(card: ActionCard, out: WriteOutcome): string {
	return JSON.stringify({
		action_id: card.id,
		status: card.status,
		summary: out.summary,
		...(out.changes?.length ? { changes: out.changes } : {}),
		...(out.url ? { url: out.url } : {}),
		...(out.result ?? {}),
		...(out.notes?.length ? { warnings: out.notes } : {}),
		note: out.undoable === false ? 'Applied. This change cannot be undone.' : 'Applied. The user can undo it from the action card.'
	});
}

export type WriteRun =
	| { kind: 'done'; ok: boolean; content: string; card: ActionCard | null }
	| { kind: 'pending'; card: ActionCard };

/**
 * Run a write tool call: plan (validation — a bad call writes nothing and stores nothing),
 * then either apply it and store an `applied` row, or store a `pending` row and pause.
 */
export async function runWrite(ctx: ToolContext, tool: WriteTool, args: Record<string, unknown>, toolUseId: string): Promise<WriteRun> {
	if (!ctx.threadId) return { kind: 'done', ok: false, content: 'Writes need a conversation.', card: null };
	let plan;
	try {
		const refused = await tool.gate?.(ctx); // #322 addendum: a setting turned this tool off
		if (refused) return { kind: 'done', ok: false, content: refused, card: null };
		plan = await tool.plan(ctx, args);
	} catch (e) {
		return { kind: 'done', ok: false, content: errText(e, tool.name), card: null };
	}
	const input = JSON.stringify({ tool_use_id: toolUseId, args });

	if (tool.tier === 'approve' || plan.approve || plan.count > APPROVE_OVER) {
		const scope = { count: plan.count, sample: plan.sample, ...(plan.notes?.length ? { notes: plan.notes } : {}) };
		const after = JSON.stringify({ summary: plan.summary, scope } satisfies StoredAfter);
		const row = await ctx.db
			.prepare(
				`INSERT INTO ai_actions (thread_id, message_id, user_id, tool, input, status, after)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING *`
			)
			.bind(ctx.threadId, ctx.messageId ?? null, ctx.user.id, tool.name, input, after)
			.first<ActionRow>();
		return { kind: 'pending', card: cardOf(row!) };
	}

	try {
		const out = await applyQuiet(ctx, tool, args);
		const row = await ctx.db
			.prepare(
				`INSERT INTO ai_actions (thread_id, message_id, user_id, tool, input, status, before, after)
				 VALUES (?, ?, ?, ?, ?, 'applied', ?, ?) RETURNING *`
			)
			.bind(ctx.threadId, ctx.messageId ?? null, ctx.user.id, tool.name, input, JSON.stringify(out.before ?? null), storedAfter(out))
			.first<ActionRow>();
		const card = cardOf(row!);
		return { kind: 'done', ok: true, content: resultContent(card, out), card };
	} catch (e) {
		const error = errText(e, tool.name).slice(0, 300);
		const row = await ctx.db
			.prepare(
				`INSERT INTO ai_actions (thread_id, message_id, user_id, tool, input, status, after, error, resolved_at)
				 VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, datetime('now')) RETURNING *`
			)
			.bind(ctx.threadId, ctx.messageId ?? null, ctx.user.id, tool.name, input, JSON.stringify({ summary: plan.summary } satisfies StoredAfter), error)
			.first<ActionRow>();
		return { kind: 'done', ok: false, content: error, card: cardOf(row!) };
	}
}

export type Resolved = { ok: true; card: ActionCard; result: ToolResultBlock } | { ok: false; status: number; error: string };

/**
 * Approve or cancel a pending action. Approve runs the write now (status `approved`, or
 * `failed`); cancel never runs it. Either way the answer to the model's paused tool call
 * comes back as `result`, for the caller to store before resuming the turn. A second
 * approve/cancel finds nothing pending and is refused (409).
 */
export async function resolvePending(ctx: ToolContext, row: ActionRow, op: 'approve' | 'cancel', tool: WriteTool | undefined): Promise<Resolved> {
	const target = op === 'approve' ? 'approved' : 'cancelled';
	const claim = await ctx.db
		.prepare(`UPDATE ai_actions SET status = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'`)
		.bind(target, row.id)
		.run();
	if (!claim.meta.changes) return { ok: false, status: 409, error: 'This action was already handled.' };
	const { tool_use_id, args } = inputOf(row);

	if (op === 'cancel') {
		const card = cardOf((await actionRow(ctx.db, row.id))!);
		return {
			ok: true,
			card,
			result: { type: 'tool_result', tool_use_id, content: 'The user cancelled this action. Nothing was changed.', is_error: true }
		};
	}

	try {
		if (!tool) throw new ToolInputError('That tool is no longer available.');
		// #322 addendum: the setting may have been turned off since the card was shown.
		const refused = await tool.gate?.(ctx);
		if (refused) throw new ToolInputError(refused);
		const out = await applyQuiet(ctx, tool, args);
		const prev = parse<StoredAfter>(row.after, {});
		const after = JSON.stringify({ ...JSON.parse(storedAfter(out)), scope: prev.scope ?? null });
		await ctx.db.prepare('UPDATE ai_actions SET before = ?, after = ? WHERE id = ?').bind(JSON.stringify(out.before ?? null), after, row.id).run();
		const card = cardOf((await actionRow(ctx.db, row.id))!);
		return { ok: true, card, result: { type: 'tool_result', tool_use_id, content: resultContent(card, out) } };
	} catch (e) {
		const error = errText(e, row.tool).slice(0, 300);
		await ctx.db.prepare(`UPDATE ai_actions SET status = 'failed', error = ? WHERE id = ?`).bind(error, row.id).run();
		const card = cardOf((await actionRow(ctx.db, row.id))!);
		return { ok: true, card, result: { type: 'tool_result', tool_use_id, content: error, is_error: true } };
	}
}

export type UndoResult = { ok: true; card: ActionCard; already: boolean } | { ok: false; status: number; error: string };

/**
 * Undo an applied (or approved) action by replaying `before`. Idempotent: undoing an
 * undone action is a no-op success. Claimed first (status → undone) so two clicks can't
 * replay twice; a refusal (the record changed since) puts the status back.
 */
export async function undoAction(ctx: ToolContext, row: ActionRow, tool: WriteTool | undefined): Promise<UndoResult> {
	if (row.status === 'undone') return { ok: true, card: cardOf(row), already: true };
	if (cardOf(row).noUndo) return { ok: false, status: 409, error: 'This change can’t be undone.' };
	if (!canUndo(cardOf(row))) return { ok: false, status: 409, error: 'Only an applied change can be undone.' };
	if (!tool) return { ok: false, status: 409, error: 'That tool is no longer available, so this change can’t be undone here.' };
	const claim = await ctx.db
		.prepare(`UPDATE ai_actions SET status = 'undone', resolved_at = datetime('now') WHERE id = ? AND status = ?`)
		.bind(row.id, row.status)
		.run();
	if (!claim.meta.changes) {
		const now = await actionRow(ctx.db, row.id);
		if (now?.status === 'undone') return { ok: true, card: cardOf(now), already: true };
		return { ok: false, status: 409, error: 'This action changed while undoing — try again.' };
	}
	try {
		const before = parse<unknown>(row.before, null);
		const state = parse<StoredAfter>(row.after, {}).state ?? null;
		await withQuietScoreSources(ctx.db, () => tool.undo(ctx, before, state), ctx.now);
	} catch (e) {
		await ctx.db.prepare('UPDATE ai_actions SET status = ?, resolved_at = ? WHERE id = ?').bind(row.status, row.resolved_at, row.id).run();
		return { ok: false, status: 409, error: errText(e, row.tool) };
	}
	return { ok: true, card: cardOf((await actionRow(ctx.db, row.id))!), already: false };
}

/**
 * Cancel the thread's pending actions (the user typed a new message instead of answering).
 * Returns the tool results to store, so every paused tool call still gets its answer.
 */
export async function cancelPendingForThread(db: D1Database, threadId: number): Promise<{ results: ToolResultBlock[]; cards: ActionCard[] }> {
	const rows = await db
		.prepare(
			`UPDATE ai_actions SET status = 'cancelled', resolved_at = datetime('now')
			 WHERE thread_id = ? AND status = 'pending' RETURNING *`
		)
		.bind(threadId)
		.all<ActionRow>();
	return {
		results: rows.results.map((r) => ({
			type: 'tool_result',
			tool_use_id: inputOf(r).tool_use_id,
			content: 'Not applied: the user sent a new message instead of approving. Ask again if it is still wanted.',
			is_error: true
		})),
		cards: rows.results.map(cardOf)
	};
}
