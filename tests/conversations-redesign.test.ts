import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { conversationByKey, conversationNeighbors, recentConversations } from '../src/lib/server/conversations';
import {
	convState,
	listHref,
	moveIndex,
	nextOpen,
	splitTimeline,
	threadHref,
	messageKindLabel
} from '../src/lib/conversation-view';
import { load } from '../src/routes/conversations/[key]/+page.server';

// #226: Conversations list → thread page. View math, conversationByKey, Previous/Next
// within the filter, the thread page's 404. The Reply action itself is unchanged and stays
// covered by conversation-reply.test.ts; list filters/counts by conversations.test.ts.
const db = (env as any).DB as D1Database;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

/** Ann replied to a broadcast; Bob got a 1:1 and an unreplied broadcast; a stranger wrote in. */
async function seed() {
	const ann = await id("INSERT INTO contacts (email, name) VALUES ('ann@x.example.net', 'Ann') RETURNING id");
	const bob = await id("INSERT INTO contacts (email) VALUES ('bob@x.example.net') RETURNING id");
	const list = await id("INSERT INTO lists (name) VALUES ('L') RETURNING id");
	const bc = await id(
		"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, list_id, sent_at) VALUES ('Broadcast', 'm', 'h', 'f', 'sent', ?, '2026-01-01 10:00:00') RETURNING id",
		list
	);
	const direct = await id(
		"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('Hello Bob', 'm', 'h', 'f', 'sent', '2026-01-05 10:00:00') RETURNING id"
	);
	await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'm-ann', 'accepted')").bind(bc, ann).run();
	await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'bob@x.example.net', 'm-bob', 'accepted')").bind(bc, bob).run();
	await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'bob@x.example.net', 'm-bob2', 'accepted')").bind(direct, bob).run();
	await db
		.prepare("INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at) VALUES (?, ?, 'ann@x.example.net', 'Re: Broadcast', 'Loved it', '2026-01-02 09:00:00')")
		.bind(ann, bc)
		.run();
	const stranger = await id(
		"INSERT INTO replies (from_email, subject, received_at) VALUES ('stranger-x@y-z.example.net', 'Hi', '2026-01-03 09:00:00') RETURNING id"
	);
	return { ann, bob, bc, direct, stranger };
}

describe('conversationByKey (#226)', () => {
	it('finds a contact thread, a bare-email thread and an unlisted broadcast thread', async () => {
		const { ann, bob, bc, direct, stranger } = await seed();
		expect(await conversationByKey(db, `c${ann}-c${bc}`)).toMatchObject({ subject: 'Broadcast', count: 2, awaiting: true });
		expect(await conversationByKey(db, `c${bob}-c${direct}`)).toMatchObject({ subject: 'Hello Bob', root_kind: 'direct' });
		// Hyphens in the address don't confuse the key split.
		expect(await conversationByKey(db, `estranger-x@y-z.example.net-r${stranger}`)).toMatchObject({ subject: 'Hi', contact_id: null });
		// Bob's unreplied broadcast isn't on the tab, but the contact page links to it.
		expect(await conversationByKey(db, `c${bob}-c${bc}`)).toMatchObject({ subject: 'Broadcast', replies: 0 });
	});

	it('returns null for unknown or malformed keys', async () => {
		const { ann } = await seed();
		expect(await conversationByKey(db, `c${ann}-c999999`)).toBeNull();
		expect(await conversationByKey(db, 'c999999-c1')).toBeNull();
		expect(await conversationByKey(db, 'nonsense')).toBeNull();
		expect(await conversationByKey(db, '')).toBeNull();
	});
});

describe('conversationNeighbors (#226)', () => {
	it('walks the list order within the filter and search', async () => {
		const { ann, bob, bc, direct, stranger } = await seed();
		const keys = (await recentConversations(db, {})).rows.map((t) => t.key);
		expect(keys).toEqual([`c${bob}-c${direct}`, `estranger-x@y-z.example.net-r${stranger}`, `c${ann}-c${bc}`]);

		const mid = await conversationNeighbors(db, keys[1]);
		expect(mid.prev?.key).toBe(keys[0]);
		expect(mid.next?.key).toBe(keys[2]);
		expect(mid).toMatchObject({ index: 1, total: 3 });

		const first = await conversationNeighbors(db, keys[0]);
		expect(first.prev).toBeNull();
		expect(first.next?.subject).toBe('Hi');

		// Awaiting = the stranger + Ann: Bob's 1:1 is not in it.
		const aw = await conversationNeighbors(db, keys[1], { filter: 'awaiting' });
		expect(aw).toMatchObject({ index: 0, total: 2, prev: null });
		expect(aw.next?.key).toBe(keys[2]);
		expect(await conversationNeighbors(db, keys[0], { filter: 'awaiting' })).toMatchObject({ index: -1, prev: null, next: null });

		const searched = await conversationNeighbors(db, keys[2], { q: 'ann' });
		expect(searched).toMatchObject({ index: 0, total: 1, prev: null, next: null });
	});
});

