import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { blankField, emptyForm, type FormField, type FormSpec } from '../src/lib/forms';
import { createForm, getForm, type FormRow } from '../src/lib/server/forms';
import { handleSubmission, type SubmitContext } from '../src/lib/server/form-submit';
import {
	defaultFormTriggerConfig,
	formTriggerMatches,
	formTriggerText,
	normalizeFormTriggerConfig,
	parseFormTriggerConfig
} from '../src/lib/form-trigger';
import { TRIGGER_TYPES, triggerText, type TriggerFields } from '../src/lib/automation-trigger';
import { ruleIncomplete, ruleKindGroups } from '../src/lib/condition-rules';
import { ruleText } from '../src/lib/automation-action-labels';
import { evaluateRules, conditionRulesProblem } from '../src/lib/server/condition-eval';
import { automationsForForm } from '../src/lib/server/form-trigger';
import { createAutomation, entryRulesProblem, readSpec, storedTriggerProblem } from '../src/lib/server/automation-write';
import { actions as formActions, load as formLoad } from '../src/routes/forms/[id]/+page.server';

// #516: the "Form submitted" trigger, its answer filter, `settings.enroll`, anonymous
// submissions, re-entry, `form_answer` Condition rules and the form page's "Create automation".
const db = (env as any).DB as D1Database;
const baseEnv = { SESSION_SECRET: 'test-secret' };
let ipN = 0;
let mailN = 0;
const ctx = (): SubmitContext => ({ origin: null, crmOrigins: ['https://crm.test'], ip: `10.5.16.${++ipN}`, mxLookup: async () => 'ok' });
const mail = () => `p${++mailN}@forms516.test`;

function q(type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField {
	return { ...blankField(type, label), key, ...extra };
}

async function makeForm(mutate: (s: FormSpec) => void = () => {}, name = 'Contact us'): Promise<FormRow> {
	const id = await createForm(db, name, null);
	const spec = emptyForm(name);
	spec.settings.enroll = true;
	spec.fields.push(
		q('radio', 'Budget', 'budget', { options: [{ value: 'small', label: 'Small' }, { value: 'big', label: 'Big' }] }),
		q('number', 'Team size', 'team')
	);
	mutate(spec);
	await db.prepare("UPDATE forms SET spec = ?, status = 'published' WHERE id = ?").bind(JSON.stringify(spec), id).run();
	return (await getForm(db, id))!;
}

async function automation(cfg: Record<string, unknown>, o: { status?: string; reentry?: string; steps?: number } = {}): Promise<number> {
	const id = (await db
		.prepare(`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry) VALUES ('Form flow', ?, 'form_submitted', ?, ?) RETURNING id`)
		.bind(o.status ?? 'active', JSON.stringify({ ...defaultFormTriggerConfig(), ...cfg }), o.reentry ?? 'once')
		.first<{ id: number }>())!.id;
	for (let i = 0; i < (o.steps ?? 1); i++) {
		await db
			.prepare(
				`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
				 VALUES (?, ?, 'tag', 'add', 'from-form', '', '', 'sender@forms516.test', 3600)`
			)
			.bind(id, i)
			.run();
	}
	return id;
}

const passes = async (aid: number) =>
	(
		await db
			.prepare('SELECT id, contact_id, status, form_submission_id FROM automation_enrollments WHERE automation_id = ? ORDER BY id')
			.bind(aid)
			.all<{ id: number; contact_id: number; status: string; form_submission_id: number | null }>()
	).results;

const submit = (form: FormRow, answers: Record<string, unknown>) => handleSubmission(db, baseEnv, form, { answers: answers as any }, ctx());

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare("DELETE FROM automation_steps WHERE automation_id IN (SELECT id FROM automations WHERE trigger_type = 'form_submitted')"),
		db.prepare("DELETE FROM automations WHERE trigger_type = 'form_submitted'")
	]);
});

// ── pure ────────────────────────────────────────────────────────────────────────────────

