import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { GmailMessage } from '../src/lib/server/gmail';
import {
	AUTOMATED_LOCAL_RE,
	automatedReason,
	buildInternalSet,
	isAutomatedSender,
	isInternal,
	parseDomainList
} from '../src/lib/mail-filter';
import {
	BACKFILL_QUERY,
	RELIST_QUERY,
	clearMailTokenCache,
	filterByContacts,
	gmailInConversations,
	loadInternalSet,
	parseMail,
	refilterStoredMail,
	runMailTick,
	saveMailAccount,
	setGmailInConversations,
	setInternalDomains,
	storeMessages
} from '../src/lib/server/mail-sync';
import { awaitingReplyCount, conversationsFor, recentConversations } from '../src/lib/server/conversations';

// #443: Gmail sync noise — internal addresses never make a conversation, automated mail is
// skipped, stored noise is purged, and Gmail in the Conversations tab is opt-in.

const db = (env as any).DB as D1Database;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const MAIL_ENV = { MAIL_TOKEN_KEY: newKey(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' };
const ME = 'accounts@ourco.example';

type Fx = { id: string; thread?: string; from: string; to?: string; cc?: string; labels?: string[]; headers?: Record<string, string> };

function gmsg(f: Fx): GmailMessage {
	return {
		id: f.id,
		threadId: f.thread ?? `t-${f.id}`,
		labelIds: f.labels ?? ['INBOX'],
		snippet: `snippet ${f.id}`,
		internalDate: String(Date.parse('2026-10-01T10:00:00Z')),
		payload: {
			headers: [
				{ name: 'From', value: f.from },
				...(f.to ? [{ name: 'To', value: f.to }] : []),
				...(f.cc ? [{ name: 'Cc', value: f.cc }] : []),
				{ name: 'Subject', value: `Subject ${f.id}` },
				...Object.entries(f.headers ?? {}).map(([name, value]) => ({ name, value }))
			]
		}
	};
}

let ann = 0;
let alan = 0;
let acct = 0;

beforeEach(async () => {
	clearMailTokenCache();
	await db.batch([
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'mail_%'`),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM contacts'),
		db.prepare(`UPDATE users SET email = NULL WHERE email IS NOT NULL`)
	]);
	ann = (await db.prepare(`INSERT INTO contacts (email, name) VALUES ('ann@client.example.net', 'Ann') RETURNING id`).first<number>('id'))!;
	alan = (await db.prepare(`INSERT INTO contacts (email, name) VALUES ('alan@ourco.example', 'Alan') RETURNING id`).first<number>('id'))!;
	await db.prepare(`INSERT INTO contacts (email) VALUES ('ops@partner.example.net')`).run();
	acct = await saveMailAccount(db, MAIL_ENV, { email: ME, refreshToken: 'r', userId: null });
});

const linkedContacts = async () =>
	(await db.prepare('SELECT DISTINCT contact_id FROM mail_message_contacts ORDER BY contact_id').all<{ contact_id: number }>()).results.map(
		(r) => r.contact_id
	);
const n = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'))!;

describe('rules (pure)', () => {
	it('builds the internal set: mailboxes, users, domains; case-insensitive', () => {
		const set = buildInternalSet({ mailboxes: ['Accounts@Ourco.example'], userEmails: ['robin@Freelance.example.net', null] });
		expect([...set.domains]).toEqual(['ourco.example']);
		expect(isInternal('ALAN@ourco.example', set)).toBe(true);
		expect(isInternal('alan@mail.ourco.example', set)).toBe(true);
		expect(isInternal('robin@freelance.example.net', set)).toBe(true);
		expect(isInternal('other@freelance.example.net', set)).toBe(false);
		expect(isInternal('ann@client.example.net', set)).toBe(false);
		expect(isInternal('x@notourco.example', set)).toBe(false);
		// A saved list replaces the default domains (empty = none).
		const custom = buildInternalSet({ mailboxes: [ME], domains: ['example.org'] });
		expect(isInternal('alan@ourco.example', custom)).toBe(false);
		expect(isInternal(ME, custom)).toBe(true);
		expect(isInternal('a@example.org', custom)).toBe(true);
	});

	it('parses the domain list', () => {
		expect(parseDomainList(' Ourco.example, @example.org;bad,, ourco.example localhost')).toEqual(['ourco.example', 'example.org']);
		expect(parseDomainList('')).toEqual([]);
	});

	it('flags automated mail by label, header and sender', () => {
		const h = (o: Record<string, string>) => (name: string) => o[name] ?? null;
		expect(automatedReason(h({}), 'ann@client.example.net')).toBeNull();
		expect(automatedReason(h({}), 'ann@client.example.net', ['CATEGORY_UPDATES'])).toBe('label:CATEGORY_UPDATES');
		expect(automatedReason(h({}), 'ann@client.example.net', ['CATEGORY_FORUMS'])).toBe('label:CATEGORY_FORUMS');
		expect(automatedReason(h({ 'List-Unsubscribe': '<mailto:x>' }), 'ann@client.example.net')).toBe('list-unsubscribe');
		expect(automatedReason(h({ Precedence: 'Bulk' }), 'ann@client.example.net')).toBe('precedence:bulk');
		expect(automatedReason(h({ Precedence: 'auto_reply' }), 'ann@client.example.net')).toBe('precedence:auto_reply');
		expect(automatedReason(h({ Precedence: 'first-class' }), 'ann@client.example.net')).toBeNull();
		expect(automatedReason(h({ 'Auto-Submitted': 'auto-replied' }), 'ann@client.example.net')).toBe('auto-submitted');
		expect(automatedReason(h({ 'Auto-Submitted': 'no' }), 'ann@client.example.net')).toBeNull();
		expect(automatedReason(h({ 'X-Auto-Response-Suppress': 'All' }), 'ann@client.example.net')).toBe('x-auto-response-suppress');
		for (const local of ['noreply', 'no-reply', 'No-Reply', 'notification', 'notifications', 'receipts', 'billing', 'MAILER-DAEMON', 'donotreply', 'do-not-reply']) {
			expect(isAutomatedSender(`${local}@vendor.com`)).toBe(true);
		}
		expect(isAutomatedSender('ann@client.example.net')).toBe(false);
		expect(AUTOMATED_LOCAL_RE.test('alan')).toBe(false);
	});

	it('skips Updates and Forums in the backfill and re-list queries', () => {
		for (const q of [BACKFILL_QUERY, RELIST_QUERY]) {
			expect(q).toContain('-category:updates');
			expect(q).toContain('-category:forums');
		}
	});
});

describe('keep / skip on sync', () => {
	it('loads the internal set from mailboxes, users and the saved domains', async () => {
		await db.prepare(`INSERT OR IGNORE INTO users (github_login, role) VALUES ('noise-user', 'member')`).run();
		await db.prepare(`UPDATE users SET email = 'Robin@Freelance.example.net' WHERE github_login = 'noise-user'`).run();
		let set = await loadInternalSet(db);
		expect(isInternal('robin@freelance.example.net', set)).toBe(true);
		expect(isInternal('alan@ourco.example', set)).toBe(true);
		await setInternalDomains(db, ['partner.example.net']);
		set = await loadInternalSet(db);
		expect(isInternal('alan@ourco.example', set)).toBe(false);
		expect(isInternal('ops@partner.example.net', set)).toBe(true);
		expect(isInternal(ME, set)).toBe(true);
	});

	it('internal-only → skipped; an outside contact → kept, linked to the outsider only', async () => {
		const kept = await filterByContacts(db, ME, [
			parseMail(gmsg({ id: 'i1', from: 'Alan <alan@ourco.example>', to: ME })),
			parseMail(gmsg({ id: 'i2', from: 'alan@ourco.example', to: 'ann@client.example.net', cc: ME }))
		]);
		expect(kept.has('i1')).toBe(false);
		expect(kept.get('i2')).toEqual([ann]);

		expect(await storeMessages(db, { id: acct, email: ME }, [
			gmsg({ id: 'i1', from: 'Alan <alan@ourco.example>', to: ME }),
			gmsg({ id: 'i2', from: 'alan@ourco.example', to: 'ann@client.example.net', cc: ME })
		])).toBe(1);
		expect(await linkedContacts()).toEqual([ann]);
		const row = await db.prepare(`SELECT participants FROM mail_messages WHERE gmail_id = 'i2'`).first<string>('participants');
		expect(JSON.parse(row!)).toContain('alan@ourco.example'); // internal participants still recorded
	});

	it('automated headers, senders and category labels → skipped', async () => {
		const box = { id: acct, email: ME };
		const stored = await storeMessages(db, box, [
			gmsg({ id: 'a1', from: 'ann@client.example.net', to: ME, headers: { 'List-Unsubscribe': '<https://x>' } }),
			gmsg({ id: 'a2', from: 'ann@client.example.net', to: ME, headers: { Precedence: 'list' } }),
			gmsg({ id: 'a3', from: 'ann@client.example.net', to: ME, headers: { 'Auto-Submitted': 'auto-generated' } }),
			gmsg({ id: 'a4', from: 'ann@client.example.net', to: ME, headers: { 'X-Auto-Response-Suppress': 'OOF' } }),
			gmsg({ id: 'a5', from: 'billing@client.example.net', to: ME, cc: 'ann@client.example.net' }),
			gmsg({ id: 'a6', from: 'ann@client.example.net', to: ME, labels: ['INBOX', 'CATEGORY_UPDATES'] }),
			gmsg({ id: 'ok', from: 'ann@client.example.net', to: ME, headers: { 'Auto-Submitted': 'no' } })
		]);
		expect(stored).toBe(1);
		const ids = (await db.prepare('SELECT gmail_id FROM mail_messages').all<{ gmail_id: string }>()).results.map((r) => r.gmail_id);
		expect(ids).toEqual(['ok']);
	});
});

describe('cleanup of stored mail', () => {
	async function seedNoise() {
		// Stored the pre-#443 way: link rows written directly, one thread per message.
		const msg = async (gid: string, gt: string, from: string, participants: string[], contacts: number[]) => {
			const threadId = await db
				.prepare('INSERT INTO mail_threads (account_id, gmail_thread_id) VALUES (?, ?) RETURNING id')
				.bind(acct, gt)
				.first<number>('id');
			const mid = (await db
				.prepare(
					`INSERT INTO mail_messages (account_id, thread_id, gmail_id, gmail_thread_id, direction, from_email, participants, sent_at)
					 VALUES (?, ?, ?, ?, 'in', ?, ?, '2026-10-01 10:00:00') RETURNING id`
				)
				.bind(acct, threadId, gid, gt, from, JSON.stringify(participants))
				.first<number>('id'))!;
			for (const c of contacts) await db.prepare('INSERT INTO mail_message_contacts (message_id, contact_id) VALUES (?, ?)').bind(mid, c).run();
		};
		await msg('n1', 'T-internal', 'alan@ourco.example', ['alan@ourco.example', ME], [alan]);
		await msg('n2', 'T-mixed', 'alan@ourco.example', ['alan@ourco.example', 'ann@client.example.net'], [alan, ann]);
		await msg('n3', 'T-receipt', 'receipts@client.example.net', ['receipts@client.example.net', 'ann@client.example.net'], [ann]);
		await msg('n4', 'T-real', 'ann@client.example.net', ['ann@client.example.net', ME], [ann]);
	}

	it('drops internal links, then unlinked messages, then empty threads; idempotent', async () => {
		await seedNoise();
		const deleted: string[][] = [];
		const media = { delete: async (keys: string[]) => void deleted.push(keys) } as unknown as R2Bucket;
		const res = await refilterStoredMail(db, media);
		expect(res).toEqual({ links: 3, messages: 2, threads: 2 });
		expect(await linkedContacts()).toEqual([ann]);
		const left = (await db.prepare('SELECT gmail_id FROM mail_messages ORDER BY gmail_id').all<{ gmail_id: string }>()).results;
		expect(left.map((r) => r.gmail_id)).toEqual(['n2', 'n4']);
		expect(await n('mail_threads')).toBe(2);
		expect(deleted.flat().sort()).toEqual([`mail/${acct}/n1.txt`, `mail/${acct}/n3.txt`]);
		expect(await refilterStoredMail(db)).toEqual({ links: 0, messages: 0, threads: 0 });
	});

	it('runs once on the first tick, gated by an app_state flag', async () => {
		await seedNoise();
		expect(await runMailTick(db, {})).toEqual({ skipped: 'not_configured' });
		expect(await n('mail_messages')).toBe(2);
		const flag = await db.prepare(`SELECT value FROM app_state WHERE key = 'mail_refilter_443'`).first<string>('value');
		expect(JSON.parse(flag!)).toMatchObject({ messages: 2, threads: 2 });
		// A second tick doesn't re-run it (a link written now survives).
		await db.prepare('INSERT INTO mail_message_contacts (message_id, contact_id) SELECT id, ? FROM mail_messages WHERE gmail_id = ?').bind(alan, 'n4').run();
		await runMailTick(db, {});
		expect(await linkedContacts()).toEqual([ann, alan].sort((a, b) => a - b));
	});
});

describe('Gmail in Conversations is opt-in', () => {
	it('off: the tab, counts and awaiting tile leave Gmail out; the contact page keeps it. On: listed + Gmail chip', async () => {
		await storeMessages(db, { id: acct, email: ME }, [gmsg({ id: 'c1', thread: 'CT', from: 'Ann <ann@client.example.net>', to: ME })]);
		expect(await gmailInConversations(db)).toBe(false);
		const off = await recentConversations(db, {});
		expect(off.rows).toEqual([]);
		expect(off.gmail).toBe(false);
		expect(off.counts).toMatchObject({ all: 0, awaiting: 0, gmail: 0 });
		expect(await awaitingReplyCount(db)).toBe(0);
		expect((await conversationsFor(db, ann)).map((t) => t.root_kind)).toEqual(['gmail']);

		await setGmailInConversations(db, true);
		const on = await recentConversations(db, {});
		expect(on.gmail).toBe(true);
		expect(on.rows.map((t) => t.root_kind)).toEqual(['gmail']);
		expect(on.counts).toMatchObject({ all: 1, awaiting: 1, gmail: 1 });
		expect((await recentConversations(db, { filter: 'gmail' })).rows).toHaveLength(1);
		expect(await awaitingReplyCount(db)).toBe(1);
	});
});
