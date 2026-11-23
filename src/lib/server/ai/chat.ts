// POST /api/assistant/chat (#287): session-gated (NOT a PUBLIC_PREFIX — and the handler
// checks locals.user itself), returns an SSE stream of LoopEvents to the panel.
// Body: { thread_id?, message, model?, effort?, page?: { route, params, selected? } }.
// Refuses before calling the model when: no session (401), assistant off (403), no key
// (503), model not allowed (400), or a spend cap is reached (429).
//
// POST /api/assistant/actions/:id (#301): { op: 'undo' | 'approve' | 'cancel' } on one of the
// signed-in user's own ai_actions (anyone else's → 404). Undo answers JSON; approve / cancel
// answer the paused tool call and resume the turn as the same SSE stream as chat.

import { json, type RequestEvent } from '@sveltejs/kit';
import { effortFor, supportsTools, type Effort, type ModelInfo } from '$lib/ai-models';
import { getBranding } from '../branding';
import { getTimezone } from '../settings';
import { actionForUser, cancelPendingForThread, cardOf, resolvePending, undoAction } from './actions';
import { availability, codeAllowedFor, configModelInfo, featureModel, getAssistantConfig, modelKeyProblem, spendCheck, type AssistantConfig } from './config';
import { providerFor } from './providers';
import { runTurn, type LoopEvent } from './loop';
import { promptSkills } from './skills';
import { systemPrompt, withSkills } from './system';
import {
	MESSAGE_MAX,
	appendMessage,
	cleanPageContext,
	createThread,
	historyFor,
	setThreadModel,
	threadForUser,
	titleFrom
} from './threads';
import { chatTools, toolByName } from './tools';
import { isWriteTool, type ToolContext } from './tools/types';
import type { SessionUser } from '../users';
import { publicBaseUrlFor } from '$lib/server/public-url';

/** Origin for record links: Settings → Domain, PUBLIC_BASE_URL, else the request's origin (#120). */
function baseUrlOf(event: RequestEvent): Promise<string> {
	return publicBaseUrlFor(event);
}

/** #322: the same Postmark credentials the contacts bulk bar passes (suppress + resubscribe guard). */
function postmarkOf(event: RequestEvent): ToolContext['postmark'] {
	const env = event.platform?.env;
	return { token: env?.POSTMARK_TOKEN, stream: env?.POSTMARK_STREAM, txStream: env?.POSTMARK_STREAM_TX };
}

function todayIn(tz: string, now: Date): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}

type StreamEventOut = LoopEvent | { type: 'thread'; id: number; model: string; effort: string | null } | { type: 'message'; id: number };

/** Run one turn on the stored thread and stream it. `prelude` events go out first. */
async function streamTurn(
	event: RequestEvent,
	o: {
		db: D1Database;
		user: SessionUser;
		cfg: AssistantConfig;
		threadId: number;
		model: ModelInfo;
		effort: Effort | null;
		prelude?: LoopEvent[];
		fetch?: typeof fetch;
	}
): Promise<Response> {
	const { db, user, cfg, threadId, model, effort } = o;
	const [history, tz, branding, skills] = await Promise.all([historyFor(db, threadId), getTimezone(db), getBranding(db), promptSkills(db)]);
	const now = new Date();
	const system = withSkills(
		systemPrompt({ appName: branding.appName, timezone: tz, today: todayIn(tz, now), userLogin: user.github_login, allowDelete: cfg.allowDelete, allowCode: codeAllowedFor(cfg, user) }),
		skills
	);
	// #696: the model's own provider (Anthropic or the OpenAI-compatible endpoint).
	const provider = await providerFor(db, event.platform?.env, cfg, model, o.fetch ?? fetch);
	const baseUrl = await baseUrlOf(event);

	const abort = new AbortController();
	event.request.signal?.addEventListener('abort', () => abort.abort());
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	const send = (e: StreamEventOut) => {
		writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => abort.abort());
	};

	const work = (async () => {
		send({ type: 'thread', id: threadId, model: model.id, effort });
		for (const e of o.prelude ?? []) send(e);
		try {
			await runTurn({
				provider,
				model,
				effort,
				system,
				messages: history,
				// #322 addendum: delete_contacts only while Settings → Assistant → Permissions allows it.
				tools: chatTools(cfg),
				ctx: { db, user, baseUrl, now, threadId, postmark: postmarkOf(event), ai: { provider, model, effort } },
				emit: send,
				signal: abort.signal,
				persist: async (m) => {
					if (m.role === 'tool') return appendMessage(db, threadId, { role: 'tool', content: m.content });
					const id = await appendMessage(db, threadId, { role: 'assistant', content: m.content, model: model.id, usage: m.usage, costMicros: m.costMicros });
					send({ type: 'message', id }); // #310: the panel's thumbs up / down target
					return id;
				}
			});
		} catch (e) {
			console.error('assistant turn failed:', e instanceof Error ? e.message : 'error');
			send({ type: 'error', message: 'The assistant hit an error.' });
		} finally {
			await writer.close().catch(() => {});
		}
	})();
	event.platform?.ctx?.waitUntil?.(work);

	return new Response(readable, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
	});
}

