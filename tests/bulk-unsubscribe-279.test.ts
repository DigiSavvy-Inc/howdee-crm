import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { actions as contactActions } from '../src/routes/contacts/+page.server';
import { actions as listActions } from '../src/routes/lists/[id]/+page.server';
import { POST as bulkApi } from '../src/routes/api/v1/contacts/bulk/+server';
import { generateApiKey } from '../src/lib/server/api-keys';
import { BULK_UNSUB_REASON, bulkUnsubscribe, resolveSelection } from '../src/lib/server/contact-bulk';
import { contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { campaignWhoCount } from '../src/lib/server/bounce-filter';
import { compileSegment } from '../src/lib/server/segment-query';

// #279: bulk unsubscribe / resubscribe (bulk bar on /contacts + /lists/[id], the Data API),
// Postmark suppression batching, and the bounce / spam / campaign-segment filters.
const db = (env as any).DB as D1Database;

type Fields = Record<string, string | string[]>;
function form(fields: Fields): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
	return fd;
}
function contactsEvent(action: string, fields: Fields) {
	return {
		platform: { env },
		request: new Request(`https://app.test/contacts?/${action}`, { method: 'POST', body: form(fields) })
	} as any;
}
function listEvent(action: string, listId: number, fields: Fields) {
	return {
		platform: { env },
		params: { id: String(listId) },
		request: new Request(`https://app.test/lists/${listId}?/${action}`, { method: 'POST', body: form(fields) })
	} as any;
}
async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const r = await db.prepare(sql).bind(...binds).first<{ n: number }>();
	return r?.n ?? 0;
}
async function contact(email: string, subscribed = 1): Promise<number> {
	return (await db
		.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, ?) RETURNING id')
		.bind(email, subscribed)
		.first<{ id: number }>())!.id;
}
const subscribed = async (id: number) => count('SELECT subscribed AS n FROM contacts WHERE id = ?', id);

