import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	normalizeSubject,
	stripReplyPrefixes,
	inReplyToFromHeaders,
	messageIdKey,
	threadMessages,
	conversationsFor,
	recentConversations,
	awaitingReplyCount,
	matchesFilter,
	parseConvFilter,
	type ConvMessage
} from '../src/lib/server/conversations';
import { GET as repliesRedirect } from '../src/routes/replies/+server';
import { POST as inbound } from '../src/routes/api/inbound/+server';

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

function out(at: string, subject: string, o: Partial<ConvMessage> = {}): ConvMessage {
	return {
		dir: 'out', at, subject, campaign_id: 1, recipient_id: 1, message_id: null, send_kind: 'campaign',
		status: 'accepted', error: null, signals: null, reply_id: null, text: null, in_reply_to: null,
		campaign_subject: null, ...o
	};
}
function inn(at: string, subject: string, o: Partial<ConvMessage> = {}): ConvMessage {
	return {
		dir: 'in', at, subject, campaign_id: null, recipient_id: null, message_id: null, send_kind: null,
		status: null, error: null, signals: null, reply_id: 1, text: 'hi', in_reply_to: null,
		campaign_subject: null, ...o
	};
}
const party = { contact_id: 7, email: 'ann@x.example.net', name: 'Ann' };

describe('subject normalisation (#157)', () => {
	it('strips stacked Re:/Fwd:/Fw: prefixes, case- and space-insensitive', () => {
		expect(stripReplyPrefixes('Re: Fwd: RE[2]: Hello there')).toBe('Hello there');
		expect(normalizeSubject('  re:  FW:Hello   There ')).toBe('hello there');
		expect(normalizeSubject('Fwd: hello there')).toBe(normalizeSubject('Hello There'));
		// Not a prefix: "Re" inside a word, or later in the subject.
		expect(normalizeSubject('Regarding: x')).toBe('regarding: x');
		expect(normalizeSubject('Hello re: x')).toBe('hello re: x');
		expect(normalizeSubject(null)).toBe('');
	});

	it('reads In-Reply-To from the Headers array and keys message ids', () => {
		expect(
			inReplyToFromHeaders([
				{ Name: 'X-Other', Value: '1' },
				{ Name: 'In-Reply-To', Value: ' <ABC-123@mtasv.net> ' }
			])
		).toBe('ABC-123@mtasv.net');
		expect(inReplyToFromHeaders([{ Name: 'in-reply-to', Value: 'bare-id' }])).toBe('bare-id');
		expect(inReplyToFromHeaders(undefined)).toBeNull();
		expect(inReplyToFromHeaders([{ Name: 'In-Reply-To', Value: '' }])).toBeNull();
		expect(messageIdKey('<ABC-123@mtasv.net>')).toBe('abc-123');
		expect(messageIdKey('abc-123')).toBe('abc-123');
	});
});

