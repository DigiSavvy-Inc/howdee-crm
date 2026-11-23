import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { load, actions } from '../src/routes/lists/[id]/+page.server';
import { compileRule, parseRules, segmentMembershipSql } from '../src/lib/server/segment-query';
import { appendRule, applyFilterRule, filterRuleOptions, groupRule, ruleMember } from '../src/lib/server/segment-filter-rule';

// #224: a dynamic segment's member table takes the full /contacts filter + sort, bulk
// actions act on (rules AND filter), and an In / Not in group filter can be turned into an
// Exclude / Require rule. Static lists keep their own filter (member-filter.test.ts).
const db = (env as any).DB as D1Database;

type Fields = Record<string, string | string[]>;

function form(fields: Fields): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
	return fd;
}
function loadEvent(listId: number, qs = '') {
	return { platform: { env }, params: { id: String(listId) }, url: new URL(`https://app.test/lists/${listId}${qs}`) } as any;
}
const run = async (listId: number, qs = '') => (await load(loadEvent(listId, qs))) as any;
function actionEvent(action: string, listId: number, fields: Fields) {
	return {
		platform: { env },
		params: { id: String(listId) },
		request: new Request(`https://app.test/lists/${listId}?/${action}`, { method: 'POST', body: form(fields) })
	} as any;
}

