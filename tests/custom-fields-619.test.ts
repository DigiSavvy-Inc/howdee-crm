import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import {
	BUILT_IN_FIELD_KEYS,
	CUSTOM_FIELD_LIMITS,
	FIELD_CAP_MESSAGE,
	FORM_PROTECTED_KEYS,
	fieldKeyFromLabel,
	labelFromKey,
	suggestFieldType,
	uniqueKey,
	validateField,
	valueProblem,
	displayValue
} from '../src/lib/custom-fields';
import {
	archiveCustomField,
	createCustomField,
	customFieldByKey,
	defineKey,
	fieldPicker,
	formFieldPicker,
	formsUsingKeys,
	listCustomFields,
	moveCustomField,
	restoreCustomField,
	undefinedKeys,
	updateCustomField,
	valueCounts
} from '../src/lib/server/custom-fields';
import { blankField, emptyForm, normalizeFormSpec, validateFormSpec, withSettingsOutcome, type FormAction } from '../src/lib/forms';
import { createForm } from '../src/lib/server/forms';
import { POST as apiPOST, GET as apiGET } from '../src/routes/api/custom-fields/+server';
import { load as settingsLoad, actions as settingsActions } from '../src/routes/settings/custom-fields/+page.server';
import { load as contactLoad, actions as contactActions } from '../src/routes/contacts/[id]/+page.server';

// #619: defined custom fields — migration seed, server module, form spec round trip, the
// picker's type suggestion, the API and the Settings page.

/** What the contact page load returns for the Custom fields card. */
type ContactFieldsData = {
	definedFields: { key: string; label: string; type: string; value: string; archived: boolean }[];
	addableFields: { key: string; label: string }[];
	formData: [string, string][];
};

/** A valid form spec (required email question) with one more question mapped to `metaKey`. */
function specMapping(metaKey: string, actions: FormAction[] = []) {
	const email = blankField('email', 'Email');
	email.key = 'email';
	email.required = true;
	email.map = { to: 'contact', field: 'email' };
	const q = blankField('short_text', 'Anything');
	q.key = 'anything';
	q.map = { to: 'meta', key: metaKey };
	return withSettingsOutcome({ ...emptyForm('Protected'), fields: [email, q] }, actions);
}

