import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { conversationByKey, conversationsFor, recentConversations } from '../src/lib/server/conversations';
import { CONV_BULK_MAX, parseThreadKeys } from '../src/lib/server/conversation-state';
import { clearMailTokenCache, saveMailAccount, storeMessages, syncMailAccount } from '../src/lib/server/mail-sync';
import type { GmailMessage } from '../src/lib/server/gmail';
import { awaitingReplyCount } from '../src/lib/server/conversations';
import { rangeSelect } from '../src/lib/conversation-view';
import { actions } from '../src/routes/conversations/+page.server';
import { load as threadLoad } from '../src/routes/conversations/[key]/+page.server';

// #379: archive / unarchive / delete conversations.
const db = (env as any).DB as D1Database;
const ME = 'alan@ourco.example';

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const MAIL_ENV = { MAIL_TOKEN_KEY: newKey(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' };

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'))!;

beforeEach(async () => {
	clearMailTokenCache();
	await db.batch([
		db.prepare('DELETE FROM conversation_state'),
		db.prepare('DELETE FROM conversation_hidden_sends'),
		db.prepare('DELETE FROM conversation_deleted_gmail'),
		db.prepare('DELETE FROM conversation_hidden_gmail'),
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'mail_%'`),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`INSERT OR IGNORE INTO users (github_login, role) VALUES ('conv-admin', 'admin')`)
	]);
});

/** Ann replied to a broadcast (opened + clicked); Bob got a 1:1 and replied twice. */
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
	const rAnn = await id(
		"INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'm-ann', 'accepted') RETURNING id",
		bc,
		ann
	);
	await id(
		"INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'bob@x.example.net', 'm-bob2', 'accepted') RETURNING id",
		direct,
		bob
	);
	await db.batch([
		db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, 'open')").bind(bc, rAnn, ann),
		db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, 'click')").bind(bc, rAnn, ann),
		db
			.prepare("INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at) VALUES (?, ?, 'ann@x.example.net', 'Re: Broadcast', 'Loved it', '2026-01-02 09:00:00')")
			.bind(ann, bc),
		db
			.prepare("INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, 'bob@x.example.net', 'Re: Hello Bob', 'Hi', '2026-01-06 09:00:00')")
			.bind(bob),
		db
			.prepare("INSERT INTO replies (contact_id, from_email, subject, text, received_at) VALUES (?, 'bob@x.example.net', 'Re: Hello Bob', 'Again', '2026-01-07 09:00:00')")
			.bind(bob)
	]);
	return { ann, bob, bc, direct, annKey: `c${ann}-c${bc}`, bobKey: `c${bob}-c${direct}` };
}

function ev(action: string, fields: [string, string][], role: 'admin' | 'member' = 'member') {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	return {
		url: new URL(`https://app.test/conversations?/${action}`),
		request: new Request(`https://app.test/conversations?/${action}`, { method: 'POST', body: fd }),
		locals: { user: { id: 1, github_login: role === 'admin' ? 'conv-admin' : 'mem', role } },
		platform: { env: { DB: db } }
	} as any;
}

const keysOf = async (filter: 'all' | 'archived' | 'awaiting') =>
	(await recentConversations(db, { filter })).rows.map((t) => t.key).sort();

describe('archive (#379)', () => {
	it('hides a thread, shows it under Archived, unarchive restores it', async () => {
		const { annKey, bobKey } = await seed();
		expect(await keysOf('all')).toEqual([annKey, bobKey].sort());
		expect(await awaitingReplyCount(db)).toBe(2);

		const res = await actions.archive(ev('archive', [['key', annKey]]));
		expect(res).toMatchObject({ affected: 1, skipped: 0 });
		expect(await keysOf('all')).toEqual([bobKey]);
		expect(await keysOf('archived')).toEqual([annKey]);
		const { counts } = await recentConversations(db);
		expect(counts).toMatchObject({ all: 1, awaiting: 1, archived: 1 });
		expect(await awaitingReplyCount(db)).toBe(1); // dashboard tile excludes archived
		expect(await db.prepare('SELECT archived_by, archived_last_at FROM conversation_state WHERE thread_key = ?').bind(annKey).first()).toEqual({
			archived_by: '@mem',
			archived_last_at: '2026-01-02 09:00:00'
		});

		await actions.unarchive(ev('unarchive', [['key', annKey]]));
		expect(await keysOf('all')).toEqual([annKey, bobKey].sort());
		expect(await keysOf('archived')).toEqual([]);
	});

	it('a new inbound message auto-unarchives it; our own new send does not', async () => {
		const { ann, bc, annKey } = await seed();
		await actions.archive(ev('archive', [['key', annKey]]));
		expect(await keysOf('archived')).toEqual([annKey]);

		// Still archived after an outbound follow-up in the same thread (In-Reply-To match).
		await db
			.prepare("UPDATE replies SET message_id_header = 'their-1@x.example.net' WHERE contact_id = ?")
			.bind(ann)
			.run();
		const fu = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at, in_reply_to_message_id) VALUES ('Re: Broadcast', 'm', 'h', 'f', 'sent', '2026-01-03 10:00:00', 'their-1@x.example.net') RETURNING id"
		);
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'm-fu', 'accepted')").bind(fu, ann).run();
		expect(await keysOf('archived')).toEqual([annKey]);

		await db
			.prepare("INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at) VALUES (?, ?, 'ann@x.example.net', 'Re: Broadcast', 'One more', '2026-01-04 09:00:00')")
			.bind(ann, bc)
			.run();
		expect(await keysOf('archived')).toEqual([]);
		expect(await keysOf('all')).toContain(annKey);
	});

	it('thread page knows the archive state; return_to redirects', async () => {
		const { annKey } = await seed();
		await expect(
			actions.archive(ev('archive', [['key', annKey], ['return_to', '/conversations?filter=awaiting']]))
		).rejects.toMatchObject({ status: 303, location: '/conversations?filter=awaiting' });
		const page = (await threadLoad({ params: { key: annKey }, url: new URL('https://app.test/x'), locals: { user: { role: 'member' } }, platform: { env: { DB: db } } } as any)) as any;
		expect(page).toMatchObject({ archived: true, isAdmin: false });
		// An off-site return_to is ignored.
		const res = await actions.unarchive(ev('unarchive', [['key', annKey], ['return_to', '//evil.example/']]));
		expect(res).toMatchObject({ affected: 1 });
	});
});

describe('delete (#379)', () => {
	it('removes only the inbound rows; sends, campaigns and events stay, hidden from Conversations', async () => {
		const { ann, bob, annKey, bobKey } = await seed();
		const before = { recipients: await count('recipients'), campaigns: await count('campaigns'), events: await count('events') };
		expect(before).toEqual({ recipients: 2, campaigns: 2, events: 2 });

		const res = await actions.delete(ev('delete', [['key', annKey], ['key', bobKey], ['confirm', '1']], 'admin'));
		expect(res).toMatchObject({ affected: 2, skipped: 0 });

		expect(await count('replies')).toBe(0);
		expect({ recipients: await count('recipients'), campaigns: await count('campaigns'), events: await count('events') }).toEqual(before);
		expect(await count('conversation_hidden_sends')).toBe(2);
		expect(await keysOf('all')).toEqual([]);
		expect(await conversationsFor(db, ann)).toEqual([]);
		expect(await conversationsFor(db, bob)).toEqual([]);
		expect(await conversationByKey(db, annKey)).toBeNull();
		expect(await awaitingReplyCount(db)).toBe(0);
		expect(await db.prepare('SELECT deleted_by FROM conversation_state WHERE thread_key = ?').bind(annKey).first('deleted_by')).toBe('@conv-admin');
	});

	it('leaves other threads alone', async () => {
		const { annKey, bobKey } = await seed();
		await actions.delete(ev('delete', [['key', annKey], ['confirm', '1']], 'admin'));
		expect(await count('replies')).toBe(2);
		expect(await keysOf('all')).toEqual([bobKey]);
	});

	it('is admin-only (403) and needs confirm', async () => {
		const { annKey } = await seed();
		const r = await actions.delete(ev('delete', [['key', annKey], ['confirm', '1']], 'member'));
		expect(r).toMatchObject({ status: 403 });
		expect(await count('replies')).toBe(3);
		const r2 = await actions.delete(ev('delete', [['key', annKey]], 'admin'));
		expect(r2).toMatchObject({ status: 400 });
		expect(await count('replies')).toBe(3);
	});

	it('a deleted Gmail message is not re-imported by the sync', async () => {
		const ann = await id("INSERT INTO contacts (email, name) VALUES ('ann@x.example.net', 'Ann') RETURNING id");
		const adminId = (await db.prepare(`SELECT id FROM users WHERE github_login = 'conv-admin'`).first<number>('id'))!;
		const acct = await saveMailAccount(db, MAIL_ENV, { email: ME, refreshToken: 'r', userId: adminId });
		const msg = (gid: string, at: string): GmailMessage => ({
			id: gid,
			threadId: 'GT1',
			labelIds: ['INBOX'],
			snippet: `snippet ${gid}`,
			internalDate: String(Date.parse(at)),
			payload: {
				mimeType: 'text/plain',
				headers: [
					{ name: 'From', value: 'Ann <ann@x.example.net>' },
					{ name: 'To', value: ME },
					{ name: 'Subject', value: 'Lunch' },
					{ name: 'Message-ID', value: `<${gid}@mail.gmail.com>` }
				]
			}
		});
		await storeMessages(db, { id: acct, email: ME }, [msg('g1', '2026-09-01T10:00:00Z')]);
		const [thread] = await conversationsFor(db, ann);
		expect(thread.key).toBe(`c${ann}-gGT1`);

		await actions.delete(ev('delete', [['key', thread.key], ['confirm', '1']], 'admin'));
		expect(await count('mail_messages')).toBe(0);
		expect(await count('mail_threads')).toBe(0);
		expect(await db.prepare('SELECT mailbox, gmail_id FROM conversation_deleted_gmail').first()).toEqual({ mailbox: ME, gmail_id: 'g1' });

		// The store step skips it…
		expect(await storeMessages(db, { id: acct, email: ME }, [msg('g1', '2026-09-01T10:00:00Z')])).toBe(0);
		expect(await count('mail_messages')).toBe(0);

		// …and a full sync never fetches it again, while a new message in the thread comes in.
		const calls: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
			calls.push(url.pathname);
			if (url.host === 'oauth2.googleapis.com') return Response.json({ access_token: 'at-1', expires_in: 3600 });
			const p = url.pathname.replace('/gmail/v1/users/me', '');
			if (p === '/profile') return Response.json({ emailAddress: ME, historyId: '100' });
			if (p === '/messages') return Response.json({ messages: [{ id: 'g1', threadId: 'GT1' }, { id: 'g2', threadId: 'GT1' }] });
			if (p === '/messages/g1') return Response.json(msg('g1', '2026-09-01T10:00:00Z'));
			if (p === '/messages/g2') return Response.json(msg('g2', '2026-09-03T10:00:00Z'));
			return new Response('{}', { status: 404 });
		}) as typeof fetch;
		const r = await syncMailAccount(db, MAIL_ENV, acct, { fetch: fetchImpl });
		expect(r).toMatchObject({ stored: 1 });
		expect(calls).not.toContain('/gmail/v1/users/me/messages/g1');
		const ids = await db.prepare('SELECT gmail_id FROM mail_messages').all<{ gmail_id: string }>();
		expect(ids.results.map((x) => x.gmail_id)).toEqual(['g2']);
	});
});

