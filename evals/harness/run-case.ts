// Assistant evals (#391): run one golden case — restore the eval D1, build its fixture, then
// one assistant turn exactly as the app runs it:
//  - mode "chat": a stored thread + the user message (with page context), the chat system
//    prompt with skills, chatTools(cfg) and runTurn — the same steps as ai/chat.ts streamTurn
//    (only the SSE plumbing is left out);
//  - mode "job": an ai_jobs row whose prompt is the message, run through jobs.ts runJob (its
//    read-only tools, preamble and caps) with the webhook answered locally.
// The provider is the real Anthropic one (runner) or a recording (CI replay); observe() wraps
// it either way, so tool calls, results and the transcript are read the same way.

import { effortFor, modelInfo, type Usage } from '../../src/lib/ai-models';
import type { ContentBlock, ToolResultBlock, ToolUseBlock, AiProvider } from '../../src/lib/server/ai/provider';
import { codeAllowedFor, getAssistantConfig } from '../../src/lib/server/ai/config';
import { getJob, runJob } from '../../src/lib/server/ai/jobs';
import { runTurn } from '../../src/lib/server/ai/loop';
import { promptSkills } from '../../src/lib/server/ai/skills';
import { systemPrompt, withSkills } from '../../src/lib/server/ai/system';
import { appendMessage, cleanPageContext, createThread, historyFor, titleFrom } from '../../src/lib/server/ai/threads';
import { TOOLS, chatTools } from '../../src/lib/server/ai/tools';
import { getBranding } from '../../src/lib/server/branding';
import { getTimezone } from '../../src/lib/server/settings';
import { findActiveUserById } from '../../src/lib/server/users';
import { DEFAULT_TIMEOUT_MS, resolveFixture, resolveRefs } from '../../scripts/assistant-evals-lib.mjs';
import { restoreSnapshot, type Snapshot } from './db-reset';
import { buildFixture, type Fixture } from './fixtures';
import { observe, type Observed } from './providers';

export const EVAL_BASE_URL = 'https://crm.example.test';

export type EvalCase = {
	id: string;
	category: string;
	message: string;
	expect: string;
	fixture?: string | Record<string, unknown>;
	user?: 'admin' | 'member';
	mode?: 'chat' | 'job';
	settings?: Record<string, unknown>;
	page?: { route: string; params?: Record<string, unknown>; selected?: unknown[] };
	graders: Record<string, any>[];
	ci?: boolean;
	timeout_ms?: number;
};

export type EvalToolCall = { name: string; input: unknown; outcome: 'ok' | 'error' | 'pending' | 'not_run'; result?: string };

export type EvalRun = {
	id: string;
	category: string;
	mode: 'chat' | 'job';
	user: 'admin' | 'member';
	model: string;
	effort: string | null;
	message: string;
	toolCalls: EvalToolCall[];
	offered: string[];
	tiers: Record<string, string>;
	text: string;
	finalText: string;
	stopReason: string;
	error: string | null;
	refs: Record<string, number>;
	usage: Usage;
	costMicros: number;
	latencyMs: number;
	transcript: Record<string, unknown>[];
	/** Raw model responses, for --record. */
	responses: { content: ContentBlock[]; stopReason: string | null }[];
};

export type RunCaseOptions = {
	db: D1Database;
	snapshot: Snapshot;
	fixtures: Record<string, unknown>;
	/** Built after the fixture, so a replay can resolve the fixture's refs. */
	provider: (refs: Record<string, number>) => AiProvider;
	model: string;
	effort: string | null;
	/** Only checked by availability() in job mode; any non-empty value in a replay. */
	apiKey: string;
	timeoutMs?: number;
};

const TIERS: Record<string, string> = Object.fromEntries(TOOLS.map((t) => [t.name, t.tier]));
const RESULT_KEEP = 1500;

function todayIn(tz: string, now: Date): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}

const textOf = (content: ContentBlock[]) => content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();