const db = (env as any).DB as D1Database;
const migrations = (env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[];
const seed = migrations.find((m) => m.name.startsWith('0123_'))!;
const platformEnv = { ...(env as any), SESSION_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://app.test' };
const admin = { id: 1, login: 'admin-619', role: 'admin' };
const member = { id: 2, login: 'member-619', role: 'member' };

function jsonEvent(body: unknown, user: unknown) {
	const url = new URL('https://app.test/api/custom-fields');
	return {
		platform: { env: platformEnv },
		params: {},
		url,
		locals: { user },
		request: new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
	} as any;
}
function formEvent(path: string, params: Record<string, string>, fields: [string, string][], user: unknown) {
	const fd = new FormData();
	for (const [k, v] of fields) fd.append(k, v);
	const url = new URL(`https://app.test${path}`);
	return { platform: { env: platformEnv }, params, url, locals: { user }, request: new Request(url, { method: 'POST', body: fd, headers: { origin: 'https://app.test' } }) } as any;
}
function getEvent(path: string, params: Record<string, string>, user: unknown) {
	const url = new URL(`https://app.test${path}`);
	return { platform: { env: platformEnv }, params, url, locals: { user }, request: new Request(url), setHeaders: () => {} } as any;
}

beforeEach(async () => {
	await db.prepare('DELETE FROM custom_fields').run();
});

describe('vocabulary', () => {
	it('builds keys and labels', () => {
		expect(fieldKeyFromLabel('Monthly budget?')).toBe('monthly_budget');
		expect(fieldKeyFromLabel('2026 plans')).toBe('f_2026_plans');
		expect(fieldKeyFromLabel('x'.repeat(80))).toHaveLength(50);
		expect(labelFromKey('project_type')).toBe('Project type');
		expect(uniqueKey('budget', ['budget', 'budget_2'])).toBe('budget_3');
	});

	it('suggests a type from the question type', () => {
		expect(suggestFieldType('number')).toEqual({ type: 'number', options: [] });
		expect(suggestFieldType('rating')).toEqual({ type: 'number', options: [] });
		expect(suggestFieldType('date')).toEqual({ type: 'date', options: [] });
		expect(suggestFieldType('checkbox')).toEqual({ type: 'yes_no', options: [] });
		expect(suggestFieldType('consent')).toEqual({ type: 'yes_no', options: [] });
		expect(suggestFieldType('select', [{ label: 'Small' }, { label: 'Large' }, { label: 'small' }])).toEqual({ type: 'choice', options: ['Small', 'Large'] });
		expect(suggestFieldType('radio', [{ label: 'A' }])).toEqual({ type: 'choice', options: ['A'] });
		expect(suggestFieldType('short_text')).toEqual({ type: 'text', options: [] });
		expect(suggestFieldType('checkboxes', [{ label: 'A' }])).toEqual({ type: 'text', options: [] });
	});

	it('validates definitions and values', () => {
		expect(validateField({ label: 'Budget' })).toMatchObject({ ok: true, key: 'budget', type: 'text' });
		expect(validateField({ label: '' }).ok).toBe(false);
		expect(validateField({ label: 'Size', type: 'choice', options: '' }).ok).toBe(false);
		expect(validateField({ label: 'Size', type: 'choice', options: 'S\nM\n\nS' })).toMatchObject({ ok: true, options: ['S', 'M'] });
		expect(validateField({ label: 'X', type: 'weird' }).ok).toBe(false);
		expect(validateField({ label: 'X', key: 'a"b' }).ok).toBe(false);
		expect(validateField({ label: 'X', key: 'k'.repeat(51) }).ok).toBe(false);
		const num = { label: 'Budget', type: 'number' as const, options: [] };
		expect(valueProblem(num, '12.5')).toBeNull();
		expect(valueProblem(num, 'lots')).toMatch(/number/);
		expect(valueProblem({ label: 'D', type: 'date', options: [] }, '2026-02-30x')).toMatch(/date/);
		expect(valueProblem({ label: 'D', type: 'date', options: [] }, '2026-02-03')).toBeNull();
		expect(valueProblem({ label: 'Y', type: 'yes_no', options: [] }, 'maybe')).toMatch(/yes or no/);
		expect(valueProblem({ label: 'C', type: 'choice', options: ['A'] }, 'B')).toMatch(/options/);
		expect(valueProblem(num, '')).toBeNull();
		expect(displayValue('yes_no', 'yes')).toBe('Yes');
		expect(displayValue('yes_no', 'no')).toBe('No');
		expect(BUILT_IN_FIELD_KEYS).toEqual(['hygiene', 'phone']);
	});
});

describe('migration 0123 seed', () => {
	async function runSeed() {
		for (const q of seed.queries) await db.prepare(q).run();
	}

	it('is 0123_custom_fields.sql', () => {
		expect(seed?.name).toBe('0123_custom_fields.sql');
	});

	it('an empty database gets no rows', async () => {
		const had = await db.prepare('SELECT COUNT(*) AS n FROM contacts').first<{ n: number }>();
		if (had!.n > 0) return; // other test files share the DB
		await runSeed();
		expect((await listCustomFields(db, { includeArchived: true })).length).toBe(0);
	});

	it('seeds one text row per key found in contacts.meta, skipping malformed meta', async () => {
		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('a@seed619.test', '{"project_type":"Site","budget":"5k"}')`).run();
		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('b@seed619.test', '{"budget":"1k","lead-source":"ad"}')`).run();
		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('c@seed619.test', '{not json')`).run();
		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('d@seed619.test', '[1,2]')`).run();
		await runSeed();
		await runSeed(); // idempotent
		const rows = await listCustomFields(db);
		const byKey = new Map(rows.map((r) => [r.key, r]));
		expect(byKey.get('budget')).toMatchObject({ label: 'Budget', type: 'text', options: [] });
		expect(byKey.get('project_type')).toMatchObject({ label: 'Project type', type: 'text' });
		expect(byKey.get('lead-source')).toMatchObject({ label: 'Lead source' });
		expect(rows.filter((r) => r.key === 'budget')).toHaveLength(1);
		expect(rows.some((r) => r.key === '0' || r.key === '1')).toBe(false);
		// Position follows the key order.
		const keys = rows.map((r) => r.key);
		expect(keys.indexOf('budget')).toBeLessThan(keys.indexOf('project_type'));
	});
});