describe('threadMessages (#157)', () => {
	it('links a reply to its campaign even with an unrelated subject', () => {
		const t = threadMessages(
			[
				out('2026-01-01 10:00:00', 'Newsletter', { campaign_id: 5, recipient_id: 50 }),
				inn('2026-01-02 10:00:00', 'totally different', { campaign_id: 5, reply_id: 9 })
			],
			party
		);
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ subject: 'Newsletter', count: 2, sent: 1, replies: 1, awaiting: true, last_dir: 'in' });
	});

	it('exact In-Reply-To beats subject and campaign', () => {
		const t = threadMessages(
			[
				out('2026-01-01 10:00:00', 'A', { campaign_id: 1, recipient_id: 10, message_id: 'aaa' }),
				out('2026-01-01 11:00:00', 'B', { campaign_id: 2, recipient_id: 20, message_id: 'bbb' }),
				inn('2026-01-02 10:00:00', 'Re: B', { in_reply_to: '<AAA@mtasv.net>' })
			],
			party
		);
		const a = t.find((x) => x.subject === 'A')!;
		const b = t.find((x) => x.subject === 'B')!;
		expect(a.replies).toBe(1);
		expect(b.replies).toBe(0);
	});

	it('subject-threads direct sends and unlinked replies within 30 days', () => {
		const t = threadMessages(
			[
				out('2026-01-01 10:00:00', 'Quick question', { campaign_id: 1, recipient_id: 1, send_kind: 'direct' }),
				inn('2026-01-03 10:00:00', 'RE: quick  question', { reply_id: 1 }),
				out('2026-01-04 10:00:00', 'Re: Quick question', { campaign_id: 2, recipient_id: 2, send_kind: 'direct' })
			],
			party
		);
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ root_kind: 'direct', count: 3, awaiting: false, last_dir: 'out' });
	});

	it('starts a new thread when the same subject is more than 30 days after the last message', () => {
		const t = threadMessages(
			[
				out('2026-01-01 10:00:00', 'Check-in', { campaign_id: 1, recipient_id: 1, send_kind: 'direct' }),
				out('2026-01-30 10:00:00', 'Check-in', { campaign_id: 2, recipient_id: 2, send_kind: 'direct' }), // 29d → joins
				out('2026-03-15 10:00:00', 'Fwd: Check-in', { campaign_id: 3, recipient_id: 3, send_kind: 'direct' }), // 44d → new
				inn('2026-05-01 10:00:00', 'Re: Check-in', { reply_id: 4 }) // 47d → new, inbound-rooted
			],
			party
		);
		expect(t).toHaveLength(3);
		expect(t.map((x) => x.count)).toEqual([1, 1, 2]); // newest activity first
		expect(t[0]).toMatchObject({ root_kind: 'reply', awaiting: true });
	});

	it('does not subject-thread broadcasts into each other', () => {
		const t = threadMessages(
			[
				out('2026-01-01 10:00:00', 'Weekly', { campaign_id: 1, recipient_id: 1 }),
				out('2026-01-08 10:00:00', 'Weekly', { campaign_id: 2, recipient_id: 2 })
			],
			party
		);
		expect(t).toHaveLength(2);
		expect(t.every((x) => !x.awaiting)).toBe(true);
	});

	it('filters: awaiting = last message inbound; replied; sent only', () => {
		const [awaiting] = threadMessages([out('2026-01-01 00:00:00', 'x'), inn('2026-01-02 00:00:00', 'Re: x', { campaign_id: 1 })], party);
		const [answered] = threadMessages(
			[out('2026-01-01 00:00:00', 'x', { send_kind: 'direct' }), inn('2026-01-02 00:00:00', 'Re: x'), out('2026-01-03 00:00:00', 'Re: x', { campaign_id: 2, recipient_id: 2, send_kind: 'direct' })],
			party
		);
		const [sentOnly] = threadMessages([out('2026-01-01 00:00:00', 'x')], party);
		expect([awaiting, answered, sentOnly].map((t) => matchesFilter(t, 'awaiting'))).toEqual([true, false, false]);
		expect([awaiting, answered, sentOnly].map((t) => matchesFilter(t, 'replied'))).toEqual([true, true, false]);
		expect([awaiting, answered, sentOnly].map((t) => matchesFilter(t, 'sent'))).toEqual([false, false, true]);
		expect(parseConvFilter('awaiting')).toBe('awaiting');
		expect(parseConvFilter('bogus')).toBe('all');
	});
});

