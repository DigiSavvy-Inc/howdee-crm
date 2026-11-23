import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/lists/[id]/+page.server';
import {
	DEFAULT_DIR,
	DEFAULT_SORT,
	emptyFilter,
	filterParams,
	isFiltered,
	memberQuery,
	parseFilter
} from '../src/lib/server/contact-filter';

const db = (env as any).DB as D1Database;

function makeEvent(action: string, listId: number, formEntries: Record<string, string | string[]>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(formEntries)) {
		if (Array.isArray(v)) for (const item of v) fd.append(k, item);
		else fd.append(k, v);
	}
	return {
		platform: { env },
		params: { id: String(listId) },
		request: new Request(`https://app.test/lists/${listId}?/${action}`, { method: 'POST', body: fd })
	} as any;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const r = await db.prepare(sql).bind(...binds).first<{ n: number }>();
	return r?.n ?? 0;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM events'),
		db.prepare('DELETE FROM recipients'),
		db.prepare('DELETE FROM replies'),
		db.prepare('DELETE FROM unsubscribes'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare('DELETE FROM automations'),
		db.prepare('DELETE FROM list_members'),
		db.prepare('DELETE FROM campaigns'),
		db.prepare('DELETE FROM lists'),
		db.prepare('DELETE FROM contacts')
	]);
});

describe('parseFilter (#member-filter)', () => {
	it('defaults to an unfiltered, added-desc view when given nothing', () => {
		const f = parseFilter(new URLSearchParams());
		expect(f).toEqual(emptyFilter());
		expect(f.status).toBe('all');
		expect(f.sort).toBe(DEFAULT_SORT);
		expect(f.dir).toBe(DEFAULT_DIR);
		expect(isFiltered(f)).toBe(false);
	});

	it('clamps status to all/subscribed/pending and rejects junk', () => {
		expect(parseFilter(new URLSearchParams('status=subscribed')).status).toBe('subscribed');
		expect(parseFilter(new URLSearchParams('status=pending')).status).toBe('pending');
		// #705: no Unsubscribed view of a group's members (they're hidden; see /contacts).
		expect(parseFilter(new URLSearchParams('status=unsubscribed')).status).toBe('all');
		expect(parseFilter(new URLSearchParams('status=bogus')).status).toBe('all');
		expect(parseFilter(new URLSearchParams('status=')).status).toBe('all');
	});

	it('clamps sort to the known keys, unknown falls back to the default', () => {
		expect(parseFilter(new URLSearchParams('sort=email')).sort).toBe('email');
		expect(parseFilter(new URLSearchParams('sort=nonsense')).sort).toBe(DEFAULT_SORT);
		expect(parseFilter(new URLSearchParams('dir=asc')).dir).toBe('asc');
		expect(parseFilter(new URLSearchParams('dir=sideways')).dir).toBe('desc');
	});

	it('only rejects malformed dates, not well-formed ones', () => {
		expect(parseFilter(new URLSearchParams('added_from=2026-01-15')).addedFrom).toBe('2026-01-15');
		expect(parseFilter(new URLSearchParams('added_from=not-a-date')).addedFrom).toBe('');
		expect(parseFilter(new URLSearchParams('added_from=01/15/2026')).addedFrom).toBe('');
	});

	it('round-trips through filterParams for non-default values only', () => {
		const f = parseFilter(new URLSearchParams('q=jane&status=subscribed&sort=email&dir=asc'));
		expect(filterParams(f)).toEqual({ q: 'jane', status: 'subscribed', sort: 'email', dir: 'asc' });
		// default sort/dir don't round-trip (keeps URLs clean)
		expect(filterParams(parseFilter(new URLSearchParams('q=jane')))).toEqual({ q: 'jane' });
	});

	it('accepts FormData too (used to re-resolve "all matching" server-side)', () => {
		const fd = new FormData();
		fd.set('q', 'gmail');
		fd.set('status', 'subscribed');
		const f = parseFilter(fd);
		expect(f.q).toBe('gmail');
		expect(f.status).toBe('subscribed');
	});
});

