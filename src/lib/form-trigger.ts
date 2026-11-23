// #516 (Forms 4/7): the "Form submitted" automation trigger (`form_submitted`). Universal (no
// server imports): the config stored in `automations.trigger_config`, its validation, matching
// and the one-line summary. Firing lives in `src/lib/server/form-trigger.ts`.
//
// The config:
//   form_id  one form; null = any form
//   filter   optional FormRuleSet over the submission's answers (`$lib/form-logic`); null = every
//            submission. With "any form" the filter reads each form's answers by key.
//
// A submission only starts automations when its form's `settings.enroll` is on, it resolved to
// a contact (anonymous submissions never enrol) and the trigger matches. One that waits on a
// confirmation (double opt-in, or a Consent question that resubscribes) starts them when the
// person confirms, not at submit; never confirmed = never started. Re-entry, entry conditions and
// the one-active-pass rule apply through `enroll()`.
import { evaluateRuleSet, normalizeRuleSet, type FormRuleSet } from '$lib/form-logic';
import type { AnswerValue } from '$lib/forms';

export const FORM_TRIGGER_KIND = 'form_submitted';

export function isFormTriggerKind(type: unknown): type is 'form_submitted' {
	return type === FORM_TRIGGER_KIND;
}

export type FormTriggerConfig = { form_id: number | null; filter: FormRuleSet | null };

export function defaultFormTriggerConfig(): FormTriggerConfig {
	return { form_id: null, filter: null };
}

/** Untrusted input → a clean config, or the first problem. That the form exists is checked by
 *  the write layer. */
export function normalizeFormTriggerConfig(
	raw: Record<string, unknown> | null | undefined
): { ok: true; config: FormTriggerConfig } | { ok: false; error: string } {
	const src = raw && typeof raw === 'object' ? raw : {};
	const cfg = defaultFormTriggerConfig();
	const f = src.form_id;
	if (f !== undefined && f !== null && f !== '' && f !== 'any') {
		const n = typeof f === 'string' ? Number(f) : f;
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return { ok: false, error: 'That form is not valid.' };
		cfg.form_id = n;
	}
	if (src.filter !== undefined && src.filter !== null) {
		if (typeof src.filter !== 'object' || Array.isArray(src.filter)) return { ok: false, error: 'The answer filter is not valid.' };
		const rules = (src.filter as { rules?: unknown }).rules;
		if (Array.isArray(rules) && rules.length) {
			const set = normalizeRuleSet(src.filter);
			if (!set || set.rules.length !== rules.length) return { ok: false, error: 'Every answer filter rule needs a question and a comparison.' };
			cfg.filter = set;
		}
	}
	return { ok: true, config: cfg };
}

/** `automations.trigger_config` → config. Lenient: junk → defaults (any form, no filter). */
export function parseFormTriggerConfig(json: string | null | undefined): FormTriggerConfig {
	if (!json) return defaultFormTriggerConfig();
	try {
		const raw = JSON.parse(json);
		if (!raw || typeof raw !== 'object') return defaultFormTriggerConfig();
		const r = normalizeFormTriggerConfig({ form_id: raw.form_id, filter: normalizeRuleSet(raw.filter) });
		return r.ok ? r.config : defaultFormTriggerConfig();
	} catch {
		return defaultFormTriggerConfig();
	}
}

/** Does this submission match the trigger? (the form, then the answer filter) */
export function formTriggerMatches(cfg: FormTriggerConfig, sub: { formId: number; answers: Record<string, AnswerValue> }): boolean {
	if (cfg.form_id !== null && cfg.form_id !== sub.formId) return false;
	return evaluateRuleSet(cfg.filter, sub.answers);
}

/** "When a contact submits form “Contact us” (2 answer conditions)", "When a contact submits any form". */
export function formTriggerText(cfg: FormTriggerConfig, formName: (id: number) => string | null): string {
	const form = cfg.form_id === null ? 'any form' : `form “${formName(cfg.form_id) ?? '(deleted form)'}”`;
	const n = cfg.filter?.rules.length ?? 0;
	return `When a contact submits ${form}${n ? ` (${n} answer condition${n === 1 ? '' : 's'})` : ''}`;
}

/** The trigger drawer's note when the chosen form doesn't start automations. */
export const FORM_ENROLL_OFF_NOTE =
	'This form doesn’t start automations: turn on “Enrol in automations” in the form’s Settings tab, or no submission will enrol anyone here.';
