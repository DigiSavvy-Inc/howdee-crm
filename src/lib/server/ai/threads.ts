// Assistant threads + messages in D1 (#287, migration 0077). A thread belongs to one user;
// every read here is scoped by user_id, so nobody sees anyone else's conversations.

import type { Usage } from '$lib/ai-models';
import { SELECTION_MAX } from '$lib/assistant-actions';
import type { ChatMessage, ContentBlock } from './provider';

/** `selected` (#301): contact ids checked on /contacts or /lists/[id], ≤ SELECTION_MAX. */
export type PageContext = { route: string; params: Record<string, string>; selected?: number[] };

export type ThreadRow = {
	id: number;
	user_id: number;
	title: string;
	model: string;
	effort: string | null;
	created_at: string;
	updated_at: string;
	total_input_tokens: number;
	total_output_tokens: number;
	cost_micros: number;
};

export const TITLE_MAX = 60;
export const MESSAGE_MAX = 8000;

/** `{ route, params, selected? }` from the browser, cleaned: a path-ish route, ≤ 10 string
 *  params, ≤ SELECTION_MAX positive integer contact ids. */
export function cleanPageContext(raw: unknown): PageContext | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const route = typeof r.route === 'string' ? r.route.trim().slice(0, 200) : '';
	if (!route.startsWith('/')) return null;
	const params: Record<string, string> = {};
	if (r.params && typeof r.params === 'object' && !Array.isArray(r.params)) {
		for (const [k, v] of Object.entries(r.params as Record<string, unknown>).slice(0, 10)) {
			if (/^[a-z_]{1,30}$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) params[k] = String(v).slice(0, 100);
		}
	}
	const selected = Array.isArray(r.selected)
		? [...new Set(r.selected.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, SELECTION_MAX)
		: [];
	return selected.length ? { route, params, selected } : { route, params };
}

export function pageContextText(pc: PageContext): string {
	const p = Object.keys(pc.params).length ? ` params ${JSON.stringify(pc.params)}` : '';
	const sel = pc.selected?.length ? `; ${pc.selected.length} selected contacts, ids ${JSON.stringify(pc.selected)}` : '';
	return `[Page context: the user is on ${pc.route}${p}${sel}]`;
}