export async function handleChat(event: RequestEvent, opts: { fetch?: typeof fetch } = {}): Promise<Response> {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });

	const cfg = await getAssistantConfig(db);
	const avail = await availability(db, cfg, event.platform?.env, user);
	if (!avail.available) return json({ error: avail.message, reason: avail.reason }, { status: avail.reason === 'no_key' ? 503 : 403 });

	let body: Record<string, unknown> = {};
	try {
		const b = await event.request.json();
		if (b && typeof b === 'object') body = b as Record<string, unknown>;
	} catch {
		/* empty body → 400 below */
	}
	const message = typeof body.message === 'string' ? body.message.trim() : '';
	if (!message) return json({ error: 'A message is required.' }, { status: 400 });
	if (message.length > MESSAGE_MAX) return json({ error: `Messages are limited to ${MESSAGE_MAX} characters.` }, { status: 400 });

	let threadId = Number(body.thread_id) || 0;
	const thread = threadId ? await threadForUser(db, threadId, user.id) : null;
	if (threadId && !thread) return json({ error: 'Conversation not found.' }, { status: 404 });

	// An explicit pick must be allowed; a thread's stored model that was removed (from the
	// catalogue or the install's provider config), is no longer allowed or can't use tools
	// falls back to the chat's model (#695, #696).
	const requested = typeof body.model === 'string' && body.model ? body.model : null;
	const stored = requested ? null : configModelInfo(cfg, thread?.model);
	const model = requested
		? configModelInfo(cfg, requested)
		: stored && cfg.allowedModels.includes(stored.id) && supportsTools(stored)
			? stored
			: featureModel(cfg, 'chat');
	if (!model || !cfg.allowedModels.includes(model.id)) return json({ error: 'That model is not allowed here.' }, { status: 400 });
	// #696: the chat calls tools, so a model without tool support can't run it.
	if (!supportsTools(model)) return json({ error: "That model can't use tools, which the assistant needs." }, { status: 400 });
	const keyProblem = await modelKeyProblem(db, event.platform?.env, model);
	if (keyProblem) return json({ error: keyProblem, reason: 'no_key' }, { status: 503 });
	const effort = effortFor(model, body.effort ?? thread?.effort ?? cfg.defaultEffort);

	const spend = await spendCheck(db, cfg, user.id);
	if (!spend.ok) return json({ error: spend.message, reason: 'cap' }, { status: 429 });

	const pageContext = cleanPageContext(body.page);
	const prelude: LoopEvent[] = [];
	if (!threadId) threadId = await createThread(db, user.id, model.id, effort, titleFrom(message));
	else {
		if (thread && (thread.model !== model.id || thread.effort !== effort)) await setThreadModel(db, threadId, model.id, effort);
		// #301: a new message instead of Approve / Cancel cancels what was waiting, and
		// answers its tool call, so the stored history stays valid.
		const pending = await cancelPendingForThread(db, threadId);
		if (pending.results.length) await appendMessage(db, threadId, { role: 'tool', content: pending.results });
		for (const card of pending.cards) prelude.push({ type: 'action', action: card });
	}
	await appendMessage(db, threadId, { role: 'user', content: [{ type: 'text', text: message }], pageContext });

	return streamTurn(event, { db, user, cfg, threadId, model, effort, prelude, fetch: opts.fetch });
}

