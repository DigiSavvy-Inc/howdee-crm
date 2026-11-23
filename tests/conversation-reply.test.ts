import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { conversationsFor, replyThreadingIds, threadMessages, type ConvMessage, type Conversation } from '../src/lib/server/conversations';
import { replyHeaders, replySubject, bareAddress } from '../src/lib/server/conversation-reply';
import { actions } from '../src/routes/conversations/+page.server';
import { POST as inbound } from '../src/routes/api/inbound/+server';

const db = (env as any).DB as D1Database;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

function out(at: string, subject: string, o: Partial<ConvMessage> = {}): ConvMessage {
	return {
		dir: 'out', at, subject, campaign_id: 1, recipient_id: 1, message_id: null, send_kind: 'direct',
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

describe('reply threading headers (#159)', () => {
	it('In-Reply-To = newest known id; References = thread ids oldest first; failed sends skipped', () => {
		const [conv] = threadMessages(
			[
				out('2026-01-01 10:00:00', 'Hello', { campaign_id: 1, recipient_id: 1, message_id: 'pm-1' }),
				inn('2026-01-02 10:00:00', 'Re: Hello', { reply_id: 1, in_reply_to: 'pm-1@mtasv.net', message_id: 'CA1@mail.gmail.com' }),
				out('2026-01-03 10:00:00', 'Re: Hello', { campaign_id: 2, recipient_id: 2, message_id: 'pm-x', status: 'error' }),
				inn('2026-01-04 10:00:00', 'Re: Hello', { reply_id: 2, message_id: null })
			],
			party
		);
		expect(conv.count).toBe(4);
		expect(replyThreadingIds(conv)).toEqual({
			inReplyTo: 'CA1@mail.gmail.com',
			references: ['pm-1@mtasv.net', 'CA1@mail.gmail.com']
		});
		expect(replyHeaders(conv)).toEqual([
			{ Name: 'In-Reply-To', Value: '<CA1@mail.gmail.com>' },
			{ Name: 'References', Value: '<pm-1@mtasv.net> <CA1@mail.gmail.com>' }
		]);
		expect(replySubject(conv)).toBe('Re: Hello');
	});

	it('no known ids → no threading headers', () => {
		const [conv] = threadMessages([inn('2026-01-01 10:00:00', 'Hi')], party);
		expect(replyHeaders(conv)).toEqual([]);
	});

	it('a Reply-box send joins the thread it answers, even past the subject window', () => {
		const threads = threadMessages(
			[
				inn('2026-01-01 10:00:00', 'Question', { reply_id: 1, message_id: 'CA1@mail.gmail.com' }),
				out('2026-03-01 10:00:00', 'Something else', { campaign_id: 5, in_reply_to: 'CA1@mail.gmail.com' })
			],
			party
		);
		expect(threads).toHaveLength(1);
		expect(threads[0].count).toBe(2);
		expect(threads[0].awaiting).toBe(false);
	});

	it('bareAddress strips a display name', () => {
		expect(bareAddress('Alan V <Alan@Ourco.example>')).toBe('alan@ourco.example');
		expect(bareAddress('alan@ourco.example')).toBe('alan@ourco.example');
	});
});

describe('POST /conversations?/reply (#159)', () => {
	let sent: any[][] = [];
	const original = globalThis.fetch;
	let ann: number;
	let thread: Conversation;

	beforeEach(async () => {
		await db.batch([
			db.prepare('DELETE FROM events'),
			db.prepare('DELETE FROM recipients'),
			db.prepare('DELETE FROM replies'),
			db.prepare('DELETE FROM campaigns'),
			db.prepare('DELETE FROM contacts'),
			db.prepare("DELETE FROM app_state WHERE key IN ('reply_bcc_operator', 'default_from', 'approved_senders')")
		]);
		sent = [];
		let n = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith('/email/batch')) {
				const batch = JSON.parse(String(init?.body));
				sent.push(batch);
				return new Response(
					JSON.stringify(batch.map(() => ({ ErrorCode: 0, Message: 'OK', MessageID: `new-${++n}` }))),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		}) as typeof fetch;

		ann = await id("INSERT INTO contacts (email, first_name) VALUES ('ann@x.example.net', 'Ann') RETURNING id");
		const camp = await id(
			"INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at) VALUES ('Hello', 'm', 'h', 'me@x.example.net', 'sent', '2026-01-01 10:00:00') RETURNING id"
		);
		await db
			.prepare("INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@x.example.net', 'pm-1', 'accepted')")
			.bind(camp, ann)
			.run();
		await db
			.prepare(
				`INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at, in_reply_to_message_id, message_id_header)
				 VALUES (?, ?, 'ann@x.example.net', 'Re: Hello', 'thanks!', '2026-01-02 10:00:00', 'pm-1@mtasv.net', 'CA1@mail.gmail.com')`
			)
			.bind(ann, camp)
			.run();
		[thread] = await conversationsFor(db, ann);
	});

	afterEach(() => {
		globalThis.fetch = original;
	});

	function ev(fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		return {
			url: new URL('https://app.test/conversations?/reply'),
			request: new Request('https://app.test/conversations?/reply', { method: 'POST', body: fd }),
			locals: { user: { id: 1, role: 'member' } },
			platform: {
				env: {
					DB: db,
					POSTMARK_TOKEN: 't',
					POSTMARK_FROM: 'me@x.example.net',
					POSTMARK_STREAM_TX: 'outbound',
					SESSION_SECRET: 's',
					PUBLIC_BASE_URL: 'https://app.test'
				}
			}
		} as any;
	}

	const reply = (body = 'Sounds **good**.') =>
		(actions.reply as any)(ev({ conv_key: thread.key, contact_id: String(ann), email: 'ann@x.example.net', body }));

	it('sends on the transactional stream with In-Reply-To/References, no BCC by default', async () => {
		expect(thread.awaiting).toBe(true);
		const res = await reply();
		expect(res).toMatchObject({ replySent: true, replyKey: thread.key });
		expect(sent).toHaveLength(1);
		const [msg] = sent[0];
		expect(msg.To).toBe('ann@x.example.net');
		expect(msg.From).toBe('me@x.example.net');
		expect(msg.MessageStream).toBe('outbound');
		expect(msg.Subject).toBe('Re: Hello');
		expect(msg.Bcc).toBeUndefined();
		expect(msg.Headers).toEqual([
			{ Name: 'In-Reply-To', Value: '<CA1@mail.gmail.com>' },
			{ Name: 'References', Value: '<pm-1@mtasv.net> <CA1@mail.gmail.com>' }
		]);
		expect(msg.HtmlBody).toContain('<strong>good</strong>');
		expect(msg.HtmlBody).not.toContain('%%UNSUB_URL%%');
	});

	it('logs a direct send that shows in the same conversation immediately', async () => {
		await reply();
		const camp = await db
			.prepare("SELECT list_id, status, in_reply_to_message_id FROM campaigns WHERE subject = 'Re: Hello'")
			.first<{ list_id: number | null; status: string; in_reply_to_message_id: string }>();
		expect(camp).toEqual({ list_id: null, status: 'sent', in_reply_to_message_id: 'CA1@mail.gmail.com' });

		const convs = await conversationsFor(db, ann);
		expect(convs).toHaveLength(1);
		expect(convs[0].key).toBe(thread.key);
		expect(convs[0].count).toBe(3);
		expect(convs[0].last_dir).toBe('out');
		expect(convs[0].awaiting).toBe(false);
		expect(convs[0].messages.at(-1)!.message_id).toBe('new-1');
	});

	it('their answer to our reply keeps threading (In-Reply-To = our new MessageID)', async () => {
		await reply();
		const res = await inbound({
			url: new URL('https://app.test/api/inbound?key=k'),
			request: new Request('https://app.test/api/inbound', {
				method: 'POST',
				body: JSON.stringify({
					FromFull: { Email: 'ann@x.example.net' },
					Subject: 'Totally different',
					TextBody: 'great',
					Headers: [
						{ Name: 'Message-ID', Value: '<CA2@mail.gmail.com>' },
						{ Name: 'In-Reply-To', Value: '<new-1@mtasv.net>' }
					]
				})
			}),
			platform: { env: { DB: db, INBOUND_KEY: 'k', POSTMARK_FROM: 'me@x.example.net' } }
		} as any);
		expect(res.status).toBe(200);
		const row = await db
			.prepare("SELECT message_id_header FROM replies WHERE text = 'great'")
			.first<{ message_id_header: string }>();
		expect(row?.message_id_header).toBe('CA2@mail.gmail.com');

		const convs = await conversationsFor(db, ann);
		expect(convs).toHaveLength(1);
		expect(convs[0].count).toBe(4);
		expect(convs[0].awaiting).toBe(true);
		expect(replyThreadingIds(convs[0]).inReplyTo).toBe('CA2@mail.gmail.com');
	});

	it('BCCs the operator (the From address) when the Settings toggle is on', async () => {
		await db
			.prepare("INSERT INTO app_state (key, value) VALUES ('reply_bcc_operator', '1'), ('default_from', 'Alan@Ourco.example')")
			.run();
		await reply();
		expect(sent[0][0].From).toBe('Alan@Ourco.example');
		expect(sent[0][0].Bcc).toBe('alan@ourco.example');
	});

	it('rejects an empty body, an unknown thread, and an unapproved From — nothing sent', async () => {
		const empty = await reply('   ');
		expect(empty.status).toBe(400);
		const unknown = await (actions.reply as any)(ev({ conv_key: 'c999-nope', contact_id: String(ann), email: '', body: 'x' }));
		expect(unknown.status).toBe(404);
		await db.prepare("INSERT INTO app_state (key, value) VALUES ('approved_senders', 'other.example.net')").run();
		const blocked = await reply();
		expect(blocked.status).toBe(400);
		expect(blocked.data.replyError).toMatch(/approved/);
		expect(sent).toHaveLength(0);
	});

	it('a failed Postmark send is recorded as failed and reported', async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify([{ ErrorCode: 406, Message: 'Inactive recipient' }]), { status: 200 })) as typeof fetch;
		const res = await reply();
		expect(res.status).toBe(400);
		expect(res.data.replyError).toBe('Inactive recipient');
		const camp = await db
			.prepare("SELECT status FROM campaigns WHERE subject = 'Re: Hello'")
			.first<{ status: string }>();
		expect(camp?.status).toBe('failed');
	});
});