export async function runEvalCase(c: EvalCase, o: RunCaseOptions): Promise<EvalRun> {
	const { db } = o;
	await restoreSnapshot(db, o.snapshot);
	const fixture = resolveFixture(c.fixture, o.fixtures as Record<string, any>) as Fixture;
	const built = await buildFixture(db, fixture, c.settings ?? {});
	const userId = c.user === 'member' ? built.memberId : built.adminId;
	const user = (await findActiveUserById(db, userId))!;
	const model = modelInfo(o.model);
	if (!model) throw new Error(`Unknown model ${o.model}`);
	const effort = effortFor(model, o.effort);
	const { provider, seen } = observe(o.provider(built.refs));
	const mode = c.mode ?? 'chat';
	const timeoutMs = c.timeout_ms ?? o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadlineMs = Math.max(5_000, timeoutMs - 5_000);
	const results = new Map<string, ToolResultBlock>();
	const pending = new Set<string>();
	let stopReason = 'error';
	let costMicros = 0;
	let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let error: string | null = null;
	const started = Date.now();
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abort.abort();
			reject(new Error(`timed out after ${timeoutMs} ms`));
		}, timeoutMs);
	});

	const work = async () => {
		const now = new Date();
		if (mode === 'job') {
			const job = await db
				.prepare(
					`INSERT INTO ai_jobs (name, prompt, model, effort, schedule_kind, schedule_time, timezone, webhook_url, payload_format, enabled, created_by)
					 VALUES ('Eval job', ?, ?, ?, 'daily', '08:00', 'America/Los_Angeles', 'https://hooks.example.com/eval', 'json', 1, ?) RETURNING id`
				)
				.bind(c.message, model.id, effort, userId)
				.first<{ id: number }>();
			const row = (await getJob(db, job!.id))!;
			const r = await runJob(db, { ANTHROPIC_API_KEY: o.apiKey }, row, {
				trigger: 'manual',
				now,
				provider,
				deadlineMs,
				fetch: (async () => new Response('ok', { status: 200 })) as typeof fetch
			});
			costMicros = r.costMicros;
			stopReason = r.status === 'ok' ? 'end_turn' : r.status;
			if (r.status !== 'ok') error = r.error ?? `job ${r.status}`;
			return;
		}
		const cfg = await getAssistantConfig(db);
		const [tz, branding, skills] = await Promise.all([getTimezone(db), getBranding(db), promptSkills(db)]);
		const threadId = await createThread(db, user.id, model.id, effort, titleFrom(c.message));
		const page = c.page ? cleanPageContext(resolveRefs(c.page, built.refs)) : null;
		await appendMessage(db, threadId, { role: 'user', content: [{ type: 'text', text: c.message }], pageContext: page });
		const system = withSkills(
			systemPrompt({ appName: branding.appName, timezone: tz, today: todayIn(tz, now), userLogin: user.github_login, allowDelete: cfg.allowDelete, allowCode: codeAllowedFor(cfg, user) }),
			skills
		);
		const r = await runTurn({
			provider,
			model,
			effort,
			system,
			messages: await historyFor(db, threadId),
			tools: chatTools(cfg),
			ctx: { db, user, baseUrl: EVAL_BASE_URL, now, threadId },
			emit: (e) => {
				if (e.type === 'pending') pending.add(e.action.tool_use_id);
				if (e.type === 'error' && !error && e.message !== 'Stopped.') error = e.message;
			},
			signal: abort.signal,
			deadlineMs,
			persist: async (m) => {
				if (m.role === 'tool') for (const b of m.content) results.set(b.tool_use_id, b);
				return appendMessage(
					db,
					threadId,
					m.role === 'assistant'
						? { role: 'assistant', content: m.content, model: model.id, usage: m.usage, costMicros: m.costMicros }
						: { role: 'tool', content: m.content }
				);
			}
		});
		stopReason = r.stopReason;
		costMicros = r.costMicros;
		usage = r.usage;
		// A turn waiting for Approve ends with stopReason 'pending' — expected, not an error.
		if (r.stopReason === 'pending' || r.stopReason === 'end_turn' || r.stopReason === 'stop_sequence') error = null;
	};

	try {
		await Promise.race([work(), timeout]);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		clearTimeout(timer);
	}

	return observation(c, o, seen, { results, pending, stopReason, error, costMicros, usage, latencyMs: Date.now() - started, refs: built.refs, mode, effort, db });
}