describe('conversation loading from D1 (#157)', () => {
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
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'bob@x.example.net', 'm-bob', 'accepted')").bind(bc, bob).run();
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'bob@x.example.net', 'm-bob2', 'accepted')").bind(direct, bob).run();
		await db.prepare("INSERT INTO events (campaign_id, recipient_id, contact_id, type) VALUES (?, ?, ?, 'open'), (?, ?, ?, 'open')").bind(bc, rAnn, ann, bc, rAnn, ann).run();
		await db
			.prepare("INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at) VALUES (?, ?, 'ann@x.example.net', 'Re: Broadcast', 'Loved it', '2026-01-02 09:00:00')")
			.bind(ann, bc)
			.run();
		// An unknown sender, no contact.
		await db.prepare("INSERT INTO replies (from_email, subject, received_at) VALUES ('stranger@y.example.net', 'Hi', '2026-01-03 09:00:00')").run();
		return { ann, bob, bc, direct };
	}

	it('conversationsFor threads a contact\'s sends + replies, with per-send badges', async () => {
		const { ann, bob } = await seed();
		const a = await conversationsFor(db, ann);
		expect(a).toHaveLength(1);
		expect(a[0]).toMatchObject({ subject: 'Broadcast', count: 2, awaiting: true, root_kind: 'campaign' });
		expect(a[0].messages[0].signals).toMatchObject({ opens: 2, clicks: 0 });
		const b = await conversationsFor(db, bob);
		expect(b.map((t) => [t.subject, t.root_kind])).toEqual([
			['Hello Bob', 'direct'],
			['Broadcast', 'campaign']
		]);
	});

	it('recentConversations lists replied + direct threads only, with chips, search and paging', async () => {
		await seed();
		const all = await recentConversations(db, {});
		// Bob's unreplied broadcast is bulk mail, not a conversation.
		expect(all.rows.map((t) => t.subject)).toEqual(['Hello Bob', 'Hi', 'Broadcast']);
		expect(all.counts).toEqual({ all: 3, awaiting: 2, replied: 2, sent: 1, gmail: 0, archived: 0 });
		expect((await recentConversations(db, { filter: 'sent' })).rows.map((t) => t.email)).toEqual(['bob@x.example.net']);
		expect((await recentConversations(db, { q: 'ANN' })).rows.map((t) => t.subject)).toEqual(['Broadcast']);
		expect((await recentConversations(db, { q: 'hello' })).total).toBe(1);
		const p2 = await recentConversations(db, { limit: 2, offset: 2 });
		expect(p2.rows).toHaveLength(1);
		expect(p2.total).toBe(3);
		expect(await awaitingReplyCount(db)).toBe(2);
	});
});

describe('inbound In-Reply-To capture (#157)', () => {
	function ev(body: unknown) {
		return {
			url: new URL('https://app.test/api/inbound?key=k'),
			request: new Request('https://app.test/api/inbound', { method: 'POST', body: JSON.stringify(body) }),
			platform: { env: { DB: db, INBOUND_KEY: 'k', POSTMARK_FROM: 'me@x.example.net' } }
		} as any;
	}

	it('stores the header and uses it to link the campaign when MailboxHash is absent', async () => {
		const ann = await id("INSERT INTO contacts (email) VALUES ('ann@x.example.net') RETURNING id");
		const camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status) VALUES ('S', 'm', 'h', 'f', 'sent') RETURNING id"
		);
		await db.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'abc-1', 'accepted')").bind(camp, ann).run();
		const res = await inbound(
			ev({
				FromFull: { Email: 'Ann@x.example.net' },
				Subject: 'Re: S',
				TextBody: 'hello',
				Headers: [{ Name: 'In-Reply-To', Value: '<abc-1@mtasv.net>' }]
			})
		);
		expect(res.status).toBe(200);
		const row = await db
			.prepare('SELECT contact_id, campaign_id, in_reply_to_message_id FROM replies')
			.first<{ contact_id: number; campaign_id: number; in_reply_to_message_id: string }>();
		expect(row).toEqual({ contact_id: ann, campaign_id: camp, in_reply_to_message_id: 'abc-1@mtasv.net' });
	});
});

describe('GET /replies (#157)', () => {
	it('301s to /conversations, keeping the query', async () => {
		const res = await repliesRedirect({ url: new URL('https://app.test/replies?x=1') } as any);
		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe('/conversations?x=1');
	});
});
