import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions as contactActions } from '../src/routes/contacts/+page.server';
import { actions as listActions } from '../src/routes/lists/[id]/+page.server';
import { POST as bulkApi } from '../src/routes/api/v1/contacts/bulk/+server';
import { generateApiKey, type ApiScope } from '../src/lib/server/api-keys';
import { BULK_CAP } from '../src/lib/server/contact-bulk';

// Bulk bar + Data API (#214): every action in both selection modes (checked ids, and
// `all=1` + the page filter re-run server-side), the 20k cap, 500-row chunking,
// idempotency and remove-from-list on /lists/[id].
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
const ids = (...n: number[]) => n.map(String);

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const r = await db.prepare(sql).bind(...binds).first<{ n: number }>();
	return r?.n ?? 0;
}
async function contact(email: string, extra: { company_id?: number; subscribed?: number } = {}): Promise<number> {
	return (await db
		.prepare('INSERT INTO contacts (email, company_id, subscribed) VALUES (?, ?, ?) RETURNING id')
		.bind(email, extra.company_id ?? null, extra.subscribed ?? 1)
		.first<{ id: number }>())!.id;
}
async function group(name: string, kind: string): Promise<number> {
	return (await db.prepare('INSERT INTO lists (name, kind) VALUES (?, ?) RETURNING id').bind(name, kind).first<{ id: number }>())!.id;
}
async function join(listId: number, ...contactIds: number[]) {
	await db.batch(contactIds.map((c) => db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c)));
}
const members = (listId: number) => count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', listId);
const isMember = (listId: number, contactId: number) =>
	count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', listId, contactId);

/** Bulk-insert n contacts in one statement (cap/chunk tests); returns their company id. */
async function many(n: number, tag: string): Promise<number> {
	const co = (await db.prepare('INSERT INTO companies (name) VALUES (?) RETURNING id').bind(tag).first<{ id: number }>())!.id;
	await db
		.prepare(
			`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
			 INSERT INTO contacts (email, company_id) SELECT 'm' || i || '@${tag}.test', ? FROM seq`
		)
		.bind(n, co)
		.run();
	return co;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM api_keys'),
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('UPDATE automation_steps SET parent_step_id = NULL'),
		db.prepare('DELETE FROM automation_steps'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts'),
		db.prepare('DELETE FROM companies')
	]);
});

