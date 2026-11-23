import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { open } from '../src/lib/server/crypto-box';
import {
	bareMessageId,
	extractBody,
	googleAuthorizeUrl,
	parseAddresses,
	sanitizeEmailHtml,
	type GmailMessage
} from '../src/lib/server/gmail';
import {
	BACKFILL_QUERY,
	RELIST_QUERY,
	clearMailTokenCache,
	filterByContacts,
	getMailAccount,
	parseMail,
	runMailTick,
	saveMailAccount,
	setGmailInConversations,
	storeMessages,
	syncMailAccount
} from '../src/lib/server/mail-sync';
import { loadMessageBody } from '../src/lib/server/mail-body';
import { conversationsFor, recentConversations, threadMessages, type ConvMessage } from '../src/lib/server/conversations';
import { actions, load } from '../src/routes/settings/mail/+page.server';
import { GET as contactConversations } from '../src/routes/api/v1/contacts/[id]/conversations/+server';
import { generateApiKey } from '../src/lib/server/api-keys';

const db = (env as any).DB as D1Database;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const MAIL_ENV = { MAIL_TOKEN_KEY: newKey(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' };
const REFRESH = '1//refresh-token-value';
const ME = 'alan@ourco.example';

let ann = 0;
let bob = 0;
let adminId = 0;

beforeEach(async () => {
	clearMailTokenCache();
	await db.batch([
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'mail_%'`),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`INSERT OR IGNORE INTO users (github_login, role) VALUES ('mail-admin', 'admin')`)
	]);
	adminId = (await db.prepare(`SELECT id FROM users WHERE github_login = 'mail-admin'`).first<number>('id'))!;
	ann = (await db.prepare(`INSERT INTO contacts (email, name) VALUES ('ann@x.example.net', 'Ann') RETURNING id`).first<number>('id'))!;
	bob = (await db.prepare(`INSERT INTO contacts (email) VALUES ('bob+news@x.example.net') RETURNING id`).first<number>('id'))!;
});

// ── Fixture Gmail ────────────────────────────────────────────────────────────────────

type Fx = {
	id: string;
	thread: string;
	from: string;
	to?: string;
	cc?: string;
	subject?: string;
	msgId?: string;
	inReplyTo?: string;
	at?: string; // ISO
	labels?: string[];
	body?: GmailMessage['payload'];
};

function gmailMsg(f: Fx): GmailMessage {
	const headers = [
		{ name: 'From', value: f.from },
		...(f.to ? [{ name: 'To', value: f.to }] : []),
		...(f.cc ? [{ name: 'Cc', value: f.cc }] : []),
		{ name: 'Subject', value: f.subject ?? 'Hello' },
		...(f.msgId ? [{ name: 'Message-ID', value: `<${f.msgId}>` }] : []),
		...(f.inReplyTo ? [{ name: 'In-Reply-To', value: `<${f.inReplyTo}>` }] : [])
	];
	return {
		id: f.id,
		threadId: f.thread,
		labelIds: f.labels ?? ['INBOX'],
		snippet: `snippet ${f.id}`,
		internalDate: String(Date.parse(f.at ?? '2026-09-01T10:00:00Z')),
		payload: { mimeType: 'multipart/alternative', headers, parts: f.body ? [f.body] : [] }
	};
}

/** A fake Google: token + revoke + Gmail profile/messages/history, with call log. */
function fakeGoogle(opts: {
	messages: Fx[];
	pageSize?: number;
	historyId?: string;
	history?: (start: string, pageToken: string | null) => Response;
	status?: (url: URL) => number | null; // force an error status for a URL
}) {
	const calls: string[] = [];
	let tokens = 0;
	const byId = new Map(opts.messages.map((m) => [m.id, m]));
	const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
		const forced = opts.status?.(url);
		if (forced) return new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), { status: forced });
		if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
			tokens++;
			return Response.json({ access_token: `at-${tokens}`, expires_in: 3600 });
		}
		if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') return new Response('{}', { status: 200 });
		const auth = new Headers(init?.headers).get('Authorization') ?? '';
		if (!auth.startsWith('Bearer at-')) return new Response('{}', { status: 401 });
		const p = url.pathname.replace('/gmail/v1/users/me', '');
		if (p === '/profile') return Response.json({ emailAddress: ME, historyId: opts.historyId ?? '1000' });
		if (p === '/messages') {
			const size = Math.min(Number(url.searchParams.get('maxResults')), opts.pageSize ?? 100);
			const q = url.searchParams.get('q') ?? '';
			const pool = opts.messages.filter((m) => !q.startsWith('{') || q.includes(m.from) || q.includes(m.to ?? '~') || q.includes(m.cc ?? '~'));
			const start = Number(url.searchParams.get('pageToken') ?? 0);
			const slice = pool.slice(start, start + size);
			return Response.json({
				messages: slice.map((m) => ({ id: m.id, threadId: m.thread })),
				...(start + size < pool.length ? { nextPageToken: String(start + size) } : {})
			});
		}
		if (p === '/history') return opts.history!(url.searchParams.get('startHistoryId')!, url.searchParams.get('pageToken'));
		const m = /^\/messages\/([^/]+)$/.exec(p);
		if (m) {
			const fx = byId.get(decodeURIComponent(m[1]));
			if (!fx) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 });
			return Response.json(gmailMsg(fx));
		}
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	return { f, calls, tokenCalls: () => tokens };
}

async function connect(): Promise<number> {
	return saveMailAccount(db, MAIL_ENV, { email: ME, refreshToken: REFRESH, userId: adminId });
}

const counts = async () => ({
	threads: (await db.prepare('SELECT COUNT(*) AS n FROM mail_threads').first<number>('n'))!,
	messages: (await db.prepare('SELECT COUNT(*) AS n FROM mail_messages').first<number>('n'))!,
	links: (await db.prepare('SELECT COUNT(*) AS n FROM mail_message_contacts').first<number>('n'))!
});

// ── Tests ────────────────────────────────────────────────────────────────────────────

describe('Gmail OAuth + token storage (#158)', () => {
	it('builds an offline, forced-consent, read-only authorize URL', () => {
		const u = new URL(googleAuthorizeUrl('cid', 'https://crm.test/auth/google/callback', 'st.x'));
		expect(u.searchParams.get('access_type')).toBe('offline');
		expect(u.searchParams.get('prompt')).toBe('consent');
		expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
		expect(u.searchParams.get('state')).toBe('st.x');
	});

	it('stores the refresh token sealed (round-trips, never in clear)', async () => {
		const id = await connect();
		const row = await getMailAccount(db, id);
		expect(row!.refresh_blob.startsWith('v1.')).toBe(true);
		expect(row!.refresh_blob).not.toContain(REFRESH);
		expect(await open(MAIL_ENV.MAIL_TOKEN_KEY, row!.refresh_blob)).toBe(REFRESH);
		expect(row!.user_id).toBe(adminId);
		// Reconnecting the same address updates the row instead of adding one.
		expect(await saveMailAccount(db, MAIL_ENV, { email: 'Alan@Ourco.example', refreshToken: 'new', userId: adminId })).toBe(id);
		expect(await open(MAIL_ENV.MAIL_TOKEN_KEY, (await getMailAccount(db, id))!.refresh_blob)).toBe('new');
	});
});

describe('participant filter (#158)', () => {
	it('parses address lists, lowercasing only (+tags kept)', () => {
		expect(parseAddresses('"Doe, Jane" <Jane@X.example.net>, bob+news@x.example.net; Carl <carl@y.example.org>')).toEqual([
			'jane@x.example.net',
			'bob+news@x.example.net',
			'carl@y.example.org'
		]);
		expect(parseAddresses(null)).toEqual([]);
		expect(bareMessageId('<abc@mail.gmail.com>')).toBe('abc@mail.gmail.com');
	});

	it('keeps only messages with a contact participant, ignoring the mailbox itself', async () => {
		await db.prepare(`INSERT INTO contacts (email) VALUES (?)`).bind(ME).run(); // the operator is a contact too
		const mails = [
			parseMail(gmailMsg({ id: 'a', thread: 't', from: `Alan <${ME}>`, to: 'Ann <ANN@x.example.net>' })),
			parseMail(gmailMsg({ id: 'b', thread: 't', from: 'stranger@z.example.net', to: ME })),
			parseMail(gmailMsg({ id: 'c', thread: 't', from: 'bob@x.example.net', to: ME })), // +tag differs → no match
			parseMail(gmailMsg({ id: 'd', thread: 't', from: 'bob+news@x.example.net', to: ME, cc: 'ann@x.example.net' }))
		];
		const kept = await filterByContacts(db, ME, mails);
		expect([...kept.keys()]).toEqual(['a', 'd']);
		expect(kept.get('a')).toEqual([ann]);
		expect(kept.get('d')!.sort()).toEqual([ann, bob].sort());
	});
});

describe('backfill + budget (#158)', () => {
	const five: Fx[] = [
		{ id: 'm1', thread: 't1', from: 'Ann <ann@x.example.net>', to: ME, subject: 'Project', msgId: 'm1@mail.gmail.com', at: '2026-09-01T10:00:00Z' },
		{ id: 'm2', thread: 't1', from: ME, to: 'ann@x.example.net', subject: 'Re: Project', msgId: 'm2@mail.gmail.com', inReplyTo: 'm1@mail.gmail.com', at: '2026-09-02T10:00:00Z' },
		{ id: 'm3', thread: 't2', from: 'noise@z.example.net', to: ME },
		{ id: 'm4', thread: 't3', from: ME, to: 'bob+news@x.example.net', subject: 'Invoice' },
		{ id: 'm5', thread: 't4', from: 'other@z.example.net', to: ME }
	];

	it('pages the 1-year list within the per-tick budget, then switches to history', async () => {
		const id = await connect();
		const g = fakeGoogle({ messages: five, historyId: '777' });
		const r1 = await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f, budget: 3 });
		expect(r1).toMatchObject({ mode: 'backfill', scanned: 3, stored: 2 });
		expect(r1.done).toBeUndefined();
		expect(g.calls.find((c) => c.includes('/messages?'))).toContain(`q=${encodeURIComponent(BACKFILL_QUERY).replace(/%20/g, '+')}`);
		// Metadata only, with the headers we need.
		expect(g.calls.some((c) => c.includes('format=metadata') && c.includes('metadataHeaders=In-Reply-To'))).toBe(true);
		let acct = await getMailAccount(db, id);
		expect(acct).toMatchObject({ history_id: null, list_page_token: '3', list_start_history_id: '777', scanned: 3 });

		const r2 = await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f, budget: 3 });
		expect(r2).toMatchObject({ scanned: 2, stored: 1, done: true });
		acct = await getMailAccount(db, id);
		expect(acct).toMatchObject({ history_id: '777', list_page_token: null, last_error: null });
		expect(await counts()).toEqual({ threads: 2, messages: 3, links: 3 });
		// The access token was refreshed once and cached across both runs.
		expect(g.tokenCalls()).toBe(1);

		const dirs = await db.prepare('SELECT gmail_id, direction FROM mail_messages ORDER BY gmail_id').all<{ gmail_id: string; direction: string }>();
		expect(dirs.results).toEqual([
			{ gmail_id: 'm1', direction: 'in' },
			{ gmail_id: 'm2', direction: 'out' },
			{ gmail_id: 'm4', direction: 'out' }
		]);
	});

	it('runMailTick shares one budget and skips paused / unconfigured', async () => {
		const id = await connect();
		const g = fakeGoogle({ messages: five });
		expect(await runMailTick(db, { MAIL_TOKEN_KEY: MAIL_ENV.MAIL_TOKEN_KEY }, { fetch: g.f })).toEqual({ skipped: 'not_configured' });
		await db.prepare('UPDATE mail_accounts SET paused = 1 WHERE id = ?').bind(id).run();
		expect(await runMailTick(db, MAIL_ENV, { fetch: g.f })).toEqual([]);
		await db.prepare('UPDATE mail_accounts SET paused = 0 WHERE id = ?').bind(id).run();
		const res = (await runMailTick(db, MAIL_ENV, { fetch: g.f, budget: 2 })) as { scanned: number }[];
		expect(res[0].scanned).toBe(2);
	});

	it('backs off on a 429 and keeps the cursor', async () => {
		const id = await connect();
		const now = new Date('2026-10-06T12:00:00Z');
		const g = fakeGoogle({ messages: five, status: (u) => (u.pathname.endsWith('/messages/m2') ? 429 : null) });
		const r = await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f, now });
		expect(r.error).toMatch(/rate limit/i);
		const acct = await getMailAccount(db, id);
		expect(acct!.list_page_token).toBeNull(); // page not advanced → retried next time
		expect(acct!.backoff_count).toBe(1);
		expect(Date.parse(acct!.backoff_until!)).toBe(now.getTime() + 60_000);
		expect((await counts()).messages).toBe(1); // m1 was stored before the 429
		// Inside the backoff window the tick skips it.
		expect(await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f, now: new Date(now.getTime() + 30_000) })).toMatchObject({ skipped: 'backoff' });
		// A second failure doubles the wait.
		await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f, now: new Date(now.getTime() + 61_000) });
		const again = await getMailAccount(db, id);
		expect(Date.parse(again!.backoff_until!)).toBe(now.getTime() + 61_000 + 120_000);
	});
});

describe('incremental history (#158)', () => {
	async function incremental(historyId = '500'): Promise<number> {
		const id = await connect();
		await db.prepare('UPDATE mail_accounts SET history_id = ? WHERE id = ?').bind(historyId, id).run();
		return id;
	}

	it('stores added messages through the same filter and advances history_id', async () => {
		const id = await incremental();
		const msgs: Fx[] = [
			{ id: 'h1', thread: 'th', from: 'ann@x.example.net', to: ME },
			{ id: 'h2', thread: 'tp', from: 'ann@x.example.net', to: ME, labels: ['CATEGORY_PROMOTIONS'] },
			{ id: 'h3', thread: 'tz', from: 'nobody@z.example.net', to: ME }
		];
		const g = fakeGoogle({
			messages: msgs,
			history: (start, pageToken) => {
				expect(start).toBe('500');
				return pageToken
					? Response.json({ history: [{ id: '602', messagesAdded: [{ message: { id: 'h3', threadId: 'tz' } }] }], historyId: '610' })
					: Response.json({
							history: [
								{ id: '601', messagesAdded: [{ message: { id: 'h1', threadId: 'th', labelIds: ['INBOX'] } }] },
								{ id: '601', messagesAdded: [{ message: { id: 'h2', threadId: 'tp', labelIds: ['CATEGORY_PROMOTIONS'] } }] }
							],
							nextPageToken: 'p2',
							historyId: '605'
						});
			}
		});
		const r = await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f });
		expect(r).toMatchObject({ mode: 'incremental', stored: 1, scanned: 2 });
		expect(g.calls.some((c) => c.includes('/messages/h2'))).toBe(false); // promotions never fetched
		expect(await getMailAccount(db, id)).toMatchObject({ history_id: '610', history_page_token: null });
	});

	it('falls back to a 30-day re-list when the historyId is too old (404)', async () => {
		const id = await incremental('1');
		const g = fakeGoogle({
			messages: [{ id: 'r1', thread: 'tr', from: 'ann@x.example.net', to: ME }],
			historyId: '9000',
			history: () => new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 })
		});
		const r = await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f });
		expect(r).toMatchObject({ mode: 'relist', fallback: true, stored: 1, done: true });
		const listCall = g.calls.find((c) => c.includes('/messages?'))!;
		expect(new URL(`https://x${listCall.split(' ')[1]}`).searchParams.get('q')).toBe(RELIST_QUERY);
		expect(await getMailAccount(db, id)).toMatchObject({ history_id: '9000', list_query: null });
	});
});

describe('nightly re-match (#158)', () => {
	it('links new contacts to stored messages and searches their past mail', async () => {
		const id = await connect();
		const msgs: Fx[] = [
			{ id: 'x1', thread: 'tx', from: 'ann@x.example.net', to: ME, cc: 'carol@new.example.net' },
			{ id: 'x2', thread: 'ty', from: 'carol@new.example.net', to: ME }
		];
		const g = fakeGoogle({ messages: msgs, history: () => Response.json({ historyId: '501' }) });
		await db.prepare('UPDATE mail_accounts SET history_id = ? WHERE id = ?').bind('500', id).run();
		await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f }); // nothing new; re-match not due yet
		// Store x1 (Ann matched) the way a sync would have.
		await storeMessages(db, { id, email: ME }, msgs.slice(0, 1).map(gmailMsg));
		const carol = (await db.prepare(`INSERT INTO contacts (email) VALUES ('carol@new.example.net') RETURNING id`).first<number>('id'))!;

		const later = new Date(Date.now() + 25 * 3600_000);
		const r = await syncMailAccount(db, MAIL_ENV, id, { fetch: g.f, now: later });
		expect(r.rematched).toBe(2); // x1 linked from the DB, x2 found by the Gmail search
		const linked = await db
			.prepare('SELECT m.gmail_id FROM mail_message_contacts l JOIN mail_messages m ON m.id = l.message_id WHERE l.contact_id = ? ORDER BY 1')
			.bind(carol)
			.all<{ gmail_id: string }>();
		expect(linked.results.map((x) => x.gmail_id)).toEqual(['x1', 'x2']);
		expect(g.calls.some((c) => c.includes(encodeURIComponent('{from:carol@new.example.net')))).toBe(true);
	});
});

