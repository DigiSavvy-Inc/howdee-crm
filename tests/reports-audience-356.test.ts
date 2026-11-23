import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { parseReportSpec, type ReportSpec } from '../src/lib/report-spec';
import { liveSegmentBlocker } from '../src/lib/report-audience';
import { reportContactIds } from '../src/lib/server/reports/engine';
import { createReport } from '../src/lib/server/reports/store';
import { compileSegment, parseRules } from '../src/lib/server/segment-query';
import { actions as newActions } from '../src/routes/reports/new/+page.server';
import { actions as savedActions, load as loadSaved } from '../src/routes/reports/[id]/+page.server';

const db = (env as { DB: D1Database }).DB;

type User = { id: number; role: 'admin' | 'member' };
let admin: User;
let member: User;

beforeEach(async () => {
	await db.prepare(`DELETE FROM reports WHERE name LIKE 'r356-%'`).run();
	await db.prepare(`DELETE FROM automations WHERE name LIKE 'r356-%'`).run();
	await db.prepare(`DELETE FROM contacts WHERE email LIKE 'r356-%'`).run();
	await db.prepare(`DELETE FROM lists WHERE name LIKE 'r356-%'`).run();
	await db.prepare(`DELETE FROM companies WHERE name LIKE 'r356-%'`).run();
	await db.prepare(`DELETE FROM users WHERE github_login = 'r356-member'`).run();
	const adminRow = await db.prepare(`SELECT id FROM users WHERE github_login = 'ourco-admin'`).first<{ id: number }>();
	admin = { id: adminRow!.id, role: 'admin' };
	const memberRow = await db
		.prepare(`INSERT INTO users (github_login, role) VALUES ('r356-member', 'member') RETURNING id`)
		.first<{ id: number }>();
	member = { id: memberRow!.id, role: 'member' };
});

async function contact(email: string, fields: { subscribed?: number; company_id?: number | null } = {}): Promise<number> {
	const row = await db
		.prepare(`INSERT INTO contacts (email, source, subscribed, company_id) VALUES (?, 'r356', ?, ?) RETURNING id`)
		.bind(email, fields.subscribed ?? 1, fields.company_id ?? null)
		.first<{ id: number }>();
	return row!.id;
}

function postEvent(user: User, params: Record<string, string>, fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('https://crm.test/reports', { method: 'POST', body }),
		url: new URL('https://crm.test/reports'),
		params,
		locals: { user },
		platform: { env }
	} as any;
}

function pageEvent(user: User, params: Record<string, string>) {
	return {
		request: new Request('https://crm.test/reports'),
		url: new URL('https://crm.test/reports'),
		params,
		locals: { user },
		platform: { env }
	} as any;
}

const sourceSpec = (extra: Partial<ReportSpec> = {}) =>
	parseReportSpec({
		entity: 'contacts',
		filters: { match: 'all', rules: [{ field: 'source', op: 'is', value: 'r356' }] },
		columns: ['email'],
		limit: 25,
		...extra
	});

async function members(listId: number): Promise<number[]> {
	const rows = await db
		.prepare(`SELECT contact_id FROM list_members WHERE list_id = ? ORDER BY contact_id`)
		.bind(listId)
		.all<{ contact_id: number }>();
	return rows.results.map((row) => row.contact_id);
}

