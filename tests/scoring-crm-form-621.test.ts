// #621: scoring points for submitting a CRM form (form_submissions), with an optional filter on
// the form and on its answers; the seeded Lead score rule (migration 0125); the form page's
// Scoring section; the contact page history row.
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { EVENT_TYPES, SOURCE_LABELS, SOURCE_TABLES, answerRulesText, eventTypeLabel, validateRule, validateScore } from '../src/lib/scoring';
import { createRule, createScore } from '../src/lib/server/scoring/store';
import { rebuildScore, runScoringJob, setWatermarks, type Watermarks } from '../src/lib/server/scoring/engine';
import { contactScores } from '../src/lib/server/scoring/contact';
import { formScoreRules, formPickers } from '../src/lib/server/scoring/form-rules';
import * as editPage from '../src/routes/settings/scoring/[id]/+page.server';
import * as listPage from '../src/routes/settings/scoring/+page.server';
import * as formPage from '../src/routes/forms/[id]/+page.server';

const db = (env as any).DB as D1Database;
const migrations = import.meta.glob('../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

let admin: any;
let member: any;
let seq = 0;

function sessionUser(u: { id: number; github_login: string; role: 'admin' | 'member' }) {
	return { ...u, name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false } as any;
}

async function makeUser(login: string, role: 'admin' | 'member') {
	const r = await db.prepare('INSERT INTO users (github_login, role) VALUES (?, ?) RETURNING id').bind(login, role).first<{ id: number }>();
	return sessionUser({ id: r!.id, github_login: login, role });
}

function ev(path: string, opts: { user: any; params?: Record<string, string> }) {
	const url = new URL(`https://app.test${path}`);
	return {
		url,
		params: opts.params ?? {},
		request: new Request(url),
		locals: { user: opts.user, authed: !!opts.user },
		platform: { env: env as any }
	} as any;
}

async function contact(): Promise<number> {
	seq++;
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(`crmform-${seq}-${Date.now()}@test.co`).first<{ id: number }>())!.id;
}

const SPEC = {
	title: 'Audit',
	fields: [
		{ id: 'f_email', type: 'email', key: 'email', label: 'Email', required: true, options: [], map: { to: 'contact', field: 'email' } },
		{
			id: 'f_role',
			type: 'radio',
			key: 'role',
			label: 'Your role',
			required: false,
			options: [
				{ value: 'owner', label: 'Owner' },
				{ value: 'staff', label: 'Staff' }
			]
		},
		{ id: 'f_rate', type: 'rating', key: 'rate', label: 'How likely', required: false, options: [] }
	]
};

async function form(name = `Form ${++seq}`): Promise<number> {
	return (
		await db
			.prepare("INSERT INTO forms (name, slug, status, spec) VALUES (?, ?, 'published', ?) RETURNING id")
			.bind(name, `f-${seq}-${Date.now()}`, JSON.stringify(SPEC))
			.first<{ id: number }>()
	)!.id;
}

async function submit(formId: number, contactId: number | null, answers: Record<string, unknown>, status = 'added', ago = '-0 seconds'): Promise<number> {
	return (
		await db
			.prepare(`INSERT INTO form_submissions (form_id, contact_id, status, answers, created_at) VALUES (?, ?, ?, ?, datetime('now', ?)) RETURNING id`)
			.bind(formId, contactId, status, JSON.stringify(answers), ago)
			.first<{ id: number }>()
	)!.id;
}