describe('server module', () => {
	it('creates, refuses a duplicate key, updates and looks up by key', async () => {
		const a = await createCustomField(db, { label: 'Monthly budget', type: 'number' });
		expect(a).toMatchObject({ ok: true, field: { key: 'monthly_budget', type: 'number', built_in: false } });
		const dup = await createCustomField(db, { label: 'Other', key: 'monthly_budget' });
		expect(dup).toMatchObject({ ok: false, status: 409 });
		const id = a.ok ? a.field.id : 0;
		const up = await updateCustomField(db, id, { label: 'Budget per month', type: 'choice', options: ['Low', 'High'] });
		expect(up).toMatchObject({ ok: true, field: { key: 'monthly_budget', label: 'Budget per month', type: 'choice', options: ['Low', 'High'] } });
		expect((await customFieldByKey(db, 'monthly_budget'))?.label).toBe('Budget per month');
		expect(await updateCustomField(db, 999999, { label: 'x' })).toMatchObject({ ok: false, status: 404 });
	});

	it('built-in keys show as built in and cannot be archived or retyped', async () => {
		const h = await defineKey(db, 'hygiene');
		expect(h).toMatchObject({ ok: true, field: { key: 'hygiene', label: 'Hygiene', built_in: true, type: 'text' } });
		const id = h.ok ? h.field.id : 0;
		expect(await archiveCustomField(db, id)).toMatchObject({ ok: false, status: 400 });
		expect(await updateCustomField(db, id, { type: 'number' })).toMatchObject({ ok: false, status: 400 });
		expect(await updateCustomField(db, id, { label: 'Address check' })).toMatchObject({ ok: true, field: { label: 'Address check' } });
		expect(await createCustomField(db, { label: 'Phone', key: 'phone', type: 'number' })).toMatchObject({ ok: false });
	});

	it('archiving hides from pickers and keeps contact data; restore brings it back', async () => {
		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('arch@f619.test', '{"shoe_size":"42"}')`).run();
		const f = await createCustomField(db, { label: 'Shoe size', key: 'shoe_size', type: 'number' });
		const id = f.ok ? f.field.id : 0;
		await archiveCustomField(db, id);
		expect((await fieldPicker(db)).some((x) => x.key === 'shoe_size')).toBe(false);
		expect((await fieldPicker(db, ['shoe_size'])).find((x) => x.key === 'shoe_size')?.label).toBe('Shoe size (archived)');
		const meta = await db.prepare(`SELECT meta FROM contacts WHERE email = 'arch@f619.test'`).first<{ meta: string }>();
		expect(JSON.parse(meta!.meta)).toEqual({ shoe_size: '42' });
		expect((await valueCounts(db)).get('shoe_size')).toBeGreaterThanOrEqual(1);
		await restoreCustomField(db, id);
		expect((await fieldPicker(db)).some((x) => x.key === 'shoe_size')).toBe(true);
	});

	it('the field cap counts active fields only; restore past the cap is refused', async () => {
		const insert = (key: string, archived: boolean) =>
			db
				.prepare(`INSERT INTO custom_fields (key, label, position, archived_at) VALUES (?, ?, 0, ${archived ? "datetime('now')" : 'NULL'})`)
				.bind(key, key);
		const active = Array.from({ length: CUSTOM_FIELD_LIMITS.fields - 1 }, (_, i) => insert(`cap_${i}`, false));
		const archived = Array.from({ length: 5 }, (_, i) => insert(`cap_old_${i}`, true));
		await db.batch([...active, ...archived]);
		// 199 active + 5 archived: the 200th active one still fits.
		expect(await createCustomField(db, { label: 'Last slot' })).toMatchObject({ ok: true });
		expect(await createCustomField(db, { label: 'One too many' })).toEqual({ ok: false, error: FIELD_CAP_MESSAGE, status: 400 });
		expect(FIELD_CAP_MESSAGE).toMatch(/active custom fields\. Archive one you no longer use/);
		expect(await defineKey(db, 'cap_undefined_619')).toMatchObject({ ok: false, status: 400 });
		const old = (await customFieldByKey(db, 'cap_old_0'))!;
		expect(await restoreCustomField(db, old.id)).toEqual({ ok: false, error: FIELD_CAP_MESSAGE, status: 400 });
		expect((await customFieldByKey(db, 'cap_old_0'))?.archived_at).not.toBeNull();
		// Archiving an unused field frees the slot.
		await archiveCustomField(db, (await customFieldByKey(db, 'cap_0'))!.id);
		expect(await restoreCustomField(db, old.id)).toMatchObject({ ok: true, field: { key: 'cap_old_0', archived_at: null } });
	});

	it('reorders and lists undefined keys', async () => {
		const a = await createCustomField(db, { label: 'Alpha' });
		const b = await createCustomField(db, { label: 'Beta' });
		expect((await listCustomFields(db)).map((f) => f.key)).toEqual(['alpha', 'beta']);
		await moveCustomField(db, b.ok ? b.field.id : 0, -1);
		expect((await listCustomFields(db)).map((f) => f.key)).toEqual(['beta', 'alpha']);
		await moveCustomField(db, a.ok ? a.field.id : 0, 1); // already last: no change
		expect((await listCustomFields(db)).map((f) => f.key)).toEqual(['beta', 'alpha']);

		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('undef@f619.test', '{"alpha":"1","mystery_619":"x"}')`).run();
		const u = await undefinedKeys(db);
		expect(u.find((x) => x.key === 'mystery_619')).toMatchObject({ label: 'Mystery 619' });
		expect(u.some((x) => x.key === 'alpha')).toBe(false);
	});

	it('finds the forms that map to a key', async () => {
		const id = await createForm(db, 'Fields form 619', admin.id);
		const q = blankField('short_text', 'Budget');
		q.key = 'budget';
		q.map = { to: 'meta', key: 'budget_619' };
		const spec = withSettingsOutcome({ ...emptyForm('Fields'), fields: [blankField('email', 'Email'), q] }, [
			{ type: 'set_field', key: 'campaign_619', value: 'spring' }
		]);
		await db.prepare('UPDATE forms SET spec = ? WHERE id = ?').bind(JSON.stringify(spec), id).run();
		const used = await formsUsingKeys(db);
		expect(used.get('budget_619')?.map((f) => f.id)).toContain(id);
		expect(used.get('campaign_619')?.map((f) => f.id)).toContain(id);
	});
});

