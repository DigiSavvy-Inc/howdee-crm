// #566: company timeline — contact activity merged with Gmail, GitHub, Zoho Books and Timing;
// ordering, the `?tl=` / `?tl_n=` parsing, the billing gate, an empty company, the contactIds
// fast path in recentActivity, conversation links, chips only for sources with rows, and no
// Gmail copy of a message the app already holds.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { companyTimeline } from '../src/lib/server/company-timeline';
import { recentActivity } from '../src/lib/server/activity';
import {
	contactTypesFor,
	mergeTimeline,
	nextTimelineSize,
	parseTimelineFilter,
	parseTimelineSize,
	toUtcStamp
} from '../src/lib/company-timeline';
import type { ActivityItem } from '../src/lib/server/activity';

const db = (env as any).DB as D1Database;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM site_events'),
		db.prepare('DELETE FROM tracking_sites'),
		db.prepare('DELETE FROM pipeline_history'),
		db.prepare('DELETE FROM pipeline_cards'),
		db.prepare('DELETE FROM mail_message_contacts'),
		db.prepare('DELETE FROM mail_messages'),
		db.prepare('DELETE FROM mail_threads'),
		db.prepare('DELETE FROM mail_accounts'),
		db.prepare('DELETE FROM zoho_payments'),
		db.prepare('DELETE FROM zoho_invoices'),
		db.prepare('DELETE FROM company_zoho_contacts'),
		db.prepare('DELETE FROM company_metrics'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM subscription_confirmations'),
		db.prepare('DELETE FROM form_submissions'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

const company = (name: string) => id(`INSERT INTO companies (name) VALUES (?) RETURNING id`, name);
const contact = (email: string, companyId: number | null, opts: { archived?: boolean } = {}) =>
	id(
		`INSERT INTO contacts (email, company_id, created_at, archived_at) VALUES (?, ?, '2026-01-01 00:00:00', ?) RETURNING id`,
		email,
		companyId,
		opts.archived ? '2026-01-02 00:00:00' : null
	);
const event = (contactId: number, type: string, at: string) =>
	db.prepare('INSERT INTO events (contact_id, type, detail, recorded_at) VALUES (?, ?, ?, ?)').bind(contactId, type, '{}', at).run();
const reply = (contactId: number, subject: string, at: string) =>
	id(`INSERT INTO replies (contact_id, from_email, subject, received_at) VALUES (?, 'x@example.com', ?, ?) RETURNING id`, contactId, subject, at);

async function gmail(
	contactIds: number[],
	opts: { gmailId: string; thread: string; subject: string; at: string; dir?: 'in' | 'out'; messageId?: string }
) {
	let acct = (await db.prepare('SELECT id FROM mail_accounts LIMIT 1').first<{ id: number }>())?.id;
	if (!acct) acct = await id(`INSERT INTO mail_accounts (email, refresh_blob) VALUES ('box@example.net', 'x') RETURNING id`);
	const th = await id(
		`INSERT INTO mail_threads (account_id, gmail_thread_id) VALUES (?, ?)
		 ON CONFLICT (account_id, gmail_thread_id) DO UPDATE SET subject = subject RETURNING id`,
		acct,
		opts.thread
	);
	const mid = await id(
		`INSERT INTO mail_messages (account_id, thread_id, gmail_id, gmail_thread_id, direction, from_email, subject, participants, sent_at, message_id_header)
		 VALUES (?, ?, ?, ?, ?, 'someone@example.com', ?, '[]', ?, ?) RETURNING id`,
		acct,
		th,
		opts.gmailId,
		opts.thread,
		opts.dir ?? 'in',
		opts.subject,
		opts.at,
		opts.messageId ?? null
	);
	for (const c of contactIds) await db.prepare('INSERT INTO mail_message_contacts (message_id, contact_id) VALUES (?, ?)').bind(mid, c).run();
	return mid;
}

async function connectTools(co: number) {
	await db
		.prepare(
			`INSERT INTO company_metrics (company_id, last_tracked_at, last_tracked_title, timing_synced_at, recent_issues, github_synced_at)
			 VALUES (?, '2026-11-10T09:00:00Z', 'Design review', '2026-11-15 00:00:00', ?, '2026-11-15 00:00:00')`
		)
		.bind(
			co,
			JSON.stringify([
				{ number: 7, title: 'Fix login', state: 'closed', html_url: 'https://github.com/acme/web/issues/7', updated_at: '2026-11-12T10:00:00Z', repo: 'acme/web' },
				{ number: 9, title: 'Bad link', state: 'open', html_url: 'javascript:alert(1)', updated_at: '2026-11-03T10:00:00Z', repo: 'acme/web' }
			])
		)
		.run();
	await db.prepare(`INSERT INTO company_zoho_contacts (company_id, zoho_contact_id, contact_name) VALUES (?, 'z1', 'Acme Books')`).bind(co).run();
	await db
		.prepare(
			`INSERT INTO zoho_invoices (invoice_id, zoho_contact_id, invoice_number, status, date, total, balance, currency_code, zoho_url)
			 VALUES ('i1', 'z1', 'INV-1', 'sent', '2026-11-11', 500, 500, 'USD', 'https://books.zoho.com/app#/invoices/i1'),
			        ('i2', 'z1', 'INV-2', 'draft', '2026-11-14', 100, 100, 'USD', NULL)`
		)
		.run();
	await db
		.prepare(
			`INSERT INTO zoho_payments (payment_id, zoho_contact_id, payment_number, date, amount, currency_code, invoice_numbers)
			 VALUES ('p1', 'z1', 'PAY-1', '2026-11-13', 500, 'USD', 'INV-1')`
		)
		.run();
}

describe('company timeline helpers (#566)', () => {
	it('parses the source chip and the size', () => {
		expect(parseTimelineFilter('github')).toBe('github');
		expect(parseTimelineFilter('nope')).toBe('all');
		expect(parseTimelineFilter(null)).toBe('all');
		expect(parseTimelineSize('50')).toBe(50);
		expect(parseTimelineSize('37')).toBe(25);
		expect(parseTimelineSize(null)).toBe(25);
		expect(nextTimelineSize(25)).toBe(50);
		expect(nextTimelineSize(200)).toBeNull();
		expect(contactTypesFor('replies')).toEqual(['reply']);
		expect(contactTypesFor('github')).toEqual([]);
		expect(contactTypesFor('all')).toContain('open');
		expect(contactTypesFor('all')).not.toContain('gmail');
	});

	it('normalises integration dates to UTC stamps', () => {
		expect(toUtcStamp('2026-11-11')).toBe('2026-11-11 00:00:00');
		expect(toUtcStamp('2026-11-12T10:00:00Z')).toBe('2026-11-12 10:00:00');
		expect(toUtcStamp('2026-11-12T10:00:00-08:00')).toBe('2026-11-12 18:00:00');
		expect(toUtcStamp('2026-11-12 10:00:00')).toBe('2026-11-12 10:00:00');
		expect(toUtcStamp('junk')).toBeNull();
		expect(toUtcStamp(null)).toBeNull();
	});

	it('merges newest first, ties by type, then original order', () => {
		const it = (at: string, type: ActivityItem['type'], detail: string) =>
			({ at, type, detail, contact_id: null, email: null, name: null, campaign_id: null, subject: null, automation_id: null, automation_name: null }) as ActivityItem;
		const out = mergeTimeline(
			[
				[it('2026-11-02 00:00:00', 'open', 'a'), it('2026-11-01 00:00:00', 'open', 'b')],
				[it('2026-11-03 00:00:00', 'github', 'c'), it('2026-11-02 00:00:00', 'click', 'd')]
			],
			3
		);
		expect(out.map((x) => x.detail)).toEqual(['c', 'd', 'a']);
	});
});

describe('recentActivity contactIds (#566)', () => {
	it('keeps only rows about those contacts and skips app-wide sources', async () => {
		const a = await contact('a@example.com', null);
		const b = await contact('b@example.com', null);
		await event(a, 'open', '2026-11-01 10:00:00');
		await event(b, 'open', '2026-11-01 11:00:00');
		await reply(a, 'Hi', '2026-11-02 10:00:00');
		const rows = await recentActivity(db, { contactIds: [a], limit: 50 });
		expect(rows.every((r) => r.contact_id === a)).toBe(true);
		expect(rows.map((r) => r.type)).toEqual(expect.arrayContaining(['open', 'reply', 'contact']));
		expect(rows.find((r) => r.type === 'reply')?.reply_id).toBeTypeOf('number');
		expect(await recentActivity(db, { contactIds: [], limit: 50 })).toEqual([]);
	});
});

describe('companyTimeline (#566)', () => {
	it('an empty company has no sources and no rows', async () => {
		const co = await company('Empty');
		const t = await companyTimeline(db, co, { billing: true });
		expect(t.items).toEqual([]);
		expect(t.sources).toEqual([]);
		expect(t.filter).toBe('all');
		expect(t.more).toBe(false);
	});

	it('merges contact activity with Gmail, GitHub, billing and Timing, newest first', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		const gone = await contact('gone@example.com', co, { archived: true });
		const other = await contact('other@example.com', null);
		await event(ann, 'click', '2026-11-14 12:00:00');
		await event(gone, 'click', '2026-11-14 13:00:00');
		await event(other, 'click', '2026-11-14 14:00:00');
		await gmail([ann], { gmailId: 'g1', thread: 't1', subject: 'Proposal', at: '2026-11-15 09:00:00' });
		await connectTools(co);

		const t = await companyTimeline(db, co, { billing: true });
		expect(t.sources).toEqual(['email', 'gmail', 'contacts', 'github', 'billing', 'timing']);
		const seq = t.items.map((i) => `${i.type}@${i.at.slice(0, 10)}`);
		expect(seq).toEqual([
			'gmail@2026-11-15',
			'click@2026-11-14',
			'payment@2026-11-13',
			'github@2026-11-12',
			'invoice@2026-11-11',
			'timing@2026-11-10',
			'github@2026-11-03',
			'contact@2026-01-01'
		]);
		// Archived and other companies' contacts never show; a draft invoice is left out.
		expect(t.items.some((i) => i.contact_id === gone || i.contact_id === other)).toBe(false);
		expect(t.items.some((i) => i.ref === 'INV-2')).toBe(false);
		// Links: GitHub only when it is a github.com URL; Gmail into its conversation.
		const gh = t.items.filter((i) => i.type === 'github');
		expect(gh[0]).toMatchObject({ detail: 'Fix login', status: 'closed', ref: 'acme/web#7', url: 'https://github.com/acme/web/issues/7' });
		expect(gh[1].url).toBeNull();
		expect(t.items[0]).toMatchObject({ contact_id: ann, subject: 'Proposal', conv_key: `c${ann}-gt1` });
		expect(t.items.find((i) => i.type === 'invoice')).toMatchObject({ ref: 'INV-1', amount: 500, currency: 'USD', status: 'sent' });
	});

	it('the billing gate: no invoices, payments or Billing chip without access', async () => {
		const co = await company('Acme');
		await contact('ann@example.com', co);
		await connectTools(co);
		const t = await companyTimeline(db, co, { billing: false });
		expect(t.sources).not.toContain('billing');
		expect(t.items.some((i) => i.type === 'invoice' || i.type === 'payment')).toBe(false);
		// Asking for the billing chip anyway falls back to everything else.
		const asked = await companyTimeline(db, co, { billing: false, filter: 'billing' });
		expect(asked.filter).toBe('all');
		expect(asked.items.some((i) => i.type === 'invoice' || i.type === 'payment')).toBe(false);
	});

	it('Gmail shows whatever the Conversations setting says', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		await db.prepare(`INSERT OR REPLACE INTO app_state (key, value) VALUES ('mail_in_conversations', '0')`).run();
		await gmail([ann], { gmailId: 'g1', thread: 't1', subject: 'Hello', at: '2026-11-15 09:00:00', dir: 'out' });
		const t = await companyTimeline(db, co, { billing: false, filter: 'gmail' });
		expect(t.filter).toBe('gmail');
		expect(t.items).toHaveLength(1);
		expect(t.items[0]).toMatchObject({ type: 'gmail', direction: 'out', subject: 'Hello' });
	});

	it('a chip only shows for a source with rows; asking for an empty one falls back to all', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		await event(ann, 'open', '2026-11-14 12:00:00');
		const t = await companyTimeline(db, co, { billing: false });
		expect(t.sources).toEqual(['email', 'contacts']);
		expect(t.sources).not.toContain('site');
		expect(t.sources).not.toContain('pipeline');
		const asked = await companyTimeline(db, co, { billing: false, filter: 'site' });
		expect(asked.filter).toBe('all');
		expect(asked.items.map((i) => i.type)).toEqual(['open', 'contact']);
	});

	it('a Gmail copy of a reply the app already holds is not listed twice', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		const rid = await reply(ann, 'Quote', '2026-11-14 10:00:00');
		await db.prepare("UPDATE replies SET message_id_header = '<dup-1@x.example.net>' WHERE id = ?").bind(rid).run();
		await gmail([ann], { gmailId: 'g1', thread: 't1', subject: 'Quote', at: '2026-11-14 10:00:05', messageId: 'dup-1@x.example.net' });
		await gmail([ann], { gmailId: 'g2', thread: 't2', subject: 'Other', at: '2026-11-15 09:00:00' });

		const t = await companyTimeline(db, co, { billing: false });
		expect(t.items.filter((i) => i.type === 'reply')).toHaveLength(1);
		const rows = t.items.filter((i) => i.type === 'gmail');
		expect(rows.map((i) => i.subject)).toEqual(['Other']);
		expect(rows[0].conv_key).toBe(`c${ann}-gt2`);

		const only = await companyTimeline(db, co, { billing: false, filter: 'gmail' });
		expect(only.items.map((i) => i.subject)).toEqual(['Other']);
		expect(only.more).toBe(false);
	});

	it('a Gmail message linked to two contacts shows once', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		const bob = await contact('bob@example.com', co);
		await gmail([ann, bob], { gmailId: 'g1', thread: 't1', subject: 'Both', at: '2026-11-15 09:00:00' });
		const t = await companyTimeline(db, co, { billing: false, filter: 'gmail' });
		expect(t.items).toHaveLength(1);
	});

	it('filters by source, links replies to their conversation, and pages with Show more', async () => {
		const co = await company('Acme');
		const ann = await contact('ann@example.com', co);
		const rid = await reply(ann, 'Question', '2026-11-10 10:00:00');
		for (let d = 1; d <= 30; d++) await event(ann, 'open', `2026-10-${String(d).padStart(2, '0')} 08:00:00`);

		const replies = await companyTimeline(db, co, { billing: false, filter: 'replies' });
		expect(replies.items.map((i) => i.type)).toEqual(['reply']);
		expect(replies.items[0]).toMatchObject({ reply_id: rid, conv_key: `c${ann}-r${rid}` });

		const first = await companyTimeline(db, co, { billing: false, filter: 'email' });
		expect(first.items).toHaveLength(25);
		expect(first.more).toBe(true);
		const second = await companyTimeline(db, co, { billing: false, filter: 'email', size: '50' });
		expect(second.items).toHaveLength(30);
		expect(second.more).toBe(false);
	});
});