export async function handleAction(event: RequestEvent, opts: { fetch?: typeof fetch } = {}): Promise<Response> {
	const user = event.locals.user;
	if (!user) return json({ error: 'Not signed in.' }, { status: 401 });
	const db = event.platform?.env?.DB;
	if (!db) return json({ error: 'No database.' }, { status: 500 });

	const id = Number(event.params.id);
	const row = Number.isInteger(id) && id > 0 ? await actionForUser(db, id, user.id) : null;
	if (!row) return json({ error: 'Action not found.' }, { status: 404 });

	let op = '';
	try {
		const b = (await event.request.json()) as { op?: unknown } | null;
		op = typeof b?.op === 'string' ? b.op : '';
	} catch {
		/* → 400 */
	}
	if (op !== 'undo' && op !== 'approve' && op !== 'cancel') return json({ error: 'op must be undo, approve or cancel.' }, { status: 400 });

	const tool = toolByName(row.tool);
	const writeTool = tool && isWriteTool(tool) ? tool : undefined;
	const ctx: ToolContext = {
		db,
		user,
		baseUrl: await baseUrlOf(event),
		now: new Date(),
		threadId: row.thread_id,
		messageId: row.message_id,
		postmark: postmarkOf(event)
	};

	if (op === 'undo') {
		const r = await undoAction(ctx, row, writeTool);
		if (!r.ok) return json({ error: r.error, action: cardOf(row) }, { status: r.status });
		return json({ action: r.card, already: r.already });
	}

	// approve / cancel: resume the paused turn.
	if (row.status !== 'pending') return json({ error: 'This action was already handled.', action: cardOf(row) }, { status: 409 });
	const thread = await threadForUser(db, row.thread_id, user.id);
	if (!thread) return json({ error: 'Conversation not found.' }, { status: 404 });
	const cfg = await getAssistantConfig(db);
	const avail = await availability(db, cfg, event.platform?.env, user);
	if (!avail.available) return json({ error: avail.message, reason: avail.reason }, { status: avail.reason === 'no_key' ? 503 : 403 });
	const spend = await spendCheck(db, cfg, user.id);
	if (!spend.ok) return json({ error: spend.message, reason: 'cap' }, { status: 429 });
	const stored = configModelInfo(cfg, thread.model);
	const model = stored && cfg.allowedModels.includes(stored.id) && supportsTools(stored) ? stored : featureModel(cfg, 'chat');
	if (!model) return json({ error: 'No allowed model can use tools (Settings → Assistant).' }, { status: 400 });
	const keyProblem = await modelKeyProblem(db, event.platform?.env, model);
	if (keyProblem) return json({ error: keyProblem, reason: 'no_key' }, { status: 503 });
	const effort = effortFor(model, thread.effort ?? cfg.defaultEffort);

	const r = await resolvePending(ctx, row, op, writeTool);
	if (!r.ok) return json({ error: r.error, action: cardOf(row) }, { status: r.status });
	await appendMessage(db, thread.id, { role: 'tool', content: [r.result] });
	return streamTurn(event, { db, user, cfg, threadId: thread.id, model, effort, prelude: [{ type: 'action', action: r.card }], fetch: opts.fetch });
}