async function campaign(): Promise<number> {
	return (await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, from_email, status, sent_at)
			 VALUES ('AI made websites cheaper', 'md', '<p>hi</p>', 'alan@ourco.example', 'sent', datetime('now')) RETURNING id`
		)
		.first<{ id: number }>())!.id;
}
async function recipient(campaignId: number, contactId: number, email: string): Promise<number> {
	return (await db
		.prepare(
			"INSERT INTO recipients (campaign_id, contact_id, email, status, message_id) VALUES (?, ?, ?, 'accepted', ?) RETURNING id"
		)
		.bind(campaignId, contactId, email, `msg-${email}`)
		.first<{ id: number }>())!.id;
}
async function event(campaignId: number | null, recipientId: number | null, contactId: number, type: string, detail?: object) {
	await db
		.prepare('INSERT INTO events (campaign_id, recipient_id, contact_id, type, detail) VALUES (?, ?, ?, ?, ?)')
		.bind(campaignId, recipientId, contactId, type, detail ? JSON.stringify(detail) : null)
		.run();
}
async function filterIds(params: Record<string, string>): Promise<number[]> {
	const { where, params: binds } = contactsWhere(parseContactsFilter(new URLSearchParams(params)));
	const rows = await db.prepare(`SELECT id FROM contacts ${where} ORDER BY id`).bind(...binds).all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	// unsubscribes → contacts has no ON DELETE: don't leave rows that block another file's cleanup.
	await db.prepare('DELETE FROM unsubscribes').run();
});

describe('bulk unsubscribe', () => {
	it('unsubscribes checked rows, writes one operator (bulk) row each, cancels active passes, reports counts', async () => {
		const a = await contact('a@b.test');
		const b = await contact('b@b.test');
		const gone = await contact('gone@b.test', 0);
		const auto = (await db
			.prepare("INSERT INTO automations (name, status) VALUES ('Nurture', 'active') RETURNING id")
			.first<{ id: number }>())!.id;
		const step = (await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type)
				 VALUES (?, 0, 0, 'Hi', 'md', 'alan@ourco.example', 'email') RETURNING id`
			)
			.bind(auto)
			.first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_enrollments (automation_id, contact_id, current_step_id, status, next_run_at)
				 VALUES (?, ?, ?, 'active', datetime('now'))`
			)
			.bind(auto, a, step)
			.run();

		const out = (await contactActions.bulkUnsubscribe(
			contactsEvent('bulkUnsubscribe', { contact_ids: [a, b, gone].map(String), suppress: '1' })
		)) as any;
		expect(out.affected).toBe(2);
		expect(out.skipped).toBe(1);
		// No POSTMARK_TOKEN in the test env: nothing is sent, and the banner says so.
		expect(out.bulkSuccess).toBe(
			'Unsubscribed 2 · 1 already unsubscribed · 1 automation pass cancelled · Postmark not configured, nothing suppressed'
		);
		expect(await subscribed(a)).toBe(0);
		expect(await subscribed(b)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes WHERE reason = ?', BULK_UNSUB_REASON)).toBe(2);
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes WHERE contact_id = ?', gone)).toBe(0);
		const pass = await db
			.prepare('SELECT status, next_run_at, ended_at FROM automation_enrollments WHERE contact_id = ?')
			.bind(a)
			.first<{ status: string; next_run_at: string | null; ended_at: string | null }>();
		expect(pass).toMatchObject({ status: 'cancelled', next_run_at: null });
		expect(pass?.ended_at).toBeTruthy();

		// Again: everyone is already unsubscribed, no new rows.
		const again = (await contactActions.bulkUnsubscribe(
			contactsEvent('bulkUnsubscribe', { contact_ids: [a, b].map(String) })
		)) as any;
		expect(again.bulkSuccess).toBe('Unsubscribed 0 · 2 already unsubscribed');
		expect(await count('SELECT COUNT(*) AS n FROM unsubscribes')).toBe(2);
	});

	it('works for "all matching" on /contacts (bounced filter) and on /lists/[id]', async () => {
		const hard = await contact('hard@b.test');
		const soft = await contact('soft@b.test');
		const fine = await contact('fine@b.test');
		await event(null, null, hard, 'bounce', { Type: 'HardBounce' });
		await event(null, null, soft, 'bounce', { Type: 'SoftBounce' });

		const out = (await contactActions.bulkUnsubscribe(
			contactsEvent('bulkUnsubscribe', { all: '1', bounced: 'hard' })
		)) as any;
		expect(out.bulkSuccess).toBe('Unsubscribed 1');
		expect([await subscribed(hard), await subscribed(soft), await subscribed(fine)]).toEqual([0, 1, 1]);

		const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('News', 'list') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([soft, fine].map((c) => db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, c)));
		const fromList = (await listActions.bulkUnsubscribe(listEvent('bulkUnsubscribe', list, { all: '1' }))) as any;
		expect(fromList.bulkSuccess).toBe('Unsubscribed 2');
		expect(await subscribed(fine)).toBe(0);
	});

	it('suppresses in Postmark 50 addresses per request and keeps going past a failure', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 60; i++) ids.push(await contact(`p${i}@b.test`));
		const bodies: string[][] = [];
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const emails = JSON.parse(String(init.body)).Suppressions.map((s: { EmailAddress: string }) => s.EmailAddress);
			bodies.push(emails);
			if (bodies.length === 1) {
				return new Response(
					JSON.stringify({ Suppressions: emails.map((e: string, i: number) => ({ EmailAddress: e, Status: i === 0 ? 'Failed' : 'Suppressed' })) }),
					{ status: 200 }
				);
			}
			throw new Error('network down');
		});
		vi.stubGlobal('fetch', fetchMock);

		const sel = await resolveSelection(db, { ids });
		if (!sel.ok) throw new Error(sel.error);
		const out = await bulkUnsubscribe(db, sel, { suppress: true, postmark: { token: 't', stream: 'broadcast' } });
		expect(bodies.map((b) => b.length)).toEqual([50, 10]);
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.postmarkapp.com/message-streams/broadcast/suppressions');
		expect(out).toMatchObject({ ok: true, affected: 60 });
		if (out.ok) expect(out.message).toBe('Unsubscribed 60 · 49 suppressed in Postmark · 11 Postmark suppressions failed');
	});

	it('leaves Postmark alone when the box is unticked', async () => {
		const a = await contact('a@b.test');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const sel = await resolveSelection(db, { ids: [a] });
		if (!sel.ok) throw new Error(sel.error);
		await bulkUnsubscribe(db, sel, { suppress: false, postmark: { token: 't', stream: 'broadcast' } });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('bulk resubscribe', () => {
	it('sets subscribed = 1 only, with counts; with no token it never calls Postmark (#285 note)', async () => {
		const a = await contact('a@b.test', 0);
		const b = await contact('b@b.test', 1);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const out = (await contactActions.bulkResubscribe(
			contactsEvent('bulkResubscribe', { contact_ids: [a, b].map(String) })
		)) as any;
		expect(out.bulkSuccess).toBe('Resubscribed 1 · 1 already subscribed · Postmark not configured, suppressions not checked');
		expect(await subscribed(a)).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('deliverability filters', () => {
	it('bounced=hard|any and spam=1', async () => {
		const hard = await contact('hard@b.test');
		const bad = await contact('bad@b.test');
		const inactive = await contact('inactive@b.test');
		const soft = await contact('soft@b.test');
		const spam = await contact('spam@b.test');
		const spamRow = await contact('spamrow@b.test');
		await contact('clean@b.test');
		await event(null, null, hard, 'bounce', { Type: 'HardBounce' });
		await event(null, null, bad, 'bounce', { Type: 'BadEmailAddress' });
		await event(null, null, inactive, 'bounce', { Type: 'SpamNotification', Inactive: true });
		await event(null, null, soft, 'bounce', { Type: 'SoftBounce', Inactive: false });
		await event(null, null, spam, 'spam', { RecordType: 'SpamComplaint' });
		await db
			.prepare("INSERT INTO unsubscribes (contact_id, email, reason) VALUES (NULL, 'spamrow@b.test', 'Marked as spam')")
			.run();
		// A truncated (invalid JSON) payload must not break the query.
		await db
			.prepare("INSERT INTO events (contact_id, type, detail) VALUES (?, 'bounce', ?)")
			.bind(soft, '{"Type":"SoftBounce","Content":"abc')
			.run();

		expect(await filterIds({ bounced: 'hard' })).toEqual([hard, bad, inactive]);
		expect(await filterIds({ bounced: 'any' })).toEqual([hard, bad, inactive, soft]);
		expect(await filterIds({ spam: '1' })).toEqual([spam, spamRow]);
		expect(await filterIds({ bounced: 'junk' })).toHaveLength(7); // ignored
	});

	it('campaign=<id>&campaign_who=… picks that campaign’s recipients by segment', async () => {
		const c = await campaign();
		const other = await campaign();
		const ids: Record<string, number> = {};
		const rids: Record<string, number> = {};
		for (const name of ['clicker', 'opener', 'quiet', 'bouncer', 'unsub', 'unsubpage']) {
			ids[name] = await contact(`${name}@b.test`);
			rids[name] = await recipient(c, ids[name], `${name}@b.test`);
		}
		const outsider = await contact('outsider@b.test');
		const orid = await recipient(other, outsider, 'outsider@b.test');
		await event(other, orid, outsider, 'bounce', { Type: 'HardBounce' });
		await event(c, rids.clicker, ids.clicker, 'open');
		await event(c, rids.clicker, ids.clicker, 'click');
		await event(c, rids.opener, ids.opener, 'open');
		await event(c, rids.bouncer, ids.bouncer, 'bounce', { Type: 'HardBounce' });
		await event(c, rids.unsub, ids.unsub, 'unsubscribe');
		await db
			.prepare("INSERT INTO unsubscribes (contact_id, campaign_id, email, reason) VALUES (?, ?, 'unsubpage@b.test', 'Too many emails')")
			.bind(ids.unsubpage, c)
			.run();

		const who = (w: string) => filterIds({ campaign: String(c), campaign_who: w });
		expect(await who('bounced')).toEqual([ids.bouncer]);
		expect(await who('clicked')).toEqual([ids.clicker]);
		expect(await who('opened')).toEqual([ids.opener]);
		expect(await who('opens')).toEqual([ids.clicker, ids.opener]);
		expect(await who('none')).toEqual([ids.quiet, ids.unsub, ids.unsubpage]);
		expect(await who('unsubscribed')).toEqual([ids.unsub, ids.unsubpage]);
		expect(await filterIds({ campaign: String(c) })).toHaveLength(6); // every recipient
		expect(await campaignWhoCount(db, c, 'bounced')).toBe(1);

		// "Open in Contacts" → select all → unsubscribe the bounced.
		const out = (await contactActions.bulkUnsubscribe(
			contactsEvent('bulkUnsubscribe', { all: '1', campaign: String(c), campaign_who: 'bounced' })
		)) as any;
		expect(out.bulkSuccess).toBe('Unsubscribed 1');
		expect(await subscribed(ids.bouncer)).toBe(0);
		expect(await subscribed(outsider)).toBe(1);
	});

	it('segment rules bounced / spam_complaint compile to the same sets', async () => {
		const hard = await contact('hard@b.test');
		const soft = await contact('soft@b.test');
		const spam = await contact('spam@b.test');
		await event(null, null, hard, 'bounce', { Type: 'HardBounce' });
		await event(null, null, soft, 'bounce', { Type: 'SoftBounce' });
		await event(null, null, spam, 'spam');
		const run = async (field: string, op: string) => {
			const seg = compileSegment({ match: 'all', rules: [{ field, op }] });
			if (!seg) throw new Error('no segment');
			const rows = await db.prepare(`SELECT id FROM (${seg.sql}) ORDER BY id`).bind(...seg.binds).all<{ id: number }>();
			return rows.results.map((r) => r.id);
		};
		expect(await run('bounced', 'hard')).toEqual([hard]);
		expect(await run('bounced', 'any')).toEqual([hard, soft]);
		expect(await run('bounced', 'none')).toEqual([spam]);
		expect(await run('spam_complaint', 'yes')).toEqual([spam]);
		expect(await run('spam_complaint', 'no')).toEqual([hard, soft]);
	});
});

describe('POST /api/v1/contacts/bulk unsubscribe / resubscribe', () => {
	async function key(): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare("INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES ('t', ?, ?, ?, 'read_write')")
			.bind(k.tokenHash, k.prefix, k.last4)
			.run();
		return k.token;
	}
	async function call(token: string, body: unknown) {
		const url = new URL('https://app.test/api/v1/contacts/bulk');
		const res = await bulkApi({
			request: new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify(body)
			}),
			platform: { env },
			url,
			params: {}
		} as any);
		return { status: res.status, body: JSON.parse(await res.text()) };
	}

	it('unsubscribes by filter and resubscribes by ids', async () => {
		const t = await key();
		const a = await contact('a@b.test');
		const b = await contact('b@b.test');
		await event(null, null, a, 'bounce', { Type: 'HardBounce' });

		const un = await call(t, { action: 'unsubscribe', filter: { bounced: 'hard' }, suppress: false });
		expect(un.status).toBe(200);
		expect(un.body.data).toMatchObject({ action: 'unsubscribe', matched: 1, affected: 1, skipped: 0, message: 'Unsubscribed 1' });
		expect(await subscribed(a)).toBe(0);
		expect(await subscribed(b)).toBe(1);

		expect((await call(t, { action: 'unsubscribe', ids: [a], suppress: 'yes' })).status).toBe(400);

		const re = await call(t, { action: 'resubscribe', ids: [a, b] });
		expect(re.body.data).toMatchObject({ affected: 1, skipped: 1, message: 'Resubscribed 1 · 1 already subscribed · Postmark not configured, suppressions not checked' });
		expect(await subscribed(a)).toBe(1);
	});
});

// #279 × #280: the deliverability filters compose with the Active / Archived view.
describe('deliverability filters × archived view', () => {
	const archive = (id: number) => db.prepare("UPDATE contacts SET archived_at = datetime('now') WHERE id = ?").bind(id).run();

	it('default view drops archived matches; archived=1 shows only them; counts follow the Active view', async () => {
		const active = await contact('active@b.test');
		const gone = await contact('gone@b.test');
		await event(null, null, active, 'bounce', { Type: 'HardBounce' });
		await event(null, null, gone, 'bounce', { Type: 'HardBounce' });
		const cid = await campaign();
		await recipient(cid, active, 'active@b.test');
		await recipient(cid, gone, 'gone@b.test');
		await archive(gone);

		expect(await filterIds({ bounced: 'hard' })).toEqual([active]);
		expect(await filterIds({ bounced: 'hard', archived: '1' })).toEqual([gone]);
		expect(await filterIds({ bounced: 'hard', archived: 'all' })).toEqual([active, gone]);
		expect(await filterIds({ campaign: String(cid), campaign_who: 'sent' })).toEqual([active]);
		expect(await filterIds({ campaign: String(cid), campaign_who: 'sent', archived: '1' })).toEqual([gone]);
		expect(await campaignWhoCount(db, cid, 'sent')).toBe(1);
	});

	it('"all matching" unsubscribe honours both: Active view skips archived, Archived view unsubscribes them', async () => {
		const active = await contact('active@b.test');
		const gone = await contact('gone@b.test');
		await event(null, null, active, 'bounce', { Type: 'HardBounce' });
		await event(null, null, gone, 'bounce', { Type: 'HardBounce' });
		await archive(gone);

		const inActive = (await contactActions.bulkUnsubscribe(contactsEvent('bulkUnsubscribe', { all: '1', bounced: 'hard' }))) as any;
		expect(inActive.bulkSuccess).toBe('Unsubscribed 1');
		expect([await subscribed(active), await subscribed(gone)]).toEqual([0, 1]);

		const inArchived = (await contactActions.bulkUnsubscribe(
			contactsEvent('bulkUnsubscribe', { all: '1', bounced: 'hard', archived: '1' })
		)) as any;
		expect(inArchived.bulkSuccess).toBe('Unsubscribed 1');
		expect(await subscribed(gone)).toBe(0);
		// Still archived: unsubscribing doesn't restore.
		expect(await count('SELECT COUNT(*) AS n FROM contacts WHERE id = ? AND archived_at IS NOT NULL', gone)).toBe(1);

		// Checked rows in the Archived view work too.
		const re = (await contactActions.bulkResubscribe(contactsEvent('bulkResubscribe', { contact_ids: [String(gone)] }))) as any;
		expect(re.bulkSuccess).toBe('Resubscribed 1 · Postmark not configured, suppressions not checked');
	});
});
