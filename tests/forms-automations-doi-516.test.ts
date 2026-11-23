import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #516: a submission that waits on a confirmation (double opt-in, or a Consent question that
// resubscribes, #541) starts its "Form submitted" automations when the person confirms — once,
// stamped with that submission, with the form's settings at confirm time — and never before.
const spies = vi.hoisted(() => ({ sendBatch: vi.fn(), suppressionsByEmail: vi.fn(), unsuppress: vi.fn() }));
vi.mock('../src/lib/server/postmark', async (orig) => ({
	...(await orig<object>()),
	sendBatch: spies.sendBatch,
	suppressionsByEmail: spies.suppressionsByEmail,
	unsuppress: spies.unsuppress
}));

import { blankField, emptyForm, type FormField, type FormSpec } from '../src/lib/forms';
import { createForm, getForm, type FormRow } from '../src/lib/server/forms';
import { handleSubmission, type SubmitContext } from '../src/lib/server/form-submit';
import { cleanIntent, confirmSubscription } from '../src/lib/server/double-optin';
import { defaultFormTriggerConfig } from '../src/lib/form-trigger';

const db = (env as any).DB as D1Database;
const pmEnv = { POSTMARK_TOKEN: 'pm-test', POSTMARK_FROM: 'sender@forms516.test', POSTMARK_STREAM: 'broadcast', SESSION_SECRET: 's' };
let ipN = 0;
let mailN = 0;
const ctx = (): SubmitContext => ({
	origin: 'https://crm.test',
	crmOrigins: ['https://crm.test'],
	ip: `10.5.17.${++ipN}`,
	baseUrl: 'https://crm.test',
	mxLookup: async () => 'ok'
});
const mail = () => `d${++mailN}@forms516doi.test`;

function lastToken(): string {
	const calls = spies.sendBatch.mock.calls;
	const msgs = calls[calls.length - 1][1] as { TextBody: string }[];
	const m = /\/confirm\/([A-Za-z0-9_-]+)/.exec(msgs[0].TextBody);
	if (!m) throw new Error('no token in the email');
	return m[1];
}

async function makeForm(mutate: (s: FormSpec) => void = () => {}): Promise<FormRow> {
	const id = await createForm(db, 'Newsletter sign-up', null);
	const spec = emptyForm('Newsletter sign-up');
	spec.settings.enroll = true;
	spec.settings.double_optin = true;
	const f = (type: FormField['type'], label: string, key: string, extra: Partial<FormField> = {}): FormField => ({ ...blankField(type, label), key, ...extra });
	spec.fields.push(
		f('radio', 'Budget', 'budget', { options: [{ value: 'small', label: 'Small' }, { value: 'big', label: 'Big' }] }),
		f('consent', 'Yes, email me', 'consent')
	);
	mutate(spec);
	await db.prepare("UPDATE forms SET spec = ?, status = 'published' WHERE id = ?").bind(JSON.stringify(spec), id).run();
	return (await getForm(db, id))!;
}

async function automation(cfg: Record<string, unknown>, reentry = 'once'): Promise<number> {
	const id = (await db
		.prepare(`INSERT INTO automations (name, status, trigger_type, trigger_config, reentry) VALUES ('Form flow', 'active', 'form_submitted', ?, ?) RETURNING id`)
		.bind(JSON.stringify({ ...defaultFormTriggerConfig(), ...cfg }), reentry)
		.first<{ id: number }>())!.id;
	await db
		.prepare(
			`INSERT INTO automation_steps (automation_id, position, type, tag_action, tag_name, subject, body_md, from_email, delay_before_seconds)
			 VALUES (?, 0, 'tag', 'add', 'from-form', '', '', 'sender@forms516.test', 3600)`
		)
		.bind(id)
		.run();
	return id;
}

const passes = async (aid: number) =>
	(
		await db
			.prepare('SELECT id, contact_id, status, form_submission_id FROM automation_enrollments WHERE automation_id = ? ORDER BY id')
			.bind(aid)
			.all<{ id: number; contact_id: number; status: string; form_submission_id: number | null }>()
	).results;

const intentOf = async (contactId: number) => {
	const row = await db
		.prepare('SELECT intent FROM subscription_confirmations WHERE contact_id = ? ORDER BY id DESC LIMIT 1')
		.bind(contactId)
		.first<{ intent: string }>();
	return JSON.parse(row?.intent ?? '{}') as { form_submission_id?: number };
};

const submit = (form: FormRow, answers: Record<string, string>) => handleSubmission(db, pmEnv, form, { answers }, ctx());

beforeEach(async () => {
	vi.clearAllMocks();
	spies.sendBatch.mockImplementation(async (_t: string, msgs: unknown[]) =>
		msgs.map((_, i) => ({ ErrorCode: 0, Message: 'OK', MessageID: `m-${Math.random()}-${i}` }))
	);
	spies.suppressionsByEmail.mockResolvedValue({ map: new Map(), errors: [], read: 2 });
	spies.unsuppress.mockResolvedValue({ ok: true });
	await db.batch([
		db.prepare('DELETE FROM subscription_confirmations'),
		db.prepare('DELETE FROM automation_enrollment_events'),
		db.prepare('DELETE FROM automation_pending_triggers'),
		db.prepare('DELETE FROM automation_enrollments'),
		db.prepare("DELETE FROM automation_steps WHERE automation_id IN (SELECT id FROM automations WHERE trigger_type = 'form_submitted')"),
		db.prepare("DELETE FROM automations WHERE trigger_type = 'form_submitted'"),
		db.prepare('DELETE FROM rate_limits')
	]);
});