describe('form spec round trip', () => {
	it('keeps a custom-field mapping and a Set a field action as keys', () => {
		const email = blankField('email', 'Email');
		email.key = 'email';
		email.required = true;
		email.map = { to: 'contact', field: 'email' };
		const q = blankField('select', 'Company size');
		q.key = 'company_size';
		q.options = [{ value: 'Small', label: 'Small' }, { value: 'Large', label: 'Large' }];
		q.map = { to: 'meta', key: 'company_size' };
		const spec = withSettingsOutcome({ ...emptyForm('Round trip'), fields: [email, q] }, [
			{ type: 'set_field', key: 'not_defined_yet', value: 'x' },
			{ type: 'message_md', md: 'Thanks' }
		]);
		const back = normalizeFormSpec(JSON.parse(JSON.stringify(spec)));
		expect(back.fields[1].map).toEqual({ to: 'meta', key: 'company_size' });
		expect(back.outcomes.flatMap((o) => o.actions)).toContainEqual({ type: 'set_field', key: 'not_defined_yet', value: 'x' });
		expect(validateFormSpec(back)).toEqual([]);
		// The picker's suggestion for this question.
		expect(suggestFieldType(q.type, q.options)).toEqual({ type: 'choice', options: ['Small', 'Large'] });
	});
});

