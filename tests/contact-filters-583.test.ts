// #583: contacts filters — search by company, the Lists · Segments · Tags picker links, a chip
// for every filter kind, and the grouped Filters panel (sections, find, active counts).
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { contactsFilterParams, contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { memberQuery, parseFilter } from '../src/lib/server/contact-filter';
import { DELIVERY_CHIP_KINDS, chipOverrides, contactFilterChips, pipelineChipLabel } from '../src/lib/contact-filter-chips';
import { allGroupsHref, groupPageHref, pickedGroup, pickerSections } from '../src/lib/group-picker';
import { FILTER_SECTIONS, FIELD_TEXT, fieldMatches, sectionActiveCounts } from '../src/lib/contact-filter-sections';

const db = (env as { DB: D1Database }).DB;
const T = `f583-${Date.now()}`;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

describe('toolbar search matches company (#583)', () => {
	let listId: number;
	let byText: number;
	let byLink: number;
	// beforeEach runs once per test in the same database, so each run gets its own tag
	// (company names and contact emails are unique).
	let run = 0;
	let tag = '';

	beforeEach(async () => {
		tag = `${T}-r${++run}`;
		const coId = await id('INSERT INTO companies (name) VALUES (?) RETURNING id', `Zebracorp ${tag}`);
		// Company text only (no linked row).
		byText = await id(`INSERT INTO contacts (email, company) VALUES (?, ?) RETURNING id`, `text-${tag}@x.test`, `Quokka Labs ${tag}`);
		// Linked to a company whose name differs from the (blank) company text.
		byLink = await id(`INSERT INTO contacts (email, company_id) VALUES (?, ?) RETURNING id`, `link-${tag}@x.test`, coId);
		await id(`INSERT INTO contacts (email) VALUES (?) RETURNING id`, `other-${tag}@x.test`);
		listId = await id(`INSERT INTO lists (name, kind) VALUES (?, 'list') RETURNING id`, `L ${tag}`);
		await db.batch(
			[byText, byLink].map((c) => db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c))
		);
	});

	async function contactsMatching(q: string): Promise<number[]> {
		const { where, params } = contactsWhere(parseContactsFilter(new URLSearchParams({ q })));
		const rows = await db.prepare(`SELECT id FROM contacts ${where} ORDER BY id`).bind(...params).all<{ id: number }>();
		return rows.results.map((r) => r.id);
	}
	async function membersMatching(q: string): Promise<number[]> {
		const { where, params } = memberQuery(listId, parseFilter(new URLSearchParams({ q })));
		const rows = await db
			.prepare(`SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${where} ORDER BY c.id`)
			.bind(...params)
			.all<{ id: number }>();
		return rows.results.map((r) => r.id);
	}

	it('/contacts search finds the company text and the linked company name', async () => {
		expect(await contactsMatching(`quokka labs ${tag}`)).toEqual([byText]);
		expect(await contactsMatching(`zebracorp ${tag}`)).toEqual([byLink]);
	});

	it('the member table search (contact-filter.ts) does the same', async () => {
		expect(await membersMatching(`Quokka Labs ${tag}`)).toEqual([byText]);
		expect(await membersMatching(`Zebracorp ${tag}`)).toEqual([byLink]);
		expect(await membersMatching(`nothing-${tag}`)).toEqual([]);
	});
});

