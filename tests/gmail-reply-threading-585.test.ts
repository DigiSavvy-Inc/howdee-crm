// #585: replies sent from our own mail client (synced Gmail) join the thread they answer and
// clear "Awaiting our reply" everywhere — References, the reply forward's id, BCC copies, the
// outbound subject rule, send-as aliases, the Conversations switch, hidden messages, and
// internal senders on Postmark inbound.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	awaitingContactIds,
	awaitingReplyCount,
	conversationsFor,
	hasReplyPrefix,
	recentConversations,
	threadMessages,
	type ConvMessage
} from '../src/lib/server/conversations';
import {
	backfillReferences,
	correctMailDirections,
	loadInternalSet,
	mailDirection,
	parseMail,
	saveMailAccount,
	setGmailInConversations,
	storeMessages
} from '../src/lib/server/mail-sync';
import { METADATA_HEADERS, type GmailMessage } from '../src/lib/server/gmail';
import { parseReferences } from '../src/lib/message-id';
import { messageAuthor, messageVerb } from '../src/lib/conversation-view';
import { companyConversations } from '../src/lib/server/company-conversations';

const db = (env as any).DB as D1Database;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const MAIL_ENV = { MAIL_TOKEN_KEY: newKey(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' };
const ME = 'owner@ourco.example';

// ── Pure threading ───────────────────────────────────────────────────────────────────

function out(at: string, subject: string, o: Partial<ConvMessage> = {}): ConvMessage {
	return {
		dir: 'out', at, subject, campaign_id: 1, recipient_id: 1, message_id: null, send_kind: 'campaign',
		status: 'accepted', error: null, signals: null, reply_id: null, text: null, in_reply_to: null,
		campaign_subject: null, ...o
	};
}
function reply(at: string, subject: string, o: Partial<ConvMessage> = {}): ConvMessage {
	return {
		dir: 'in', at, subject, campaign_id: 1, recipient_id: null, message_id: null, send_kind: null,
		status: null, error: null, signals: null, reply_id: 1, text: 'their reply', in_reply_to: null,
		campaign_subject: 'Launch', ...o
	};
}
function gmail(at: string, dir: 'in' | 'out', gt: string, o: Partial<ConvMessage> = {}): ConvMessage {
	return {
		dir, at, subject: 'Re: Launch', campaign_id: null, recipient_id: null, message_id: null, send_kind: null,
		status: null, error: null, signals: null, reply_id: null, text: null, in_reply_to: null,
		campaign_subject: null, source: 'gmail', mail_message_id: Math.floor(Math.random() * 1e6),
		gmail_thread_id: gt, from: null, snippet: 'gmail text', references: [], ...o
	};
}
const party = { contact_id: 7, email: 'ann@client.example', name: 'Ann' };

describe('threadMessages: our Gmail answers (#585)', () => {
	const campaign = out('2026-10-01 09:00:00', 'Launch', { message_id: 'pm-camp' });
	const theirReply = reply('2026-10-02 09:00:00', 'Re: Launch', {
		message_id: 'their-1@mail.client.example',
		in_reply_to: 'pm-camp@mtasv.net',
		forward_id: 'fwd-1'
	});

	it('a reply to the forward with References naming their reply joins the thread and clears awaiting', () => {
		const answer = gmail('2026-10-02 10:00:00', 'out', 'gt-fwd', {
			in_reply_to: 'fwd-1@mtasv.net',
			references: ['their-1@mail.client.example', 'fwd-1@mtasv.net'],
			message_id: 'ours-1@mail.gmail.com'
		});
		const t = threadMessages([campaign, theirReply, answer], party);
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ root_kind: 'campaign', count: 3, awaiting: false, last_dir: 'out', gmail_thread_id: 'gt-fwd' });
	});

	it('a reply to the forward without References finds it by the forward id', () => {
		const answer = gmail('2026-10-02 10:00:00', 'out', 'gt-fwd', { in_reply_to: 'fwd-1@mtasv.net', subject: 'Re: Launch' });
		const t = threadMessages([campaign, theirReply, answer], party);
		expect(t).toHaveLength(1);
		expect(t[0].awaiting).toBe(false);
	});

	it('the rest of that Gmail conversation follows into the same thread, both directions', () => {
		const answer = gmail('2026-10-02 10:00:00', 'out', 'gt-fwd', { in_reply_to: 'fwd-1@mtasv.net' });
		const followUp = gmail('2026-10-03 10:00:00', 'in', 'gt-fwd', { subject: 'Re: Launch' });
		const t = threadMessages([campaign, theirReply, answer, followUp], party);
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ count: 4, awaiting: true, preview: 'gmail text' });
	});

	it('References are tried newest first, after In-Reply-To', () => {
		const other = out('2026-09-01 09:00:00', 'Older', { campaign_id: 2, recipient_id: 2, message_id: 'pm-old' });
		const answer = gmail('2026-10-02 10:00:00', 'out', 'gt-x', {
			subject: 'Something else',
			references: ['pm-old@mtasv.net', 'their-1@mail.client.example']
		});
		const t = threadMessages([other, campaign, theirReply, answer], party);
		const host = t.find((x) => x.messages.some((m) => m.source === 'gmail'))!;
		expect(host.root_campaign_id).toBe(1);
	});

	it('a reply to a BCC copy, then a follow-up, joins the app thread (copy dropped, its Gmail thread followed)', () => {
		const direct = out('2026-10-05 09:00:00', 'Proposal', { campaign_id: 3, recipient_id: 3, send_kind: 'direct', message_id: 'pm-dir' });
		// The BCC copy sorts first (same second) — its Gmail thread is still registered.
		const copy = gmail('2026-10-05 08:59:59', 'out', 'gt-bcc', { subject: 'Proposal', message_id: 'pm-dir@mtasv.net' });
		const theirs = gmail('2026-10-06 09:00:00', 'in', 'gt-bcc', { subject: 'Re: Proposal' });
		const ours = gmail('2026-10-06 10:00:00', 'out', 'gt-bcc', { subject: 'Re: Proposal' });
		const t = threadMessages([direct, copy, theirs, ours], party);
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ root_kind: 'direct', count: 3, awaiting: false, gmail_thread_id: 'gt-bcc' });
	});

	it('the outbound subject rule: a Re: subject within 30 days joins, outside it does not', () => {
		const t1 = threadMessages(
			[campaign, theirReply, gmail('2026-10-20 10:00:00', 'out', 'gt-new', { subject: 'RE: launch' })],
			party
		);
		expect(t1).toHaveLength(1);
		expect(t1[0].awaiting).toBe(false);

		const late = threadMessages([campaign, theirReply, gmail('2026-11-05 10:00:00', 'out', 'gt-new', { subject: 'Re: Launch' })], party);
		expect(late).toHaveLength(2);
		expect(late.find((x) => x.root_kind === 'campaign')!.awaiting).toBe(true);
	});

	it('the subject rule needs a reply prefix and is outbound only', () => {
		const noPrefix = threadMessages([campaign, theirReply, gmail('2026-10-03 10:00:00', 'out', 'gt-n', { subject: 'Launch' })], party);
		expect(noPrefix).toHaveLength(2);
		const inbound = threadMessages([campaign, theirReply, gmail('2026-10-03 10:00:00', 'in', 'gt-n', { subject: 'Re: Launch' })], party);
		expect(inbound).toHaveLength(2);
		expect(hasReplyPrefix('Re: x')).toBe(true);
		expect(hasReplyPrefix('RE[2]: x')).toBe(true);
		expect(hasReplyPrefix('Fwd: x')).toBe(false);
		expect(hasReplyPrefix('Regarding x')).toBe(false);
	});

	it('parses References headers, de-duplicated, oldest first', () => {
		expect(parseReferences('<a@x> <B@y>\n <a@x>')).toEqual(['a@x', 'B@y']);
		expect(parseReferences('')).toEqual([]);
		expect(parseReferences(null)).toEqual([]);
		expect(METADATA_HEADERS).toContain('References');
	});

	it('names the teammate and says "replied from Gmail"', () => {
		const conv = { name: 'Ann', email: 'ann@client.example' };
		expect(messageAuthor({ dir: 'out', source: 'gmail', teammate: 'Pat Lee' }, conv)).toBe('Pat Lee');
		expect(messageAuthor({ dir: 'out', source: 'gmail', teammate: null }, conv)).toBe('You');
		expect(messageVerb({ dir: 'out', source: 'gmail' })).toBe('replied from Gmail');
		expect(messageVerb({ dir: 'out' })).toBe('sent');
		expect(messageVerb({ dir: 'in', source: 'gmail' })).toBe('replied');
	});
});

