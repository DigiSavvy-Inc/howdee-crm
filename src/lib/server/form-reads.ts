// #516 (Forms 4/7): form data where contacts and automations live. No SvelteKit imports.
//   formPicker               forms + their answer questions (trigger drawer, Condition rules, filters)
//   formSubmittedClause      "submitted a form (any / this one) in the last N days" — shared by the
//                            `/contacts` and `/lists/[id]` filters and the `form_submitted` segment rule
//   contactFormSubmissions   the contact page's Forms card
//   submissionForRule        which submission a Condition step's `form_answer` rule reads
import { answerText, isAnswerType, normalizeFormSpec, type AnswerValue, type FormField } from '$lib/forms';

/** Submissions that resolved to a contact (the others have no contact_id anyway). */
export const CONTACT_SUBMISSION_STATUSES = "('added', 'updated')";

export type FormQuestion = { key: string; label: string; type: string; options: { value: string; label: string }[] };
export type FormPickerRow = { id: number; name: string; status: string; enroll: boolean; questions: FormQuestion[] };

function questionsOf(fields: FormField[]): FormQuestion[] {
	return fields
		.filter((f) => isAnswerType(f.type) && f.key)
		.map((f) => ({
			key: f.key,
			label: (f.label || f.key).slice(0, 120),
			type: f.type,
			options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label }))
		}));
}

/** Every form (archived ones last), with its answer questions. */
export async function formPicker(db: D1Database): Promise<FormPickerRow[]> {
	const rows = await db
		.prepare(`SELECT id, name, status, spec FROM forms ORDER BY status = 'archived', name COLLATE NOCASE, id`)
		.all<{ id: number; name: string; status: string; spec: string }>();
	return rows.results.map((r) => {
		const spec = normalizeFormSpec(r.spec);
		return { id: r.id, name: r.name, status: r.status, enroll: !!spec.settings.enroll, questions: questionsOf(spec.fields) };
	});
}

/**
 * EXISTS clause over `form_submissions` for the contact id expression `idExpr` (`c.id`,
 * `contacts.id`): a submission that resolved to the contact, to `formId` (null = any form), in
 * the last `days` days (null = ever). `negate` = has NOT.
 */
export function formSubmittedClause(
	idExpr: string,
	formId: number | null,
	days: number | null,
	negate = false
): { clause: string; binds: (string | number)[] } {
	const parts = [`fs.contact_id = ${idExpr}`, `fs.status IN ${CONTACT_SUBMISSION_STATUSES}`];
	const binds: (string | number)[] = [];
	if (formId) {
		parts.push('fs.form_id = ?');
		binds.push(formId);
	}
	if (days) {
		parts.push("fs.created_at >= datetime('now', ?)");
		binds.push(`-${days} days`);
	}
	const inner = `SELECT 1 FROM form_submissions fs WHERE ${parts.join(' AND ')}`;
	return { clause: negate ? `NOT EXISTS (${inner})` : `EXISTS (${inner})`, binds };
}

export type ContactSubmission = {
	id: number;
	form_id: number;
	form_name: string;
	status: string;
	created_at: string;
	answers: { label: string; text: string }[];
};

/** A contact's submissions, newest first (≤ `limit`), answers labelled by the form's questions. */
export async function contactFormSubmissions(db: D1Database, contactId: number, limit = 50): Promise<ContactSubmission[]> {
	const rows = await db
		.prepare(
			`SELECT s.id, s.form_id, s.status, s.created_at, s.answers, f.name AS form_name, f.spec
			 FROM form_submissions s JOIN forms f ON f.id = s.form_id
			 WHERE s.contact_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT ?`
		)
		.bind(contactId, limit)
		.all<{ id: number; form_id: number; status: string; created_at: string; answers: string; form_name: string; spec: string }>();
	const specs = new Map<number, FormField[]>();
	return rows.results.map((r) => {
		if (!specs.has(r.form_id)) specs.set(r.form_id, normalizeFormSpec(r.spec).fields);
		const fields = specs.get(r.form_id)!;
		let raw: Record<string, AnswerValue> = {};
		try {
			raw = JSON.parse(r.answers) ?? {};
		} catch {
			raw = {};
		}
		const answers: { label: string; text: string }[] = [];
		const seen = new Set<string>();
		for (const f of fields) {
			if (!f.key || raw[f.key] === undefined) continue;
			seen.add(f.key);
			answers.push({ label: f.label || f.key, text: answerText(raw[f.key], f) });
		}
		// Answers to questions since removed from the form: shown under their key.
		for (const [k, v] of Object.entries(raw)) if (!seen.has(k)) answers.push({ label: k, text: answerText(v) });
		return { id: r.id, form_id: r.form_id, form_name: r.form_name, status: r.status, created_at: r.created_at, answers };
	});
}

/**
 * The answers a `form_answer` Condition rule reads for this contact and form: the submission
 * that started the pass (`enrollmentId`) when it is to that form, else the contact's latest
 * submission to it. Null = none (the rule is false).
 */
export async function submissionForRule(
	db: D1Database,
	contactId: number,
	formId: number,
	enrollmentId?: number | null
): Promise<Record<string, AnswerValue> | null> {
	const parse = (s: string | null | undefined): Record<string, AnswerValue> | null => {
		if (!s) return null;
		try {
			const v = JSON.parse(s);
			return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
		} catch {
			return null;
		}
	};
	if (enrollmentId) {
		const own = await db
			.prepare(
				`SELECT s.answers FROM automation_enrollments e JOIN form_submissions s ON s.id = e.form_submission_id
				 WHERE e.id = ? AND s.form_id = ? AND s.contact_id = ?`
			)
			.bind(enrollmentId, formId, contactId)
			.first<{ answers: string }>();
		if (own) return parse(own.answers);
	}
	const latest = await db
		.prepare(
			`SELECT answers FROM form_submissions WHERE contact_id = ? AND form_id = ? AND status IN ${CONTACT_SUBMISSION_STATUSES}
			 ORDER BY created_at DESC, id DESC LIMIT 1`
		)
		.bind(contactId, formId)
		.first<{ answers: string }>();
	return latest ? parse(latest.answers) : null;
}
