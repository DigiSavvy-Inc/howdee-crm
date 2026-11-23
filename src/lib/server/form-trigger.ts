// #516 (Forms 4/7): the "Form submitted" (`form_submitted`) automation trigger. Config + matching
// in universal `$lib/form-trigger`.
//
// Fired by `handleSubmission` (form-submit.ts) once the submission row exists and the contact
// write is done — or, when the submission went through the confirmation route (double opt-in /
// a Consent question that resubscribes, #541), by `confirmSubscription` (double-optin.ts) when
// the person confirms (`fireFormTriggersForSubmission`, the submission id rides in the intent).
//
// Rules: nothing fires unless the form's `settings.enroll` is on (read when it fires) and the
// submission resolved to a contact (anonymous submissions never enrol; someone who never confirms
// never does either). Active automations whose form / answer filter match → `enroll()` with the
// submission id stamped on the new pass (re-entry, entry conditions and the one-active-pass rule
// apply); paused ones record a pending trigger (#397); drafts are never looked at.
import { formTriggerMatches, parseFormTriggerConfig } from '$lib/form-trigger';
import type { AnswerValue } from '$lib/forms';
import { enroll } from './automations';
import { logEvent, recordPendingTriggers } from './automation-flow';
import { getForm } from './forms';

export type FormTriggerSummary = { matched: number; enrolled: number; pending: number };

export async function fireFormTriggers(
	db: D1Database,
	sub: {
		form: { id: number; name: string; enroll: boolean };
		submissionId: number;
		contactId: number | null;
		answers: Record<string, AnswerValue>;
	},
	now: Date = new Date()
): Promise<FormTriggerSummary> {
	const summary: FormTriggerSummary = { matched: 0, enrolled: 0, pending: 0 };
	if (!sub.form.enroll || !sub.contactId) return summary;
	const autos = await db
		.prepare(
			`SELECT id, status, trigger_config FROM automations
			 WHERE status IN ('active', 'paused') AND trigger_type = 'form_submitted' ORDER BY id`
		)
		.all<{ id: number; status: string; trigger_config: string | null }>();
	const detail = `submitted “${sub.form.name}”`.slice(0, 300);
	for (const a of autos.results) {
		const cfg = parseFormTriggerConfig(a.trigger_config);
		if (!formTriggerMatches(cfg, { formId: sub.form.id, answers: sub.answers })) continue;
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, [sub.contactId], 'form_submitted');
			summary.pending++;
			continue;
		}
		summary.matched++;
		const r = await enroll(db, a.id, [sub.contactId], { now, formSubmissionId: sub.submissionId });
		summary.enrolled += r.created.length;
		for (const id of r.created) {
			await logEvent(db, { id, automation_id: a.id, contact_id: sub.contactId }, null, 'trigger:form_submitted', detail);
		}
	}
	return summary;
}

/**
 * Confirm time (double opt-in / #541): fire for a stored submission, exactly as `handleSubmission`
 * would have — the form's current name and `settings.enroll`, the stored answers. Nothing when the
 * submission is gone (deleted, pruned) or isn't this contact's, or the form was deleted.
 */
export async function fireFormTriggersForSubmission(
	db: D1Database,
	submissionId: number,
	contactId: number,
	now: Date = new Date()
): Promise<FormTriggerSummary> {
	const none: FormTriggerSummary = { matched: 0, enrolled: 0, pending: 0 };
	const sub = await db
		.prepare('SELECT form_id, contact_id, answers FROM form_submissions WHERE id = ?')
		.bind(submissionId)
		.first<{ form_id: number; contact_id: number | null; answers: string | null }>();
	if (!sub || sub.contact_id !== contactId) return none;
	const form = await getForm(db, sub.form_id);
	if (!form) return none;
	let answers: Record<string, AnswerValue> = {};
	try {
		const v = JSON.parse(sub.answers ?? '{}');
		if (v && typeof v === 'object' && !Array.isArray(v)) answers = v;
	} catch {
		answers = {};
	}
	return fireFormTriggers(
		db,
		{ form: { id: form.id, name: form.name, enroll: form.spec.settings.enroll }, submissionId, contactId, answers },
		now
	);
}

export type FormAutomationRow = { id: number; name: string; status: string; filtered: boolean; any_form: boolean };

/** The automations a form starts: `form_submitted` triggers on this form, then those on any form. */
export async function automationsForForm(db: D1Database, formId: number): Promise<FormAutomationRow[]> {
	const rows = await db
		.prepare(`SELECT id, name, status, trigger_config FROM automations WHERE trigger_type = 'form_submitted' ORDER BY name COLLATE NOCASE, id`)
		.all<{ id: number; name: string; status: string; trigger_config: string | null }>();
	const out: FormAutomationRow[] = [];
	for (const r of rows.results) {
		const cfg = parseFormTriggerConfig(r.trigger_config);
		if (cfg.form_id !== null && cfg.form_id !== formId) continue;
		out.push({ id: r.id, name: r.name, status: r.status, filtered: !!cfg.filter?.rules.length, any_form: cfg.form_id === null });
	}
	return out.sort((a, b) => Number(a.any_form) - Number(b.any_form));
}
