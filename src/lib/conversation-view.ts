// Conversations view math (#226) — client- and server-safe. Labels, the thread state, the
// URLs the list and thread pages share, the timeline's "Show N earlier" split, j/k list
// navigation, the collapsible row's open state and the reply tree (#378). Pure, so the
// tests drive it directly.
import type { ConvFilter, Conversation, ConvMessage } from '$lib/server/conversations';
import { messageIdKey } from '$lib/message-id';

export const KIND_LABEL: Record<Conversation['root_kind'], string> = {
	campaign: 'Campaign',
	automation: 'Automation',
	direct: '1:1',
	reply: 'Inbound',
	gmail: 'Gmail'
};

/** Kind of one message, for its timeline badge. */
export function messageKindLabel(m: ConvMessage): string {
	if (m.source === 'gmail') return 'Gmail';
	if (m.dir === 'in') return 'Reply';
	return KIND_LABEL[m.send_kind ?? 'campaign'];
}

export const FILTER_TABS: { key: ConvFilter; label: string }[] = [
	{ key: 'all', label: 'All' },
	{ key: 'awaiting', label: 'Awaiting my reply' },
	{ key: 'replied', label: 'Replied' },
	{ key: 'sent', label: 'Sent only' },
	{ key: 'gmail', label: 'Gmail' }, // #443: only while Settings → Mail shows Gmail here
	{ key: 'archived', label: 'Archived' }
];

export const EMPTY_TEXT: Record<ConvFilter, string> = {
	all: 'No conversations yet. Replies to your sends and your 1:1 emails will show up here.',
	awaiting: 'No conversations awaiting your reply.',
	replied: 'No conversations with a reply yet.',
	sent: 'No 1:1 emails waiting on an answer.',
	gmail: 'No Gmail threads with contacts yet.',
	archived: 'No archived conversations. A new reply brings an archived one back.'
};

/**
 * Shift-click range select (#379): plain click sets one key, shift-click sets every key
 * from the last-clicked row to this one to `on`. Returns the new selection, in list order.
 */
export function rangeSelect(
	keys: string[],
	selected: string[],
	index: number,
	on: boolean,
	anchor: number,
	shift: boolean
): string[] {
	const set = new Set(selected);
	const [lo, hi] = shift && anchor >= 0 && anchor < keys.length ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index];
	for (let i = lo; i <= hi; i++) {
		if (on) set.add(keys[i]);
		else set.delete(keys[i]);
	}
	return keys.filter((k) => set.has(k));
}

export type ConvState = 'awaiting' | 'replied' | 'sent';

/** The thread's state Label: theirs is last → awaiting; else replied if they ever did. */
export function convState(c: Pick<Conversation, 'awaiting' | 'replies'>): ConvState {
	if (c.awaiting) return 'awaiting';
	return c.replies > 0 ? 'replied' : 'sent';
}

export const STATE_LABEL: Record<ConvState, string> = {
	awaiting: 'Awaiting reply',
	replied: 'Replied',
	sent: 'Sent'
};

/** List context carried from the list into a thread (and back): filter, search, page. */
export type ListCtx = { filter?: ConvFilter; q?: string; page?: number };

export function listQuery(ctx: ListCtx): string {
	const p = new URLSearchParams();
	if (ctx.filter && ctx.filter !== 'all') p.set('filter', ctx.filter);
	if (ctx.q) p.set('q', ctx.q);
	if (ctx.page && ctx.page > 1) p.set('page', String(ctx.page));
	const s = p.toString();
	return s ? `?${s}` : '';
}

export function listHref(ctx: ListCtx): string {
	return `/conversations${listQuery(ctx)}`;
}

export function threadHref(key: string, ctx: ListCtx = {}): string {
	return `/conversations/${encodeURIComponent(key)}${listQuery(ctx)}`;
}

/** Long threads show only the newest few; older ones sit behind "Show N earlier messages". */
export const TIMELINE_VISIBLE = 6;

export function splitTimeline<T>(messages: T[], showAll: boolean, keep = TIMELINE_VISIBLE): { hidden: number; shown: T[] } {
	if (showAll || messages.length <= keep) return { hidden: 0, shown: messages };
	return { hidden: messages.length - keep, shown: messages.slice(-keep) };
}

/** j/k list navigation: the index to focus next, clamped to the list (-1 = none focused). */
export function moveIndex(current: number, key: string, length: number): number {
	if (length <= 0) return -1;
	if (key === 'j' || key === 'ArrowDown') return Math.min(length - 1, current + 1);
	if (key === 'k' || key === 'ArrowUp') return current < 0 ? 0 : Math.max(0, current - 1);
	return current;
}

/** The collapsible thread row on the contact page: a click flips it, Esc only closes. */
export function nextOpen(open: boolean, action: 'toggle' | 'escape'): boolean {
	return action === 'toggle' ? !open : false;
}

