// Reports (#389): build a report spec from a sentence. One model call through the
// assistant's provider (no second LLM client), at most one retry with the validator's
// error. Every reply goes through `parseModelReply` → `validateForViewer` (parseReportSpec +
// the admin-only rule); nothing the model wrote reaches the DB or the query compiler
// before that. Nothing is saved — the caller shows the spec in the builder.
//
// Usage + audit, no migration: each build runs in its own assistant thread ("Report
// builder: …"), so its messages carry cost_micros and count toward the spend caps and the
// Settings → Assistant usage table like any chat turn; one ai_actions row (tool
// `suggest_report`, status applied | failed) records the request and the outcome. The
// assistant's suggest_report read tool passes `audit: false` (reads are never audited).

import { costMicros, effortFor, type Effort, type ModelInfo } from '$lib/ai-models';
import {
	NL_DESCRIPTION_MAX,
	catalogPrompt,
	parseModelReply,
	readback,
	reportCatalog,
	understoodParts,
	validateForViewer,
	type NlRecords
} from '$lib/report-nl';
import { ReportError, parseReportSpec, type ReportSpec, type ReportViewer } from '$lib/report-spec';
import { encodeSpec } from '$lib/report-view';
import { availability, featureModel, getAssistantConfig, modelKeyProblem, spendCheck, type AssistantConfig } from '../ai/config';
import { providerFor } from '../ai/providers';
import type { AiProvider, ChatMessage, ContentBlock } from '../ai/provider';
import { appendMessage, createThread, threadForUser, titleFrom } from '../ai/threads';

export const NL_TOOL = 'suggest_report';
export const NL_THREAD_PREFIX = 'Report builder: ';
export const NL_MAX_TOKENS = 4000;
export const NL_FAILED = "I couldn't turn that into a report.";

export type NlUser = { id: number; role: ReportViewer['role'] };

export type NlOutcome =
	| { kind: 'spec'; spec: ReportSpec; readback: string; href: string; threadId: number; actionId: number | null }
	| { kind: 'questions'; questions: string[]; threadId: number; actionId: number | null }
	| { kind: 'error'; error: string; understood: string[]; threadId: number | null; actionId: number | null };

export type NlRequest = {
	user: NlUser;
	description: string;
	/** The builder's current spec, for "make it 90 days" refinements. */
	current?: ReportSpec | null;
	/** Continue an earlier build's thread (the refine loop). Ignored unless it is the user's. */
	threadId?: number | null;
	records?: NlRecords;
	provider: AiProvider;
	model: ModelInfo;
	effort: Effort | null;
	/** false = no ai_actions row (the chat's read tool: reads are never audited). Default true. */
	audit?: boolean;
};

function userText(description: string, current: ReportSpec | null | undefined): string {
	const lines = [`<request>${description.replaceAll('</request>', '')}</request>`];
	if (current) {
		lines.push('This changes the current report. Keep everything the request does not change.');
		lines.push(`Current spec: ${JSON.stringify(current)}`);
	}
	return lines.join('\n');
}

async function callModel(req: NlRequest, system: string, messages: ChatMessage[]): Promise<{ text: string; content: ContentBlock[]; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } } | { error: string }> {
	let done: { content: ContentBlock[]; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } } | null = null;
	for await (const e of req.provider.stream({ model: req.model.id, effort: req.effort, system, messages, tools: [], maxTokens: NL_MAX_TOKENS })) {
		if (e.type === 'error') return { error: e.message };
		if (e.type === 'done') done = { content: e.content, usage: e.usage };
	}
	if (!done) return { error: 'The model stopped without an answer.' };
	const text = done.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
	return { text, content: done.content, usage: done.usage };
}