async function observation(
	c: EvalCase,
	o: RunCaseOptions,
	seen: Observed,
	x: {
		results: Map<string, ToolResultBlock>;
		pending: Set<string>;
		stopReason: string;
		error: string | null;
		costMicros: number;
		usage: Usage;
		latencyMs: number;
		refs: Record<string, number>;
		mode: 'chat' | 'job';
		effort: string | null;
		db: D1Database;
	}
): Promise<EvalRun> {
	// Tool results: the persisted ones (chat) plus those sent back in later requests (jobs).
	for (const req of seen.requests)
		for (const m of req.messages)
			for (const b of m.content) if (b.type === 'tool_result' && !x.results.has(b.tool_use_id)) x.results.set(b.tool_use_id, b);
	// Calls waiting for Approve have no result; ai_actions knows them by tool_use_id.
	const rows = await x.db.prepare(`SELECT input FROM ai_actions WHERE status = 'pending'`).all<{ input: string }>();
	for (const r of rows.results) {
		try {
			x.pending.add(String(JSON.parse(r.input).tool_use_id ?? ''));
		} catch {
			/* skip */
		}
	}

	const toolCalls: EvalToolCall[] = [];
	const transcript: Record<string, unknown>[] = [{ role: 'user', text: c.message, ...(c.page ? { page: c.page } : {}) }];
	for (const resp of seen.responses) {
		const uses = resp.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
		transcript.push({ role: 'assistant', text: textOf(resp.content), tool_calls: uses.map((u) => ({ name: u.name, input: u.input })) });
		const out: Record<string, unknown>[] = [];
		for (const u of uses) {
			const res = x.results.get(u.id);
			let outcome: EvalToolCall['outcome'] = 'not_run';
			if (res) outcome = res.content.startsWith('Not run:') ? 'not_run' : res.is_error ? 'error' : 'ok';
			else if (x.pending.has(u.id)) outcome = 'pending';
			const result = res ? res.content.slice(0, RESULT_KEEP) : undefined;
			toolCalls.push({ name: u.name, input: u.input, outcome, ...(result !== undefined ? { result } : {}) });
			out.push({ name: u.name, outcome, ...(result !== undefined ? { result } : {}) });
		}
		if (out.length) transcript.push({ role: 'tool', results: out });
	}
	const texts = seen.responses.map((r) => textOf(r.content)).filter(Boolean);
	const usage = seen.responses.reduce(
		(s, r) => ({ input: s.input + r.usage.input, output: s.output + r.usage.output, cacheRead: s.cacheRead + r.usage.cacheRead, cacheWrite: s.cacheWrite + r.usage.cacheWrite }),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	);
	return {
		id: c.id,
		category: c.category,
		mode: x.mode,
		user: c.user ?? 'admin',
		model: o.model,
		effort: x.effort,
		message: c.message,
		toolCalls,
		offered: seen.requests[0]?.tools ?? [],
		tiers: TIERS,
		text: texts.join('\n\n'),
		finalText: texts.at(-1) ?? '',
		stopReason: x.stopReason,
		error: x.error ?? (seen.errors[0] ?? null),
		refs: x.refs,
		usage: x.mode === 'job' ? usage : x.usage,
		costMicros: x.costMicros,
		latencyMs: x.latencyMs,
		transcript,
		responses: seen.responses.map((r) => ({ content: r.content, stopReason: r.stopReason }))
	};
}
