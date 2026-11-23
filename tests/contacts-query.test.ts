import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	parseContactsFilter,
	contactsFilterParams,
	contactsWhere,
	isFiltered,
	isNarrowed,
	type ContactsFilter
} from '../src/lib/server/contacts-query';

const db = (env as any).DB as D1Database;

const EMPTY: ContactsFilter = {
	q: '',
	status: 'active', // #705: the default — subscribed or pending
	source: '',
	company: '',
	companyId: null,
	addedFrom: '',
	addedTo: '',
	inGroup: null,
	notInGroup: null,
	visited: '',
	visitedDays: null,
	site: 'all',
	hasCompany: '',
	metrics: [],
	tier: '',
	openedDays: null,
	neverOpened: false,
	openedN: null,
	openedOf: null,
	pipeline: null,
	bounced: '',
	spam: false,
	campaign: null,
	campaignWho: '',
	archived: undefined,
	hygiene: undefined,
	// #423 (contacts overview tiles)
	unsubFrom: '',
	cooledDays: null,
	awaiting: false,
	awaitingDays: null,
	noList: false,
	// #448
	topicOut: null,
	createdDays: null,
	// #467 (named scores)
	score: null,
	band: null,
	// #516 (submitted a form)
	form: null,
	formDays: null
};

describe('parseContactsFilter', () => {
	it('defaults to an unfiltered view when given nothing', () => {
		expect(parseContactsFilter(new URLSearchParams())).toEqual(EMPTY);
	});

	it('parses the #423 overview keys and ignores the period picker', () => {
		const f = parseContactsFilter(
			new URLSearchParams('unsub_from=2026-10-01&cooled_days=14&awaiting=1&awaiting_days=3&no_list=1')
		);
		expect(f.unsubFrom).toBe('2026-10-01');
		expect(f.cooledDays).toBe(14);
		expect(f.awaiting).toBe(true);
		expect(f.awaitingDays).toBe(3);
		expect(f.noList).toBe(true);
		// awaiting_days only counts alongside awaiting=1; junk dates are dropped
		expect(parseContactsFilter(new URLSearchParams('awaiting_days=3')).awaitingDays).toBeNull();
		expect(parseContactsFilter(new URLSearchParams('unsub_from=oct')).unsubFrom).toBe('');
		// `period` is the overview picker, not a filter: it parses to the empty view
		expect(parseContactsFilter(new URLSearchParams('period=30d'))).toEqual(EMPTY);
	});

	it('clamps status to all/subscribed/unsubscribed and rejects junk', () => {
		expect(parseContactsFilter(new URLSearchParams('status=subscribed')).status).toBe('subscribed');
		expect(parseContactsFilter(new URLSearchParams('status=unsubscribed')).status).toBe('unsubscribed');
		expect(parseContactsFilter(new URLSearchParams('status=bogus')).status).toBe('active');
		expect(parseContactsFilter(new URLSearchParams('status=')).status).toBe('active');
		expect(parseContactsFilter(new URLSearchParams('status=all')).status).toBe('all');
		expect(parseContactsFilter(new URLSearchParams('archived=1')).status).toBe('all');
		expect(parseContactsFilter(new URLSearchParams(), { defaultStatus: 'all' }).status).toBe('all');
		expect(contactsFilterParams({ ...EMPTY, status: 'all' })).toEqual({ status: 'all' });
	});

	it('only accepts well-formed YYYY-MM-DD dates', () => {
		expect(parseContactsFilter(new URLSearchParams('added_from=2026-01-15')).addedFrom).toBe(
			'2026-01-15'
		);
		expect(parseContactsFilter(new URLSearchParams('added_from=not-a-date')).addedFrom).toBe('');
		expect(parseContactsFilter(new URLSearchParams('added_to=01/15/2026')).addedTo).toBe('');
	});

	it('rejects a non-integer / non-positive "in" or "notin" group id', () => {
		expect(parseContactsFilter(new URLSearchParams('in=abc')).inGroup).toBeNull();
		expect(parseContactsFilter(new URLSearchParams('in=-3')).inGroup).toBeNull();
		expect(parseContactsFilter(new URLSearchParams('in=0')).inGroup).toBeNull();
		expect(parseContactsFilter(new URLSearchParams('in=4.5')).inGroup).toBeNull();
		expect(parseContactsFilter(new URLSearchParams('in=42')).inGroup).toBe(42);
		expect(parseContactsFilter(new URLSearchParams('notin=xyz')).notInGroup).toBeNull();
		expect(parseContactsFilter(new URLSearchParams('notin=7')).notInGroup).toBe(7);
	});

	it('trims and caps the company field to 120 chars', () => {
		const long = 'y'.repeat(200);
		const f = parseContactsFilter(new URLSearchParams({ company: `  ${long}  ` }));
		expect(f.company).toBe(long.slice(0, 120));
		expect(f.company.length).toBe(120);
	});
});