describe('delete keeps outbound Gmail (#379 review)', () => {
	const gmsg = (gid: string, at: string, dir: 'in' | 'out'): GmailMessage => ({
		id: gid,
		threadId: 'GT9',
		labelIds: dir === 'out' ? ['SENT'] : ['INBOX'],
		snippet: `snippet ${gid}`,
		internalDate: String(Date.parse(at)),
		payload: {
			mimeType: 'text/plain',
			headers: [
				{ name: 'From', value: dir === 'out' ? `Alan <${ME}>` : 'Ann <ann@x.example.net>' },
				{ name: 'To', value: dir === 'out' ? 'ann@x.example.net' : ME },
				{ name: 'Subject', value: 'Proposal' },
				{ name: 'Message-ID', value: `<${gid}@mail.gmail.com>` }
			]
		}
	});
	const gmailIds = async () =>
		(await db.prepare('SELECT gmail_id, direction FROM mail_messages ORDER BY gmail_id').all<{ gmail_id: string; direction: string }>()).results;

	async function setup() {
		const ann = await id("INSERT INTO contacts (email, name) VALUES ('ann@x.example.net', 'Ann') RETURNING id");
		const adminId = (await db.prepare(`SELECT id FROM users WHERE github_login = 'conv-admin'`).first<number>('id'))!;
		const acct = await saveMailAccount(db, MAIL_ENV, { email: ME, refreshToken: 'r', userId: adminId });
		const box = { id: acct, email: ME };
		// We wrote first (out), Ann answered (in).
		await storeMessages(db, box, [gmsg('g0', '2026-09-01T10:00:00Z', 'out'), gmsg('g1', '2026-09-02T10:00:00Z', 'in')]);
		const [thread] = await conversationsFor(db, ann);
		expect(thread.key).toBe(`c${ann}-gGT9`);
		expect(thread.messages.map((m) => m.dir)).toEqual(['out', 'in']);
		return { ann, acct, box, key: thread.key };
	}

	it('deletes the inbound Gmail row, keeps the outbound one and hides it from thread and list', async () => {
		const { ann, key } = await setup();
		expect(await count('mail_messages')).toBe(2);

		const res = await actions.delete(ev('delete', [['key', key], ['confirm', '1']], 'admin'));
		expect(res).toMatchObject({ affected: 1, skipped: 0 });

		// The mailbox's own send survives; only Ann's message is gone.
		expect(await count('mail_messages')).toBe(1);
		expect(await gmailIds()).toEqual([{ gmail_id: 'g0', direction: 'out' }]);
		expect(await count('mail_threads')).toBe(1); // still holds g0
		expect(await db.prepare('SELECT mailbox, gmail_id, thread_key FROM conversation_hidden_gmail').all()).toMatchObject({
			results: [{ mailbox: ME, gmail_id: 'g0', thread_key: key }]
		});
		expect((await db.prepare('SELECT gmail_id FROM conversation_deleted_gmail').all<{ gmail_id: string }>()).results).toEqual([{ gmail_id: 'g1' }]);

		// Hidden everywhere in Conversations: the list, the contact page, the thread page.
		expect(await keysOf('all')).toEqual([]);
		expect(await conversationsFor(db, ann)).toEqual([]);
		expect(await conversationByKey(db, key)).toBeNull();
		expect(await awaitingReplyCount(db)).toBe(0);
	});

	it('a Gmail re-sync neither re-imports the inbound message nor un-hides the outbound one', async () => {
		const { ann, acct, box, key } = await setup();
		await actions.delete(ev('delete', [['key', key], ['confirm', '1']], 'admin'));

		// Re-storing both (what a history re-sync hands storeMessages): g1 skipped, g0 still hidden.
		await storeMessages(db, box, [gmsg('g0', '2026-09-01T10:00:00Z', 'out'), gmsg('g1', '2026-09-02T10:00:00Z', 'in')]);
		expect(await gmailIds()).toEqual([{ gmail_id: 'g0', direction: 'out' }]);
		expect(await conversationsFor(db, ann)).toEqual([]);

		// Even when the outbound row is stored afresh (new mail_messages id, e.g. after a reconnect).
		await db.prepare("DELETE FROM mail_messages WHERE gmail_id = 'g0'").run();
		await storeMessages(db, box, [gmsg('g0', '2026-09-01T10:00:00Z', 'out')]);
		expect(await count('mail_messages')).toBe(1);
		expect(await conversationsFor(db, ann)).toEqual([]);

		// A full sync: g1 never fetched, g0 known, a new inbound g2 comes in and shows alone.
		const calls: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
			calls.push(url.pathname);
			if (url.host === 'oauth2.googleapis.com') return Response.json({ access_token: 'at-1', expires_in: 3600 });
			const p = url.pathname.replace('/gmail/v1/users/me', '');
			if (p === '/profile') return Response.json({ emailAddress: ME, historyId: '100' });
			if (p === '/messages')
				return Response.json({ messages: ['g0', 'g1', 'g2'].map((gid) => ({ id: gid, threadId: 'GT9' })) });
			if (p === '/messages/g0') return Response.json(gmsg('g0', '2026-09-01T10:00:00Z', 'out'));
			if (p === '/messages/g1') return Response.json(gmsg('g1', '2026-09-02T10:00:00Z', 'in'));
			if (p === '/messages/g2') return Response.json(gmsg('g2', '2026-09-04T10:00:00Z', 'in'));
			return new Response('{}', { status: 404 });
		}) as typeof fetch;
		await syncMailAccount(db, MAIL_ENV, acct, { fetch: fetchImpl });
		expect(calls).not.toContain('/gmail/v1/users/me/messages/g1');
		expect(await gmailIds()).toEqual([
			{ gmail_id: 'g0', direction: 'out' },
			{ gmail_id: 'g2', direction: 'in' }
		]);
		const threads = await conversationsFor(db, ann);
		expect(threads).toHaveLength(1);
		expect(threads[0].messages.map((m) => m.mail_message_id != null && m.dir)).toEqual(['in']);
		expect(await count('conversation_hidden_gmail')).toBe(1);
	});
});

