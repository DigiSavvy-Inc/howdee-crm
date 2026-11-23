import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	activeContactSql,
	activeSubscriptionSql,
	hiddenArchivedSql,
	hiddenNote,
	hiddenUnsubscribedSql,
	rulesAskForSubscription,
	segmentAudienceSql
} from '../src/lib/server/active-audience';
import { load as listLoad } from '../src/routes/lists/[id]/+page.server';
import { contactsFilterParams, contactsWhere, parseContactsFilter } from '../src/lib/server/contacts-query';
import { memberQuery, parseFilter } from '../src/lib/server/contact-filter';
import { activeMemberCount, activeOnly, memberIds, recipientsForList } from '../src/lib/server/segments';
import { dynamicMemberCount } from '../src/lib/server/groups-bulk';
import { getCompany } from '../src/lib/server/company-read';
import { siteSearch } from '../src/lib/server/site-search';
import { reportContactIds } from '../src/lib/server/reports/engine';
import { parseReportSpec } from '../src/lib/report-spec';
import { REPORT_METRICS } from '../src/lib/report-metrics';
import { enrollContactsInAutomation } from '../src/lib/server/automations';
import { bulkEnroll } from '../src/lib/server/contact-bulk';
import { GET as exportGroups } from '../src/routes/groups/[kind]/export/+server';

// #705: one fixture — subscribed, pending (double opt-in), unsubscribed and archived contacts in a
// list, a tag, a hand-picked segment, a rules segment and a company — checked in every view and
// count. Only the Contacts page's explicit Status / Archived filters show the hidden two.
const db = (env as any).DB as D1Database;

const ids = {} as Record<'sub' | 'pend' | 'unsub' | 'arch' | 'list' | 'tag' | 'seg' | 'dyn' | 'dynUnsub' | 'company', number>;

async function id(sql: string, ...binds: unknown[]): Promise<number> {
	return (await db.prepare(sql).bind(...binds).first<{ id: number }>())!.id;
}

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_branch_hits'),
		db.prepare('DELETE FROM automation_enrollment_events'),
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
	ids.company = await id(`INSERT INTO companies (name) VALUES ('Aud705 Co') RETURNING id`);
	const add = (email: string, cols: string) =>
		id(
			`INSERT INTO contacts (email, first_name, source, company, company_id, subscribed, confirm_pending, archived_at)
			 VALUES (?, 'Aud', 'a705', 'Aud705 Co', ?, ${cols}) RETURNING id`,
			email,
			ids.company
		);
	ids.sub = await add('aud705-sub@example.com', `1, 0, NULL`);
	ids.pend = await add('aud705-pend@example.com', `0, 1, NULL`);
	ids.unsub = await add('aud705-unsub@example.com', `0, 0, NULL`);
	ids.arch = await add('aud705-arch@example.com', `1, 0, datetime('now')`);

	ids.list = await id(`INSERT INTO lists (name, kind) VALUES ('Aud705 list', 'list') RETURNING id`);
	ids.tag = await id(`INSERT INTO lists (name, kind) VALUES ('aud705-tag', 'tag') RETURNING id`);
	ids.seg = await id(`INSERT INTO lists (name, kind) VALUES ('Aud705 picked', 'segment') RETURNING id`);
	ids.dyn = await id(
		`INSERT INTO lists (name, kind, rules) VALUES ('Aud705 rules', 'segment', ?) RETURNING id`,
		JSON.stringify({ match: 'all', rules: [{ field: 'source', op: 'is', value: 'a705' }] })
	);
	ids.dynUnsub = await id(
		`INSERT INTO lists (name, kind, rules) VALUES ('Aud705 unsubscribed', 'segment', ?) RETURNING id`,
		JSON.stringify({ match: 'all', rules: [{ field: 'source', op: 'is', value: 'a705' }, { field: 'subscribed', op: 'no' }] })
	);
	const stmts = [];
	for (const g of [ids.list, ids.tag, ids.seg]) {
		for (const c of [ids.sub, ids.pend, ids.unsub, ids.arch]) {
			stmts.push(db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(g, c));
		}
	}
	await db.batch(stmts);
});

const ACTIVE = () => [ids.sub, ids.pend].sort((a, b) => a - b);