async function score(): Promise<number> {
	const v = validateScore({ name: `CRM form score ${++seq}`, decay_mode: 'expire', bands: '[]' });
	if (!v.ok) throw new Error(v.error);
	const r = await createScore(db, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

async function rule(scoreId: number, raw: Record<string, unknown>): Promise<number> {
	const v = validateRule({ kind: 'event', event_type: 'crm_form_submit', ...raw }, 'expire');
	if (!v.ok) throw new Error(v.error);
	const r = await createRule(db, scoreId, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

async function watermarksToNow(): Promise<void> {
	const wm: Watermarks = {};
	for (const s of SOURCE_TABLES) {
		const col = s === 'list_members' ? 'rowid' : 'id';
		wm[s] = (await db.prepare(`SELECT COALESCE(MAX(${col}), 0) AS m FROM ${s}`).first<{ m: number }>())!.m;
	}
	await setWatermarks(db, wm);
}

async function ledger(scoreId: number, contactId: number) {
	return (
		await db.prepare('SELECT * FROM score_points WHERE score_id = ? AND contact_id = ? ORDER BY id').bind(scoreId, contactId).all<any>()
	).results;
}

const owner = { match: 'all', rules: [{ field: 'role', op: 'eq', value: 'owner' }] };

beforeAll(async () => {
	admin = await makeUser(`crmform-admin-${Date.now()}`, 'admin');
	member = await makeUser(`crmform-member-${Date.now()}`, 'member');
	await runScoringJob(db);
});

describe('catalogue + validation', () => {
	it('adds the CRM form event and relabels the webhook one', () => {
		const crm = EVENT_TYPES.find((e) => e.type === 'crm_form_submit')!;
		expect(crm).toMatchObject({ label: 'Submitted a CRM form', source: 'form_submissions', filters: ['form_id', 'answers'] });
		expect(eventTypeLabel('form_submit')).toBe('Submitted an external form (webhook)');
		expect(SOURCE_LABELS.form_submissions).toBe('Form submission');
		expect(SOURCE_TABLES).toContain('form_submissions');
	});

	it('validates the form and the answer rule set', () => {
		const ok = validateRule({ kind: 'event', event_type: 'crm_form_submit', points: '10', filter: JSON.stringify({ form_id: 3, answers: owner }) });
		expect(ok.ok && ok.value.filter).toEqual({ form_id: 3, answers: owner });
		// Answers need one form.
		expect(validateRule({ kind: 'event', event_type: 'crm_form_submit', points: '10', filter: JSON.stringify({ answers: owner }) }).ok).toBe(false);
		// At most 10 rules.
		const many = { match: 'all', rules: Array.from({ length: 11 }, () => ({ field: 'role', op: 'eq', value: 'owner' })) };
		expect(validateRule({ kind: 'event', event_type: 'crm_form_submit', points: '1', filter: JSON.stringify({ form_id: 3, answers: many }) }).ok).toBe(false);
		// Unknown op, missing value, a non-number for a number comparison.
		for (const r of [
			{ field: 'role', op: 'like', value: 'x' },
			{ field: 'role', op: 'eq', value: '' },
			{ field: 'rate', op: 'gte', value: 'high' },
			{ field: 'contact:email', op: 'not_empty' }
		]) {
			const v = validateRule({ kind: 'event', event_type: 'crm_form_submit', points: '1', filter: { form_id: 3, answers: { match: 'all', rules: [r] } } });
			expect(v.ok, JSON.stringify(r)).toBe(false);
		}
		// Unary ops take no value; an empty rule list = no condition.
		const unary = validateRule({ kind: 'event', event_type: 'crm_form_submit', points: '1', filter: { form_id: 3, answers: { match: 'any', rules: [{ field: 'rate', op: 'not_empty', value: 'x' }] } } });
		expect(unary.ok && unary.value.filter?.answers).toEqual({ match: 'any', rules: [{ field: 'rate', op: 'not_empty' }] });
		const none = validateRule({ kind: 'event', event_type: 'crm_form_submit', points: '1', filter: { form_id: 3, answers: { match: 'all', rules: [] } } });
		expect(none.ok && none.value.filter).toEqual({ form_id: 3 });
		// The webhook event can't take the new filters.
		expect(validateRule({ kind: 'event', event_type: 'form_submit', points: '1', filter: { form_id: 3 } }).ok).toBe(false);
	});

	it('puts answer conditions in words', () => {
		const q = [{ key: 'role', label: 'Your role', type: 'radio', options: [{ value: 'owner', label: 'Owner' }] }];
		expect(answerRulesText(owner as any, q)).toBe('“Your role” is “Owner”');
		expect(
			answerRulesText({ match: 'any', rules: [{ field: 'rate', op: 'gte', value: '8' }, { field: 'role', op: 'not_empty' }] }, q)
		).toBe('“rate” is at least “8” or “Your role” is answered');
	});
});

describe('engine', () => {
	it('filters by form', async () => {
		const s = await score();
		const a = await form();
		const b = await form();
		await rule(s, { points: '10', filter: JSON.stringify({ form_id: a }) });
		const c = await contact();
		await watermarksToNow();
		const subA = await submit(a, c, { role: 'staff' });
		await submit(b, c, { role: 'staff' });
		await runScoringJob(db);
		const rows = await ledger(s, c);
		expect(rows.map((r) => [r.source_type, r.source_id, r.points])).toEqual([['form_submissions', String(subA), 10]]);
	});

	it('any CRM form when no form is picked', async () => {
		const s = await score();
		await rule(s, { points: '2' });
		const c = await contact();
		await watermarksToNow();
		await submit(await form(), c, {});
		await submit(await form(), c, {}, 'updated');
		await runScoringJob(db);
		expect((await ledger(s, c)).length).toBe(2);
	});

	it('answer rule set true and false', async () => {
		const s = await score();
		const f = await form();
		await rule(s, { points: '10', filter: JSON.stringify({ form_id: f, answers: owner }) });
		await rule(s, { points: '5', filter: JSON.stringify({ form_id: f, answers: { match: 'all', rules: [{ field: 'rate', op: 'gte', value: '8' }] } }) });
		const c1 = await contact();
		const c2 = await contact();
		await watermarksToNow();
		await submit(f, c1, { role: 'owner', rate: 9 });
		await submit(f, c2, { role: 'staff', rate: 3 });
		await runScoringJob(db);
		expect((await ledger(s, c1)).map((r) => r.points).sort()).toEqual([10, 5]);
		expect(await ledger(s, c2)).toEqual([]);
	});

	it('anonymous, spam and rejected submissions earn nothing', async () => {
		const s = await score();
		const f = await form();
		await rule(s, { points: '10', filter: JSON.stringify({ form_id: f }) });
		const c = await contact();
		await watermarksToNow();
		await submit(f, null, { role: 'owner' }, 'anonymous');
		await submit(f, c, { role: 'owner' }, 'rejected');
		await submit(f, c, { role: 'owner' }, 'spam');
		await runScoringJob(db);
		expect(await ledger(s, c)).toEqual([]);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM score_points WHERE score_id = ?').bind(s).first<{ n: number }>())!.n).toBe(0);
	});

	it('`once` and `max_per_day`', async () => {
		const s1 = await score();
		const s2 = await score();
		const f = await form();
		await rule(s1, { points: '10', once: 'on', filter: JSON.stringify({ form_id: f }) });
		await rule(s2, { points: '3', max_per_day: '2', filter: JSON.stringify({ form_id: f }) });
		const c = await contact();
		await watermarksToNow();
		for (let i = 0; i < 3; i++) await submit(f, c, {});
		await runScoringJob(db);
		await submit(f, c, {});
		await runScoringJob(db);
		expect((await ledger(s1, c)).length).toBe(1);
		expect((await ledger(s2, c)).length).toBe(2);
	});

	it('never awards points for submissions made before the rule', async () => {
		const s = await score();
		const f = await form();
		const c = await contact();
		await submit(f, c, { role: 'owner' }, 'added', '-2 days');
		await rule(s, { points: '10', filter: JSON.stringify({ form_id: f }) });
		await rebuildScore(db, s);
		for (let i = 0; i < 10; i++) await runScoringJob(db);
		expect(await ledger(s, c)).toEqual([]);
		const fresh = await submit(f, c, { role: 'owner' });
		for (let i = 0; i < 3; i++) await runScoringJob(db);
		expect((await ledger(s, c)).map((r) => r.source_id)).toEqual([String(fresh)]);
	});
});

describe('migration 0125', () => {
	const name = Object.keys(migrations).find((k) => k.includes('/0125_'))!;
	const insert = migrations[name]
		.split(';')
		.map((st) => st.replace(/^\s*--.*$/gm, '').trim())
		.find((st) => st.startsWith('INSERT'))!;

	it('adds "Submitted a CRM form" to the Lead score once', async () => {
		expect(name).toContain('0125_form_score_rule.sql');
		const lead = (await db.prepare("SELECT id FROM score_defs WHERE slug = 'lead-score'").first<{ id: number }>())!.id;
		const rows = async () =>
			(await db.prepare("SELECT * FROM score_rules WHERE score_id = ? AND event_type = 'crm_form_submit'").bind(lead).all<any>()).results;
		const r = await rows();
		expect(r.length).toBe(1);
		expect(r[0]).toMatchObject({ label: 'Submitted a CRM form', points: 20, expires_days: 180, kind: 'event', active: 1, filter: null });
		expect(r[0].created_at).toBeTruthy();
		// Guard: re-running adds nothing while the CRM rule exists…
		await db.prepare(insert).run();
		expect((await rows()).length).toBe(1);
		// …nor once the webhook form rule is gone.
		const ids = r.map((x) => x.id);
		const webhook = (await db.prepare("SELECT id FROM score_rules WHERE score_id = ? AND event_type = 'form_submit'").bind(lead).first<{ id: number }>())!.id;
		await db.prepare('DELETE FROM score_rules WHERE id = ?').bind(ids[0]).run();
		await db.prepare("UPDATE score_rules SET event_type = 'email_reply' WHERE id = ?").bind(webhook).run();
		await db.prepare(insert).run();
		expect((await rows()).length).toBe(0);
		// With the webhook rule back, it's added again.
		await db.prepare("UPDATE score_rules SET event_type = 'form_submit' WHERE id = ?").bind(webhook).run();
		await db.prepare(insert).run();
		expect((await rows()).length).toBe(1);
	});
});

describe('surfaces', () => {
	it('the contact history row names and links the form', async () => {
		const s = await score();
		const f = await form('History form');
		await rule(s, { points: '7', filter: JSON.stringify({ form_id: f }) });
		const c = await contact();
		await watermarksToNow();
		await submit(f, c, {});
		await runScoringJob(db);
		const sc = (await contactScores(db, c)).find((x) => x.score_id === s)!;
		expect(sc.history[0]).toMatchObject({ source_type: 'form_submissions', form_id: f, form_name: 'History form', points: 7 });
	});

	it('formScoreRules lists rules on this form and on any form, in words', async () => {
		const s = await score();
		const f = await form();
		const other = await form();
		await rule(s, { points: '10', filter: JSON.stringify({ form_id: f, answers: owner }) });
		await rule(s, { points: '4', filter: JSON.stringify({ form_id: other }) });
		const pick = (await formPickers(db)).find((x) => x.id === f)!;
		expect(pick.questions.map((q) => q.key)).toEqual(['email', 'role', 'rate']);
		const rows = (await formScoreRules(db, f, pick.questions)).filter((r) => r.score_id === s);
		expect(rows).toEqual([expect.objectContaining({ points: 10, this_form: true, conditions: '“Your role” is “Owner”' })]);
		// The seeded Lead score rule counts any CRM form.
		expect((await formScoreRules(db, f, pick.questions)).some((r) => !r.this_form && r.points === 20)).toBe(true);
	});

	it('the form page returns its score rules to admins only', async () => {
		const f = await form();
		const a: any = await formPage.load(ev(`/forms/${f}`, { user: admin, params: { id: String(f) } }));
		expect(a.scoreRules.some((r: any) => r.points === 20)).toBe(true);
		const m: any = await formPage.load(ev(`/forms/${f}`, { user: member, params: { id: String(f) } }));
		expect(m.scoreRules).toEqual([]);
	});

	it('Settings → Scoring carries the form through to the score page', async () => {
		const f = await form('Preselected');
		const list: any = await listPage.load(ev(`/settings/scoring?form=${f}`, { user: admin }));
		expect(list.addForm).toEqual({ id: f, name: 'Preselected' });
		const s = await score();
		const page: any = await editPage.load(ev(`/settings/scoring/${s}?add_form=${f}`, { user: admin, params: { id: String(s) } }));
		expect(page.addForm).toBe(f);
		expect(page.pickers.forms.find((x: any) => x.id === f)?.questions.length).toBe(3);
		const none: any = await editPage.load(ev(`/settings/scoring/${s}?add_form=999999`, { user: admin, params: { id: String(s) } }));
		expect(none.addForm).toBeNull();
	});
});