describe('isFiltered / isNarrowed', () => {
	it('q alone narrows the set but is not counted by isFiltered (the Filters-popover dot)', () => {
		const f = { ...EMPTY, q: 'jane' };
		expect(isFiltered(f)).toBe(false);
		expect(isNarrowed(f)).toBe(true);
	});

	it('any non-q field is both filtered and narrowed', () => {
		expect(isFiltered({ ...EMPTY, status: 'subscribed' })).toBe(true);
		expect(isFiltered({ ...EMPTY, company: 'acme' })).toBe(true);
		expect(isNarrowed({ ...EMPTY, inGroup: 3 })).toBe(true);
	});

	it('the empty filter is neither filtered nor narrowed', () => {
		expect(isFiltered(EMPTY)).toBe(false);
		expect(isNarrowed(EMPTY)).toBe(false);
		const parsed = parseContactsFilter(new URLSearchParams());
		expect(isFiltered(parsed)).toBe(false);
		expect(isNarrowed(parsed)).toBe(false);
		// the period picker never lights the Filters dot
		const withPeriod = parseContactsFilter(new URLSearchParams('period=7d'));
		expect(isFiltered(withPeriod)).toBe(false);
		expect(isNarrowed(withPeriod)).toBe(false);
	});

	it('each #423 key counts as a filter', () => {
		expect(isFiltered({ ...EMPTY, unsubFrom: '2026-10-01' })).toBe(true);
		expect(isFiltered({ ...EMPTY, cooledDays: 14 })).toBe(true);
		expect(isFiltered({ ...EMPTY, awaiting: true })).toBe(true);
		expect(isFiltered({ ...EMPTY, noList: true })).toBe(true);
	});
});

describe('contactsFilterParams', () => {
	it('omits empty/default fields', () => {
		expect(contactsFilterParams(EMPTY)).toEqual({});
	});

	it('round-trips only the set fields', () => {
		const f: ContactsFilter = { ...EMPTY, q: 'jane', status: 'subscribed', inGroup: 5 };
		expect(contactsFilterParams(f)).toEqual({ q: 'jane', status: 'subscribed', in: '5' });
	});

	it('round-trips the #423 keys', () => {
		const qs = 'unsub_from=2026-10-01&cooled_days=14&awaiting=1&awaiting_days=3&no_list=1';
		const params = contactsFilterParams(parseContactsFilter(new URLSearchParams(qs)));
		expect(params).toEqual({
			unsub_from: '2026-10-01',
			cooled_days: '14',
			awaiting: '1',
			awaiting_days: '3',
			no_list: '1'
		});
		expect(parseContactsFilter(new URLSearchParams(params))).toEqual(
			parseContactsFilter(new URLSearchParams(qs))
		);
		// awaiting_days is dropped without awaiting
		expect(contactsFilterParams({ ...EMPTY, awaitingDays: 3 })).toEqual({});
	});
});

describe('contactsWhere (SQL shape)', () => {
	it('only hides archived contacts (#280) when nothing is set', () => {
		expect(contactsWhere(EMPTY)).toEqual({ where: 'WHERE (subscribed = 1 OR confirm_pending = 1) AND archived_at IS NULL', params: [] });
		expect(contactsWhere({ ...EMPTY, status: 'all' })).toEqual({ where: 'WHERE archived_at IS NULL', params: [] });
		expect(contactsWhere({ ...EMPTY, status: 'all', archived: 'all' })).toEqual({ where: '', params: [] });
	});

	it('binds exactly one param per ? placeholder for a fully-populated filter', () => {
		const f: ContactsFilter = {
			q: 'jane',
			status: 'subscribed',
			source: 'csv',
			company: 'acme',
			companyId: 3,
			addedFrom: '2024-01-01',
			addedTo: '2024-12-31',
			inGroup: 1,
			notInGroup: 2,
			visited: '/pricing',
			visitedDays: 30,
			site: 'any',
			hasCompany: 'yes',
			metrics: [{ metric: 'hours_30d', op: 'gt', value: 5 }],
			tier: 'hot',
			openedDays: 14,
			neverOpened: true,
			openedN: 2,
			openedOf: 5,
			pipeline: 4,
			bounced: 'hard',
			spam: true,
			campaign: 7,
			campaignWho: 'none'
		};
		const { where, params } = contactsWhere(f);
		expect(where.startsWith('WHERE ')).toBe(true);
		const placeholders = (where.match(/\?/g) ?? []).length;
		expect(placeholders).toBe(params.length);
	});

	it('the q clause carries ESCAPE for LIKE-wildcard safety', () => {
		const { where } = contactsWhere({ ...EMPTY, q: 'a%b_c' });
		expect(where).toContain("ESCAPE '\\'");
	});
});

// --- D1 round-trip -------------------------------------------------------------------