describe('/contacts bulk: add to list / remove from list', () => {
	it('adds checked ids, is idempotent, and reports "already there"', async () => {
		const news = await group('Newsletter', 'list');
		const a = await contact('a@b.test');
		const b = await contact('b@b.test');
		const first = await contactActions.addToList(contactsEvent('addToList', { list_id: String(news), contact_ids: ids(a, b) }));
		expect(first).toMatchObject({ affected: 2, skipped: 0, bulkSuccess: 'Added 2 to “Newsletter”' });
		const again = await contactActions.addToList(contactsEvent('addToList', { list_id: String(news), contact_ids: ids(a, b) }));
		expect(again).toMatchObject({ affected: 0, skipped: 2, bulkSuccess: 'Added 0 to “Newsletter” · 2 already there' });
		expect(await members(news)).toBe(2);
	});

	it('creates a new list inline and adds every contact matching the filter (all=1), ignoring stray ids', async () => {
		const acme = (await db.prepare("INSERT INTO companies (name) VALUES ('Acme') RETURNING id").first<{ id: number }>())!.id;
		const in1 = await contact('1@acme.test', { company_id: acme });
		const in2 = await contact('2@acme.test', { company_id: acme });
		const out = await contact('x@other.test');
		const res = await contactActions.addToList(
			contactsEvent('addToList', { all: '1', company_id: String(acme), new_list: 'Acme people', contact_ids: ids(out) })
		);
		expect(res).toMatchObject({ affected: 2 });
		const list = await db.prepare("SELECT id FROM lists WHERE name = 'Acme people' AND kind = 'list'").first<{ id: number }>();
		expect(await isMember(list!.id, in1)).toBe(1);
		expect(await isMember(list!.id, in2)).toBe(1);
		expect(await isMember(list!.id, out)).toBe(0);
	});

	it('fires list_added automations for the newly added contacts only', async () => {
		const news = await group('Newsletter', 'list');
		const aid = (await db
			.prepare("INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES ('Welcome', 'active', 'list_added', ?) RETURNING id")
			.bind(news)
			.first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
				 VALUES (?, 0, 0, '', '', '', 'tag', 'add', 'welcomed')`
			)
			.bind(aid)
			.run();
		const a = await contact('a@b.test');
		await contactActions.addToList(contactsEvent('addToList', { list_id: String(news), contact_ids: ids(a) }));
		expect(await count('SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', aid, a)).toBe(1);
	});

	it('removes from a list in both modes and counts the ones that were not in it', async () => {
		const news = await group('Newsletter', 'list');
		const a = await contact('a@b.test', { subscribed: 0 });
		const b = await contact('b@b.test');
		const c = await contact('c@b.test', { subscribed: 0 });
		await join(news, a, b);
		const one = await contactActions.removeFromList(contactsEvent('removeFromList', { list_id: String(news), contact_ids: ids(b, c) }));
		expect(one).toMatchObject({ affected: 1, skipped: 1, bulkSuccess: 'Removed 1 from “Newsletter” · 1 weren\'t in it' });
		await join(news, b);
		const all = await contactActions.removeFromList(contactsEvent('removeFromList', { list_id: String(news), all: '1', status: 'unsubscribed' }));
		expect(all).toMatchObject({ affected: 1 });
		expect(await isMember(news, a)).toBe(0);
		expect(await isMember(news, b)).toBe(1);
	});

	it('refuses a derived company group', async () => {
		const co = await group('Acme', 'company');
		const a = await contact('a@b.test');
		await join(co, a);
		const res = await contactActions.removeFromList(contactsEvent('removeFromList', { list_id: String(co), contact_ids: ids(a) }));
		expect(res).toMatchObject({ status: 404 }); // not a list/segment target from /contacts
		expect(await members(co)).toBe(1);
	});
});

describe('/contacts bulk: tags', () => {
	it('adds and removes a tag for checked ids and for all matching', async () => {
		const a = await contact('a@b.test');
		const b = await contact('b@b.test', { subscribed: 0 });
		// #705: status=all — the default view (and its "all matching") leaves unsubscribed b out.
		const added = await contactActions.bulkTag(contactsEvent('bulkTag', { tag: 'vip', all: '1', status: 'all' }));
		expect(added).toMatchObject({ affected: 2, bulkSuccess: 'Tagged 2 with “vip”' });
		const tag = (await db.prepare("SELECT id FROM lists WHERE name = 'vip' AND kind = 'tag'").first<{ id: number }>())!.id;

		const again = await contactActions.bulkTag(contactsEvent('bulkTag', { tag: 'VIP', contact_ids: ids(a) }));
		expect(again).toMatchObject({ affected: 0, skipped: 1 }); // same tag (NOCASE), idempotent

		const removed = await contactActions.removeTag(contactsEvent('removeTag', { tag: 'vip', all: '1', status: 'unsubscribed' }));
		expect(removed).toMatchObject({ affected: 1, bulkSuccess: 'Removed tag “vip” from 1' });
		expect(await isMember(tag, a)).toBe(1);
		expect(await isMember(tag, b)).toBe(0);

		const byId = await contactActions.removeTag(contactsEvent('removeTag', { tag: 'vip', contact_ids: ids(a, b) }));
		expect(byId).toMatchObject({ affected: 1, bulkSuccess: 'Removed tag “vip” from 1 · 1 didn\'t have it' });
	});

	it('reports an unknown tag on remove', async () => {
		const a = await contact('a@b.test');
		const res = await contactActions.removeTag(contactsEvent('removeTag', { tag: 'nope', contact_ids: ids(a) }));
		expect(res).toMatchObject({ status: 404 });
	});
});

describe('/contacts bulk: segment, enroll, delete on the shared helper', () => {
	it('adds to a new segment', async () => {
		const a = await contact('a@b.test');
		const res = await contactActions.addToSegment(contactsEvent('addToSegment', { new_segment: 'Hot', contact_ids: ids(a) }));
		expect(res).toMatchObject({ affected: 1, bulkSuccess: 'Added 1 to “Hot”' });
		expect(await count("SELECT COUNT(*) AS n FROM lists WHERE name = 'Hot' AND kind = 'segment'")).toBe(1);
	});

	it('enrolls all matching into an active automation', async () => {
		const aid = (await db.prepare("INSERT INTO automations (name, status) VALUES ('Drip', 'active') RETURNING id").first<{ id: number }>())!.id;
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
				 VALUES (?, 0, 0, '', '', '', 'tag', 'add', 'x')`
			)
			.bind(aid)
			.run();
		await contact('a@b.test');
		await contact('b@b.test', { subscribed: 0 });
		const res = await contactActions.addToAutomation(contactsEvent('addToAutomation', { automation_id: String(aid), all: '1', status: 'all' }));
		expect(res).toMatchObject({ affected: 1, skipped: 1, bulkHref: `/automations/${aid}` });
	});

	it('deletes checked ids without a typed confirm, but all matching only with "delete"', async () => {
		const a = await contact('a@b.test');
		await contact('b@b.test', { subscribed: 0 });
		await contact('c@b.test', { subscribed: 0 });
		expect(await contactActions.deleteContacts(contactsEvent('deleteContacts', { contact_ids: ids(a) }))).toMatchObject({
			affected: 1,
			bulkSuccess: 'Deleted 1 contact'
		});
		const refused = await contactActions.deleteContacts(contactsEvent('deleteContacts', { all: '1', status: 'unsubscribed' }));
		expect(refused).toMatchObject({ status: 400 });
		expect(await count('SELECT COUNT(*) AS n FROM contacts')).toBe(2);
		const ok = await contactActions.deleteContacts(
			contactsEvent('deleteContacts', { all: '1', status: 'unsubscribed', confirm: 'DELETE' })
		);
		expect(ok).toMatchObject({ affected: 2, bulkSuccess: 'Deleted 2 contacts' });
		expect(await count('SELECT COUNT(*) AS n FROM contacts')).toBe(0);
	});
});

