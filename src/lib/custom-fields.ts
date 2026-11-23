// #619: defined custom fields — vocabulary, key / label rules, validation and the form
// builder's type suggestion. Universal (no DB): the form builder, the contact page, the rule
// builder and Settings → Custom fields all use it. Storage: src/lib/server/custom-fields.ts.
//
// Contact data is unchanged: values stay strings in contacts.meta keyed by `key`. A definition
// only adds a label, a type, options (choice) and an order.

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'yes_no', 'choice'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
	text: 'Text',
	number: 'Number',
	date: 'Date',
	yes_no: 'Yes / no',
	choice: 'Choice'
};

export const CUSTOM_FIELD_LIMITS = {
	/** Same as the form builder's custom field key limit (FORM_LIMITS.metaKey). */
	key: 50,
	label: 80,
	options: 50,
	option: 100,
	/** Active (non-archived) fields; archived ones don't count. */
	fields: 200
} as const;

/** The cap message: create, define and restore all refuse with it. */
export const FIELD_CAP_MESSAGE = `At most ${CUSTOM_FIELD_LIMITS.fields} active custom fields. Archive one you no longer use to add another.`;

/** What a yes / no field stores (a ticked form checkbox writes `yes`). */
export const YES_VALUE = 'yes';
export const NO_VALUE = 'no';

/**
 * Keys the app writes itself. They show as built in: they can be relabelled and reordered
 * but never archived or retyped (the app's writers own their shape).
 *  - `hygiene`: address hygiene result (src/lib/server/hygiene.ts, #306)
 *  - `phone`:   a form question mapped to the contact's phone (src/lib/server/form-submit.ts)
 */
export const BUILT_IN_FIELD_KEYS: readonly string[] = ['hygiene', 'phone'];
export const isBuiltInKey = (key: string) => BUILT_IN_FIELD_KEYS.includes(key);

/**
 * Built-in keys only the app may write. Forms never offer them ("Maps to: Custom field",
 * "Set fields") and the form spec refuses them; segment and automation rules still read them.
 *  - `hygiene`: written by the address check, read by the Contacts hygiene filter.
 * (`phone` is not here: a form question mapped to Phone is how it gets written.)
 */
export const FORM_PROTECTED_KEYS: readonly string[] = ['hygiene'];
export const isFormProtectedKey = (key: string) => FORM_PROTECTED_KEYS.includes(key);

export type CustomField = {
	id: number;
	key: string;
	label: string;
	type: CustomFieldType;
	options: string[];
	position: number;
	archived_at: string | null;
	built_in: boolean;
};

/** The slim shape pickers get. */
export type FieldOption = Pick<CustomField, 'key' | 'label' | 'type' | 'options'>;

export function isCustomFieldType(t: unknown): t is CustomFieldType {
	return typeof t === 'string' && (CUSTOM_FIELD_TYPES as readonly string[]).includes(t);
}

/** A key for a new field from its label (`Monthly budget?` → `monthly_budget`). */
export function fieldKeyFromLabel(label: string): string {
	const k = String(label ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, CUSTOM_FIELD_LIMITS.key)
		.replace(/_+$/g, '');
	return /^[a-z]/.test(k) ? k : k ? `f_${k}`.slice(0, CUSTOM_FIELD_LIMITS.key) : '';
}

/** A readable label from a stored key (`project_type` → `Project type`). */
export function labelFromKey(key: string): string {
	const t = String(key ?? '').replace(/[_-]+/g, ' ').trim();
	return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, CUSTOM_FIELD_LIMITS.label);
}

/** A key that isn't taken: `budget`, then `budget_2`, `budget_3`… */
export function uniqueKey(base: string, taken: Iterable<string>): string {
	const set = new Set(taken);
	const b = base || 'field';
	if (!set.has(b)) return b;
	for (let n = 2; n < 1000; n++) {
		const suffix = `_${n}`;
		const k = b.slice(0, CUSTOM_FIELD_LIMITS.key - suffix.length) + suffix;
		if (!set.has(k)) return k;
	}
	return b;
}

/** Key check: 1–50 characters, trimmed, no quotes, backslashes or control characters (the
 *  key goes into a JSON path in segment rules). Existing meta keys of any shape within that
 *  can be defined as they are. */