describe('form_submitted config', () => {
	it('is a trigger type', () => {
		expect(TRIGGER_TYPES.map((t) => t.type)).toContain('form_submitted');
	});
	it('normalizes the form and the answer filter', () => {
		expect(normalizeFormTriggerConfig({})).toEqual({ ok: true, config: { form_id: null, filter: null } });
		expect(normalizeFormTriggerConfig({ form_id: 'any' })).toEqual({ ok: true, config: { form_id: null, filter: null } });
		const r = normalizeFormTriggerConfig({ form_id: '4', filter: { match: 'any', rules: [{ field: 'budget', op: 'eq', value: 'big' }] } });
		expect(r).toEqual({ ok: true, config: { form_id: 4, filter: { match: 'any', rules: [{ field: 'budget', op: 'eq', value: 'big' }] } } });
		expect(normalizeFormTriggerConfig({ form_id: 0 }).ok).toBe(false);
		expect(normalizeFormTriggerConfig({ filter: { rules: [{ field: 'budget', op: 'bogus' }] } }).ok).toBe(false);
		expect(parseFormTriggerConfig('junk')).toEqual(defaultFormTriggerConfig());
	});
	it('matches the form, then the filter', () => {
		const cfg = { form_id: 3, filter: { match: 'all' as const, rules: [{ field: 'team', op: 'gte' as const, value: 10 }] } };
		expect(formTriggerMatches(cfg, { formId: 3, answers: { team: 12 } })).toBe(true);
		expect(formTriggerMatches(cfg, { formId: 3, answers: { team: 2 } })).toBe(false);
		expect(formTriggerMatches(cfg, { formId: 4, answers: { team: 12 } })).toBe(false);
		expect(formTriggerMatches({ form_id: null, filter: null }, { formId: 9, answers: {} })).toBe(true);
	});
	it('text', () => {
		expect(formTriggerText({ form_id: null, filter: null }, () => null)).toBe('When a contact submits any form');
		const a = { trigger_type: 'form_submitted', trigger_config: JSON.stringify({ form_id: 2, filter: { match: 'all', rules: [{ field: 'x', op: 'empty' }] } }), reentry: 'once' } as TriggerFields;
		expect(triggerText(a, { lists: [], sites: [], stages: [], forms: [{ id: 2, name: 'Quote' }] })).toBe('When a contact submits form “Quote” (1 answer condition)');
	});
});

// ── firing from handleSubmission ────────────────────────────────────────────────────────

