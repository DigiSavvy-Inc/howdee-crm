import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { emptyForm } from '../src/lib/forms';
import { createForm, recordSubmission } from '../src/lib/server/forms';
import { compileRule, compileSegment } from '../src/lib/server/segment-query';
import { contactsWhere, contactsFilterParams, parseContactsFilter, parseFormFilter } from '../src/lib/server/contacts-query';
import { memberQuery, parseFilter, filterParams } from '../src/lib/server/contact-filter';
import { contactFormSubmissions, formPicker, formSubmittedClause } from '../src/lib/server/form-reads';
import { contactFilterChips } from '../src/lib/contact-filter-chips';
import { filterToRules } from '../src/lib/server/contacts-overview';
import { load as contactLoad } from '../src/routes/contacts/[id]/+page.server';
import formsCard from '../src/lib/components/forms/FormsCard.svelte?raw';
import contactPage from '../src/routes/contacts/[id]/+page.svelte?raw';

// #516: the "Submitted form" contacts filter (/contacts + the member table), the
// `form_submitted` segment rule, and the contact page's Forms card.
const db = (env as any).DB as D1Database;

async function form(name: string): Promise<number> {
	const id = await createForm(db, name, null);
	const spec = emptyForm(name);
	spec.fields.push({ ...spec.fields[0], id: 'q2', key: 'budget', type: 'radio', label: 'Budget', required: false, map: null, options: [{ value: 'big', label: 'Big' }] });
	await db.prepare("UPDATE forms SET spec = ?, status = 'published' WHERE id = ?").bind(JSON.stringify(spec), id).run();
	return id;
}
async function contact(email: string): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(email).first<{ id: number }>())!.id;
}
async function submitted(formId: number, contactId: number | null, opts: { status?: 'added' | 'updated' | 'anonymous' | 'spam'; daysAgo?: number; answers?: Record<string, unknown> } = {}) {
	const id = await recordSubmission(db, {
		form_id: formId,
		form_version: 1,
		contact_id: contactId,
		email: null,
		status: opts.status ?? 'added',
		detail: null,
		answers: (opts.answers ?? {}) as any,
		utm: null,
		referrer: null,
		ip_hash: null,
		user_agent: null
	});
	if (opts.daysAgo) await db.prepare("UPDATE form_submissions SET created_at = datetime('now', ?) WHERE id = ?").bind(`-${opts.daysAgo} days`, id).run();
	return id;
}
async function ids(where: string, binds: unknown[]): Promise<number[]> {
	return (await db.prepare(`SELECT id FROM contacts WHERE ${where} ORDER BY id`).bind(...binds).all<{ id: number }>()).results.map((r) => r.id);
}
async function filtered(w: { where: string; params: unknown[] }): Promise<number[]> {
	return (await db.prepare(`SELECT id FROM contacts ${w.where} ORDER BY id`).bind(...w.params).all<{ id: number }>()).results.map((r) => r.id);
}
async function segment(rule: Record<string, string>): Promise<number[]> {
	const seg = compileSegment({ match: 'all', rules: [rule as any] });
	return (await db.prepare(`${seg.sql} ORDER BY 1`).bind(...seg.binds).all<Record<string, number>>()).results.map((r) => Object.values(r)[0]);
}

let fA = 0;
let fB = 0;
let ann = 0;
let bob = 0;
let cat = 0;
let dan = 0;

beforeEach(async () => {
	await db.batch([db.prepare('DELETE FROM form_submissions'), db.prepare('DELETE FROM contacts')]);
	fA = await form('Quote');
	fB = await form('Feedback');
	ann = await contact('ann@surfaces516.test'); // Quote, today
	bob = await contact('bob@surfaces516.test'); // Feedback, 40 days ago
	cat = await contact('cat@surfaces516.test'); // nothing
	dan = await contact('dan@surfaces516.test'); // only a spam row
	await submitted(fA, ann, { answers: { email: 'ann@surfaces516.test', budget: 'big' } });
	await submitted(fB, bob, { status: 'updated', daysAgo: 40 });
	await submitted(fA, dan, { status: 'spam' });
});

describe('formSubmittedClause', () => {
	it('any form / one form / a window / negated', async () => {
		const run = async (formId: number | null, days: number | null, negate = false) => {
			const c = formSubmittedClause('contacts.id', formId, days, negate);
			return ids(c.clause, c.binds);
		};
		expect(await run(null, null)).toEqual([ann, bob]);
		expect(await run(fA, null)).toEqual([ann]);
		expect(await run(null, 30)).toEqual([ann]);
		expect(await run(fB, 30)).toEqual([]);
		expect(await run(null, null, true)).toEqual([cat, dan]);
	});
});