export function keyProblem(key: string): string | null {
	const k = String(key ?? '');
	if (!k.trim()) return 'Key is required.';
	if (k !== k.trim()) return 'Key can’t start or end with a space.';
	if (k.length > CUSTOM_FIELD_LIMITS.key) return `Key is over ${CUSTOM_FIELD_LIMITS.key} characters.`;
	// eslint-disable-next-line no-control-regex
	if (/["\\\u0000-\u001f]/.test(k)) return 'Key can’t contain quotes, backslashes or control characters.';
	return null;
}

/** Clean a choice list: trimmed, non-empty, unique (case-insensitive), capped. */
export function cleanOptions(raw: unknown): string[] {
	const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of list) {
		const s = String(v ?? '').trim().slice(0, CUSTOM_FIELD_LIMITS.option);
		if (!s || seen.has(s.toLowerCase())) continue;
		seen.add(s.toLowerCase());
		out.push(s);
		if (out.length >= CUSTOM_FIELD_LIMITS.options) break;
	}
	return out;
}

export type FieldInput = { key?: string; label?: string; type?: string; options?: unknown };

/** Validate a definition (create or edit). Returns the clean values or the first problem. */
export function validateField(
	input: FieldInput,
	opts: { requireKey?: boolean } = {}
): { ok: true; key: string; label: string; type: CustomFieldType; options: string[] } | { ok: false; error: string } {
	const label = String(input.label ?? '').trim();
	if (!label) return { ok: false, error: 'Label is required.' };
	if (label.length > CUSTOM_FIELD_LIMITS.label) return { ok: false, error: `Label is over ${CUSTOM_FIELD_LIMITS.label} characters.` };
	const type = input.type ?? 'text';
	if (!isCustomFieldType(type)) return { ok: false, error: 'Unknown field type.' };
	const options = type === 'choice' ? cleanOptions(input.options) : [];
	if (type === 'choice' && options.length === 0) return { ok: false, error: 'A choice field needs at least one option.' };
	let key = String(input.key ?? '');
	if (!key && !opts.requireKey) key = fieldKeyFromLabel(label);
	const kp = keyProblem(key);
	if (kp) return { ok: false, error: kp };
	return { ok: true, key, label, type, options };
}

/**
 * The type a new field gets when it is created from a form question (#619): number → number,
 * date → date, single checkbox / consent → yes / no, dropdown / multiple choice → choice with
 * the question's options, rating → number; anything else → text.
 */
export function suggestFieldType(questionType: string, options: { label: string }[] = []): { type: CustomFieldType; options: string[] } {
	switch (questionType) {
		case 'number':
		case 'rating':
			return { type: 'number', options: [] };
		case 'date':
			return { type: 'date', options: [] };
		case 'checkbox':
		case 'consent':
			return { type: 'yes_no', options: [] };
		case 'select':
		case 'radio': {
			const opts = cleanOptions(options.map((o) => o.label));
			return opts.length ? { type: 'choice', options: opts } : { type: 'text', options: [] };
		}
		default:
			return { type: 'text', options: [] };
	}
}

/** Check a value typed on the contact page against the field's type ('' = clear, always fine). */
export function valueProblem(f: Pick<CustomField, 'label' | 'type' | 'options'>, v: string): string | null {
	if (v === '') return null;
	switch (f.type) {
		case 'number':
			return Number.isFinite(Number(v)) ? null : `${f.label} must be a number.`;
		case 'date':
			return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? null : `${f.label} must be a date (YYYY-MM-DD).`;
		case 'yes_no':
			return v === YES_VALUE || v === NO_VALUE ? null : `${f.label} must be yes or no.`;
		case 'choice':
			return f.options.includes(v) ? null : `${f.label} must be one of its options.`;
		default:
			return null;
	}
}

/** Display text for a stored value. */
export function displayValue(type: CustomFieldType, v: string): string {
	if (type === 'yes_no') {
		const t = v.trim().toLowerCase();
		if (['yes', 'true', '1', 'on'].includes(t)) return 'Yes';
		if (['no', 'false', '0', 'off'].includes(t)) return 'No';
	}
	return v;
}