// ── Direction ────────────────────────────────────────────────────────────────────────

function gmsg(o: { id: string; from: string; to: string; labels?: string[]; refs?: string; thread?: string; subject?: string }): GmailMessage {
	return {
		id: o.id,
		threadId: o.thread ?? `t-${o.id}`,
		labelIds: o.labels ?? ['INBOX'],
		snippet: `snippet ${o.id}`,
		internalDate: String(Date.parse('2026-10-10T10:00:00Z')),
		payload: {
			headers: [
				{ name: 'From', value: o.from },
				{ name: 'To', value: o.to },
				{ name: 'Subject', value: o.subject ?? 'Re: Launch' },
				{ name: 'Message-ID', value: `<${o.id}@mail.gmail.com>` },
				...(o.refs ? [{ name: 'References', value: o.refs }] : [])
			]
		}
	};
}

let ann = 0;
let acct = 0;
let userId = 0;

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'mail_%'`),
		db.prepare('DELETE FROM conversation_hidden_gmail'),
		db.prepare('DELETE FROM conversation_state'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare(`DELETE FROM lists WHERE name = 'Customers 585'`),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`DELETE FROM users WHERE github_login = 'pat-585'`)
	]);
	userId = (await db
		.prepare(`INSERT INTO users (github_login, name, role, email) VALUES ('pat-585', 'Pat Lee', 'member', 'pat@ourco.example') RETURNING id`)
		.first<number>('id'))!;
	ann = (await db.prepare(`INSERT INTO contacts (email, name) VALUES ('ann@client.example', 'Ann') RETURNING id`).first<number>('id'))!;
	acct = await saveMailAccount(db, MAIL_ENV, { email: ME, refreshToken: 'r', userId });
});

describe('direction is decided by the mailbox (#585)', () => {
	it('SENT label, the mailbox, and any internal address (a send-as alias) are ours', async () => {
		const internal = await loadInternalSet(db, ME);
		const p = (o: Parameters<typeof gmsg>[0]) => parseMail(gmsg(o));
		expect(mailDirection(p({ id: 'a', from: 'Ann <ann@client.example>', to: ME }), ME, internal)).toBe('in');
		expect(mailDirection(p({ id: 'b', from: ME, to: 'ann@client.example' }), ME, internal)).toBe('out');
		expect(mailDirection(p({ id: 'c', from: 'Sales <sales@ourco.example>', to: 'ann@client.example' }), ME, internal)).toBe('out');
		expect(mailDirection(p({ id: 'd', from: 'alias@elsewhere.example', to: 'ann@client.example', labels: ['SENT'] }), ME, internal)).toBe('out');
	});

	it('stores an alias sender as outbound, with its References', async () => {
		await storeMessages(db, { id: acct, email: ME }, [
			gmsg({ id: 'al1', from: 'Sales <sales@ourco.example>', to: 'ann@client.example', refs: '<x@y> <z@w>' })
		]);
		const row = await db
			.prepare('SELECT direction, references_header FROM mail_messages WHERE gmail_id = ?')
			.bind('al1')
			.first<{ direction: string; references_header: string }>();
		expect(row).toEqual({ direction: 'out', references_header: '<x@y> <z@w>' });
	});

	it('corrects stored rows whose From is internal', async () => {
		await insertMail({ gid: 'old1', dir: 'in', from: 'sales@ourco.example', gt: 'g-old' });
		expect(await correctMailDirections(db)).toBe(1);
		expect(await db.prepare(`SELECT direction FROM mail_messages WHERE gmail_id = 'old1'`).first('direction')).toBe('out');
		expect(await correctMailDirections(db)).toBe(0);
	});
});

// ── Stored rows ──────────────────────────────────────────────────────────────────────

async function insertMail(o: {
	gid: string;
	dir: 'in' | 'out';
	from: string;
	gt: string;
	at?: string;
	subject?: string;
	inReplyTo?: string | null;
	refs?: string | null;
	contact?: number;
}): Promise<number> {
	const threadId = await db
		.prepare(
			`INSERT INTO mail_threads (account_id, gmail_thread_id) VALUES (?, ?)
			 ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET subject = subject RETURNING id`
		)
		.bind(acct, o.gt)
		.first<number>('id');
	const id = (await db
		.prepare(
			`INSERT INTO mail_messages (account_id, thread_id, gmail_id, gmail_thread_id, message_id_header, in_reply_to,
			   direction, from_email, participants, subject, snippet, sent_at, references_header)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			acct,
			threadId,
			o.gid,
			o.gt,
			`${o.gid}@mail.gmail.com`,
			o.inReplyTo ?? null,
			o.dir,
			o.from,
			o.subject ?? 'Re: Launch',
			`snippet ${o.gid}`,
			o.at ?? '2026-10-02 10:00:00',
			o.refs === undefined ? '' : o.refs
		)
		.first<number>('id'))!;
	await db.prepare('INSERT INTO mail_message_contacts (message_id, contact_id) VALUES (?, ?)').bind(id, o.contact ?? ann).run();
	return id;
}