describe('group picker links (#583)', () => {
	const groups = {
		list: [{ id: 1, name: 'Newsletter', count: 120 }],
		segment: [
			{ id: 2, name: 'VIP', count: 8 },
			{ id: 3, name: 'Hot leads', count: 4, dynamic: true }
		],
		tag: [{ id: 4, name: 'news-hot', count: 3 }]
	};

	it('each row links to its own page; the menu ends with links to /groups/<kind>', () => {
		expect(groupPageHref(2)).toBe('/lists/2');
		expect(allGroupsHref('list')).toBe('/groups/list');
		expect(allGroupsHref('segment')).toBe('/groups/segment');
		expect(allGroupsHref('tag')).toBe('/groups/tag');
		const secs = pickerSections(groups);
		expect(secs.map((s) => [s.title, s.allLabel, s.allHref])).toEqual([
			['Lists', 'All lists', '/groups/list'],
			['Segments', 'All segments', '/groups/segment'],
			['Tags', 'All tags', '/groups/tag']
		]);
	});

	it('search narrows rows (case-insensitive) and drops empty sections', () => {
		const secs = pickerSections(groups, 'HOT');
		expect(secs.map((s) => [s.kind, s.items.map((g) => g.id)])).toEqual([
			['segment', [3]],
			['tag', [4]]
		]);
		expect(pickerSections(groups, 'zzz')).toEqual([]);
	});

	it('pickedGroup names the active `in=` group', () => {
		expect(pickedGroup(groups, 4)).toEqual({ kind: 'tag', group: groups.tag[0] });
		expect(pickedGroup(groups, null)).toBeNull();
		expect(pickedGroup(groups, 99)).toBeNull();
	});
});

describe('a chip for every filter kind (#583)', () => {
	const ALL =
		'in=1&notin=2&source=csv&added_from=2026-01-01&added_to=2026-02-01&company=acme&company_id=7&has_company=yes' +
		'&tier=hot&opened_days=30&never_opened=1&opened_n=2&opened_of=5' +
		'&visited=%2Fpricing&visited_days=7&site=any&pipeline=any&cm=hours_30d:gt:5,issues_open:gte:1' +
		'&bounced=hard&spam=1&hygiene=invalid&unsub_from=2026-01-01&cooled_days=30&score=9:gte:50&band=9:Hot' +
		'&topic_out=11&created_days=14&awaiting=1&awaiting_days=3&no_list=1&campaign=5&campaign_who=opened' +
		'&q=jane&status=subscribed';
	const f = parseContactsFilter(new URLSearchParams(ALL));
	const chips = contactFilterChips(f, {
		groups: [
			{ id: 1, name: 'Newsletter', kind: 'list' },
			{ id: 2, name: 'VIP', kind: 'segment' }
		],
		company: { id: 7, name: 'Acme Inc' },
		stages: [],
		topics: [{ id: 11, label: 'Product news' }],
		scores: [{ id: 9, name: 'Lead score' }],
		campaignLabel: 'Contacts who opened “Hello”'
	});
	const byKind = (k: string) => chips.filter((c) => c.kind === k);

	it('covers every parameter except the search and status (those have toolbar controls)', () => {
		const cleared = new Set(chips.flatMap((c) => [...c.clear, ...Object.keys(c.set ?? {})]));
		const params = Object.keys(contactsFilterParams(f)).filter((k) => k !== 'q' && k !== 'status');
		for (const p of params) expect(cleared.has(p), p).toBe(true);
		expect(cleared.has('q')).toBe(false);
		expect(cleared.has('status')).toBe(false);
	});

	it('names groups, companies, topics, scores and the campaign', () => {
		expect(byKind('in')[0].label).toBe('In list: Newsletter');
		expect(byKind('notin')[0].label).toBe('Not in segment: VIP');
		expect(byKind('company_id')[0]).toMatchObject({ label: 'Company: Acme Inc', href: '/companies/7' });
		expect(byKind('topic_out')[0].label).toBe('Opted out of topic: Product news');
		expect(byKind('score')[0].label).toBe('Lead score ≥ 50');
		expect(byKind('band')[0].label).toBe('Lead score band: Hot');
		expect(byKind('campaign')[0]).toMatchObject({ label: 'Contacts who opened “Hello”', clear: ['campaign', 'campaign_who'] });
		expect(byKind('added')[0]).toMatchObject({ label: 'Added 2026-01-01 – 2026-02-01', clear: ['added_from', 'added_to'] });
		expect(byKind('visited')[0].label).toBe('Visited “/pricing” in the last 7 days');
		expect(byKind('opened_n')[0].label).toBe('Opened 2 of the last 5 sends');
	});

	it('one chip per company metric; removing one keeps the others', () => {
		const metrics = byKind('metric');
		expect(metrics).toHaveLength(2);
		expect(chipOverrides(metrics[0])).toEqual({ page: null, cm: 'issues_open:gte:1' });
		expect(chipOverrides(metrics[1])).toEqual({ page: null, cm: 'hours_30d:gt:5' });
		const only = contactFilterChips(parseContactsFilter(new URLSearchParams('cm=hours_30d:gt:5')));
		expect(chipOverrides(only[0])).toEqual({ page: null, cm: null });
	});

	it('removal overrides drop the chip params and reset the page', () => {
		expect(chipOverrides(byKind('awaiting')[0])).toEqual({ page: null, awaiting: null, awaiting_days: null });
	});

	it('no filters → no chips; unknown names fall back to ids', () => {
		expect(contactFilterChips(parseContactsFilter(new URLSearchParams('q=x&status=pending')))).toEqual([]);
		const bare = contactFilterChips(parseContactsFilter(new URLSearchParams('in=42&company_id=8')));
		expect(bare.map((c) => c.label)).toEqual(['In group: #42', 'Company: #8 (deleted)']);
	});

	it('the "Overview for" delivery kinds and pipeline labels are unchanged', () => {
		expect(chips.filter((c) => DELIVERY_CHIP_KINDS.has(c.kind)).map((c) => c.kind)).toEqual([
			'bounced', 'spam', 'hygiene', 'unsub_from', 'cooled_days', 'score', 'band', 'topic_out', 'created_days', 'awaiting', 'no_list', 'campaign'
		]);
		expect(pipelineChipLabel('any')).toBe('On the pipeline (any stage)');
		expect(pipelineChipLabel('none')).toBe('Not in pipeline');
		expect(pipelineChipLabel(3, [{ id: 3, name: 'Proposal' }])).toBe('Pipeline stage: Proposal');
		expect(pipelineChipLabel(4, [])).toBe('Pipeline stage: (deleted stage)');
		expect(pipelineChipLabel(null)).toBeNull();
	});
});