describe('memberQuery LIKE escaping (#member-filter)', () => {
	let listId: number;

	beforeEach(async () => {
		listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>())!.id;
		const literal = (await db.prepare("INSERT INTO contacts (email) VALUES ('has-percent@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const other = (await db.prepare("INSERT INTO contacts (email) VALUES ('nopercent@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			// literal '%' in source — must not silently match everything as a wildcard would
			db.prepare('UPDATE contacts SET source = ? WHERE id = ?').bind('50%off', literal),
			db.prepare('UPDATE contacts SET source = ? WHERE id = ?').bind('csv-import', other),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, literal),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, other)
		]);
	});

	async function matchedEmails(f: ReturnType<typeof parseFilter>): Promise<string[]> {
		const { where, params, orderBy } = memberQuery(listId, f);
		const rows = await db
			.prepare(`SELECT c.email FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${where} ORDER BY ${orderBy}`)
			.bind(...params)
			.all<{ email: string }>();
		return rows.results.map((r) => r.email);
	}

	it('a literal % in the source filter matches only the literal text, not everything', async () => {
		const f = parseFilter(new URLSearchParams('source=50%25off')); // %25 = URL-encoded '%'
		expect(await matchedEmails(f)).toEqual(['has-percent@x.example.net']);
	});

	it('a literal % that is not present in any row matches nothing (proves % is not a wildcard)', async () => {
		const f = parseFilter(new URLSearchParams('source=xyz%25'));
		expect(await matchedEmails(f)).toEqual([]);
	});

	it('an underscore in the filter is escaped, not treated as a single-char wildcard', async () => {
		// Row A has a literal underscore; row B has some other char in that position.
		// If '_' in the *filter* text were left as a real SQL wildcard, searching for
		// "a_b" would incorrectly also match "aXb". It must match only the literal.
		const literalUnderscore = (await db
			.prepare("INSERT INTO contacts (email) VALUES ('under-score@x.example.net') RETURNING id")
			.first<{ id: number }>())!.id;
		const otherChar = (await db
			.prepare("INSERT INTO contacts (email) VALUES ('other-char@x.example.net') RETURNING id")
			.first<{ id: number }>())!.id;
		await db.batch([
			db.prepare('UPDATE contacts SET source = ? WHERE id = ?').bind('a_b', literalUnderscore),
			db.prepare('UPDATE contacts SET source = ? WHERE id = ?').bind('aXb', otherChar),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, literalUnderscore),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, otherChar)
		]);
		expect(await matchedEmails(parseFilter(new URLSearchParams('source=a_b')))).toEqual(['under-score@x.example.net']);
	});
});

describe('list_members.added_at default (#member-filter)', () => {
	it('defaults to a current timestamp when not supplied on insert', async () => {
		const listId = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('L', 'list') RETURNING id").first<{ id: number }>())!.id;
		const contactId = (await db.prepare("INSERT INTO contacts (email) VALUES ('new@x.example.net') RETURNING id").first<{ id: number }>())!.id;

		const before = new Date();
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, contactId).run();
		const row = await db
			.prepare('SELECT added_at FROM list_members WHERE list_id = ? AND contact_id = ?')
			.bind(listId, contactId)
			.first<{ added_at: string }>();

		expect(row?.added_at).toBeTruthy();
		const added = new Date(row!.added_at.replace(' ', 'T') + 'Z');
		expect(added.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
		expect(added.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
	});
});

describe('in / notin group filters (#member-filter)', () => {
	it('"also in" restricts to contacts who are also members of another group', async () => {
		const listA = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('A', 'list') RETURNING id").first<{ id: number }>())!.id;
		const tagHot = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('hot', 'tag') RETURNING id").first<{ id: number }>())!.id;
		const c1 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c1@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const c2 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c2@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c1),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c2),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(tagHot, c1)
		]);

		const f = parseFilter(new URLSearchParams(`in=${tagHot}`));
		const { where, params } = memberQuery(listA, f);
		const rows = await db
			.prepare(`SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${where}`)
			.bind(...params)
			.all<{ id: number }>();
		expect(rows.results.map((r) => r.id)).toEqual([c1]);
	});

	it('"not in" excludes contacts who are members of another group', async () => {
		const listA = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('A', 'list') RETURNING id").first<{ id: number }>())!.id;
		const tagHot = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('hot', 'tag') RETURNING id").first<{ id: number }>())!.id;
		const c1 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c1@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		const c2 = (await db.prepare("INSERT INTO contacts (email) VALUES ('c2@x.example.net') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c1),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c2),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(tagHot, c1)
		]);

		const f = parseFilter(new URLSearchParams(`notin=${tagHot}`));
		const { where, params } = memberQuery(listA, f);
		const rows = await db
			.prepare(`SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${where}`)
			.bind(...params)
			.all<{ id: number }>();
		expect(rows.results.map((r) => r.id)).toEqual([c2]);
	});
});