describe('Gmail threading in conversations (#158)', () => {
	const party = { contact_id: 7, email: 'ann@x.example.net', name: 'Ann' };
	const gm = (at: string, o: Partial<ConvMessage>): ConvMessage => ({
		dir: 'in', at, subject: 'Hi', campaign_id: null, recipient_id: null, message_id: null, send_kind: null,
		status: null, error: null, signals: null, reply_id: null, text: null, in_reply_to: null,
		campaign_subject: null, source: 'gmail', mail_message_id: 1, gmail_thread_id: 'T1', ...o
	});

	it('groups by threadId (not subject), joins app threads by In-Reply-To, drops duplicates', () => {
		const appSend: ConvMessage = {
			dir: 'out', at: '2026-01-01 09:00:00', subject: 'Offer', campaign_id: 5, recipient_id: 9, message_id: 'pm-1',
			send_kind: 'direct', status: 'accepted', error: null, signals: null, reply_id: null, text: null,
			in_reply_to: null, campaign_subject: null
		};
		const threads = threadMessages(
			[
				appSend,
				gm('2026-01-02 09:00:00', { mail_message_id: 1, gmail_thread_id: 'T1', subject: 'Re: Offer', in_reply_to: 'pm-1@mtasv.net', message_id: 'g1@mail.gmail.com' }),
				gm('2026-01-03 09:00:00', { mail_message_id: 2, gmail_thread_id: 'T1', subject: 'Re: Offer', dir: 'out' }),
				gm('2026-01-04 09:00:00', { mail_message_id: 3, gmail_thread_id: 'T2', subject: 'Offer' }), // same subject, other thread
				gm('2026-01-05 09:00:00', { mail_message_id: 4, gmail_thread_id: 'T3', message_id: 'pm-1@mtasv.net' }) // BCC copy
			],
			party
		);
		expect(threads.map((t) => [t.root_kind, t.count, t.gmail_thread_id])).toEqual([
			['gmail', 1, 'T2'],
			['direct', 3, 'T1']
		]);
		expect(threads[1].key).toBe('c7-c5');
		expect(threads[0].key).toBe('c7-gT2');
	});

	it('shows synced threads on the contact and the Conversations tab, and via the API', async () => {
		const id = await connect();
		await storeMessages(db, { id, email: ME }, [
			gmailMsg({ id: 'c1', thread: 'CT', from: 'Ann <ann@x.example.net>', to: ME, subject: 'Lunch?', msgId: 'c1@mail.gmail.com' })
		]);
		const convs = await conversationsFor(db, ann);
		expect(convs).toHaveLength(1);
		expect(convs[0]).toMatchObject({ root_kind: 'gmail', gmail_thread_id: 'CT', subject: 'Lunch?', awaiting: true });
		expect(convs[0].messages[0]).toMatchObject({ source: 'gmail', from: 'Ann', message_id: 'c1@mail.gmail.com' });
		expect((await recentConversations(db, {})).rows).toEqual([]); // #443: off by default
		await setGmailInConversations(db, true);
		const tab = await recentConversations(db, {});
		expect(tab.rows.map((t) => t.root_kind)).toEqual(['gmail']);

		const key = await generateApiKey();
		const token = key.token;
		await db
			.prepare(`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, 'read')`)
			.bind(key.tokenHash, key.prefix, key.last4)
			.run();
		const res = await contactConversations({
			request: new Request(`https://crm.test/api/v1/contacts/${ann}/conversations`, { headers: { Authorization: `Bearer ${token}` } }),
			url: new URL(`https://crm.test/api/v1/contacts/${ann}/conversations`),
			params: { id: String(ann) },
			platform: { env }
		} as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { root_kind: string }[]; pagination: { total: number } };
		expect(body.data[0].root_kind).toBe('gmail');
		expect(body.pagination.total).toBe(1);
	});
});