describe('save report results as a segment', () => {
	it('creates a live segment whose members equal the report ids, linked back to the report', async () => {
		const a = await contact('r356-a@x.example.net');
		const b = await contact('r356-b@x.example.net', { subscribed: 0 });
		const spec = sourceSpec();
		const report = await createReport(db, { name: 'r356-report', spec, createdBy: admin.id }, admin);

		const res = (await savedActions.saveSegment(
			postEvent(admin, { id: String(report.id) }, { spec: JSON.stringify(spec), name: 'r356-seg', report_name: 'r356-report' })
		)) as { audienceSuccess: string; audienceHref: string };
		expect(res.audienceSuccess).toMatch(/r356-seg/);

		const seg = await db
			.prepare(`SELECT id, kind, rules, description FROM lists WHERE name = 'r356-seg'`)
			.first<{ id: number; kind: string; rules: string; description: string }>();
		expect(seg?.kind).toBe('segment');
		expect(res.audienceHref).toBe(`/lists/${seg!.id}`);
		expect(seg!.description).toBe(`From report #${report.id}: r356-report`);
		const compiled = compileSegment(parseRules(seg!.rules));
		const rows = await db.prepare(compiled.sql).bind(...compiled.binds).all<{ id: number }>();
		const segIds = rows.results.map((row) => row.id).sort((x, y) => x - y);
		// The rules match b too; #705: the report (like the segment's page) shows the active
		// audience only, so unsubscribed b isn't one of the report's people.
		expect(segIds).toEqual([a, b]);
		expect(await reportContactIds(db, spec, admin)).toEqual([a]);

		// Live: a new matching contact joins without another save.
		const c = await contact('r356-c@x.example.net');
		const again = await db.prepare(compiled.sql).bind(...compiled.binds).all<{ id: number }>();
		expect(again.results.map((row) => row.id)).toContain(c);

		const load = await loadSaved(pageEvent(admin, { id: String(report.id) }));
		expect(load.audience?.savedAs).toEqual([{ id: seg!.id, name: 'r356-seg', kind: 'segment' }]);
		expect(load.audience?.total).toBe(2); // a + c; unsubscribed b is hidden (#705)
		expect(load.audience?.subscribed).toBe(2);
		expect(load.audience?.liveBlocker).toBeNull();

		const dup = await savedActions.saveSegment(
			postEvent(admin, { id: String(report.id) }, { spec: JSON.stringify(spec), name: 'r356-seg' })
		);
		expect(dup).toMatchObject({ status: 400, data: { audienceError: expect.stringMatching(/already exists/) } });
	});

	it('offers only the list when the spec is not expressible', async () => {
		await contact('r356-a@x.example.net');
		const spec = sourceSpec({ thresholds: { minSent: 3 } });
		expect(liveSegmentBlocker(spec)).toMatch(/at least 3 sends/);
		const report = await createReport(db, { name: 'r356-threshold', spec, createdBy: admin.id }, admin);
		const load = await loadSaved(pageEvent(admin, { id: String(report.id) }));
		expect(load.audience?.liveBlocker).toMatch(/Save as a list instead/);

		const refused = await savedActions.saveSegment(
			postEvent(admin, { id: String(report.id) }, { spec: JSON.stringify(spec), name: 'r356-nope' })
		);
		expect(refused).toMatchObject({ status: 400, data: { audienceError: expect.stringMatching(/at least 3 sends/) } });
		expect(await db.prepare(`SELECT id FROM lists WHERE name = 'r356-nope'`).first()).toBeNull();

		const companies = parseReportSpec({ entity: 'companies', filters: { match: 'all', rules: [] }, columns: ['name'] });
		expect(liveSegmentBlocker(companies)).toMatch(/Company reports/);
	});
});