async function contactIds(where: { where: string; params: unknown[] }): Promise<number[]> {
	const scoped = where.where ? `${where.where} AND source = 'a705'` : `WHERE source = 'a705'`;
	const rows = await db.prepare(`SELECT id FROM contacts ${scoped} ORDER BY id`).bind(...where.params).all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

describe('the rule (active-audience.ts)', () => {
	it('is not archived AND (subscribed OR pending)', () => {
		expect(activeSubscriptionSql('c')).toBe('(c.subscribed = 1 OR c.confirm_pending = 1)');
		expect(activeContactSql('c')).toBe('(c.archived_at IS NULL AND (c.subscribed = 1 OR c.confirm_pending = 1))');
		expect(activeContactSql()).toBe('(archived_at IS NULL AND (subscribed = 1 OR confirm_pending = 1))');
		expect(() => activeContactSql('c; DROP')).toThrow();
	});

	it('a rule set that asks about subscription keeps the unsubscribed', () => {
		expect(rulesAskForSubscription({ rules: [{ field: 'subscribed' }] })).toBe(true);
		expect(rulesAskForSubscription({ rules: [{ field: 'tag' }] })).toBe(false);
		expect(rulesAskForSubscription(null)).toBe(false);
		expect(segmentAudienceSql({ rules: [{ field: 'subscribed' }] }, 'c')).toBe('(c.archived_at IS NULL)');
		expect(segmentAudienceSql({ rules: [] }, 'c')).toBe(activeContactSql('c'));
	});

	it('the companies report metric uses the same SQL (a universal module inlines it)', () => {
		const metric = REPORT_METRICS.find((m) => m.key === 'contact_count' && m.entity === 'companies') as any;
		expect(metric.select({}).sql).toContain(activeContactSql('c'));
	});
});

describe('Contacts page filter', () => {
	it('defaults to the active audience and names the hidden ones only on purpose', async () => {
		const def = parseContactsFilter(new URLSearchParams());
		expect(def.status).toBe('active');
		expect(contactsFilterParams(def)).toEqual({});
		expect(await contactIds(contactsWhere(def))).toEqual(ACTIVE());
		expect(await contactIds(contactsWhere(parseContactsFilter(new URLSearchParams('status=unsubscribed'))))).toEqual([ids.unsub]);
		expect(await contactIds(contactsWhere(parseContactsFilter(new URLSearchParams('status=all'))))).toEqual(
			[ids.sub, ids.pend, ids.unsub].sort((a, b) => a - b)
		);
		// The Archived view shows every archived contact (its default status is `all`).
		expect(await contactIds(contactsWhere(parseContactsFilter(new URLSearchParams('archived=1'))))).toEqual([ids.arch]);
		// In group on /contacts finds a group's hidden members on purpose.
		expect(await contactIds(contactsWhere(parseContactsFilter(new URLSearchParams(`in=${ids.tag}&status=unsubscribed`))))).toEqual([ids.unsub]);
	});

	it('the API bulk filter keeps its old meaning (no status = every status)', async () => {
		const f = parseContactsFilter(new URLSearchParams(`company_id=${ids.company}`), { defaultStatus: 'all' });
		expect(await contactIds(contactsWhere(f))).toEqual([ids.sub, ids.pend, ids.unsub].sort((a, b) => a - b));
	});
});

describe('group views and counts', () => {
	it('member tables of a list, a tag and a hand-picked segment show the active audience only', async () => {
		for (const g of [ids.list, ids.tag, ids.seg]) {
			for (const status of ['', 'status=unsubscribed']) {
				const q = memberQuery(g, parseFilter(new URLSearchParams(status)));
				const rows = await db
					.prepare(`SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${q.where} ORDER BY c.id`)
					.bind(...q.params)
					.all<{ id: number }>();
				expect(rows.results.map((r) => r.id)).toEqual(ACTIVE());
			}
		}
	});

	it('every "N contacts" count is 2 (subscribed + pending)', async () => {
		for (const g of [ids.list, ids.tag, ids.seg]) {
			expect(await activeMemberCount(db, { id: g, kind: g === ids.seg ? 'segment' : 'list' })).toBe(2);
		}
		const dyn = await db.prepare('SELECT id, kind, rules FROM lists WHERE id = ?').bind(ids.dyn).first<any>();
		expect(await activeMemberCount(db, dyn)).toBe(2);
		expect(await dynamicMemberCount(db, dyn.rules)).toBe(2);
		expect(await activeOnly(db, dyn, await memberIds(db, dyn))).toEqual(ACTIVE());
	});

	it('a rules segment that asks for the unsubscribed still lists them', async () => {
		const seg = await db.prepare('SELECT id, kind, rules FROM lists WHERE id = ?').bind(ids.dynUnsub).first<any>();
		expect(await activeMemberCount(db, seg)).toBe(2); // pending + unsubscribed (archived never)
		expect((await activeOnly(db, seg, await memberIds(db, seg))).sort((a, b) => a - b)).toEqual(
			[ids.pend, ids.unsub].sort((a, b) => a - b)
		);
	});

	it('the group CSV export leaves the hidden contacts out', async () => {
		const res = await exportGroups({
			params: { kind: 'tag' },
			url: new URL(`https://crm.myapp.example/groups/tag/export?id=${ids.tag}`),
			platform: { env }
		} as any);
		const csv = await res.text();
		expect(csv).toContain('aud705-sub@example.com');
		expect(csv).toContain('aud705-pend@example.com');
		expect(csv).not.toContain('aud705-unsub@example.com');
		expect(csv).not.toContain('aud705-arch@example.com');
	});
});

describe('companies, search and reports', () => {
	it('the company count is the active audience', async () => {
		expect((await getCompany(db, ids.company))?.contact_count).toBe(2);
	});

	it('site search only finds active contacts', async () => {
		const res = await siteSearch(db, 'aud705', 10);
		expect(res.contacts.items.map((h) => h.id).sort((a, b) => a - b)).toEqual(ACTIVE());
	});

	it("a contacts report's people are the active audience, unless its rules ask about subscription", async () => {
		const viewer = { id: 1, role: 'admin' as const };
		const spec = (rules: unknown[]) => parseReportSpec({ entity: 'contacts', filters: { match: 'all', rules }, columns: ['email'], limit: 25 });
		expect(await reportContactIds(db, spec([{ field: 'source', op: 'is', value: 'a705' }]), viewer)).toEqual(ACTIVE());
		expect(
			await reportContactIds(db, spec([{ field: 'source', op: 'is', value: 'a705' }, { field: 'subscribed', op: 'no' }]), viewer)
		).toEqual([ids.pend, ids.unsub].sort((a, b) => a - b));
	});
});

describe('sending and enrolment (unchanged — locked in)', () => {
	it('sends go to subscribed, non-archived members only (not pending, not unsubscribed, not archived)', async () => {
		for (const g of [ids.list, ids.tag, ids.dyn]) {
			expect((await recipientsForList(db, g)).map((r) => r.id)).toEqual([ids.sub]);
		}
	});

	it('enrolment skips them and the notice counts each reason on its own', async () => {
		const aid = await id("INSERT INTO automations (name, status, reentry) VALUES ('Aud705 flow', 'active', 'once') RETURNING id");
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, delay_before_seconds, subject, body_md, from_email, type, tag_action, tag_name)
				 VALUES (?, 0, 3600, '', '', '', 'tag', 'add', 'x')`
			)
			.bind(aid)
			.run();
		const all = [ids.sub, ids.pend, ids.unsub, ids.arch];
		const first = await enrollContactsInAutomation(db, aid, all);
		expect(first).toMatchObject({ ok: true, enrolled: 1, skipped: 3, skips: { unsubscribed: 1, pending: 1, archived: 1, already: 0, entry: 0 } });

		const again = await bulkEnroll(db, { ok: true, ids: all, all: false, missing: 0 }, aid);
		expect(again).toMatchObject({ ok: true, affected: 0, skipped: 4 });
		expect((again as any).message).toBe(
			'Enrolled 0 in “Aud705 flow” · 1 unsubscribed · 1 pending confirmation · 1 archived · 1 already in it'
		);
	});
});

describe('the group page hidden note', () => {
	const loadGroup = async (groupId: number) =>
		(await listLoad({
			platform: { env },
			params: { id: String(groupId) },
			url: new URL(`https://app.test/lists/${groupId}`)
		} as any)) as any;

	it('splits the hidden ones into unsubscribed (not archived) and archived', () => {
		expect(hiddenUnsubscribedSql('c')).toBe('(c.archived_at IS NULL AND NOT (c.subscribed = 1 OR c.confirm_pending = 1))');
		expect(hiddenArchivedSql('c')).toBe('(c.archived_at IS NOT NULL)');
		expect(hiddenNote(1, 2, 7)).toEqual({
			count: 3,
			unsubscribed: { count: 1, href: '/contacts?in=7&status=unsubscribed' },
			archived: { count: 2, href: '/contacts?in=7&archived=1&status=all' }
		});
		expect(hiddenNote(1, 0, null)).toEqual({
			count: 1,
			unsubscribed: { count: 1, href: null },
			archived: { count: 0, href: null }
		});
	});

	it('a list counts each hidden member once, and each link opens exactly that set on /contacts', async () => {
		// Archived AND unsubscribed: counts once, as archived.
		const archUnsub = await id(
			`INSERT INTO contacts (email, first_name, source, subscribed, confirm_pending, archived_at)
			 VALUES ('aud705-arch-unsub@example.com', 'Aud', 'a705', 0, 0, datetime('now')) RETURNING id`
		);
		await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(ids.list, archUnsub).run();

		const data = await loadGroup(ids.list);
		expect(data.total).toBe(2);
		expect(data.hidden).toEqual({
			count: 3,
			unsubscribed: { count: 1, href: `/contacts?in=${ids.list}&status=unsubscribed` },
			archived: { count: 2, href: `/contacts?in=${ids.list}&archived=1&status=all` }
		});

		const opens = async (href: string) =>
			contactIds(contactsWhere(parseContactsFilter(new URL(href, 'https://app.test').searchParams)));
		expect(await opens(data.hidden.unsubscribed.href)).toEqual([ids.unsub]);
		expect(await opens(data.hidden.archived.href)).toEqual([ids.arch, archUnsub].sort((a, b) => a - b));
	});

	it('a rules segment keeps its note without links', async () => {
		const data = await loadGroup(ids.dyn);
		expect(data.hidden).toEqual({
			count: 1,
			unsubscribed: { count: 1, href: null },
			archived: { count: 0, href: null }
		});
	});
});
