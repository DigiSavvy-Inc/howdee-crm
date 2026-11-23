import { describe, it, expect } from 'vitest';
import {
	messageAuthor,
	replyParents,
	splitTimeline,
	threadRails,
	threadTree,
	THREAD_MAX_LEVEL,
	THREAD_MAX_LEVEL_NARROW
} from '../src/lib/conversation-view';
import type { ConvMessage } from '../src/lib/server/conversations';

// #378: the reply tree behind the indented thread view — parents from In-Reply-To, the
// previous-message fallback, depth capping, cycles / self-references, Gmail messages and
// the connector rails.

type M = Pick<ConvMessage, 'message_id' | 'in_reply_to'> & { n: string };
const msg = (n: string, message_id: string | null, in_reply_to: string | null = null): M => ({ n, message_id, in_reply_to });
const names = (items: { m: M }[]) => items.map((it) => it.m.n);

describe('replyParents', () => {
	it('uses the exact In-Reply-To parent (Postmark id vs header form)', () => {
		const ms = [
			msg('send', 'AAA-111'),
			msg('reply1', '<r1@mail.example>', '<aaa-111@mtasv.net>'),
			msg('reply2', '<r2@mail.example>', '<AAA-111@mtasv.net>')
		];
		expect(replyParents(ms)).toEqual([null, 0, 0]);
	});

	it('falls back to the previous message when the parent is unknown or missing', () => {
		const ms = [msg('a', 'a1'), msg('b', 'b1', '<nowhere@x>'), msg('c', null, null)];
		expect(replyParents(ms)).toEqual([null, 0, 1]);
	});

	it('never loops on a self-reference or a cycle', () => {
		const self = [msg('a', 'a1'), msg('b', 'b1', 'b1')];
		expect(replyParents(self)).toEqual([null, 0]);
		// a names c, c names a: only an earlier message can be a parent.
		const cycle = [msg('a', 'a1', 'c1'), msg('b', 'b1', 'a1'), msg('c', 'c1', 'a1')];
		expect(replyParents(cycle)).toEqual([null, 0, 0]);
		const tree = threadTree(cycle);
		expect(names(tree)).toEqual(['a', 'b', 'c']);
		expect(tree.map((t) => t.depth)).toEqual([0, 1, 1]);
	});
});

describe('threadTree', () => {
	it('lays out depth-first with children oldest first', () => {
		const ms = [
			msg('send', 's1'),
			msg('r1', 'r1', 's1'),
			msg('r2', 'r2', 's1'),
			msg('you1', 'y1', 'r1') // answers the older reply
		];
		const tree = threadTree(ms);
		expect(names(tree)).toEqual(['send', 'r1', 'you1', 'r2']);
		expect(tree.map((t) => t.depth)).toEqual([0, 1, 2, 1]);
		expect(tree.map((t) => t.parent?.n ?? null)).toEqual([null, 'send', 'r1', 'send']);
	});

	it('caps the shown level at 4 (3 on phones) and keeps the real depth', () => {
		const ms = Array.from({ length: 7 }, (_, i) => msg(`m${i}`, `id${i}`, i ? `id${i - 1}` : null));
		const tree = threadTree(ms);
		expect(tree.map((t) => t.depth)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(tree.map((t) => t.level)).toEqual([0, 1, 2, 3, 4, 4, 4]);
		expect(tree.map((t) => t.levelNarrow)).toEqual([0, 1, 2, 3, 3, 3, 3]);
		expect(Math.max(...tree.map((t) => t.level))).toBe(THREAD_MAX_LEVEL);
		expect(Math.max(...tree.map((t) => t.levelNarrow))).toBe(THREAD_MAX_LEVEL_NARROW);
	});

	it('threads Gmail-synced messages by their Message-ID headers', () => {
		const ms = [
			{ ...msg('send', 'pm-1'), source: undefined },
			{ ...msg('gmail-reply', '<CAF123@mail.gmail.com>', '<pm-1@mtasv.net>'), source: 'gmail' as const },
			{ ...msg('gmail-you', '<CAF456@mail.gmail.com>', '<CAF123@mail.gmail.com>'), source: 'gmail' as const },
			{ ...msg('gmail-other', '<CAF789@mail.gmail.com>', '<pm-1@mtasv.net>'), source: 'gmail' as const }
		];
		const tree = threadTree(ms);
		expect(names(tree)).toEqual(['send', 'gmail-reply', 'gmail-you', 'gmail-other']);
		expect(tree.map((t) => t.depth)).toEqual([0, 1, 2, 1]);
	});

	it('handles an empty thread', () => {
		expect(threadTree([])).toEqual([]);
	});

	it('keeps working with the "Show N earlier" split', () => {
		const ms = Array.from({ length: 8 }, (_, i) => msg(`m${i}`, `id${i}`));
		const split = splitTimeline(threadTree(ms), false);
		expect(split.hidden).toBe(2);
		expect(names(split.shown)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7']);
	});
});

describe('threadRails', () => {
	it('runs a column on while a sibling is still to come', () => {
		// send, r1 (→ you1 under it), r2: column 0 continues past r1 and you1, ends at r2.
		expect(threadRails([0, 1, 2, 1])).toEqual([[], [0], [0], []]);
	});

	it('ends every column at the last message', () => {
		expect(threadRails([0, 1, 2, 3])).toEqual([[], [], [], []]);
		expect(threadRails([0, 1, 1, 1])).toEqual([[], [0], [0], []]);
	});

	it('keeps an outer column through a deeper subtree', () => {
		// a, b(1), c(2), d(2), e(1): column 1 joins c and d; column 0 joins b and e.
		expect(threadRails([0, 1, 2, 2, 1])).toEqual([[], [0], [0, 1], [0], []]);
	});
});

describe('messageAuthor', () => {
	const conv = { name: 'Ann Lee', email: 'ann@example.com' };
	it('names ours, theirs and a Gmail sender', () => {
		expect(messageAuthor({ dir: 'out' }, conv)).toBe('You');
		expect(messageAuthor({ dir: 'in' }, conv)).toBe('Ann Lee');
		expect(messageAuthor({ dir: 'in', source: 'gmail', from: 'Bob' }, conv)).toBe('Bob');
		expect(messageAuthor({ dir: 'in' }, { name: null, email: 'x@y.z' })).toBe('x@y.z');
	});
});