describe('save report results as a list', () => {
	it('snapshots the ids, appends with dedupe and reports counts, without enrolling', async () => {
		const a = await contact('r356-a@x.example.net');
		const b = await contact('r356-b@x.example.net');
		const spec = sourceSpec();

		const created = (await newActions.saveList(
			postEvent(admin, {}, { spec: JSON.stringify(spec), new_list: 'r356-list', report_name: 'Unsaved' })
		)) as { audienceSuccess: string; audienceHref: string };
		const list = await db.prepare(`SELECT id, kind FROM lists WHERE name = 'r356-list'`).first<{ id: number; kind: string }>();
		expect(list?.kind).toBe('list');
		expect(created.audienceSuccess).toBe('Added 2 to “r356-list”');
		expect(await members(list!.id)).toEqual([a, b]);

		// Snapshot: a later match doesn't join.
		const c = await contact('r356-c@x.example.net');
		expect(await members(list!.id)).toEqual([a, b]);

		const automation = await db
			.prepare(
				`INSERT INTO automations (name, status, trigger_type, trigger_list_id) VALUES ('r356-auto', 'active', 'list_added', ?) RETURNING id`
			)
			.bind(list!.id)
			.first<{ id: number }>();
		await db
			.prepare(`INSERT INTO automation_steps (automation_id, position, subject, body_md, from_email, type, tag_action, tag_name)
				 VALUES (?, 0, '', '', 'f@x.example.net', 'tag', 'add', 'r356-x')`)
			.bind(automation!.id)
			.run();

		const appended = (await newActions.saveList(
			postEvent(admin, {}, { spec: JSON.stringify(spec), list_id: String(list!.id) })
		)) as { audienceSuccess: string };
		expect(appended.audienceSuccess).toBe('Added 1 to “r356-list” · 2 already there');
		expect(await members(list!.id)).toEqual([a, b, c]);
		const enrolled = await db
			.prepare(`SELECT COUNT(*) AS n FROM automation_enrollments WHERE automation_id = ?`)
			.bind(automation!.id)
			.first<{ n: number }>();
		expect(enrolled?.n).toBe(0);
	});

	it('expands a company report to the companies’ contacts', async () => {
		const co = await db.prepare(`INSERT INTO companies (name) VALUES ('r356-Acme') RETURNING id`).first<{ id: number }>();
		const a = await contact('r356-a@x.example.net', { company_id: co!.id });
		const b = await contact('r356-b@x.example.net', { company_id: co!.id });
		await contact('r356-c@x.example.net');
		const spec = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			entityFilters: [{ field: 'name', op: 'is', value: 'r356-acme' }],
			columns: ['name']
		});
		await newActions.saveList(postEvent(admin, {}, { spec: JSON.stringify(spec), new_list: 'r356-co' }));
		const list = await db.prepare(`SELECT id FROM lists WHERE name = 'r356-co'`).first<{ id: number }>();
		expect(await members(list!.id)).toEqual([a, b]);
	});
});

describe('bulk actions on results', () => {
	it('tags and untags every matching contact', async () => {
		const a = await contact('r356-a@x.example.net');
		const b = await contact('r356-b@x.example.net');
		const spec = sourceSpec();
		const tagged = (await newActions.addTag(postEvent(admin, {}, { spec: JSON.stringify(spec), tag: 'r356-tag' }))) as {
			audienceSuccess: string;
		};
		expect(tagged.audienceSuccess).toBe('Tagged 2 with “r356-tag”');
		const tag = await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = 'r356-tag'`).first<{ id: number }>();
		expect(await members(tag!.id)).toEqual([a, b]);

		const untagged = (await newActions.removeTag(postEvent(admin, {}, { spec: JSON.stringify(spec), tag: 'r356-tag' }))) as {
			audienceSuccess: string;
		};
		expect(untagged.audienceSuccess).toMatch(/Removed tag “r356-tag” from 2/);
		expect(await members(tag!.id)).toEqual([]);
	});

	it('lets a member act like on the contacts page, but not on an admin-only spec', async () => {
		const a = await contact('r356-a@x.example.net');
		const ok = (await newActions.saveList(
			postEvent(member, {}, { spec: JSON.stringify(sourceSpec()), new_list: 'r356-member-list' })
		)) as { audienceSuccess: string };
		expect(ok.audienceSuccess).toMatch(/Added 1/);
		const list = await db.prepare(`SELECT id FROM lists WHERE name = 'r356-member-list'`).first<{ id: number }>();
		expect(await members(list!.id)).toEqual([a]);

		const hours = parseReportSpec({ entity: 'companies', filters: { match: 'all', rules: [] }, columns: ['name', 'hours_30d'] });
		const refused = await newActions.addTag(postEvent(member, {}, { spec: JSON.stringify(hours), tag: 'r356-tag' }));
		expect(refused).toMatchObject({ status: 400, data: { audienceError: expect.stringMatching(/Admins only/i) } });
		expect(await db.prepare(`SELECT id FROM lists WHERE kind = 'tag' AND name = 'r356-tag'`).first()).toBeNull();
	});
});