describe('message bodies (#158)', () => {
	const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

	it('prefers text/plain, else sanitised HTML', () => {
		const both = gmailMsg({ id: 'b', thread: 't', from: 'a@x.example.net' });
		both.payload!.parts = [
			{ mimeType: 'text/html', body: { data: b64('<p>hi</p>') } },
			{ mimeType: 'text/plain', body: { data: b64('plain hi') } }
		];
		expect(extractBody(both)).toEqual({ kind: 'text', body: 'plain hi' });
		const html = gmailMsg({ id: 'b', thread: 't', from: 'a@x.example.net' });
		html.payload!.parts = [{ mimeType: 'text/html', body: { data: b64('<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:evil()">l</a>') } }];
		expect(extractBody(html)).toEqual({ kind: 'html', body: '<p>hi</p><a href="#">l</a>' });
		expect(sanitizeEmailHtml('<iframe src="x"></iframe><b>ok</b>')).toBe('<b>ok</b>');
	});

	it('fetches on demand and caches in R2 under mail/<account>/<id>.txt', async () => {
		const id = await connect();
		await storeMessages(db, { id, email: ME }, [gmailMsg({ id: 'body1', thread: 'BT', from: 'ann@x.example.net', to: ME })]);
		const mid = (await db.prepare(`SELECT id FROM mail_messages WHERE gmail_id = 'body1'`).first<number>('id'))!;
		const g = fakeGoogle({
			messages: [{ id: 'body1', thread: 'BT', from: 'ann@x.example.net', body: { mimeType: 'text/plain', body: { data: b64('Hello Alan') } } }]
		});
		const store = new Map<string, { text: string; meta: Record<string, string>; uploaded: Date }>();
		const media = {
			get: async (k: string) => {
				const o = store.get(k);
				return o ? { uploaded: o.uploaded, customMetadata: o.meta, text: async () => o.text } : null;
			},
			put: async (k: string, v: string, o: { customMetadata: Record<string, string> }) => {
				store.set(k, { text: v, meta: o.customMetadata, uploaded: new Date() });
			}
		} as unknown as R2Bucket;
		const first = await loadMessageBody(db, MAIL_ENV, mid, { media, fetch: g.f });
		expect(first).toMatchObject({ ok: true, cached: false, body: { kind: 'text', body: 'Hello Alan' } });
		expect([...store.keys()]).toEqual([`mail/${id}/body1.txt`]);
		const second = await loadMessageBody(db, MAIL_ENV, mid, { media, fetch: g.f });
		expect(second).toMatchObject({ ok: true, cached: true });
		expect(g.calls.filter((c) => c.includes('format=full'))).toHaveLength(1);
	});
});