describe('Filters panel sections (#583)', () => {
	it('every section is in the issue order and every control has find text', () => {
		expect(FILTER_SECTIONS.map((s) => s.title)).toEqual(['People', 'Engagement', 'Deliverability', 'Website', 'Pipeline and company data']);
		for (const s of FILTER_SECTIONS) for (const field of s.fields) expect(FIELD_TEXT[field], field).toBeTruthy();
	});

	it('"Find a filter" matches every typed word, case-insensitively', () => {
		expect(fieldMatches('bounced', '')).toBe(true);
		expect(fieldMatches('bounced', 'BOUNCE')).toBe(true);
		expect(fieldMatches('opened_n', 'last sends')).toBe(true);
		expect(fieldMatches('opened_n', 'last pricing')).toBe(false);
		const matching = FILTER_SECTIONS.filter((s) => s.fields.some((f) => fieldMatches(f, 'website')));
		expect(matching.map((s) => s.key)).toEqual(['website']);
	});

	it('counts active filters per section; toolbar status / in are left out', () => {
		const f = parseContactsFilter(
			new URLSearchParams('status=subscribed&in=3&source=x&tier=hot&never_opened=1&spam=1&site=none&pipeline=any&cm=hours_30d:gt:5')
		);
		expect(sectionActiveCounts(f)).toEqual({ people: 3, engagement: 2, deliverability: 1, website: 1, pipeline: 2 });
		expect(sectionActiveCounts(f, { toolbar: true })).toEqual({ people: 1, engagement: 2, deliverability: 1, website: 1, pipeline: 2 });
		expect(sectionActiveCounts(parseContactsFilter(new URLSearchParams()))).toEqual({
			people: 0, engagement: 0, deliverability: 0, website: 0, pipeline: 0
		});
	});
});
