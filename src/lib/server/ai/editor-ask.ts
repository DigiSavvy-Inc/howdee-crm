// Ask AI in the editor (#679). POST /api/assistant/editor rewrites or transforms the content
// selected in a block editor (Compose, templates, the global template, automation email
// steps, pages) and streams the result back to the open editor's popover. The person
// reviews it and clicks Replace or Insert below; nothing here saves, sends, schedules,
// activates or enrolls (no send / postmark / automations import — tests/ai-no-send.test.ts
// walks this folder), and the request carries no tool that touches data: the model answers
// through one tool whose input is the content itself. It is offered with the default tool
// choice (current models refuse a forced one), so a turn can end without it: a refusal, a
// text-only answer or tool JSON that doesn't parse ends in an `error`, with no automatic
// retry (the popover's Try again is the retry). `done` is only ever sent with a validated result.
//
// Body: { mode?, target, selection: { text, inline, blocks, partial }, document, quick?, language?,
// prompt?, previous?, refine?, cursor?, subject? } — see ./editor-ask-rules.ts (parsing, prompt,
// guard rails). #680: `mode: 'write'` (the slash menu's Ask AI) = no selection, a required prompt,
// new blocks for `cursor` (top-level blocks before it; null = the end) and the page's `subject`.
// Stream: `text` (pieces of the tool's JSON, for the live preview), then `done` (the
// validated result + notes) or `error` (`reason` rejected | timeout | failed).
//
// Bookkeeping follows Draft reply (#387): one ai_threads row per request (the prompt, and
// the answer with usage + cost — so it counts toward the spend caps), hidden from the
// panel's history, plus one ai_actions row (tool `editor_ask`, noUndo). The prompt, the
// selection and the key are never logged.

import { json, type RequestEvent } from '@sveltejs/kit';
import { costMicros, effortFor, type Usage } from '$lib/ai-models';
import { BODY_BYTES_MAX, EDITOR_ASK_OFF_MESSAGE, EDITOR_ASK_TOOL, quickLabel, type AskEvent } from '$lib/editor-ask';
import { getBranding } from '../branding';
import type { SessionUser } from '../users';
import { DEFAULT_MAX_TOKENS } from './anthropic';
import { availability, featureModel, getAssistantConfig, modelKeyProblem, spendCheck } from './config';
import {
	documentContext,
	editorSystemPrompt,
	editorTool,
	editorUserPrompt,
	parseAskBody,
	validateResult,
	writeContext,
	writeUserPrompt,
	type AskInput
} from './editor-ask-rules';
import { providerFor } from './providers';
import { promptSkills } from './skills';
import { appendMessage, createThread, titleFrom } from './threads';

/** Thinking counts against `max_tokens` too, so this is the provider's default, not less. */
const ASK_MAX_TOKENS = DEFAULT_MAX_TOKENS;
/** A request that takes longer is stopped and reported as timed out. */
export const ASK_TIMEOUT_MS = 90_000;
export const TIMEOUT_MESSAGE = 'Ask AI took too long and was stopped. Try again, or select less.';
export const FAILED_MESSAGE = "Ask AI couldn't finish. Try again.";
export const REFUSAL_MESSAGE = 'Ask AI declined this request. Try rewording it.';
export const CUT_OFF_MESSAGE = 'The result was too long and got cut off. Try again with a shorter selection.';
export const NO_EDIT_MESSAGE = "Ask AI didn't return an edit. Try again.";
export const UNREADABLE_MESSAGE = 'Ask AI returned something unreadable. Try again.';

async function recordAction(
	db: D1Database,
	o: { threadId: number; messageId: number | null; user: SessionUser; args: Record<string, unknown>; status: 'applied' | 'failed'; after: unknown; error?: string }
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO ai_actions (thread_id, message_id, user_id, tool, input, status, after, error, resolved_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
		)
		.bind(o.threadId, o.messageId, o.user.id, EDITOR_ASK_TOOL, JSON.stringify({ tool_use_id: '', args: o.args }), o.status, JSON.stringify(o.after), o.error ?? null)
		.first<{ id: number }>();
	return row!.id;
}