describe('hygiene stays app-managed in forms', () => {
	it('form pickers leave out hygiene (even when kept); rule pickers still offer it; phone stays', async () => {
		expect(FORM_PROTECTED_KEYS).toEqual(['hygiene']);
		await defineKey(db, 'hygiene');
		await defineKey(db, 'phone');
		await createCustomField(db, { label: 'Budget' });
		expect((await fieldPicker(db)).map((f) => f.key)).toEqual(['hygiene', 'phone', 'budget']);
		expect((await formFieldPicker(db)).map((f) => f.key)).toEqual(['phone', 'budget']);
		expect((await formFieldPicker(db, ['hygiene'])).some((f) => f.key === 'hygiene')).toBe(false);
		const list = await apiGET(getEvent('/api/custom-fields', {}, admin));
		expect(((await list.json()) as { fields: { key: string }[] }).fields.map((f) => f.key)).toEqual(['phone', 'budget']);
	});

	it('the API refuses to create or define hygiene', async () => {
		expect((await apiPOST(jsonEvent({ label: 'Hygiene' }, admin))).status).toBe(400);
		expect((await apiPOST(jsonEvent({ define: true, key: 'hygiene', label: 'Hygiene' }, admin))).status).toBe(400);
		expect(await customFieldByKey(db, 'hygiene')).toBeNull();
		expect((await apiPOST(jsonEvent({ define: true, key: 'phone', label: 'Phone' }, admin))).status).toBe(201);
	});

	it('the form spec refuses a mapping or a Set a field action on hygiene', () => {
		const mapped = validateFormSpec(specMapping('hygiene'));
		expect(mapped).toEqual([{ path: 'fields[1].map', message: expect.stringMatching(/set by the app/) }]);
		const set = validateFormSpec(specMapping('budget', [{ type: 'set_field', key: 'hygiene', value: 'ok' }]));
		expect(set).toEqual([{ path: 'outcomes[0].actions[0]', message: expect.stringMatching(/set by the app/) }]);
		expect(validateFormSpec(specMapping('phone', [{ type: 'set_field', key: 'budget', value: '5k' }]))).toEqual([]);
	});
});