describe('thread page load (#226)', () => {
	const ev = (key: string, qs = '', role: 'admin' | 'member' = 'member') =>
		({
			platform: { env },
			params: { key },
			url: new URL(`https://app.test/conversations/${encodeURIComponent(key)}${qs}`),
			locals: { user: { id: 1, github_login: role === 'admin' ? 'conv-admin' : 'mem', role } }
		}) as any;

	it('loads the thread with its neighbours and the list page to go back to', async () => {
		const { ann, bc } = await seed();
		const res = (await load(ev(`c${ann}-c${bc}`, '?filter=awaiting&page=4'))) as any;
		expect(res.conv.subject).toBe('Broadcast');
		expect(res.filter).toBe('awaiting');
		expect(res.page).toBe(1); // recomputed from its position, not the carried ?page
		expect(res.neighbors.prev?.subject).toBe('Hi');
		expect(res.isAdmin).toBe(false);
	});

	it('flags admins, and treats missing locals as non-admin', async () => {
		const { ann, bc } = await seed();
		const key = `c${ann}-c${bc}`;
		expect(((await load(ev(key, '', 'admin'))) as any).isAdmin).toBe(true);
		const { locals: _locals, ...bare } = ev(key);
		expect(((await load(bare)) as any).isAdmin).toBe(false);
	});

	it('404s on an unknown key', async () => {
		await seed();
		await expect(load(ev('c999999-c1'))).rejects.toMatchObject({ status: 404 });
	});
});

describe('conversation view helpers (#226)', () => {
	it('derives the state label', () => {
		expect(convState({ awaiting: true, replies: 1 })).toBe('awaiting');
		expect(convState({ awaiting: false, replies: 2 })).toBe('replied');
		expect(convState({ awaiting: false, replies: 0 })).toBe('sent');
	});

	it('builds list + thread URLs that carry filter, search and page', () => {
		expect(listHref({})).toBe('/conversations');
		expect(listHref({ filter: 'all', page: 1 })).toBe('/conversations');
		expect(listHref({ filter: 'awaiting', q: 'ann lee', page: 2 })).toBe('/conversations?filter=awaiting&q=ann+lee&page=2');
		expect(threadHref('ea@b.example.net-r3', { filter: 'replied' })).toBe('/conversations/ea%40b.example.net-r3?filter=replied');
	});

	it('hides older messages past six until asked', () => {
		const msgs = Array.from({ length: 9 }, (_, i) => i);
		expect(splitTimeline(msgs, false)).toEqual({ hidden: 3, shown: [3, 4, 5, 6, 7, 8] });
		expect(splitTimeline(msgs, true)).toEqual({ hidden: 0, shown: msgs });
		expect(splitTimeline(msgs.slice(0, 6), false).hidden).toBe(0);
	});

	it('moves list focus with j/k, clamped', () => {
		expect(moveIndex(-1, 'j', 3)).toBe(0);
		expect(moveIndex(0, 'j', 3)).toBe(1);
		expect(moveIndex(2, 'j', 3)).toBe(2);
		expect(moveIndex(2, 'k', 3)).toBe(1);
		expect(moveIndex(0, 'k', 3)).toBe(0);
		expect(moveIndex(-1, 'k', 3)).toBe(0);
		expect(moveIndex(-1, 'j', 0)).toBe(-1);
		expect(moveIndex(1, 'x', 3)).toBe(1);
	});

	it('collapsible thread: a click toggles open and closed again, Esc only closes', () => {
		let open = false;
		open = nextOpen(open, 'toggle');
		expect(open).toBe(true);
		open = nextOpen(open, 'toggle');
		expect(open).toBe(false);
		expect(nextOpen(true, 'escape')).toBe(false);
		expect(nextOpen(false, 'escape')).toBe(false);
	});

	it('labels each message kind', () => {
		const base = { dir: 'out', send_kind: 'direct' } as any;
		expect(messageKindLabel(base)).toBe('1:1');
		expect(messageKindLabel({ ...base, send_kind: 'automation' })).toBe('Automation');
		expect(messageKindLabel({ dir: 'in' } as any)).toBe('Reply');
		expect(messageKindLabel({ dir: 'in', source: 'gmail' } as any)).toBe('Gmail');
	});
});