describe('handleSubmission → form_submitted', () => {
	it('enrols the contact and stamps the submission on the pass', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id });
		const r = await submit(form, { email: mail(), budget: 'big' });
		expect(r.ok).toBe(true);
		const p = await passes(aid);
		expect(p).toHaveLength(1);
		expect(p[0].form_submission_id).toBe(r.submissionId);
		const ev = await db.prepare("SELECT detail FROM automation_enrollment_events WHERE enrollment_id = ? AND kind = 'trigger:form_submitted'").bind(p[0].id).first<{ detail: string }>();
		expect(ev?.detail).toBe('submitted “Contact us”');
	});

	it('never starts anything when the form has enroll off', async () => {
		const form = await makeForm((s) => (s.settings.enroll = false));
		const aid = await automation({ form_id: form.id });
		const anyForm = await automation({});
		await submit(form, { email: mail() });
		expect(await passes(aid)).toHaveLength(0);
		expect(await passes(anyForm)).toHaveLength(0);
	});

	it('only fires for the chosen form, or any form', async () => {
		const form = await makeForm();
		const other = await makeForm(() => {}, 'Other');
		const mine = await automation({ form_id: form.id });
		const any = await automation({});
		await submit(other, { email: mail() });
		expect(await passes(mine)).toHaveLength(0);
		expect(await passes(any)).toHaveLength(1);
	});

	it('applies the answer filter', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id, filter: { match: 'all', rules: [{ field: 'budget', op: 'eq', value: 'big' }] } });
		await submit(form, { email: mail(), budget: 'small' });
		expect(await passes(aid)).toHaveLength(0);
		await submit(form, { email: mail(), budget: 'big' });
		expect(await passes(aid)).toHaveLength(1);
	});

	it('anonymous submissions never enrol', async () => {
		const form = await makeForm((s) => {
			s.settings.allow_anonymous = true;
			s.fields[0].required = false;
		});
		const aid = await automation({ form_id: form.id });
		const r = await submit(form, { budget: 'big' });
		expect(r).toMatchObject({ ok: true, detail: 'anonymous' });
		expect(await passes(aid)).toHaveLength(0);
	});

	it('a paused automation records a pending trigger; a draft is ignored', async () => {
		const form = await makeForm();
		const paused = await automation({ form_id: form.id }, { status: 'paused' });
		const draft = await automation({ form_id: form.id }, { status: 'draft' });
		await submit(form, { email: mail() });
		const pending = await db.prepare('SELECT COUNT(*) AS n FROM automation_pending_triggers WHERE automation_id = ?').bind(paused).first<{ n: number }>();
		expect(pending?.n).toBe(1);
		expect(await passes(paused)).toHaveLength(0);
		expect(await passes(draft)).toHaveLength(0);
	});

	it('respects the re-entry policy', async () => {
		const form = await makeForm();
		const once = await automation({ form_id: form.id }, { reentry: 'once' });
		const multi = await automation({ form_id: form.id }, { reentry: 'multiple' });
		const email = mail();
		await submit(form, { email });
		// Finish the first passes so only the re-entry policy decides.
		await db.prepare("UPDATE automation_enrollments SET status = 'completed', ended_at = datetime('now')").run();
		await submit(form, { email });
		expect(await passes(once)).toHaveLength(1);
		const m = await passes(multi);
		expect(m).toHaveLength(2);
		expect(m[0].form_submission_id).not.toBe(m[1].form_submission_id);
	});
});

// ── form_answer Condition rules ──────────────────────────────────────────────────────────

describe('form_answer condition', () => {
	it('is an automation-only kind, kept out of trigger contact conditions', () => {
		const kinds = (o: Parameters<typeof ruleKindGroups>[0]) => ruleKindGroups(o).flatMap((g) => g.kinds.map((k) => k.field));
		expect(kinds({ automation: true })).toContain('form_answer');
		expect(kinds({ automation: true, noStepRules: true })).not.toContain('form_answer');
		expect(kinds({ automation: false })).not.toContain('form_answer');
		expect(kinds({ automation: false })).toContain('form_submitted');
		expect(ruleIncomplete({ field: 'form_answer', op: 'eq', value2: '3:budget' })).toBe('a value');
		expect(ruleIncomplete({ field: 'form_answer', op: 'empty', value2: '3:budget' })).toBeNull();
		expect(ruleIncomplete({ field: 'form_answer', op: 'eq', value: 'x' })).toBe('a form and a question');
		expect(ruleText({ field: 'form_answer', op: 'eq', value: 'big', value2: '3:budget' }, { form: () => 'Quote' })).toBe('answer “budget” on Quote is “big”');
	});

	it('reads the submission that started the pass, else the latest one', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id }, { reentry: 'multiple' });
		const email = mail();
		await submit(form, { email, budget: 'big', team: '12' });
		const [first] = await passes(aid);
		await db.prepare("UPDATE automation_enrollments SET status = 'completed'").run();
		await submit(form, { email, budget: 'small', team: '2' });
		const second = (await passes(aid))[1];
		const big = { match: 'all' as const, rules: [{ field: 'form_answer', op: 'eq', value: 'big', value2: `${form.id}:budget` }] };
		const team = { match: 'all' as const, rules: [{ field: 'form_answer', op: 'gte', value: '10', value2: `${form.id}:team` }] };
		// The pass's own submission.
		expect((await evaluateRules(db, first.contact_id, big, { enrollmentId: first.id })).pass).toBe(true);
		expect((await evaluateRules(db, first.contact_id, team, { enrollmentId: first.id })).pass).toBe(true);
		expect((await evaluateRules(db, second.contact_id, big, { enrollmentId: second.id })).pass).toBe(false);
		// No pass → the latest submission (small, 2).
		expect((await evaluateRules(db, first.contact_id, big)).pass).toBe(false);
		// Nobody submitted → false.
		const lone = (await db.prepare("INSERT INTO contacts (email) VALUES (?) RETURNING id").bind(mail()).first<{ id: number }>())!.id;
		expect((await evaluateRules(db, lone, { match: 'all', rules: [{ field: 'form_answer', op: 'empty', value2: `${form.id}:budget` }] })).pass).toBe(false);
	});

	it('validation: form and question must exist; entry conditions refuse it', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id });
		const ok = { match: 'all' as const, rules: [{ field: 'form_answer', op: 'eq', value: 'big', value2: `${form.id}:budget` }] };
		expect(await conditionRulesProblem(db, aid, ok)).toBeNull();
		expect(await conditionRulesProblem(db, aid, { match: 'all', rules: [{ field: 'form_answer', op: 'eq', value: 'x', value2: `${form.id}:nope` }] })).toContain('no longer on the form');
		expect(await conditionRulesProblem(db, aid, { match: 'all', rules: [{ field: 'form_answer', op: 'eq', value: 'x', value2: '999999:budget' }] })).toContain('no longer exists');
		expect(await entryRulesProblem(db, aid, ok)).toContain('form question');
	});
});

