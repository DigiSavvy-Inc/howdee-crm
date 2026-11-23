import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { parseReportSpec } from '../src/lib/report-spec';
import { decodeSpec, encodeSpec, reportCsv } from '../src/lib/report-view';
import { runReport } from '../src/lib/server/reports/engine';
import { createReport, getReport, updateReport } from '../src/lib/server/reports/store';
import { load as loadHome } from '../src/routes/reports/+page.server';
import { actions as newActions, load as loadNew } from '../src/routes/reports/new/+page.server';
import { actions as savedActions, load as loadSaved } from '../src/routes/reports/[id]/+page.server';
import { GET as csvGET } from '../src/routes/reports/[id].csv/+server';

const db = (env as { DB: D1Database }).DB;

type Role = 'admin' | 'member';
type User = { id: number; role: Role };

let admin: User;
let member: User;

beforeEach(async () => {
	await db.prepare(`DELETE FROM reports WHERE name LIKE '%r355-%'`).run();
	await db.prepare(`DELETE FROM contacts WHERE email LIKE 'r355-%' OR source = 'r355'`).run();
	await db.prepare(`DELETE FROM company_metrics WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'r355-%')`).run();
	await db.prepare(`DELETE FROM companies WHERE name LIKE 'r355-%'`).run();
	await db.prepare(`DELETE FROM users WHERE github_login = 'r355-member'`).run();
	const adminRow = await db.prepare(`SELECT id FROM users WHERE github_login = 'ourco-admin'`).first<{ id: number }>();
	if (!adminRow) throw new Error('seeded admin ourco-admin is missing');
	admin = { id: adminRow.id, role: 'admin' };
	const memberRow = await db
		.prepare(`INSERT INTO users (github_login, role) VALUES ('r355-member', 'member') RETURNING id`)
		.first<{ id: number }>();
	if (!memberRow) throw new Error('member insert failed');
	member = { id: memberRow.id, role: 'member' };
});

function pageEvent(path: string, user: User, params: Record<string, string> = {}) {
	return {
		request: new Request(`https://crm.test${path}`),
		url: new URL(`https://crm.test${path}`),
		params,
		locals: { user },
		platform: { env }
	} as any;
}

function postEvent(path: string, user: User, params: Record<string, string>, fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request(`https://crm.test${path}`, { method: 'POST', body }),
		url: new URL(`https://crm.test${path}`),
		params,
		locals: { user },
		platform: { env }
	} as any;
}

async function redirectLocation(pending: unknown): Promise<string> {
	try {
		await pending;
	} catch (err) {
		if (isRedirect(err)) return err.location;
		throw err;
	}
	throw new Error('expected a redirect');
}

function idFromLocation(location: string): number {
	const id = Number(location.split('/').pop());
	if (!Number.isInteger(id)) throw new Error(location);
	return id;
}

const contactSpec = parseReportSpec({
	entity: 'contacts',
	filters: { match: 'all', rules: [{ field: 'source', op: 'is', value: 'r355' }] },
	columns: ['email', 'name'],
	sort: { key: 'email', dir: 'asc' },
	limit: 50,
	chart: 'table'
});