describe('Settings → Mail actions (#158)', () => {
	function ev(fields: Record<string, string> | null, opts: { role?: string; extraEnv?: Record<string, unknown>; fetch?: typeof fetch } = {}) {
		const url = 'https://crm.test/settings/mail';
		let request = new Request(url);
		if (fields) {
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.set(k, v);
			request = new Request(url, { method: 'POST', body: fd });
		}
		return {
			request,
			url: new URL(url),
			platform: { env: { ...(env as any), ...MAIL_ENV, ...(opts.extraEnv ?? {}) } },
			locals: { user: { id: adminId, role: opts.role ?? 'admin' } },
			fetch: opts.fetch ?? fakeGoogle({ messages: [] }).f
		} as any;
	}

	it('lets a member see only their own mailbox; other mailboxes and the shared settings stay admin-only (#585)', async () => {
		const id = await connect(); // connected by the admin
		const member = (await db
			.prepare(`INSERT INTO users (github_login, role) VALUES ('mail-member-585', 'member') RETURNING id`)
			.first<number>('id'))!;
		const asMember = (fields: Record<string, string> | null) => {
			const e = ev(fields, { role: 'member' });
			e.locals = { user: { id: member, role: 'member' } };
			return e;
		};
		const data = (await load(asMember(null))) as any;
		expect(data).toMatchObject({ isAdmin: false, accounts: [], internalDomains: null });
		await expect(actions.pause(asMember({ account_id: String(id), paused: '1' }))).rejects.toMatchObject({ status: 403 });
		await expect(actions.internalDomains(asMember({ internal_domains: 'x.example.net' }))).rejects.toMatchObject({ status: 403 });
		await expect(actions.inConversations(asMember({ on: '1' }))).rejects.toMatchObject({ status: 403 });

		// Their own mailbox: listed, and they may pause it.
		const own = await saveMailAccount(db, MAIL_ENV, { email: 'teammate@ourco.example', refreshToken: 'r2', userId: member });
		const mine = (await load(asMember(null))) as any;
		expect(mine.accounts.map((a: { id: number }) => a.id)).toEqual([own]);
		expect(await actions.pause(asMember({ account_id: String(own), paused: '1' }))).toEqual({ paused: true });
		// An admin sees both.
		expect(((await load(ev(null))) as any).accounts).toHaveLength(2);
		await db.prepare('DELETE FROM users WHERE id = ?').bind(member).run();
	});

	it('needs a signed-in user', async () => {
		const e = ev(null);
		e.locals = {};
		await expect(load(e)).rejects.toMatchObject({ status: 403 });
	});

	it('reports a missing Google client (disabled Connect)', async () => {
		const data = (await load(ev(null, { extraEnv: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } }))) as any;
		expect(data).toMatchObject({ googleConfigured: false, tokenKeyReady: true, accounts: [] });
		expect(data.redirectUri).toBe('https://crm.test/auth/google/callback');
	});

	it('pauses, syncs now and disconnects (revoke + delete)', async () => {
		const id = await connect();
		await actions.pause(ev({ account_id: String(id), paused: '1' }));
		let data = (await load(ev(null))) as any;
		expect(data.accounts[0]).toMatchObject({ email: ME, paused: true, mode: 'backfill', connected_by: 'mail-admin' });

		const g = fakeGoogle({ messages: [{ id: 's1', thread: 'st', from: 'ann@x.example.net', to: ME }] });
		const synced = (await actions.sync(ev({ account_id: String(id) }, { fetch: g.f }))) as any;
		expect(synced).toEqual({ synced: { scanned: 1, stored: 1, done: true, purged: { links: 0, messages: 0, threads: 0 } } }); // Sync now runs even while paused
		data = (await load(ev(null))) as any;
		expect(data.accounts[0]).toMatchObject({ threads: 1, messages: 1, mode: 'incremental' });

		const out = (await actions.disconnect(ev({ account_id: String(id) }, { fetch: g.f }))) as any;
		expect(out).toEqual({ disconnected: true, revoked: true });
		const revoke = g.calls.find((c) => c.startsWith('POST /revoke'));
		expect(revoke).toBeTruthy();
		expect(await counts()).toEqual({ threads: 0, messages: 0, links: 0 });
		expect(await getMailAccount(db, id)).toBeNull();
	});
});