describe('cap + chunking', () => {
	it('works across 500-row chunks for all matching (add, tag, remove, delete)', async () => {
		const co = await many(1203, 'chunk');
		const news = await group('Newsletter', 'list');
		const filter = { all: '1', company_id: String(co) };
		expect(await contactActions.addToList(contactsEvent('addToList', { ...filter, list_id: String(news) }))).toMatchObject({
			affected: 1203,
			bulkSuccess: 'Added 1,203 to “Newsletter”'
		});
		expect(await members(news)).toBe(1203);
		expect(await contactActions.removeFromList(contactsEvent('removeFromList', { ...filter, list_id: String(news) }))).toMatchObject({
			affected: 1203
		});
		expect(await contactActions.deleteContacts(contactsEvent('deleteContacts', { ...filter, confirm: 'delete' }))).toMatchObject({
			affected: 1203
		});
		expect(await count('SELECT COUNT(*) AS n FROM contacts')).toBe(0);
	});

	it(`refuses more than ${BULK_CAP} matching contacts and changes nothing`, async () => {
		await many(BULK_CAP + 1, 'cap');
		const res = await contactActions.bulkTag(contactsEvent('bulkTag', { all: '1', tag: 'big' }));
		expect(res).toMatchObject({ status: 400 });
		expect((res as any).data.bulkError).toMatch(/20,001 contacts.*capped at 20,000/);
		expect(await count("SELECT COUNT(*) AS n FROM lists WHERE name = 'big'")).toBe(0);
	});
});

describe('/lists/[id] bulk', () => {
	it('removes from the current list by default (no list_id), in both modes', async () => {
		const news = await group('Newsletter', 'list');
		const a = await contact('a@b.test');
		const b = await contact('b@b.test', { subscribed: 0 });
		// #705: a group's member table is the active audience, so the filter picks pending b.
		await db.prepare('UPDATE contacts SET confirm_pending = 1 WHERE id = ?').bind(b).run();
		const c = await contact('c@b.test');
		await join(news, a, b, c);
		expect(await listActions.removeFromList(listEvent('removeFromList', news, { contact_ids: ids(a) }))).toMatchObject({ affected: 1 });
		expect(await listActions.removeFromList(listEvent('removeFromList', news, { all: '1', status: 'pending' }))).toMatchObject({
			affected: 1
		});
		expect(await isMember(news, c)).toBe(1);
		expect(await members(news)).toBe(1);
	});

	it('removes from another list the selection is in, and from the current tag page', async () => {
		const news = await group('Newsletter', 'list');
		const other = await group('Other', 'list');
		const vip = await group('vip', 'tag');
		const a = await contact('a@b.test');
		await join(news, a);
		await join(other, a);
		await join(vip, a);
		await listActions.removeFromList(listEvent('removeFromList', news, { list_id: String(other), all: '1' }));
		expect(await isMember(other, a)).toBe(0);
		expect(await isMember(news, a)).toBe(1);
		await listActions.removeFromList(listEvent('removeFromList', vip, { contact_ids: ids(a) }));
		expect(await isMember(vip, a)).toBe(0);
	});

	it('adds all members of a list to another list and tags them', async () => {
		const news = await group('Newsletter', 'list');
		const target = await group('Target', 'list');
		const a = await contact('a@b.test');
		const b = await contact('b@b.test');
		await contact('c@b.test'); // not in Newsletter
		await join(news, a, b);
		expect(await listActions.addToList(listEvent('addToList', news, { all: '1', list_id: String(target) }))).toMatchObject({ affected: 2 });
		expect(await listActions.bulkTag(listEvent('bulkTag', news, { all: '1', tag: 'members' }))).toMatchObject({ affected: 2 });
		expect(await members(target)).toBe(2);
	});
});