describe('report routes', () => {
	it('save creates a report', async () => {
		const location = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-saved',
					description: 'A saved report',
					folder: 'Contacts',
					pinned: '0',
					spec: JSON.stringify(contactSpec)
				})
			)
		);
		expect(location.startsWith('/reports/')).toBe(true);
		const saved = await getReport(db, idFromLocation(location));
		expect(saved?.name).toBe('r355-saved');
		expect(saved?.description).toBe('A saved report');
		expect(saved?.folder).toBe('Contacts');
		expect(saved?.pinned).toBe(0);
		expect(saved?.spec).toEqual(contactSpec);
		expect(saved?.created_by).toBe(admin.id);
	});

	it('update changes the report', async () => {
		const created = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-update',
					folder: 'Contacts',
					spec: JSON.stringify(contactSpec)
				})
			)
		);
		const id = idFromLocation(created);
		const next = parseReportSpec({ ...contactSpec, columns: ['email'], limit: 25 });
		const location = await redirectLocation(
			savedActions.save(
				postEvent(`/reports/${id}`, admin, { id: String(id) }, {
					name: 'r355-updated',
					description: 'Edited',
					folder: 'Email',
					pinned: '1',
					spec: JSON.stringify(next)
				})
			)
		);
		expect(location).toBe(`/reports/${id}`);
		const saved = await getReport(db, id);
		expect(saved?.name).toBe('r355-updated');
		expect(saved?.description).toBe('Edited');
		expect(saved?.folder).toBe('Email');
		expect(saved?.pinned).toBe(1);
		expect(saved?.spec.columns).toEqual(['email']);
		expect(saved?.spec.limit).toBe(25);
	});

	it('duplicate opens the unsaved builder with a copy of the report (#456)', async () => {
		const created = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-original',
					description: 'Keep me',
					folder: 'Contacts',
					pinned: '1',
					spec: JSON.stringify(contactSpec)
				})
			)
		);
		const id = idFromLocation(created);
		const location = await redirectLocation(
			savedActions.duplicate(postEvent(`/reports/${id}?/duplicate`, admin, { id: String(id) }, {}))
		);
		const url = new URL(location, 'https://crm.test');
		expect(url.pathname).toBe('/reports/new');
		expect(decodeSpec(url.searchParams.get('spec') ?? '')).toEqual(contactSpec);
		expect(url.searchParams.get('name')).toBe('Copy of r355-original');
		expect(url.searchParams.get('description')).toBe('Keep me');
		expect(url.searchParams.get('folder')).toBe('Contacts');
		// Nothing is saved until the user clicks Save.
		const rows = await db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE name LIKE '%r355-original%'`).first<{ n: number }>();
		expect(rows?.n).toBe(1);
		expect(await getReport(db, id)).toMatchObject({ name: 'r355-original', pinned: 1 });
		const builder = await loadNew(pageEvent(`${url.pathname}${url.search}`, admin));
		expect(builder.spec).toEqual(contactSpec);
		expect(builder.draft).toEqual({ name: 'Copy of r355-original', description: 'Keep me', folder: 'Contacts' });
	});

	it('pin sets the report on the home', async () => {
		const created = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-pin',
					folder: 'Contacts',
					pinned: '0',
					spec: JSON.stringify(contactSpec)
				})
			)
		);
		const id = idFromLocation(created);
		const before = await loadHome(pageEvent('/reports', admin));
		expect(before.pinned.some((card) => card.id === id)).toBe(false);
		const location = await redirectLocation(
			savedActions.pin(postEvent(`/reports/${id}?/pin`, admin, { id: String(id) }, { pinned: '1' }))
		);
		expect(location).toBe(`/reports/${id}`);
		const home = await loadHome(pageEvent('/reports', admin));
		const card = home.pinned.find((item) => item.id === id);
		expect(card?.name).toBe('r355-pin');
		expect(card?.href).toBe(`/reports/${id}`);
		expect(home.library.some((item) => item.id === `s:${id}` && item.folder === 'Contacts')).toBe(true);
	});

	it('delete removes the report', async () => {
		const created = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-delete',
					folder: 'Contacts',
					spec: JSON.stringify(contactSpec)
				})
			)
		);
		const id = idFromLocation(created);
		const location = await redirectLocation(
			savedActions.delete(postEvent(`/reports/${id}?/delete`, admin, { id: String(id) }, {}))
		);
		expect(location).toBe('/reports');
		expect(await getReport(db, id)).toBeNull();
		await expect(loadSaved(pageEvent(`/reports/${id}`, admin, { id: String(id) }))).rejects.toMatchObject({ status: 404 });
	});

	it("a member can't see sensitive columns", async () => {
		const sensitive = parseReportSpec({
			entity: 'contacts',
			filters: { match: 'all', rules: [] },
			columns: ['email', 'pipeline_value']
		});
		const asMember = await loadNew(pageEvent(`/reports/new?spec=${encodeSpec(sensitive)}`, member));
		expect(asMember.result).toBeNull();
		expect(asMember.error).toMatch(/Admins only/);
		expect(asMember.offeredByEntity.contacts.map((column) => column.key)).not.toContain('pipeline_value');
		expect(asMember.offeredByEntity.companies.map((column) => column.key)).not.toContain('hours_30d');
		expect(asMember.offeredByEntity.pipeline.map((column) => column.key)).not.toContain('pipeline_value');
		for (const columns of Object.values(asMember.offeredByEntity)) {
			expect(columns.some((column) => column.key.startsWith('zoho_'))).toBe(false);
		}

		const asAdmin = await loadNew(pageEvent(`/reports/new?spec=${encodeSpec(sensitive)}`, admin));
		expect(asAdmin.error).toBeNull();
		expect(asAdmin.result).not.toBeNull();
		expect(asAdmin.offeredByEntity.contacts.map((column) => column.key)).toContain('pipeline_value');
		expect(asAdmin.offeredByEntity.companies.map((column) => column.key)).toContain('hours_30d');
		expect(asAdmin.offeredByEntity.companies.some((column) => column.key.startsWith('zoho_'))).toBe(false);

		const refused = await newActions.save(
			postEvent('/reports/new', member, {}, {
				name: 'r355-secret',
				folder: 'Contacts',
				spec: JSON.stringify(sensitive)
			})
		);
		expect(refused).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Admins only/) } });
		expect(await db.prepare(`SELECT id FROM reports WHERE name = 'r355-secret'`).first()).toBeNull();

		const hours = parseReportSpec({
			entity: 'companies',
			filters: { match: 'all', rules: [] },
			columns: ['name', 'hours_30d']
		});
		const savedAt = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-hours',
					folder: 'Clients & integrations',
					spec: JSON.stringify(hours)
				})
			)
		);
		const hoursId = idFromLocation(savedAt);
		await expect(csvGET(pageEvent(`/reports/${hoursId}.csv`, member, { id: String(hoursId) }))).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringMatching(/Admins only/) }
		});
	});

	it('a member csv export and record ids hide admin-only fields', async () => {
		const richCo = await db
			.prepare(`INSERT INTO companies (name) VALUES ('r355-rich') RETURNING id`)
			.first<{ id: number }>();
		const quietCo = await db
			.prepare(`INSERT INTO companies (name) VALUES ('r355-quiet') RETURNING id`)
			.first<{ id: number }>();
		await db.prepare(`INSERT INTO company_metrics (company_id, hours_30d) VALUES (?, 40)`).bind(richCo!.id).run();
		await db.prepare(`INSERT INTO company_metrics (company_id, hours_30d) VALUES (?, 1)`).bind(quietCo!.id).run();
		const rich = await db
			.prepare(`INSERT INTO contacts (email, company_id, source) VALUES ('r355-rich@example.com', ?, 'r355') RETURNING id`)
			.bind(richCo!.id)
			.first<{ id: number }>();
		await db
			.prepare(`INSERT INTO contacts (email, company_id, source) VALUES ('r355-quiet@example.com', ?, 'r355') RETURNING id`)
			.bind(quietCo!.id)
			.run();

		const byHours = parseReportSpec({
			entity: 'contacts',
			filters: {
				match: 'all',
				rules: [{ field: 'company_metric', op: 'gt', value: '10', value2: 'hours_30d' }]
			},
			columns: ['email'],
			sort: { key: 'email', dir: 'asc' }
		});
		await expect(runReport(db, byHours, member)).rejects.toThrow(/hours_30d/);
		const adminIds = await runReport(db, byHours, admin);
		expect(adminIds.rows).toEqual([{ email: 'r355-rich@example.com' }]);
		expect(adminIds.recordIds).toEqual([rich!.id]);
		expect(JSON.stringify(adminIds.rows)).not.toContain('40');

		const savedAt = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-hours-filter',
					folder: 'Contacts',
					spec: JSON.stringify(byHours)
				})
			)
		);
		const id = idFromLocation(savedAt);
		await expect(csvGET(pageEvent(`/reports/${id}.csv`, member, { id: String(id) }))).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringMatching(/Admins only/) }
		});
		const response = await csvGET(pageEvent(`/reports/${id}.csv`, admin, { id: String(id) }));
		const text = await response.text();
		expect(text).toContain('r355-rich@example.com');
		expect(text).not.toContain('r355-quiet@example.com');
		expect(text).not.toContain('40');

		const stage = await db.prepare(`SELECT id FROM pipeline_stages WHERE name = 'Lead'`).first<{ id: number }>();
		const deal = await db
			.prepare(`INSERT INTO contacts (email, source) VALUES ('r355-deal@example.com', 'r355') RETURNING id`)
			.first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 9000, '2026-01-01 00:00:00')`
			)
			.bind(deal!.id, stage!.id)
			.run();
		const valueSpec = parseReportSpec({
			entity: 'pipeline',
			filters: { match: 'all', rules: [] },
			columns: ['cards', 'pipeline_value'],
			groupBy: 'pipeline_stage',
			sort: { key: 'pipeline_value', dir: 'desc' }
		});
		const valueSaved = await createReport(db, { name: 'r355-value', folder: 'Pipeline', spec: valueSpec }, admin);
		await expect(csvGET(pageEvent(`/reports/${valueSaved.id}.csv`, member, { id: String(valueSaved.id) }))).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringMatching(/pipeline_value/) }
		});
		const valueCsv = await csvGET(pageEvent(`/reports/${valueSaved.id}.csv`, admin, { id: String(valueSaved.id) }));
		expect(await valueCsv.text()).toMatch(/(?:^|\n)Lead,1,9000(?:\r?\n|$)/);
	});

	it("a member can't save or run a saved report that includes admin-only fields", async () => {
		const spec = parseReportSpec({
			entity: 'pipeline',
			filters: { match: 'all', rules: [] },
			columns: ['cards', 'pipeline_value'],
			groupBy: 'pipeline_stage',
			sort: { key: 'pipeline_value', dir: 'desc' }
		});
		const refused = await newActions.save(
			postEvent('/reports/new', member, {}, {
				name: 'r355-member-value',
				folder: 'Pipeline',
				spec: JSON.stringify(spec)
			})
		);
		expect(refused).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Admins only/) } });
		expect(await db.prepare(`SELECT id FROM reports WHERE name = 'r355-member-value'`).first()).toBeNull();
		await expect(createReport(db, { name: 'r355-store-secret', spec }, member)).rejects.toThrow(/Admins only/);

		const stage = await db.prepare(`SELECT id FROM pipeline_stages WHERE name = 'Qualified'`).first<{ id: number }>();
		const who = await db
			.prepare(`INSERT INTO contacts (email, source) VALUES ('r355-open@example.com', 'r355') RETURNING id`)
			.first<{ id: number }>();
		await db
			.prepare(
				`INSERT INTO pipeline_cards (contact_id, stage_id, value, entered_stage_at) VALUES (?, ?, 9000, '2026-01-01 00:00:00')`
			)
			.bind(who!.id, stage!.id)
			.run();
		const savedSpec = parseReportSpec({
			...spec,
			entityFilters: [{ field: 'stage', op: 'is', value: String(stage!.id) }]
		});
		const saved = await createReport(
			db,
			{ name: 'r355-admin-value', folder: 'Pipeline', spec: savedSpec, pinned: true, createdBy: admin.id },
			admin
		);

		const opened = await loadSaved(pageEvent(`/reports/${saved.id}`, member, { id: String(saved.id) }));
		expect(opened.result).toBeNull();
		expect(opened.error).toMatch(/Admins only/);
		expect(JSON.stringify(opened.result)).not.toContain('9000');
		expect(JSON.stringify(opened.result)).not.toContain('9,000');

		const home = await loadHome(pageEvent('/reports', member));
		const card = home.pinned.find((item) => item.id === saved.id);
		expect(card?.result).toBeNull();
		expect(card?.error).toMatch(/Admins only/);
		expect(JSON.stringify(card?.result)).not.toContain('9000');

		const asAdmin = await loadSaved(pageEvent(`/reports/${saved.id}`, admin, { id: String(saved.id) }));
		expect(asAdmin.error).toBeNull();
		expect(asAdmin.result?.rows).toEqual([expect.objectContaining({ pipeline_value: 9000 })]);

		const pin = await savedActions.pin(postEvent(`/reports/${saved.id}?/pin`, member, { id: String(saved.id) }, { pinned: '0' }));
		expect(pin).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Admins only/) } });
		const duplicate = await savedActions.duplicate(
			postEvent(`/reports/${saved.id}?/duplicate`, member, { id: String(saved.id) }, {})
		);
		expect(duplicate).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Admins only/) } });
		await expect(updateReport(db, saved.id, { name: 'r355-renamed-by-member' }, member)).rejects.toThrow(/Admins only/);
		expect((await getReport(db, saved.id))?.name).toBe('r355-admin-value');
	});

	it('CSV export matches the table rows and escapes commas, quotes, newlines and a leading formula', async () => {
		const people: [string, string][] = [
			['r355-at@example.com', '@cmd'],
			['r355-comma@example.com', 'Acme, Inc'],
			['r355-eq@example.com', '=cmd'],
			['r355-minus@example.com', '-cmd'],
			['r355-nl@example.com', 'line1\nline2'],
			['r355-plus@example.com', '+cmd'],
			['r355-quote@example.com', 'He said "hi"']
		];
		for (const [email, name] of people) {
			await db.prepare(`INSERT INTO contacts (email, name, source) VALUES (?, ?, 'r355')`).bind(email, name).run();
		}
		const savedAt = await redirectLocation(
			newActions.save(
				postEvent('/reports/new', admin, {}, {
					name: 'r355-csv',
					folder: 'Contacts',
					spec: JSON.stringify(contactSpec)
				})
			)
		);
		const id = idFromLocation(savedAt);
		const result = await runReport(db, contactSpec, { role: 'admin' });
		expect(result.rows.map((row) => row.email)).toEqual(people.map(([email]) => email));
		expect(result.rows.some((row) => '__id' in row)).toBe(false);
		expect(result.recordIds?.length).toBe(result.rows.length);

		const response = await csvGET(pageEvent(`/reports/${id}.csv`, admin, { id: String(id) }));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/csv');
		expect(response.headers.get('content-disposition')).toBe(`attachment; filename="report-${id}.csv"`);
		const text = await response.text();
		expect(text).toBe(reportCsv(result.columns, result.rows));
		expect(text).toContain('"Acme, Inc"');
		expect(text).toContain('"He said ""hi"""');
		expect(text).toContain('"line1\nline2"');
		expect(text).toContain("'=cmd");
		expect(text).toContain("'+cmd");
		expect(text).toContain("'-cmd");
		expect(text).toContain("'@cmd");
	});

	it('URL-encoded spec round-trips', async () => {
		expect(decodeSpec(encodeSpec(contactSpec))).toEqual(contactSpec);
		expect(decodeSpec(JSON.stringify(contactSpec))).toEqual(contactSpec);
		const loaded = await loadNew(pageEvent(`/reports/new?spec=${encodeSpec(contactSpec)}`, admin));
		expect(loaded.spec).toEqual(contactSpec);
		expect(loaded.unsaved).toBe(false);
		expect(loaded.mode).toBe('new');
		expect(loaded.wideLayout).toBe(true);
	});
});