describe('form_submitted + confirmation', () => {
	it('cleanIntent keeps a positive whole form_submission_id only', () => {
		expect(cleanIntent({ form_submission_id: 12 })).toEqual({ form_submission_id: 12 });
		expect(cleanIntent({ form_submission_id: 0 })).toEqual({});
		expect(cleanIntent({ form_submission_id: 1.5 })).toEqual({});
		expect(cleanIntent({ form_submission_id: 'x' as unknown as number })).toEqual({});
	});

	it('double opt-in: nothing at submit; confirming enrols once, stamped with the submission', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id, filter: { match: 'all', rules: [{ field: 'budget', op: 'eq', value: 'big' }] } }, 'multiple');
		const r = await submit(form, { email: mail(), budget: 'big' });
		expect(r).toMatchObject({ ok: true });
		expect(await passes(aid)).toHaveLength(0);
		const sub = await db.prepare('SELECT contact_id FROM form_submissions WHERE id = ?').bind(r.submissionId).first<{ contact_id: number }>();
		expect((await intentOf(sub!.contact_id)).form_submission_id).toBe(r.submissionId);

		const token = lastToken();
		expect((await confirmSubscription(db, pmEnv, token, { actor: 'self' })).ok).toBe(true);
		const p = await passes(aid);
		expect(p).toHaveLength(1);
		expect(p[0]).toMatchObject({ contact_id: sub!.contact_id, status: 'active', form_submission_id: r.submissionId });
		const ev = await db
			.prepare("SELECT detail FROM automation_enrollment_events WHERE enrollment_id = ? AND kind = 'trigger:form_submitted'")
			.bind(p[0].id)
			.first<{ detail: string }>();
		expect(ev?.detail).toBe('submitted “Newsletter sign-up”');

		// Confirming again (a second click) never enrols again, even with re-entry "multiple".
		await db.prepare("UPDATE automation_enrollments SET status = 'completed', ended_at = datetime('now')").run();
		expect(await confirmSubscription(db, pmEnv, token, { actor: 'self' })).toMatchObject({ ok: true, alreadyConfirmed: true });
		expect(await passes(aid)).toHaveLength(1);
	});

	it('never confirmed: never enrolled', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id });
		const r = await submit(form, { email: mail() });
		expect(r.ok).toBe(true);
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		expect(await passes(aid)).toHaveLength(0);
		const pending = await db.prepare('SELECT COUNT(*) AS n FROM automation_pending_triggers').first<{ n: number }>();
		expect(pending?.n).toBe(0);
	});

	it('reads the form at confirm time: enrol switched off meanwhile → nothing starts', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id });
		await submit(form, { email: mail() });
		const spec = { ...form.spec, settings: { ...form.spec.settings, enroll: false } };
		await db.prepare('UPDATE forms SET spec = ? WHERE id = ?').bind(JSON.stringify(spec), form.id).run();
		expect((await confirmSubscription(db, pmEnv, lastToken(), { actor: 'self' })).ok).toBe(true);
		expect(await passes(aid)).toHaveLength(0);
	});

	it('a second submission while pending: confirming fires for the newest one', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id });
		const email = mail();
		await submit(form, { email, budget: 'small' });
		const token = lastToken();
		// Within the re-send gap: no new email, the open confirmation carries the newest intent.
		const second = await submit(form, { email, budget: 'big' });
		expect(spies.sendBatch).toHaveBeenCalledTimes(1);
		expect((await confirmSubscription(db, pmEnv, token, { actor: 'self' })).ok).toBe(true);
		const p = await passes(aid);
		expect(p).toHaveLength(1);
		expect(p[0].form_submission_id).toBe(second.submissionId);
	});

	it('#541 consent resubscribe (double opt-in off) also enrols on confirm', async () => {
		const form = await makeForm((s) => (s.settings.double_optin = false));
		const aid = await automation({ form_id: form.id });
		const email = mail();
		await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 0)').bind(email).run();
		const r = await submit(form, { email, consent: 'on' });
		expect(r.ok).toBe(true);
		expect(await passes(aid)).toHaveLength(0);
		expect((await confirmSubscription(db, pmEnv, lastToken(), { actor: 'self' })).ok).toBe(true);
		const p = await passes(aid);
		expect(p).toHaveLength(1);
		expect(p[0].form_submission_id).toBe(r.submissionId);
	});

	it('an already-subscribed address skips the confirmation and enrols at submit', async () => {
		const form = await makeForm();
		const aid = await automation({ form_id: form.id });
		const email = mail();
		await db.prepare('INSERT INTO contacts (email, subscribed) VALUES (?, 1)').bind(email).run();
		const r = await submit(form, { email });
		expect(spies.sendBatch).not.toHaveBeenCalled();
		const p = await passes(aid);
		expect(p).toHaveLength(1);
		expect(p[0].form_submission_id).toBe(r.submissionId);
	});
});