/**
 * Who wrote a message, as the timeline shows it: for ours, the teammate who sent it from Gmail
 * (#585, the CRM user matching the sender), else "You"; for theirs, the sender.
 */
export function messageAuthor(
	m: Pick<ConvMessage, 'dir' | 'source' | 'from' | 'teammate'>,
	conv: Pick<Conversation, 'name' | 'email'>
): string {
	if (m.dir === 'out') return m.source === 'gmail' && m.teammate ? m.teammate : 'You';
	return m.source === 'gmail' && m.from ? m.from : conv.name || conv.email;
}

/** The verb after the author (#585): our Gmail mail "replied from Gmail", our sends "sent". */
export function messageVerb(m: Pick<ConvMessage, 'dir' | 'source'>): string {
	if (m.dir === 'in') return 'replied';
	return m.source === 'gmail' ? 'replied from Gmail' : 'sent';
}

// Reply tree (#378). Each message answers the earlier message whose Message-ID its
// In-Reply-To names; with no such message it answers the one before it in time (the old
// flat reading). Only an *earlier* message can be a parent, so a self-reference or a cycle
// of In-Reply-To headers can't loop — it just falls back. The tree is laid out depth-first
// (children oldest first), indented one step per level up to a cap; deeper messages stay
// at the cap and say who they answer.

/** Indent cap on wide screens, and at phone width (≤ 600px). */
export const THREAD_MAX_LEVEL = 4;
export const THREAD_MAX_LEVEL_NARROW = 3;

type Threadable = Pick<ConvMessage, 'message_id' | 'in_reply_to'>;

export type ThreadItem<T> = {
	m: T;
	/** The message this one answers (null for the first). */
	parent: T | null;
	/** Real depth in the reply tree (0 = the first message). */
	depth: number;
	/** Shown indent: depth capped at THREAD_MAX_LEVEL / THREAD_MAX_LEVEL_NARROW. */
	level: number;
	levelNarrow: number;
	/** Connector columns whose line runs on past this message, per layout. */
	rails: number[];
	railsNarrow: number[];
};

/** Parent index of each message (input oldest first): exact In-Reply-To, else the previous one. */
export function replyParents(messages: Threadable[]): (number | null)[] {
	const firstById = new Map<string, number>();
	return messages.map((m, i) => {
		let parent: number | null = i > 0 ? i - 1 : null;
		if (m.in_reply_to) {
			const p = firstById.get(messageIdKey(m.in_reply_to));
			if (p != null && p < i) parent = p;
		}
		const key = m.message_id ? messageIdKey(m.message_id) : '';
		if (key && !firstById.has(key)) firstById.set(key, i);
		return parent;
	});
}

/**
 * Columns with a line running past row i: column k joins a level-k message to its
 * level-(k+1) children, so it continues while a later row at level k+1 comes before any
 * row at level ≤ k.
 */
export function threadRails(levels: number[]): number[][] {
	return levels.map((level, i) => {
		const out: number[] = [];
		for (let k = 0; k < level; k++) {
			for (let j = i + 1; j < levels.length; j++) {
				if (levels[j] <= k + 1) {
					if (levels[j] === k + 1) out.push(k);
					break;
				}
			}
		}
		return out;
	});
}

/** The thread as a depth-first list, ready to render with indents and connector lines. */
export function threadTree<T extends Threadable>(
	messages: T[],
	maxLevel = THREAD_MAX_LEVEL,
	maxLevelNarrow = THREAD_MAX_LEVEL_NARROW
): ThreadItem<T>[] {
	const parents = replyParents(messages);
	const children: number[][] = messages.map(() => []);
	const roots: number[] = [];
	parents.forEach((p, i) => (p == null ? roots : children[p]).push(i));

	const order: { i: number; depth: number }[] = [];
	const stack = roots.map((i) => ({ i, depth: 0 })).reverse();
	while (stack.length) {
		const top = stack.pop()!;
		order.push(top);
		const kids = children[top.i];
		for (let c = kids.length - 1; c >= 0; c--) stack.push({ i: kids[c], depth: top.depth + 1 });
	}

	const levels = order.map((o) => Math.min(o.depth, maxLevel));
	const levelsNarrow = order.map((o) => Math.min(o.depth, maxLevelNarrow));
	const rails = threadRails(levels);
	const railsNarrow = threadRails(levelsNarrow);
	return order.map((o, n) => {
		const p = parents[o.i];
		return {
			m: messages[o.i],
			parent: p == null ? null : messages[p],
			depth: o.depth,
			level: levels[n],
			levelNarrow: levelsNarrow[n],
			rails: rails[n],
			railsNarrow: railsNarrow[n]
		};
	});
}