const EMAILS = {
	member: 'cq94-alice@x.test', // in the tag group, subscribed, company "Acme Inc"
	other1: 'cq94-bob@x.test', // not in the group, unsubscribed
	other2: 'cq94-carol@x.test' // not in the group, subscribed, company has a literal '%'
};
const TAG_NAME = 'cq94-test-tag';

describe('contactsWhere — D1 round-trip', () => {
	let listId: number;
	let memberId: number;

	async function wipe() {
		await db.prepare('DELETE FROM list_members WHERE list_id IN (SELECT id FROM lists WHERE name = ?)').bind(TAG_NAME).run();
		await db.prepare('DELETE FROM lists WHERE name = ?').bind(TAG_NAME).run();
		await db
			.prepare('DELETE FROM contacts WHERE email IN (?, ?, ?)')
			.bind(EMAILS.member, EMAILS.other1, EMAILS.other2)
			.run();
	}

	beforeEach(async () => {
		await wipe();
		const alice = await db
			.prepare(
				`INSERT INTO contacts (email, first_name, last_name, company, subscribed, source)
				 VALUES (?, 'Alice', 'One', 'Acme Inc', 1, 'cq94') RETURNING id`
			)
			.bind(EMAILS.member)
			.first<{ id: number }>();
		memberId = alice!.id;
		await db
			.prepare(
				`INSERT INTO contacts (email, first_name, last_name, subscribed, source)
				 VALUES (?, 'Bob', 'Two', 0, 'cq94')`
			)
			.bind(EMAILS.other1)
			.run();
		await db
			.prepare(
				`INSERT INTO contacts (email, first_name, last_name, company, subscribed, source)
				 VALUES (?, 'Carol', 'Three', '50%off', 1, 'cq94')`
			)
			.bind(EMAILS.other2)
			.run();
		const list = await db
			.prepare(`INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id`)
			.bind(TAG_NAME)
			.first<{ id: number }>();
		listId = list!.id;
		await db
			.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)')
			.bind(listId, memberId)
			.run();
	});

	afterEach(wipe);

	// Scope every query to our own test rows (source='cq94') so this file never sees rows
	// left behind by another test file/run.
	async function matching(f: ContactsFilter): Promise<string[]> {
		const { where, params } = contactsWhere(f);
		const scoped = where ? `${where} AND source = 'cq94'` : `WHERE source = 'cq94'`;
		const res = await db
			.prepare(`SELECT email FROM contacts ${scoped} ORDER BY email`)
			.bind(...params)
			.all<{ email: string }>();
		return res.results.map((r) => r.email);
	}

	it('inGroup returns only the member of the group', async () => {
		expect(await matching({ ...EMPTY, inGroup: listId })).toEqual([EMAILS.member]);
	});

	it('notInGroup returns the other two, not the member', async () => {
		expect((await matching({ ...EMPTY, status: 'all', notInGroup: listId })).sort()).toEqual(
			[EMAILS.other1, EMAILS.other2].sort()
		);
	});

	it('status composes with q', async () => {
		// Bob is unsubscribed; searching for him with status=unsubscribed finds him...
		expect(await matching({ ...EMPTY, status: 'unsubscribed', q: 'cq94-bob' })).toEqual([
			EMAILS.other1
		]);
		// ...but status=subscribed + the same search finds nobody.
		expect(await matching({ ...EMPTY, status: 'subscribed', q: 'cq94-bob' })).toEqual([]);
	});

	it('company LIKE matches a normal substring case-insensitively', async () => {
		expect(await matching({ ...EMPTY, company: 'acme' })).toEqual([EMAILS.member]);
	});

	it('company LIKE escapes a literal % so it is not treated as a wildcard', async () => {
		// If '%' in the filter text were left as a real SQL wildcard, this would match
		// every contact with a non-empty company. It must match only the literal "50%off".
		expect(await matching({ ...EMPTY, company: '50%' })).toEqual([EMAILS.other2]);
	});

	it('addedFrom = today includes rows created just now', async () => {
		const today = new Date().toISOString().slice(0, 10);
		expect((await matching({ ...EMPTY, status: 'all', addedFrom: today })).sort()).toEqual(
			[EMAILS.member, EMAILS.other1, EMAILS.other2].sort()
		);
	});

	it('paginates with LIMIT ? OFFSET ? — per=2 gives 2 rows on page 1, 1 on page 2', async () => {
		const { where, params } = contactsWhere({ ...EMPTY, status: 'all', q: 'cq94' });
		const per = 2;
		const page1 = await db
			.prepare(`SELECT email FROM contacts ${where} ORDER BY email LIMIT ? OFFSET ?`)
			.bind(...params, per, 0)
			.all<{ email: string }>();
		const page2 = await db
			.prepare(`SELECT email FROM contacts ${where} ORDER BY email LIMIT ? OFFSET ?`)
			.bind(...params, per, per)
			.all<{ email: string }>();
		expect(page1.results.length).toBe(2);
		expect(page2.results.length).toBe(1);
	});
});