export function titleFrom(message: string): string {
	const t = message.replace(/\s+/g, ' ').trim();
	return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

export async function createThread(db: D1Database, userId: number, model: string, effort: string | null, title: string): Promise<number> {
	const row = await db
		.prepare('INSERT INTO ai_threads (user_id, model, effort, title) VALUES (?, ?, ?, ?) RETURNING id')
		.bind(userId, model, effort, title)
		.first<{ id: number }>();
	return row!.id;
}

export async function threadForUser(db: D1Database, threadId: number, userId: number): Promise<ThreadRow | null> {
	return db.prepare('SELECT * FROM ai_threads WHERE id = ? AND user_id = ?').bind(threadId, userId).first<ThreadRow>();
}

/** The panel's history. #387: Draft reply bookkeeping threads (an ai_actions row with tool
 *  `draft_reply`) are left out — they're audit rows, not conversations. #679: so are Ask AI
 *  ones (`editor_ask`), and #748 resend subject suggestions (`resend_subject`). */
export async function listThreads(db: D1Database, userId: number, limit = 30): Promise<ThreadRow[]> {
	const rows = await db
		// #310: a thread pruned of its messages (kept only for a younger ai_actions row) is hidden.
		.prepare(
			`SELECT * FROM ai_threads WHERE user_id = ? AND EXISTS (SELECT 1 FROM ai_messages m WHERE m.thread_id = ai_threads.id)
			   AND id NOT IN (SELECT thread_id FROM ai_actions WHERE tool IN ('draft_reply', 'editor_ask', 'resend_subject'))
			 ORDER BY updated_at DESC, id DESC LIMIT ?`
		)
		.bind(userId, limit)
		.all<ThreadRow>();
	return rows.results;
}

export async function setThreadModel(db: D1Database, threadId: number, model: string, effort: string | null): Promise<void> {
	await db.prepare('UPDATE ai_threads SET model = ?, effort = ? WHERE id = ?').bind(model, effort, threadId).run();
}

export type NewMessage = {
	role: 'user' | 'assistant' | 'tool';
	content: ContentBlock[];
	pageContext?: PageContext | null;
	model?: string | null;
	usage?: Usage;
	costMicros?: number;
};

/** Store a message and roll its usage into the thread's totals. */
export async function appendMessage(db: D1Database, threadId: number, m: NewMessage): Promise<number> {
	const u = m.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const cost = m.costMicros ?? 0;
	const [ins] = await db.batch([
		db
			.prepare(
				`INSERT INTO ai_messages (thread_id, role, content, page_context, model, input_tokens, output_tokens,
				                          cache_read_tokens, cache_write_tokens, cost_micros)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
			)
			.bind(threadId, m.role, JSON.stringify(m.content), m.pageContext ? JSON.stringify(m.pageContext) : null, m.model ?? null, u.input, u.output, u.cacheRead, u.cacheWrite, cost),
		db
			.prepare(
				`UPDATE ai_threads SET updated_at = datetime('now'),
				   total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ?,
				   cost_micros = cost_micros + ? WHERE id = ?`
			)
			.bind(u.input + u.cacheRead + u.cacheWrite, u.output, cost, threadId)
	]);
	return (ins.results[0] as { id: number }).id;
}

/** #310: thumbs up = 1, thumbs down = -1 (migration 0096). */
export type Feedback = 1 | -1;

/**
 * Store thumbs up / down (or clear it with null) on one of the user's own assistant messages.
 * Returns false when the message isn't an assistant row of one of their threads.
 */
export async function setFeedback(db: D1Database, messageId: number, userId: number, value: Feedback | null): Promise<boolean> {
	const r = await db
		.prepare(
			`UPDATE ai_messages SET feedback = ?, feedback_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
			 WHERE id = ? AND role = 'assistant'
			   AND thread_id IN (SELECT id FROM ai_threads WHERE user_id = ?)`
		)
		.bind(value, value, messageId, userId)
		.run();
	return (r.meta.changes ?? 0) > 0;
}

type MessageRow = { id: number; role: 'user' | 'assistant' | 'tool'; content: string; page_context: string | null; created_at: string; cost_micros: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; feedback: Feedback | null };

async function messageRows(db: D1Database, threadId: number): Promise<MessageRow[]> {
	const rows = await db
		.prepare(
			`SELECT id, role, content, page_context, created_at, cost_micros, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
			        feedback
			 FROM ai_messages WHERE thread_id = ? ORDER BY id`
		)
		.bind(threadId)
		.all<MessageRow>();
	return rows.results;
}

function parseBlocks(s: string): ContentBlock[] {
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? (v as ContentBlock[]) : [];
	} catch {
		return [];
	}
}

/**
 * The stored thread as Messages API history: tool rows become user turns, a user row with
 * page context gets the context line first, and same-role neighbours are merged (an
 * aborted turn can leave two user turns in a row).
 */
export async function historyFor(db: D1Database, threadId: number): Promise<ChatMessage[]> {
	const out: ChatMessage[] = [];
	for (const r of await messageRows(db, threadId)) {
		const role = r.role === 'assistant' ? 'assistant' : 'user';
		let content = parseBlocks(r.content);
		if (r.role === 'user' && r.page_context) {
			try {
				const pc = cleanPageContext(JSON.parse(r.page_context));
				if (pc) content = [{ type: 'text', text: pageContextText(pc) }, ...content];
			} catch {
				/* ignore a bad context */
			}
		}
		if (!content.length) continue;
		const prev = out[out.length - 1];
		if (prev && prev.role === role) prev.content = [...prev.content, ...content];
		else out.push({ role, content });
	}
	return out;
}

export type DisplayMessage =
	| { kind: 'user'; id: number; text: string; at: string }
	| { kind: 'assistant'; id: number; text: string; tools: { id: string; name: string; skill?: string }[]; at: string; costMicros: number; tokens: number; feedback: Feedback | null }
	| { kind: 'tool'; id: number; results: { tool_use_id: string; ok: boolean; preview: string }[]; at: string };

/** #302: a stored load_skill call keeps its skill name, for the "Used skill: …" row. */
function skillOf(b: { name: string; input: unknown }): { skill?: string } {
	if (b.name !== 'load_skill' || !b.input || typeof b.input !== 'object') return {};
	const name = (b.input as Record<string, unknown>).name;
	return typeof name === 'string' && name.trim() ? { skill: name.trim().slice(0, 64) } : {};
}

/** The thread for the panel: user text, assistant text + tool calls, tool outcomes. */
export async function displayMessages(db: D1Database, threadId: number): Promise<DisplayMessage[]> {
	return (await messageRows(db, threadId)).map((r) => {
		const blocks = parseBlocks(r.content);
		const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
		if (r.role === 'user') return { kind: 'user', id: r.id, text, at: r.created_at };
		if (r.role === 'assistant') {
			return {
				kind: 'assistant',
				id: r.id,
				text,
				tools: blocks.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, ...skillOf(b) }] : [])),
				at: r.created_at,
				costMicros: r.cost_micros,
				tokens: r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
				feedback: r.feedback ?? null
			};
		}
		return {
			kind: 'tool',
			id: r.id,
			results: blocks.flatMap((b) =>
				b.type === 'tool_result' ? [{ tool_use_id: b.tool_use_id, ok: !b.is_error, preview: String(b.content).slice(0, 200) }] : []
			),
			at: r.created_at
		};
	});
}