describe('validation + cap (#379)', () => {
	it('parses keys: required, de-duplicated, well-formed, at most 200', () => {
		expect(parseThreadKeys([])).toMatchObject({ ok: false });
		expect(parseThreadKeys(['c1-c2', 'c1-c2', 'estranger-x@y-z.example.net-r5', 'c3-gABC'])).toEqual({
			ok: true,
			keys: ['c1-c2', 'estranger-x@y-z.example.net-r5', 'c3-gABC']
		});
		expect(parseThreadKeys(['nonsense'])).toMatchObject({ ok: false });
		expect(parseThreadKeys(['c1-x2'])).toMatchObject({ ok: false });
		expect(parseThreadKeys(["c1-c2'; DROP TABLE replies"])).toMatchObject({ ok: false });
		const many = Array.from({ length: CONV_BULK_MAX }, (_, i) => `c1-c${i}`);
		expect(parseThreadKeys(many)).toMatchObject({ ok: true });
		expect(parseThreadKeys([...many, 'c1-c999'])).toMatchObject({ ok: false });
	});

	it('the actions refuse over-cap and malformed selections (400), and skip unknown keys', async () => {
		const { annKey } = await seed();
		const many: [string, string][] = Array.from({ length: CONV_BULK_MAX + 1 }, (_, i) => ['key', `c1-c${i}`]);
		expect(await actions.archive(ev('archive', many))).toMatchObject({ status: 400 });
		expect(await actions.archive(ev('archive', [['key', 'bad key']]))).toMatchObject({ status: 400 });
		expect(await actions.archive(ev('archive', []))).toMatchObject({ status: 400 });
		expect(await actions.archive(ev('archive', [['key', annKey], ['key', 'c999999-c1']]))).toMatchObject({ affected: 1, skipped: 1 });
		expect(await count('conversation_state')).toBe(1);
	});
});

describe('rangeSelect (#379)', () => {
	const keys = ['a', 'b', 'c', 'd', 'e'];
	it('plain click toggles one; shift-click fills the range to the new state', () => {
		expect(rangeSelect(keys, [], 1, true, -1, false)).toEqual(['b']);
		expect(rangeSelect(keys, ['b'], 3, true, 1, true)).toEqual(['b', 'c', 'd']);
		expect(rangeSelect(keys, ['a', 'b', 'c', 'd'], 1, false, 3, true)).toEqual(['a']);
		expect(rangeSelect(keys, ['b'], 4, true, 1, false)).toEqual(['b', 'e']);
	});
});
