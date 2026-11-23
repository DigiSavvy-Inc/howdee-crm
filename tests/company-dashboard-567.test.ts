// #567: company dashboard 4/4 — the extracted companyConversations() helper (shared with the
// account brief), the conversations panel ordering, the weekly Timing sparkline maths, the
// billing glyph, and the timeline's Gmail chip showing only when a Gmail row would be listed.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { companyConversations, conversationPanelRows } from '../src/lib/server/company-conversations';
import { companyTimeline } from '../src/lib/server/company-timeline';
import { sparkHeights, weeklyHours } from '../src/lib/company-panels';
import { GLYPHS } from '../src/lib/icons/glyphs';
import type { Conversation } from '../src/lib/server/conversations';

const db = (env as any).DB as D1Database;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM conversation_hidden_gmail'),
		db.prepare('DELETE FROM mail_message_contacts'),
		db.prepare('DELETE FROM mail_messages'),
		db.prepare('DELETE FROM mail_threads'),
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM subscription_confirmations'),
		db.prepare('DELETE FROM form_submissions'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

const company = (name: string) => id(`INSERT INTO companies (name) VALUES (?) RETURNING id`, name);
const contact = (email: string, companyId: number, opts: { archived?: boolean } = {}) =>
	id(
		`INSERT INTO contacts (email, company_id, created_at, archived_at) VALUES (?, ?, '2026-01-01 00:00:00', ?) RETURNING id`,
		email,
		companyId,
		opts.archived ? '2026-01-02 00:00:00' : null
	);
const reply = (contactId: number, subject: string, at: string) =>
	id(`INSERT INTO replies (contact_id, from_email, subject, received_at) VALUES (?, 'x@example.com', ?, ?) RETURNING id`, contactId, subject, at);

async function gmail(contactIds: number[], opts: { gmailId: string; thread: string; subject: string; at: string }) {
	let acct = (await db.prepare('SELECT id FROM mail_accounts LIMIT 1').first<{ id: number }>())?.id;
	if (!acct) acct = await id(`INSERT INTO mail_accounts (email, refresh_blob) VALUES ('box@example.net', 'x') RETURNING id`);
	const th = await id(`INSERT INTO mail_threads (account_id, gmail_thread_id) VALUES (?, ?) RETURNING id`, acct, opts.thread);
	const mid = await id(
		`INSERT INTO mail_messages (account_id, thread_id, gmail_id, gmail_thread_id, direction, from_email, subject, participants, sent_at)
		 VALUES (?, ?, ?, ?, 'in', 'someone@example.com', ?, '[]', ?) RETURNING id`,
		acct,
		th,
		opts.gmailId,
		opts.thread,
		opts.subject,
		opts.at
	);
	for (const c of contactIds) await db.prepare('INSERT INTO mail_message_contacts (message_id, contact_id) VALUES (?, ?)').bind(mid, c).run();
	return mid;
}

const NOW = new Date('2026-11-16T12:00:00Z');

describe('companyConversations', () => {
	it('returns the threads of active contacts with a reply in the window, newest first', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		const bob = await contact('bob@example.com', co);
		const gone = await contact('gone@example.com', co, { archived: true });
		await reply(ann, 'Older question', '2026-11-01 10:00:00');
		await reply(bob, 'Newer question', '2026-11-10 10:00:00');
		await reply(gone, 'Archived contact', '2026-11-12 10:00:00');
		await reply(ann, 'Too old', '2026-05-01 10:00:00');

		const threads = await companyConversations(db, co, { now: NOW });
		expect(threads.map((t) => t.subject)).toEqual(['Newer question', 'Older question']);
		expect(threads.every((t) => t.awaiting)).toBe(true);
	});

	it('an empty company has none', async () => {
		const co = await company('Quiet');
		await contact('q@example.com', co);
		expect(await companyConversations(db, co, { now: NOW })).toEqual([]);
	});
});

describe('conversationPanelRows', () => {
	const t = (key: string, last_at: string, awaiting: boolean): Conversation =>
		({
			key,
			contact_id: 1,
			email: 'a@example.com',
			name: null,
			subject: key,
			root_campaign_id: null,
			root_kind: 'reply',
			gmail_thread_id: null,
			messages: [],
			count: 1,
			sent: 0,
			replies: 1,
			last_at,
			last_dir: awaiting ? 'in' : 'out',
			awaiting
		}) as Conversation;

	it('puts awaiting-our-reply threads first, then newest, and caps the rows', () => {
		const out = conversationPanelRows(
			[t('a', '2026-11-15 00:00:00', false), t('b', '2026-11-01 00:00:00', true), t('c', '2026-11-10 00:00:00', true), t('d', '2026-11-14 00:00:00', false)],
			3
		);
		expect(out.rows.map((r) => r.key)).toEqual(['c', 'b', 'a']);
		expect(out.total).toBe(4);
		expect(out.awaiting).toBe(2);
		expect(out.rows[0]).toMatchObject({ who: 'a@example.com', gmail: false });
	});
});

describe('weekly Timing sparkline', () => {
	it('keeps the newest snapshot per UTC Monday week and leaves weeks without one as gaps', () => {
		const weeks = weeklyHours(
			[
				{ day: '2026-11-10', value: 4 },
				{ day: '2026-11-15', value: 6 }, // same week (Mon 9 Nov), newer → wins
				{ day: '2026-11-16', value: 1 } // this week (Mon 16 Nov)
			],
			NOW,
			4
		);
		expect(weeks).toEqual([
			{ week: '2026-10-26', hours: null },
			{ week: '2026-11-02', hours: null },
			{ week: '2026-11-09', hours: 6 },
			{ week: '2026-11-16', hours: 1 }
		]);
	});

	it('scales bars: a gap stays null, a real 0 is 1px', () => {
		expect(sparkHeights([null, 0, 5, 10], 30)).toEqual([null, 1, 15, 30]);
		expect(sparkHeights([0, 0], 30)).toEqual([1, 1]);
	});
});

describe('billing glyph', () => {
	it('exists for invoice / payment rows and the billing panel', () => {
		expect(GLYPHS.billing).toContain('<path');
	});
});

describe('timeline Gmail chip (#566 follow-up)', () => {
	it('shows only when at least one Gmail message would be listed', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		await gmail([ann], { gmailId: 'g1', thread: 't1', subject: 'Hidden', at: '2026-11-15 09:00:00' });
		await db.prepare(`INSERT INTO conversation_hidden_gmail (mailbox, gmail_id) VALUES ('box@example.net', 'g1')`).run();

		const hidden = await companyTimeline(db, co, { billing: false });
		expect(hidden.sources).not.toContain('gmail');
		expect((await companyTimeline(db, co, { billing: false, filter: 'gmail' })).filter).toBe('all');

		await gmail([ann], { gmailId: 'g2', thread: 't2', subject: 'Shown', at: '2026-11-15 10:00:00' });
		const shown = await companyTimeline(db, co, { billing: false });
		expect(shown.sources).toContain('gmail');
		expect(shown.items.filter((i) => i.type === 'gmail').map((i) => i.subject)).toEqual(['Shown']);
	});
});