describe('routes', () => {
	it('API: members can read, only admins create; define keeps an existing key', async () => {
		const denied = await apiPOST(jsonEvent({ label: 'Budget' }, member));
		expect(denied.status).toBe(403);
		const made = await apiPOST(jsonEvent({ label: 'Team size', type: 'number' }, admin));
		expect(made.status).toBe(201);
		expect(await made.json()).toEqual({ field: { key: 'team_size', label: 'Team size', type: 'number', options: [] } });
		const bad = await apiPOST(jsonEvent({ label: 'Pick', type: 'choice', options: [] }, admin));
		expect(bad.status).toBe(400);
		const def = await apiPOST(jsonEvent({ define: true, key: 'Old Key', label: 'Old key', type: 'text' }, admin));
		expect(def.status).toBe(201);
		expect(((await def.json()) as { field: { key: string } }).field.key).toBe('Old Key');
		const list = await apiGET(getEvent('/api/custom-fields', {}, member));
		expect(((await list.json()) as { fields: { key: string }[] }).fields.map((f) => f.key)).toEqual(['team_size', 'Old Key']);
	});

	it('Settings → Custom fields is admin-only and creates / archives / defines', async () => {
		await expect(settingsLoad(getEvent('/settings/custom-fields', {}, member))).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 403);
		await expect(settingsActions.create!(formEvent('/settings/custom-fields', {}, [['label', 'X']], member))).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 403);
		const r = (await settingsActions.create!(formEvent('/settings/custom-fields', {}, [['label', 'Industry'], ['type', 'choice'], ['options', 'SaaS\nAgency']], admin))) as any;
		expect(r.ok).toMatch(/Industry/);
		const f = (await customFieldByKey(db, 'industry'))!;
		expect(f.options).toEqual(['SaaS', 'Agency']);
		await settingsActions.archive!(formEvent('/settings/custom-fields', {}, [['id', String(f.id)]], admin));
		const data = (await settingsLoad(getEvent('/settings/custom-fields', {}, admin))) as any;
		expect(data.fields.find((x: { key: string }) => x.key === 'industry').archived_at).not.toBeNull();
		await db.prepare(`INSERT INTO contacts (email, meta) VALUES ('def@f619.test', '{"legacy_619":"v"}')`).run();
		const after = (await settingsLoad(getEvent('/settings/custom-fields', {}, admin))) as any;
		expect(after.undefinedKeys.some((u: { key: string }) => u.key === 'legacy_619')).toBe(true);
		await settingsActions.define!(formEvent('/settings/custom-fields', {}, [['key', 'legacy_619']], admin));
		expect((await customFieldByKey(db, 'legacy_619'))?.label).toBe('Legacy 619');
	});

	it('contact page: defined fields first with typed values; bad values are refused', async () => {
		await createCustomField(db, { label: 'Seats', key: 'seats', type: 'number' });
		const c = await db
			.prepare(`INSERT INTO contacts (email, meta) VALUES ('cp@f619.test', '{"seats":"3","free_619":"hello"}') RETURNING id`)
			.first<{ id: number }>();
		const id = String(c!.id);
		const data = (await contactLoad(getEvent(`/contacts/${id}`, { id }, admin))) as any;
		expect(data.definedFields.find((f: { key: string }) => f.key === 'seats')).toMatchObject({ label: 'Seats', type: 'number', value: '3' });
		expect(data.formData).toEqual([['free_619', 'hello']]);
		const bad = (await contactActions.setField!(formEvent(`/contacts/${id}`, { id }, [['field_name', 'seats'], ['field_value', 'many'], ['typed', '1']], admin))) as any;
		expect(bad.status).toBe(400);
		await contactActions.setField!(formEvent(`/contacts/${id}`, { id }, [['field_name', 'seats'], ['field_value', ''], ['typed', '1']], admin));
		const row = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(c!.id).first<{ meta: string }>();
		expect(JSON.parse(row!.meta)).toEqual({ free_619: 'hello' });
		// Cleared: the row goes and the field is offered under "+ Add field" again.
		const after = (await contactLoad(getEvent(`/contacts/${id}`, { id }, admin))) as unknown as ContactFieldsData;
		expect(after.definedFields).toEqual([]);
		expect(after.addableFields.map((f) => f.key)).toEqual(['seats']);
	});

	it('contact page: rows only for fields with a value (archived included); addable = active fields without one', async () => {
		await createCustomField(db, { label: 'Which plan fits?', key: 'plan_619', type: 'choice', options: ['Basic', 'Pro'] });
		await createCustomField(db, { label: 'Team size', key: 'team_619', type: 'number' });
		const old = await createCustomField(db, { label: 'Old source', key: 'old_619' });
		const gone = await createCustomField(db, { label: 'Gone', key: 'gone_619' });
		await archiveCustomField(db, old.ok ? old.field.id : 0);
		await archiveCustomField(db, gone.ok ? gone.field.id : 0);
		const c = await db
			.prepare(`INSERT INTO contacts (email, meta) VALUES ('rows@f619.test', '{"plan_619":"Pro","old_619":"fair","team_619":"  ","loose_619":"x"}') RETURNING id`)
			.first<{ id: number }>();
		const id = String(c!.id);
		const data = (await contactLoad(getEvent(`/contacts/${id}`, { id }, admin))) as unknown as ContactFieldsData;
		expect(data.definedFields.map((f) => [f.key, f.label, f.archived])).toEqual([
			['plan_619', 'Which plan fits?', false],
			['old_619', 'Old source', true]
		]);
		expect(data.addableFields.map((f) => f.key)).toEqual(['team_619']);
		expect(data.formData).toEqual([['loose_619', 'x']]);
	});
});