async function audit(
	db: D1Database,
	o: { threadId: number; messageId: number | null; userId: number; args: Record<string, unknown>; status: 'applied' | 'failed'; summary: string; state?: unknown; error?: string }
): Promise<number | null> {
	try {
		const row = await db
			.prepare(
				`INSERT INTO ai_actions (thread_id, message_id, user_id, tool, input, status, after, error, resolved_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
			)
			.bind(
				o.threadId,
				o.messageId,
				o.userId,
				NL_TOOL,
				JSON.stringify({ tool_use_id: '', args: o.args }),
				o.status,
				JSON.stringify({ summary: o.summary.slice(0, 500), state: o.state ?? null, noUndo: true }),
				o.error ? o.error.slice(0, 300) : null
			)
			.first<{ id: number }>();
		return row?.id ?? null;
	} catch (e) {
		console.error('report builder audit failed:', e instanceof Error ? e.message : 'error');
		return null;
	}
}

/** Describe → spec. Never throws for a bad description or a bad model reply. */
export async function buildReportFromText(db: D1Database, req: NlRequest): Promise<NlOutcome> {
	const description = req.description.trim();
	if (!description) return { kind: 'error', error: 'Describe the report you want.', understood: [], threadId: null, actionId: null };
	if (description.length > NL_DESCRIPTION_MAX) {
		return { kind: 'error', error: `Keep the description under ${NL_DESCRIPTION_MAX} characters.`, understood: [], threadId: null, actionId: null };
	}
	const viewer: ReportViewer = { role: req.user.role };
	const log = (o: Parameters<typeof audit>[1]) => (req.audit === false ? Promise.resolve(null) : audit(db, o));
	let current: ReportSpec | null = null;
	if (req.current) {
		try {
			current = validateForViewer(req.current, viewer);
		} catch {
			current = null; // a broken draft is simply not sent as context
		}
	}

	const existing = req.threadId ? await threadForUser(db, req.threadId, req.user.id) : null;
	const threadId =
		existing && existing.title.startsWith(NL_THREAD_PREFIX)
			? existing.id
			: await createThread(db, req.user.id, req.model.id, req.effort, `${NL_THREAD_PREFIX}${titleFrom(description)}`.slice(0, 80));

	const system = catalogPrompt(reportCatalog(viewer, req.records));
	const args = { description, ...(current ? { current } : {}) };
	const first: ChatMessage = { role: 'user', content: [{ type: 'text', text: userText(description, current) }] };
	await appendMessage(db, threadId, { role: 'user', content: first.content });
	const messages: ChatMessage[] = [first];

	let lastError = '';
	let lastRaw: unknown = null;
	let messageId: number | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await callModel(req, system, messages);
		if ('error' in reply) {
			const actionId = await log({ threadId, messageId, userId: req.user.id, args, status: 'failed', summary: NL_FAILED, error: reply.error });
			return { kind: 'error', error: `${NL_FAILED} ${reply.error}`, understood: [], threadId, actionId };
		}
		messageId = await appendMessage(db, threadId, {
			role: 'assistant',
			content: reply.content,
			model: req.model.id,
			usage: reply.usage,
			costMicros: costMicros(req.model, reply.usage)
		});
		const parsed = parseModelReply(reply.text);
		if (parsed.kind === 'questions') {
			const actionId = await log({ threadId, messageId, userId: req.user.id, args, status: 'applied', summary: parsed.questions.join(' '), state: { questions: parsed.questions } });
			return { kind: 'questions', questions: parsed.questions, threadId, actionId };
		}
		if (parsed.kind === 'spec') {
			lastRaw = parsed.raw;
			try {
				const spec = validateForViewer(parsed.raw, viewer);
				const line = readback(spec, req.records);
				const actionId = await log({ threadId, messageId, userId: req.user.id, args, status: 'applied', summary: line, state: spec });
				return { kind: 'spec', spec, readback: line, href: `/reports/new?spec=${encodeSpec(spec)}`, threadId, actionId };
			} catch (e) {
				if (!(e instanceof ReportError)) throw e;
				lastError = e.message;
			}
		} else {
			lastError = parsed.error;
			if (parsed.raw) lastRaw = parsed.raw;
		}
		if (attempt === 0) {
			messages.push({ role: 'assistant', content: reply.content });
			const retry: ChatMessage = {
				role: 'user',
				content: [{ type: 'text', text: `That was rejected by the validator: ${lastError}\nReply again with one corrected JSON object only, using the catalog.` }]
			};
			messages.push(retry);
			await appendMessage(db, threadId, { role: 'user', content: retry.content });
		}
	}
	const understood = understoodParts(lastRaw, viewer);
	const actionId = await log({ threadId, messageId, userId: req.user.id, args, status: 'failed', summary: NL_FAILED, error: lastError, state: { understood } });
	return { kind: 'error', error: `${NL_FAILED} ${lastError}`.trim(), understood, threadId, actionId };
}

export type NlGate = { ok: true; cfg: AssistantConfig; model: ModelInfo; effort: Effort | null } | { ok: false; status: number; message: string };

/** The assistant's own gates: key, Access, an allowed model, the spend caps. */
export async function reportNlGate(db: D1Database, platformEnv: unknown, user: { id: number; role?: string }): Promise<NlGate> {
	const cfg = await getAssistantConfig(db);
	const avail = await availability(db, cfg, platformEnv, user);
	if (!avail.available) return { ok: false, status: avail.reason === 'no_key' ? 503 : 403, message: avail.message };
	const allowed = featureModel(cfg, 'reports');
	if (!allowed) return { ok: false, status: 400, message: 'No assistant model is allowed (Settings → Assistant).' };
	const keyProblem = await modelKeyProblem(db, platformEnv, allowed);
	if (keyProblem) return { ok: false, status: 503, message: keyProblem };
	const spend = await spendCheck(db, cfg, user.id);
	if (!spend.ok) return { ok: false, status: 429, message: spend.message };
	return { ok: true, cfg, model: allowed, effort: effortFor(allowed, cfg.defaultEffort) };
}

/** The real provider for a request: the model's provider (#696; default the report builder's model), in-app key else Worker secret. */
export async function reportNlProvider(db: D1Database, platformEnv: unknown, model?: ModelInfo): Promise<AiProvider> {
	const cfg = await getAssistantConfig(db);
	const m = model ?? featureModel(cfg, 'reports');
	return providerFor(db, platformEnv, cfg, m ?? {});
}

/** A posted `current_spec` field, or null when absent / unparseable. */
export function postedSpec(raw: FormDataEntryValue | null): ReportSpec | null {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	try {
		return parseReportSpec(JSON.parse(raw));
	} catch {
		return null;
	}
}