async function contact(email: string, source: string, extra: { name?: string; subscribed?: number } = {}): Promise<number> {
	return (await db
		.prepare('INSERT INTO contacts (email, source, name, subscribed) VALUES (?, ?, ?, ?) RETURNING id')
		.bind(email, source, extra.name ?? null, extra.subscribed ?? 1)
		.first<{ id: number }>())!.id;
}
async function group(name: string, kind: string, rules: unknown = null): Promise<number> {
	return (await db
		.prepare('INSERT INTO lists (name, kind, rules) VALUES (?, ?, ?) RETURNING id')
		.bind(name, kind, rules ? JSON.stringify(rules) : null)
		.first<{ id: number }>())!.id;
}
async function join(listId: number, ...contactIds: number[]) {
	await db.batch(contactIds.map((c) => db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(listId, c)));
}
async function hasTag(contactId: number, tag: string): Promise<boolean> {
	const r = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM list_members lm JOIN lists l ON l.id = lm.list_id
			 WHERE lm.contact_id = ? AND l.kind = 'tag' AND l.name = ?`
		)
		.bind(contactId, tag)
		.first<{ n: number }>();
	return (r?.n ?? 0) > 0;
}
async function storedRules(id: number) {
	const r = await db.prepare('SELECT rules FROM lists WHERE id = ?').bind(id).first<{ rules: string | null }>();
	return parseRules(r?.rules);
}

const COLD = { match: 'all', rules: [{ field: 'source', op: 'is', value: 'cold' }] };

beforeEach(async () => {
	await db.batch([
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

/** Segment "Cold" = source is cold → ann, bob, cat (dan is warm). vip = ann + dan. */
async function fixture() {
	const ann = await contact('ann@x.test', 'cold', { name: 'Ann' });
	const bob = await contact('bob@x.test', 'cold', { name: 'Bob' });
	const cat = await contact('cat@x.test', 'cold', { name: 'Cat' });
	const dan = await contact('dan@x.test', 'warm', { name: 'Dan' });
	const vip = await group('vip', 'tag');
	await join(vip, ann, dan);
	const news = await group('Newsletter', 'list');
	await join(news, bob, dan);
	const seg = await group('Cold', 'segment', COLD);
	return { ann, bob, cat, dan, vip, news, seg };
}
const emails = (data: any) => data.members.map((m: any) => m.email);

describe('segment SQL', () => {
	it('segmentMembershipSql is a predicate on contacts.id', () => {
		const s = segmentMembershipSql(COLD as any);
		expect(s.sql).toMatch(/^contacts\.id IN \(SELECT c\.id FROM contacts c WHERE/);
		expect(s.params).toEqual(['cold']);
	});

	it('the `list` rule compiles in / not by id and skips junk', () => {
		expect(compileRule({ field: 'list', op: 'in', value: '7' })).toMatchObject({ binds: [7] });
		expect(compileRule({ field: 'list', op: 'not', value: '7' })?.clause).toMatch(/^NOT EXISTS/);
		expect(compileRule({ field: 'list', op: 'in', value: 'x' })).toBeNull();
		expect(compileRule({ field: 'list', op: 'is', value: '7' })).toBeNull();
	});
});

describe('/lists/[id] on a dynamic segment', () => {
	it('In group (tag) returns the intersection; the header total stays the full membership', async () => {
		const f = await fixture();
		const all = await run(f.seg);
		expect(all.dynamic).toBe(true);
		expect(all.total).toBe(3);
		expect(all.filtered).toBe(false);

		const data = await run(f.seg, `?in=${f.vip}`);
		expect(emails(data)).toEqual(['ann@x.test']);
		expect(data.matched).toBe(1);
		expect(data.total).toBe(3);
		expect(data.filtered).toBe(true);
		expect(data.filterParams).toMatchObject({ in: String(f.vip) });

		const notIn = await run(f.seg, `?notin=${f.news}`);
		expect(emails(notIn).sort()).toEqual(['ann@x.test', 'cat@x.test']);
	});

	it('other /contacts filters work too (status, search)', async () => {
		const f = await fixture();
		await db.prepare('UPDATE contacts SET subscribed = 0 WHERE id = ?').bind(f.cat).run();
		// #705: a segment's page shows the active audience only — unsubscribed cat is hidden
		// (counted in `hidden`), and found on /contacts instead.
		const unsub = await run(f.seg, '?status=unsubscribed');
		expect(emails(unsub).sort()).toEqual(['ann@x.test', 'bob@x.test']);
		expect(unsub.hidden).toMatchObject({ count: 1 });
		await db.prepare('UPDATE contacts SET subscribed = 0, confirm_pending = 1 WHERE id = ?').bind(f.cat).run();
		expect(emails(await run(f.seg, '?status=pending'))).toEqual(['cat@x.test']);
		expect(emails(await run(f.seg, '?q=bob'))).toEqual(['bob@x.test']);
	});

	it('sorts by email and name', async () => {
		const f = await fixture();
		expect(emails(await run(f.seg, '?sort=email&dir=asc'))).toEqual(['ann@x.test', 'bob@x.test', 'cat@x.test']);
		expect(emails(await run(f.seg, '?sort=email&dir=desc'))).toEqual(['cat@x.test', 'bob@x.test', 'ann@x.test']);
		const byName = await run(f.seg, '?sort=name&dir=desc');
		expect(byName.members.map((m: any) => m.name)).toEqual(['Cat', 'Bob', 'Ann']);
		expect(byName.sort).toBe('name');
		expect(byName.filterParams).toMatchObject({ sort: 'name' });
	});

	it('select-all-matching bulk tag on a filtered segment affects only the intersection', async () => {
		const f = await fixture();
		const out = await actions.bulkTag(actionEvent('bulkTag', f.seg, { all: '1', in: String(f.vip), tag: 'review' }));
		expect(out).toMatchObject({ affected: 1 });
		expect(await hasTag(f.ann, 'review')).toBe(true);
		expect(await hasTag(f.bob, 'review')).toBe(false);
		expect(await hasTag(f.cat, 'review')).toBe(false);
		expect(await hasTag(f.dan, 'review')).toBe(false); // in vip, but not in the segment
	});

	it('offers Exclude / Require for each group condition with the count after', async () => {
		const f = await fixture();
		const data = await run(f.seg, `?in=${f.vip}&notin=${f.news}`);
		const opts = data.ruleShortcuts.options;
		expect(opts.map((o: any) => o.cond)).toEqual(['in', 'notin']);
		expect(opts[0]).toMatchObject({
			group: { id: f.vip, name: 'vip', kind: 'tag' },
			exclude: { rule: { field: 'tag', op: 'not', value: 'vip' }, count: 2 },
			require: { rule: { field: 'tag', op: 'has', value: 'vip' }, count: 1 }
		});
		// Not in Newsletter: excluding "these" requires Newsletter; requiring keeps the NOT.
		expect(opts[1]).toMatchObject({
			exclude: { rule: { field: 'list', op: 'in', value: String(f.news) }, count: 1 },
			require: { rule: { field: 'list', op: 'not', value: String(f.news) }, count: 2 }
		});
		expect(data.ruleShortcuts.blocked).toBeNull();
	});

	it('Exclude these appends the negated rule, saves, and redirects without the filter', async () => {
		const f = await fixture();
		const before = await run(f.seg, `?in=${f.vip}`);
		const expected = before.ruleShortcuts.options[0].exclude.count;
		await expect(
			actions.filterRule(actionEvent('filterRule', f.seg, { cond: 'in', group_id: String(f.vip), mode: 'exclude', per: '25' }))
		).rejects.toMatchObject({ status: 303, location: `/lists/${f.seg}` });
		expect(await storedRules(f.seg)).toEqual({
			match: 'all',
			rules: [...COLD.rules, { field: 'tag', op: 'not', value: 'vip' }]
		});
		const after = await run(f.seg);
		expect(after.total).toBe(expected);
		expect(emails(after).sort()).toEqual(['bob@x.test', 'cat@x.test']);
	});

	it('Require this appends the positive rule (a list by id)', async () => {
		const f = await fixture();
		const out = await applyFilterRule(db, f.seg, { cond: 'in', groupId: f.news, mode: 'require' });
		expect(out).toMatchObject({ ok: true, before: 3, after: 1 });
		expect((await storedRules(f.seg))?.rules.at(-1)).toEqual({ field: 'list', op: 'in', value: String(f.news) });
		expect(emails(await run(f.seg))).toEqual(['bob@x.test']);
	});

	it('refuses a segment that matches ANY of several rules, and bad input', async () => {
		const f = await fixture();
		const anySeg = await group('Any', 'segment', {
			match: 'any',
			rules: [
				{ field: 'source', op: 'is', value: 'cold' },
				{ field: 'source', op: 'is', value: 'warm' }
			]
		});
		const data = await run(anySeg, `?in=${f.vip}`);
		expect(data.ruleShortcuts.options).toEqual([]);
		expect(data.ruleShortcuts.blocked).toMatch(/ANY/);
		expect(await applyFilterRule(db, anySeg, { cond: 'in', groupId: f.vip, mode: 'exclude' })).toMatchObject({ ok: false });
		expect(await applyFilterRule(db, f.news, { cond: 'in', groupId: f.vip, mode: 'exclude' })).toMatchObject({ ok: false });
		expect(await applyFilterRule(db, f.seg, { cond: 'x', groupId: f.vip, mode: 'exclude' })).toMatchObject({ ok: false });
		const res = await actions.filterRule(actionEvent('filterRule', anySeg, { cond: 'in', group_id: String(f.vip), mode: 'exclude' }));
		expect(res).toMatchObject({ status: 400 });
		// With one rule, ANY == ALL, so it takes the rule and becomes ALL.
		expect(appendRule({ match: 'any', rules: [{ field: 'tag', op: 'has', value: 'a' }] }, { field: 'tag', op: 'not', value: 'b' })).toMatchObject({
			ok: true,
			rules: { match: 'all' }
		});
	});

	it('rule helpers map conditions and modes', async () => {
		expect(ruleMember('in', 'exclude')).toBe(false);
		expect(ruleMember('in', 'require')).toBe(true);
		expect(ruleMember('notin', 'exclude')).toBe(true);
		expect(ruleMember('notin', 'require')).toBe(false);
		expect(groupRule({ id: 3, name: 'Acme', kind: 'company' }, true)).toEqual({ field: 'list', op: 'in', value: '3' });
		const f = await fixture();
		// No group condition in the filter → no shortcuts.
		expect(await filterRuleOptions(db, COLD as any, { inGroup: null, notInGroup: null })).toEqual({ options: [], blocked: null });
		expect((await filterRuleOptions(db, COLD as any, { inGroup: f.vip, notInGroup: null })).options).toHaveLength(1);
	});
});

describe('/lists/[id] on a static list (unchanged)', () => {
	it('keeps the member filter, Date-added sort and no rule shortcuts', async () => {
		const f = await fixture();
		const data = await run(f.news, `?in=${f.vip}`);
		expect(data.dynamic).toBe(false);
		expect(data.filterable).toBe(true);
		expect(data.cfilter).toBeNull();
		expect(data.ruleShortcuts).toBeNull();
		expect(emails(data)).toEqual(['dan@x.test']);
		expect(data.matched).toBe(1);
		expect(data.total).toBe(2);
		expect(data.sort).toBe('added');
		expect(data.filterParams).toMatchObject({ in: String(f.vip) });
	});
});