describe('POST /api/v1/contacts/bulk', () => {
	async function key(scope: ApiScope): Promise<string> {
		const k = await generateApiKey();
		await db
			.prepare('INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)')
			.bind('t', k.tokenHash, k.prefix, k.last4, scope)
			.run();
		return k.token;
	}
	function call(token: string | undefined, body: unknown) {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (token) headers.authorization = `Bearer ${token}`;
		const url = new URL('https://app.test/api/v1/contacts/bulk');
		return bulkApi({
			request: new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
			platform: { env },
			url,
			params: {}
		} as any);
	}
	const json = async (res: Response) => JSON.parse(await res.text());

	it('needs a read_write key', async () => {
		expect((await call(undefined, { action: 'delete', ids: [1] })).status).toBe(401);
		expect((await call(await key('read'), { action: 'delete', ids: [1] })).status).toBe(403);
	});

	it('validates the body', async () => {
		const t = await key('read_write');
		expect((await call(t, { action: 'nuke', ids: [1] })).status).toBe(400);
		expect((await call(t, { action: 'add_tag', tag: 'x' })).status).toBe(400); // neither ids nor filter
		expect((await call(t, { action: 'add_tag', tag: 'x', ids: [1], filter: {} })).status).toBe(400);
		expect((await call(t, { action: 'add_tag', ids: 5 })).status).toBe(400);
		expect((await call(t, { action: 'add_list', ids: [1] })).status).toBe(400); // list missing
	});

	it('adds to a list by name (created) for a filter, then removes it by id; shape { affected, skipped }', async () => {
		const t = await key('read_write');
		const acme = (await db.prepare("INSERT INTO companies (name) VALUES ('Acme') RETURNING id").first<{ id: number }>())!.id;
		await contact('1@acme.test', { company_id: acme });
		await contact('2@acme.test', { company_id: acme });
		const other = await contact('x@other.test');
		const res = await call(t, { action: 'add_list', list: 'Acme list', filter: { company_id: acme } });
		expect(res.status).toBe(200);
		const d = (await json(res)).data;
		expect(d).toMatchObject({ action: 'add_list', matched: 2, affected: 2, skipped: 0 });
		const list = (await db.prepare("SELECT id FROM lists WHERE name = 'Acme list' AND kind = 'list'").first<{ id: number }>())!.id;
		const again = (await json(await call(t, { action: 'add_list', list, filter: { company_id: acme } }))).data;
		expect(again).toMatchObject({ affected: 0, skipped: 2 });
		const removed = (await json(await call(t, { action: 'remove_list', list, filter: { company_id: acme } }))).data;
		expect(removed).toMatchObject({ affected: 2 });
		expect((await call(t, { action: 'remove_list', list: 'No such list', ids: [other] })).status).toBe(404);
	});

	it('tags ids (unknown ids count as skipped), removes the tag', async () => {
		const t = await key('read_write');
		const a = await contact('a@b.test');
		const d = (await json(await call(t, { action: 'add_tag', tag: 'vip', ids: [a, 999999] }))).data;
		expect(d).toMatchObject({ affected: 1, skipped: 1 });
		expect((await json(await call(t, { action: 'remove_tag', tag: 'vip', ids: [a] }))).data).toMatchObject({ affected: 1 });
	});

	it('deletes by ids; a filter delete needs confirm "delete"', async () => {
		const t = await key('read_write');
		const a = await contact('a@b.test');
		await contact('b@b.test', { subscribed: 0 });
		expect((await json(await call(t, { action: 'delete', ids: [a] }))).data).toMatchObject({ affected: 1 });
		expect((await call(t, { action: 'delete', filter: { status: 'unsubscribed' } })).status).toBe(400);
		const ok = await call(t, { action: 'delete', filter: { status: 'unsubscribed' }, confirm: 'delete' });
		expect((await json(ok)).data).toMatchObject({ affected: 1 });
		expect(await count('SELECT COUNT(*) AS n FROM contacts')).toBe(0);
		// Nothing matching is not an error.
		expect((await json(await call(t, { action: 'delete', filter: { status: 'unsubscribed' }, confirm: 'delete' }))).data).toMatchObject({
			matched: 0,
			affected: 0
		});
	});
});