// ── write layer + form page ─────────────────────────────────────────────────────────────

describe('write layer + the form page', () => {
	it('stores, reads back and checks the trigger', async () => {
		const form = await makeForm();
		const created = await createAutomation(db, { name: 'W', trigger: { type: 'form_submitted', form_id: form.id, filter: null } }, { kind: 'user', id: 1 });
		expect(created.ok).toBe(true);
		const id = created.ok ? created.data.automation_id : 0;
		const spec = await readSpec(db, id);
		expect(spec.ok && spec.data.trigger).toEqual({ type: 'form_submitted', form_id: form.id, filter: null });
		const bad = await createAutomation(db, { name: 'W', trigger: { type: 'form_submitted', form_id: 999999 } }, { kind: 'user', id: 1 });
		expect(bad).toMatchObject({ ok: false, error: 'That form no longer exists.' });
		const row = await db.prepare('SELECT * FROM automations WHERE id = ?').bind(id).first<any>();
		expect(await storedTriggerProblem(db, row)).toBeNull();
	});

	it('“Create automation” makes a draft with the trigger set to this form, listed on the form page', async () => {
		const form = await makeForm(() => {}, 'Quote request');
		const event = {
			platform: { env },
			params: { id: String(form.id) },
			locals: { user: { id: 1, github_login: 'jdoe', role: 'member' } },
			request: new Request(`https://app.test/forms/${form.id}?/createAutomation`, { method: 'POST', body: new FormData() })
		} as any;
		let location = '';
		try {
			await formActions.createAutomation(event);
		} catch (e: any) {
			location = e?.location ?? '';
		}
		const m = /^\/automations\/(\d+)$/.exec(location);
		expect(m).not.toBeNull();
		const a = await db.prepare('SELECT name, status, trigger_type, trigger_config FROM automations WHERE id = ?').bind(Number(m![1])).first<any>();
		expect(a).toMatchObject({ name: 'When “Quote request” is submitted', status: 'draft', trigger_type: 'form_submitted' });
		expect(JSON.parse(a.trigger_config)).toEqual({ form_id: form.id, filter: null });

		const listed = await automationsForForm(db, form.id);
		expect(listed.map((x) => x.id)).toContain(Number(m![1]));
		const page = (await formLoad({ ...event, url: new URL(`https://app.test/forms/${form.id}`), request: new Request(`https://app.test/forms/${form.id}`) } as any)) as any;
		expect(page.automations.some((x: { id: number; status: string }) => x.id === Number(m![1]) && x.status === 'draft')).toBe(true);
	});
});