describe('server-side "all matching" resolution for bulk actions (#member-filter)', () => {
	it('addTo with select_all re-resolves ids from the posted filter, ignoring any contact_ids in the form', async () => {
		const listA = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('A', 'list') RETURNING id").first<{ id: number }>())!.id;
		const subbed = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('sub@x.example.net', 1) RETURNING id").first<{ id: number }>())!.id;
		const unsubbed = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('unsub@x.example.net', 0) RETURNING id").first<{ id: number }>())!.id;
		const decoy = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('decoy@x.example.net', 1) RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, subbed),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, unsubbed)
		]);

		const res = await actions.addTo(
			makeEvent('addTo', listA, {
				select_all: '1',
				status: 'subscribed', // filter: only the subscribed member of listA
				new_name: 'Subscribed From A',
				// a spoofed id NOT in listA and NOT matching the filter — must be ignored
				contact_ids: String(decoy)
			})
		);
		expect((res as any).bulkSuccess).toMatch(/^Added 1 to/);

		const seg = await db.prepare("SELECT id FROM lists WHERE name = 'Subscribed From A' AND kind = 'segment'").first<{ id: number }>();
		expect(seg).toBeTruthy();
		const members = await db.prepare('SELECT contact_id FROM list_members WHERE list_id = ?').bind(seg!.id).all<{ contact_id: number }>();
		expect(members.results.map((m) => m.contact_id)).toEqual([subbed]);
		// the decoy id from contact_ids must NOT have been added — select_all ignores it
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', seg!.id, decoy)).toBe(0);
	});

	it('bulkTag with select_all tags every matching contact and none outside the filter', async () => {
		const listA = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('A', 'list') RETURNING id").first<{ id: number }>())!.id;
		const c1 = (await db.prepare("INSERT INTO contacts (email, source) VALUES ('c1@x.example.net', 'csv') RETURNING id").first<{ id: number }>())!.id;
		const c2 = (await db.prepare("INSERT INTO contacts (email, source) VALUES ('c2@x.example.net', 'manual') RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c1),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, c2)
		]);

		const res = await actions.bulkTag(
			makeEvent('bulkTag', listA, { select_all: '1', source: 'csv', tag: 'imported' })
		);
		expect((res as any).bulkSuccess).toMatch(/^Tagged 1 with/);

		const tag = await db.prepare("SELECT id FROM lists WHERE name = 'imported' AND kind = 'tag'").first<{ id: number }>();
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', tag!.id, c1)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', tag!.id, c2)).toBe(0);
	});

	it('removeMembers with select_all removes only the filter-matching members, capped server-side', async () => {
		const listA = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('A', 'list') RETURNING id").first<{ id: number }>())!.id;
		// #705: members are the active audience, so the filter picks pending vs subscribed.
		const match = (await db.prepare("INSERT INTO contacts (email, subscribed, confirm_pending) VALUES ('match@x.example.net', 0, 1) RETURNING id").first<{ id: number }>())!.id;
		const keep = (await db.prepare("INSERT INTO contacts (email, subscribed) VALUES ('keep@x.example.net', 1) RETURNING id").first<{ id: number }>())!.id;
		await db.batch([
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, match),
			db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listA, keep)
		]);

		const res = await actions.removeMembers(
			makeEvent('removeMembers', listA, { select_all: '1', status: 'pending' })
		);
		expect((res as any).bulkSuccess).toMatch(/^Removed/);
		expect((res as any).affected).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', listA, keep)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND contact_id = ?', listA, match)).toBe(0);
	});

	it('select_all is blocked for kind=company just like an explicit id list is', async () => {
		const co = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Acme', 'company') RETURNING id").first<{ id: number }>())!.id;
		const c1 = (await db.prepare("INSERT INTO contacts (email, company) VALUES ('emp@x.example.net', 'Acme') RETURNING id").first<{ id: number }>())!.id;
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(co, c1).run();

		const res = await actions.removeMembers(makeEvent('removeMembers', co, { select_all: '1' }));
		expect((res as any).status).toBe(400);
		expect((res as any).data?.bulkError).toMatch(/Cannot remove/i);
		expect(await count('SELECT COUNT(*) AS n FROM list_members WHERE list_id = ?', co)).toBe(1);
	});
});