describe('/contacts filter', () => {
	it('parses, serializes and filters', async () => {
		expect(parseFormFilter('any')).toBe('any');
		expect(parseFormFilter('7')).toBe(7);
		expect(parseFormFilter('x')).toBeNull();
		const f = parseContactsFilter(new URLSearchParams({ form: 'any', form_days: '30' }));
		expect(f.form).toBe('any');
		expect(f.formDays).toBe(30);
		expect(contactsFilterParams(f)).toMatchObject({ form: 'any', form_days: '30' });
		const w = contactsWhere(f);
		expect(await filtered(w)).toEqual([ann]);
		const g = contactsWhere(parseContactsFilter(new URLSearchParams({ form: String(fB) })));
		expect(await filtered(g)).toEqual([bob]);
		// form_days without form is ignored.
		expect(parseContactsFilter(new URLSearchParams({ form_days: '3' })).formDays).toBeNull();
	});
	it('chip + Save as segment mapping', () => {
		const f = parseContactsFilter(new URLSearchParams({ form: String(fA), form_days: '7' }));
		const chip = contactFilterChips(f, { forms: [{ id: fA, name: 'Quote' }] }).find((c) => c.kind === 'form');
		expect(chip).toMatchObject({ label: 'Submitted form “Quote” in the last 7 days', clear: ['form', 'form_days'] });
		expect(filterToRules(f).rules).toContainEqual({ field: 'form_submitted', op: 'yes', value: String(fA), value2: '7' });
	});
});

describe('member table filter (/lists/[id])', () => {
	it('narrows the members', async () => {
		const list = (await db.prepare("INSERT INTO lists (name, kind) VALUES ('Surfaces 516', 'list') RETURNING id").first<{ id: number }>())!.id;
		for (const c of [ann, bob, cat]) await db.prepare('INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)').bind(list, c).run();
		const f = parseFilter(new URLSearchParams({ form: String(fA) }));
		expect(filterParams(f)).toMatchObject({ form: String(fA) });
		const q = memberQuery(list, f);
		const rows = await db
			.prepare(`SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE ${q.where} ORDER BY c.id`)
			.bind(...q.params)
			.all<{ id: number }>();
		expect(rows.results.map((r) => r.id)).toEqual([ann]);
	});
});

describe('form_submitted segment rule', () => {
	it('compiles and matches', async () => {
		expect(compileRule({ field: 'form_submitted', op: 'maybe' })).toBeNull();
		expect(compileRule({ field: 'form_submitted', op: 'yes', value: 'x' })).toBeNull();
		expect(compileRule({ field: 'form_submitted', op: 'yes', value2: '-3' })).toBeNull();
		expect(await segment({ field: 'form_submitted', op: 'yes', value: '' })).toEqual([ann, bob]);
		expect(await segment({ field: 'form_submitted', op: 'yes', value: String(fB), value2: '' })).toEqual([bob]);
		expect(await segment({ field: 'form_submitted', op: 'yes', value: '', value2: '30' })).toEqual([ann]);
		expect(await segment({ field: 'form_submitted', op: 'no', value: String(fA) })).toEqual([bob, cat, dan]);
	});
});

describe('contact page Forms card', () => {
	it('loads the submissions newest first with labelled answers', async () => {
		await submitted(fB, ann, { status: 'updated', answers: { budget: 'big', gone: 'kept' } });
		const subs = await contactFormSubmissions(db, ann);
		expect(subs.map((s) => s.form_name)).toEqual(['Feedback', 'Quote']);
		expect(subs[0].answers).toEqual([
			{ label: 'Budget', text: 'Big' },
			{ label: 'gone', text: 'kept' }
		]);
		expect(await contactFormSubmissions(db, cat)).toEqual([]);
		const picker = await formPicker(db);
		expect(picker.find((p) => p.id === fA)?.questions.map((q) => q.key)).toEqual(['email', 'budget']);
	});
	it('is returned by the contact page load and rendered when present', async () => {
		const data = (await contactLoad({
			platform: { env },
			params: { id: String(ann) },
			url: new URL(`https://app.test/contacts/${ann}`),
			locals: { user: { id: 1, github_login: 'jdoe', role: 'member' } },
			request: new Request(`https://app.test/contacts/${ann}`)
		} as any)) as any;
		expect(data.formSubmissions).toHaveLength(1);
		expect(data.formSubmissions[0]).toMatchObject({ form_id: fA, form_name: 'Quote', status: 'added' });
		expect(contactPage).toContain('<FormsCard');
		expect(formsCard).toContain('?tab=submissions&q=');
	});
});