/** What the audit row keeps of the request: no selected text, no prompt text. */
function auditArgs(input: AskInput): Record<string, unknown> {
	return {
		mode: input.mode ?? 'edit',
		target: input.target,
		quick: input.quick,
		language: input.language || null,
		prompt: !!input.prompt,
		refine: !!input.previous,
		partial: input.selection.partial,
		blocks: input.selection.blocks.length,
		// #680 write mode: where it goes and whether a subject was sent (never its text).
		...(input.mode === 'write' ? { cursor: input.cursor ?? null, document_blocks: input.document.length, subject: !!input.subject } : {})
	};
}

export async function handleEditorAsk(event: RequestEvent, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Response> {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });

	const cfg = await getAssistantConfig(db);
	if (!cfg.editorAsk) return json({ error: EDITOR_ASK_OFF_MESSAGE, reason: 'disabled' }, { status: 403 });
	const avail = await availability(db, cfg, event.platform?.env, user);
	if (!avail.available) return json({ error: avail.message, reason: avail.reason }, { status: avail.reason === 'no_key' ? 503 : 403 });

	let body: Record<string, unknown> = {};
	try {
		const raw = await event.request.text();
		if (raw.length > BODY_BYTES_MAX) return json({ error: 'That selection or document is too large for Ask AI.', reason: 'too_long' }, { status: 413 });
		const b = JSON.parse(raw);
		if (b && typeof b === 'object') body = b as Record<string, unknown>;
	} catch {
		/* → 400 below */
	}
	const parsed = parseAskBody(body);
	if (!parsed.ok) return json({ error: parsed.error, reason: parsed.reason }, { status: parsed.status });
	const input = parsed.input;

	const spend = await spendCheck(db, cfg, user.id);
	if (!spend.ok) return json({ error: spend.message, reason: 'cap' }, { status: 429 });

	// #696: Ask AI answers through a tool, so only tool-capable models (Settings → Assistant → Models).
	const model = featureModel(cfg, 'editorAsk');
	if (!model) return json({ error: 'No allowed model can use tools (Settings → Assistant).', reason: 'no_model' }, { status: 503 });
	const keyProblem = await modelKeyProblem(db, event.platform?.env, model);
	if (keyProblem) return json({ error: keyProblem, reason: 'no_key' }, { status: 503 });
	const effort = effortFor(model, cfg.defaultEffort);
	const [skills, branding] = await Promise.all([promptSkills(db), getBranding(db)]);
	const write = input.mode === 'write';
	let prompt: string;
	let docTruncated: boolean;
	if (write) {
		const wc = writeContext(input.document, input.cursor ?? input.document.length);
		prompt = writeUserPrompt(input, wc);
		docTruncated = wc.truncated;
	} else {
		const doc = documentContext(input.document, input.selection.text);
		prompt = editorUserPrompt(input, doc.text);
		docTruncated = doc.truncated;
	}
	const system = editorSystemPrompt({ target: input.target, appName: branding.appName, userLogin: user.github_login, skills: skills.always, mode: input.mode });
	// Write mode always answers in blocks (inline is only for a selection inside one text block).
	const tool = editorTool(!write && input.selection.inline !== null);

	const label = input.quick ? quickLabel(input.quick) : input.prompt || input.refine || (write ? 'write' : 'edit');
	const threadId = await createThread(db, user.id, model.id, effort, titleFrom(`Ask AI: ${label}`));
	await appendMessage(db, threadId, { role: 'user', content: [{ type: 'text', text: prompt }] });
	const args = auditArgs(input);
	const provider = await providerFor(db, event.platform?.env, cfg, model, opts.fetch ?? fetch);

	const abort = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort.abort();
	}, opts.timeoutMs ?? ASK_TIMEOUT_MS);
	event.request.signal?.addEventListener('abort', () => abort.abort());
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	const send = (e: AskEvent) => {
		writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => abort.abort());
	};
	const fail = async (message: string, reason: 'rejected' | 'timeout' | 'failed', extra: { messageId?: number | null; state?: Record<string, unknown> } = {}) => {
		await recordAction(db, {
			threadId,
			messageId: extra.messageId ?? null,
			user,
			args,
			status: 'failed',
			after: { summary: reason === 'rejected' ? 'Ask AI result rejected' : 'Ask AI failed', state: { model: model.id, reason, ...extra.state }, noUndo: true },
			error: message.slice(0, 300)
		});
		send({ type: 'error', message, reason });
	};

	const work = (async () => {
		try {
			for await (const e of provider.stream({
				model: model.id,
				effort,
				system,
				messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
				tools: [tool],
				toolInputDeltas: true,
				maxTokens: ASK_MAX_TOKENS,
				signal: abort.signal
			})) {
				if (e.type === 'tool_input') send({ type: 'text', text: e.json });
				else if (e.type === 'error') {
					await fail(timedOut ? TIMEOUT_MESSAGE : e.message, timedOut ? 'timeout' : 'failed');
					return;
				} else if (e.type === 'done') {
					const call = e.content.find((b) => b.type === 'tool_use' && b.name === EDITOR_ASK_TOOL);
					const raw = call && call.type === 'tool_use' ? call.input : null;
					const usage: Usage = e.usage;
					const cost = costMicros(model, usage);
					const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					// Stored as text (the tool input's JSON): this thread is never replayed to the model.
					const messageId = await appendMessage(db, threadId, {
						role: 'assistant',
						content: [{ type: 'text', text: raw == null ? '' : JSON.stringify(raw) }],
						model: model.id,
						usage,
						costMicros: cost
					});
					const state = { mode: input.mode ?? 'edit', target: input.target, model: model.id, tokens, cost_micros: cost, document_truncated: docTruncated };
					// How the turn ended first, then the tool call itself; each of these ends in `error`.
					if (e.stopReason === 'refusal') {
						await fail(REFUSAL_MESSAGE, 'rejected', { messageId, state });
						return;
					}
					if (e.stopReason === 'max_tokens') {
						await fail(CUT_OFF_MESSAGE, 'rejected', { messageId, state });
						return;
					}
					if (!call || call.type !== 'tool_use') {
						await fail(NO_EDIT_MESSAGE, 'failed', { messageId, state });
						return;
					}
					if (e.invalidToolInput?.includes(call.id)) {
						await fail(UNREADABLE_MESSAGE, 'rejected', { messageId, state });
						return;
					}
					const v = validateResult(raw, input);
					if (!v.ok) {
						await fail(v.message, 'rejected', { messageId, state });
						return;
					}
					const actionId = await recordAction(db, {
						threadId,
						messageId,
						user,
						args,
						status: 'applied',
						after: {
							summary: `Ask AI${input.quick ? `: ${quickLabel(input.quick)}` : write ? ': write' : ''} (${input.target})`,
							state: { ...state, shape: v.result.shape, notes: v.notes },
							noUndo: true
						}
					});
					send({ type: 'done', action_id: actionId, model: model.id, result: v.result, notes: v.notes, tokens, cost_micros: cost });
					return;
				}
			}
		} catch (e) {
			console.error('ask ai failed:', e instanceof Error ? e.name : 'error');
			await fail(timedOut ? TIMEOUT_MESSAGE : FAILED_MESSAGE, timedOut ? 'timeout' : 'failed').catch(() => {});
		} finally {
			clearTimeout(timer);
			await writer.close().catch(() => {});
		}
	})();
	event.platform?.ctx?.waitUntil?.(work);

	return new Response(readable, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
	});
}
