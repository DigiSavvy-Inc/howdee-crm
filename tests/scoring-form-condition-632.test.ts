// #632: a score condition rule may use "Submitted form" (form_submitted, #516). The server
// accepted it before; this checks it evaluates correctly in the condition run and that the
// score rule editor offers it (the RuleBuilder gets the forms).
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { CONDITION_FIELDS, validateRule, validateScore } from '../src/lib/scoring';
import { createRule, createScore } from '../src/lib/server/scoring/store';
import { computePairs, processConditions } from '../src/lib/server/scoring/engine';
import * as editPage from '../src/routes/settings/scoring/[id]/+page.server';
import scoreRuleFormSrc from '../src/lib/components/ScoreRuleForm.svelte?raw';

const db = (env as any).DB as D1Database;
let admin: any;
let seq = 0;

beforeAll(async () => {
	const r = await db.prepare("INSERT INTO users (github_login, role) VALUES (?, 'admin') RETURNING id").bind(`admin632-${Date.now()}`).first<{ id: number }>();
	admin = { id: r!.id, github_login: 'admin632', role: 'admin', name: null, avatar_url: null, tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false };
});

async function contact(): Promise<number> {
	return (await db.prepare('INSERT INTO contacts (email) VALUES (?) RETURNING id').bind(`fc632-${++seq}-${Date.now()}@test.co`).first<{ id: number }>())!.id;
}

async function form(status = 'published'): Promise<number> {
	return (
		await db
			.prepare('INSERT INTO forms (name, slug, status, spec) VALUES (?, ?, ?, ?) RETURNING id')
			.bind(`Form 632 ${++seq}`, `f632-${seq}-${Date.now()}`, status, '{}')
			.first<{ id: number }>()
	)!.id;
}

async function submit(formId: number, contactId: number | null, status = 'added', ago = '-0 seconds'): Promise<void> {
	await db
		.prepare(`INSERT INTO form_submissions (form_id, contact_id, status, answers, created_at) VALUES (?, ?, ?, '{}', datetime('now', ?))`)
		.bind(formId, contactId, status, ago)
		.run();
}

async function score(): Promise<number> {
	const v = validateScore({ name: `Form condition score ${++seq}`, decay_mode: 'expire', bands: '[]' });
	if (!v.ok) throw new Error(v.error);
	const r = await createScore(db, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

async function conditionRule(scoreId: number, rule: Record<string, unknown>, points = 6): Promise<number> {
	const v = validateRule({ kind: 'condition', points: String(points), rules: JSON.stringify({ match: 'all', rules: [rule] }) });
	if (!v.ok) throw new Error(v.error);
	const r = await createRule(db, scoreId, v.value);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

async function drain() {
	for (let i = 0; i < 20; i++) if (!(await processConditions(db, new Date()))) break;
}

async function value(scoreId: number, contactId: number): Promise<number> {
	await computePairs(db, [[contactId, scoreId]]);
	return (await db.prepare('SELECT value FROM contact_scores WHERE score_id = ? AND contact_id = ?').bind(scoreId, contactId).first<{ value: number }>())?.value ?? 0;
}

describe('#632 form_submitted as a score condition', () => {
	it('is a condition field and passes validation', () => {
		expect(CONDITION_FIELDS).toContain('form_submitted');
		expect(CONDITION_FIELDS).not.toContain('form_answer');
		const ok = validateRule({ kind: 'condition', points: '5', rules: JSON.stringify({ match: 'all', rules: [{ field: 'form_submitted', op: 'yes', value: '', value2: '' }] }) });
		expect(ok.ok).toBe(true);
		const bad = validateRule({ kind: 'condition', points: '5', rules: JSON.stringify({ match: 'all', rules: [{ field: 'form_answer', op: 'eq', value: 'x', value2: '1:q' }] }) });
		expect(bad.ok).toBe(false);
	});

	it('holds points for contacts who submitted that form (in the window), not others', async () => {
		const f = await form();
		const other = await form();
		const s = await score();
		const yes = await contact();
		const old = await contact();
		const otherForm = await contact();
		const spam = await contact();
		const none = await contact();
		await submit(f, yes);
		await submit(f, old, 'updated', '-40 days');
		await submit(other, otherForm);
		await submit(f, spam, 'spam');
		await conditionRule(s, { field: 'form_submitted', op: 'yes', value: String(f), value2: '30' });
		await drain();
		expect(await value(s, yes)).toBe(6);
		expect(await value(s, old)).toBe(0);
		expect(await value(s, otherForm)).toBe(0);
		expect(await value(s, spam)).toBe(0);
		expect(await value(s, none)).toBe(0);
	});

	it('"any form" and "did NOT submit" evaluate too', async () => {
		const f = await form();
		const anyScore = await score();
		const noScore = await score();
		const submitter = await contact();
		const silent = await contact();
		await submit(f, submitter);
		await conditionRule(anyScore, { field: 'form_submitted', op: 'yes', value: '', value2: '' }, 3);
		await conditionRule(noScore, { field: 'form_submitted', op: 'no', value: String(f), value2: '' }, 4);
		await drain();
		expect(await value(anyScore, submitter)).toBe(3);
		expect(await value(anyScore, silent)).toBe(0);
		expect(await value(noScore, submitter)).toBe(0);
		expect(await value(noScore, silent)).toBe(4);
	});

	it('the score rule editor offers it: RuleBuilder gets the forms, archived ones kept when a condition uses them', async () => {
		expect(scoreRuleFormSrc).toMatch(/<RuleBuilder[^>]*forms=\{pickers\.forms \?\? \[\]\}/s);
		const archived = await form('archived');
		const s = await score();
		await conditionRule(s, { field: 'form_submitted', op: 'yes', value: String(archived), value2: '' });
		const url = new URL(`https://app.test/settings/scoring/${s}`);
		const data: any = await editPage.load({
			url,
			params: { id: String(s) },
			request: new Request(url),
			locals: { user: admin, authed: true },
			platform: { env: env as any }
		} as any);
		expect(data.pickers.forms.map((x: any) => x.id)).toContain(archived);
	});
});