/** A broadcast to Ann, her captured reply (forwarded as fwd-1), our Gmail answer to the forward. */
async function seedForwardAnswer() {
	const list = (await db.prepare(`INSERT INTO lists (name, kind) VALUES ('Customers 585', 'list') RETURNING id`).first<number>('id'))!;
	const camp = (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at, list_id)
			 VALUES ('Launch', 'm', 'h', 'f', 'sent', '2026-10-01 09:00:00', ?) RETURNING id`
		)
		.bind(list)
		.first<number>('id'))!;
	await db
		.prepare(`INSERT INTO recipients (campaign_id, contact_id, email, message_id, status) VALUES (?, ?, 'ann@client.example', 'pm-camp', 'accepted')`)
		.bind(camp, ann)
		.run();
	await db
		.prepare(
			`INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, received_at, in_reply_to_message_id, message_id_header, forward_message_id)
			 VALUES (?, ?, 'ann@client.example', 'Re: Launch', 'Sounds good', '2026-10-02 09:00:00', 'pm-camp@mtasv.net', 'their-1@mail.client.example', 'fwd-1')`
		)
		.bind(ann, camp)
		.run();
	const answer = await insertMail({ gid: 'ans1', dir: 'out', from: 'pat@ourco.example', gt: 'gt-fwd', inReplyTo: 'fwd-1@mtasv.net' });
	return { camp, answer };
}

describe('"awaiting" with the Conversations switch off (#585)', () => {
	it('our Gmail answer clears awaiting on the thread page, the tab, the tile, the contacts filter and the company panel', async () => {
		await setGmailInConversations(db, false);
		await seedForwardAnswer();
		// A Gmail-only thread of the same contact stays out of the tab while the switch is off.
		await insertMail({ gid: 'solo', dir: 'in', from: 'ann@client.example', gt: 'gt-solo', subject: 'Unrelated', at: '2026-10-03 10:00:00' });

		const page = await conversationsFor(db, ann);
		const thread = page.find((t) => t.root_kind === 'campaign')!;
		expect(thread).toMatchObject({ count: 3, awaiting: false, last_dir: 'out' });
		const ours = thread.messages.at(-1)!;
		expect(ours).toMatchObject({ source: 'gmail', dir: 'out', teammate: 'Pat Lee' });

		const tab = await recentConversations(db, { filter: 'all' });
		expect(tab.rows.map((t) => t.key)).toEqual([thread.key]);
		expect(tab.rows[0]).toMatchObject({ awaiting: false, count: 3, preview: 'snippet ans1' });
		expect(tab.counts.awaiting).toBe(0);
		expect(await awaitingReplyCount(db)).toBe(0);
		expect(await awaitingContactIds(db)).toEqual([]);

		const company = (await db.prepare(`INSERT INTO companies (name) VALUES ('Client 585') RETURNING id`).first<number>('id'))!;
		await db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').bind(company, ann).run();
		const panel = await companyConversations(db, company, { now: new Date('2026-10-10T00:00:00Z') });
		expect(panel.find((t) => t.key === thread.key)!.awaiting).toBe(false);
		await db.prepare('UPDATE contacts SET company_id = NULL WHERE id = ?').bind(ann).run();
		await db.prepare('DELETE FROM companies WHERE id = ?').bind(company).run();
	});

	it('without the answer the thread awaits our reply', async () => {
		const { answer } = await seedForwardAnswer();
		await db.prepare('DELETE FROM mail_messages WHERE id = ?').bind(answer).run();
		expect(await awaitingReplyCount(db)).toBe(1);
		expect(await awaitingContactIds(db)).toEqual([ann]);
	});

	it('a hidden Gmail message is never re-attached', async () => {
		await seedForwardAnswer();
		await db.prepare(`INSERT INTO conversation_hidden_gmail (mailbox, gmail_id) VALUES (?, 'ans1')`).bind(ME).run();
		const thread = (await conversationsFor(db, ann)).find((t) => t.root_kind === 'campaign')!;
		expect(thread).toMatchObject({ count: 2, awaiting: true });
		expect(await awaitingReplyCount(db)).toBe(1);
	});
});

describe('References backfill (#585)', () => {
	it('fetches stored messages without References once, newest first, fixing direction from the SENT label', async () => {
		await insertMail({ gid: 'b-old', dir: 'in', from: 'ann@client.example', gt: 'g1', at: '2026-09-01 10:00:00', refs: null });
		await insertMail({ gid: 'b-new', dir: 'in', from: 'alias@elsewhere.example', gt: 'g2', at: '2026-10-01 10:00:00', refs: null });
		await insertMail({ gid: 'b-gone', dir: 'in', from: 'ann@client.example', gt: 'g3', at: '2026-08-01 10:00:00', refs: null });
		await insertMail({ gid: 'b-done', dir: 'in', from: 'ann@client.example', gt: 'g4', refs: '' });
		const fetched: string[] = [];
		const fx: Record<string, GmailMessage> = {
			'b-old': gmsg({ id: 'b-old', from: 'ann@client.example', to: ME, refs: '<root@x>' }),
			'b-new': gmsg({ id: 'b-new', from: 'alias@elsewhere.example', to: 'ann@client.example', labels: ['SENT'] })
		};
		const f = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const id = decodeURIComponent(url.pathname.split('/').pop()!);
			fetched.push(id);
			return fx[id] ? Response.json(fx[id]) : new Response('{}', { status: 404 });
		}) as typeof fetch;

		expect(await backfillReferences(db, { id: acct, email: ME }, 'tok', f, 2)).toBe(2);
		expect(fetched).toEqual(['b-new', 'b-old']);
		expect(await backfillReferences(db, { id: acct, email: ME }, 'tok', f, 10)).toBe(1);
		expect(fetched).toEqual(['b-new', 'b-old', 'b-gone']);
		expect(await backfillReferences(db, { id: acct, email: ME }, 'tok', f, 10)).toBe(0);

		const rows = await db
			.prepare('SELECT gmail_id, direction, references_header FROM mail_messages ORDER BY gmail_id')
			.all<{ gmail_id: string; direction: string; references_header: string }>();
		expect(rows.results).toEqual([
			{ gmail_id: 'b-done', direction: 'in', references_header: '' },
			{ gmail_id: 'b-gone', direction: 'in', references_header: '' },
			{ gmail_id: 'b-new', direction: 'out', references_header: '' },
			{ gmail_id: 'b-old', direction: 'in', references_header: '<root@x>' }
		]);
	});
});
