// Forms (#508, phase 1 = #509). Universal (no server imports): the form spec stored in
// `forms.spec` (JSON), its vocabulary, limits, style presets, the lenient read
// (`normalizeFormSpec`), the strict save check (`validateFormSpec`) and the per-field answer
// coercion the submit path uses (`answerSchema` / `coerceAnswers`). Later phases import these
// names — keep them stable.
//
// Shape:
//   FormSpec  { title, intro_md, fields[], pages[], outcomes[], style, settings }
//   fields    a flat list in display order; `page_break` fields split it into pages, so
//             `pages` is derived from them (page 1 = 'start', then one per break)
//   outcomes  what a submission does besides mapping. Phase 1 writes one unconditional
//             outcome (`id: 'default'`, `when: null`) from the Settings tab.
import { normalizeHex, autoTextColor } from '$lib/brand';
import type { FormRuleSet, PageJump } from '$lib/form-logic';
import {
	CONTACT_LIST_FIELD,
	CONTACT_META_PREFIX,
	CONTACT_TAG_FIELD,
	isContactRuleField,
	JUMP_END,
	MAX_JUMPS,
	normalizeJumps,
	normalizeRuleSet,
	UNARY_OPS
} from '$lib/form-logic';
import { DEFAULT_RATING, coerceRating, normalizeRating, ratingProblems, ratingText, type RatingSettings } from '$lib/form-rating';
import { isFormProtectedKey } from '$lib/custom-fields';
import { webhookUrlProblem } from '$lib/webhook-url';
import { originProblem } from '$lib/form-origins';
import { isEmail } from '$lib/csv';

export type { FormRuleSet, PageJump } from '$lib/form-logic';

// ---------------------------------------------------------------------------------------
// Vocabulary

export const FIELD_TYPE_KEYS = [
	'short_text',
	'long_text',
	'email',
	'phone',
	'number',
	'url',
	'date',
	'select',
	'radio',
	'checkboxes',
	'checkbox',
	'consent',
	'rating',
	'topics',
	'hidden',
	'heading',
	'paragraph',
	'page_break'
] as const;
export type FormFieldType = (typeof FIELD_TYPE_KEYS)[number];

export type FieldTypeInfo = {
	type: FormFieldType;
	label: string;
	/** Glyph name from `$lib/icons/glyphs`. */
	icon: string;
	/** Takes an options list (select / radio / checkboxes; topics get theirs from Settings). */
	options: boolean;
	/** Can be mapped onto the contact (Maps to picker). */
	mapping: boolean;
	/** Can be required. */
	required: boolean;
	/** Produces an answer (layout items don't). */
	answer: boolean;
};

export const FIELD_TYPES: FieldTypeInfo[] = [
	{ type: 'short_text', label: 'Short answer', icon: 'text', options: false, mapping: true, required: true, answer: true },
	{ type: 'long_text', label: 'Paragraph answer', icon: 'quote', options: false, mapping: true, required: true, answer: true },
	{ type: 'email', label: 'Email', icon: 'mail', options: false, mapping: true, required: true, answer: true },
	{ type: 'phone', label: 'Phone', icon: 'conversations', options: false, mapping: true, required: true, answer: true },
	{ type: 'number', label: 'Number', icon: 'list-ordered', options: false, mapping: true, required: true, answer: true },
	{ type: 'url', label: 'Website', icon: 'link', options: false, mapping: true, required: true, answer: true },
	{ type: 'date', label: 'Date', icon: 'schedule', options: false, mapping: true, required: true, answer: true },
	{ type: 'select', label: 'Dropdown', icon: 'chevron-down', options: true, mapping: true, required: true, answer: true },
	{ type: 'radio', label: 'Multiple choice', icon: 'list', options: true, mapping: true, required: true, answer: true },
	{ type: 'checkboxes', label: 'Checkboxes', icon: 'filter', options: true, mapping: true, required: true, answer: true },
	{ type: 'checkbox', label: 'Single checkbox', icon: 'deliverability', options: false, mapping: true, required: true, answer: true },
	{ type: 'consent', label: 'Consent', icon: 'deliverability', options: false, mapping: true, required: true, answer: true },
	{ type: 'rating', label: 'Rating', icon: 'branding', options: false, mapping: true, required: true, answer: true },
	{ type: 'topics', label: 'Subscription topics', icon: 'mail', options: false, mapping: false, required: false, answer: true },
	{ type: 'hidden', label: 'Hidden value', icon: 'eye', options: false, mapping: true, required: false, answer: true },
	{ type: 'heading', label: 'Heading', icon: 'heading', options: false, mapping: false, required: false, answer: false },
	{ type: 'paragraph', label: 'Paragraph', icon: 'text', options: false, mapping: false, required: false, answer: false },
	{ type: 'page_break', label: 'Page break', icon: 'divider', options: false, mapping: false, required: false, answer: false }
];

export function fieldTypeInfo(type: string): FieldTypeInfo | undefined {
	return FIELD_TYPES.find((t) => t.type === type);
}
export const isFieldType = (v: unknown): v is FormFieldType => (FIELD_TYPE_KEYS as readonly unknown[]).includes(v);
export const isAnswerType = (t: FormFieldType) => fieldTypeInfo(t)?.answer === true;

/** Types whose answer is a list of values. */
export const MULTI_TYPES: FormFieldType[] = ['checkboxes', 'topics'];
/** Types whose answer is a tick (true / false). */
export const TICK_TYPES: FormFieldType[] = ['checkbox', 'consent'];
/** Types whose answer is free text (contact / custom field mapping makes sense). */
const TEXTY: FormFieldType[] = ['short_text', 'long_text', 'email', 'phone', 'number', 'url', 'date', 'hidden', 'select', 'radio'];

/** Contact columns a field can write. `phone` is stored as the custom field `phone`. */
export const CONTACT_FIELDS = ['email', 'first_name', 'last_name', 'name', 'company', 'phone'] as const;
export type ContactFieldKey = (typeof CONTACT_FIELDS)[number];
export const CONTACT_FIELD_LABELS: Record<ContactFieldKey, string> = {
	email: 'Email',
	first_name: 'First name',
	last_name: 'Last name',
	name: 'Full name',
	company: 'Company',
	phone: 'Phone'
};

/**
 * Where an answer goes on the contact. null = answer only (kept on the submission).
 *   contact     a contact column (CONTACT_FIELDS)
 *   meta        a custom field (`contacts.meta[key]`); a list answer is joined with ", "
 *   tag         the chosen option(s) become tags — or, with `name`, a tick / any answer adds that tag
 *   tag_prefix  `<prefix><option>` tags (e.g. `interest:`)
 *   list        a tick (or any answer) adds the contact to list `list_id`
 *   topic       a tick opts in to topic `list_id`
 */
export type FieldMap =
	| { to: 'contact'; field: ContactFieldKey }
	| { to: 'meta'; key: string }
	| { to: 'tag'; name?: string }
	| { to: 'tag_prefix'; prefix: string }
	| { to: 'list'; list_id: number }
	| { to: 'topic'; list_id: number };
export const FIELD_MAP_KINDS = ['contact', 'meta', 'tag', 'tag_prefix', 'list', 'topic'] as const;

export type FormOption = { value: string; label: string };

export type FormField = {
	/** Stable id (`f_<random>`), never shown. */
	id: string;
	type: FormFieldType;
	/** The answer key: the POST name, the prefill `?<key>=`, the CSV column. */
	key: string;
	/** Question text (heading text, paragraph Markdown, page title for a page break). */
	label: string;
	help: string;
	required: boolean;
	placeholder: string;
	options: FormOption[];
	map: FieldMap | null;
	/** Phase 2's Logic tab writes this; the renderer and the submit path already apply it. */
	show_when: FormRuleSet | null;
	/** Rating questions only (#589): style, scale, end labels. Read through `ratingOf`. */
	rating?: RatingSettings;
};

/** A rating question's settings (the defaults when missing, e.g. a field just switched to Rating). */
export function ratingOf(f: Pick<FormField, 'rating'>): RatingSettings {
	return f.rating ? normalizeRating(f.rating) : { ...DEFAULT_RATING };
}

/** A page; `next` (#514) = its ordered jump rules (Logic tab → Page jumps), none = the next page. */
export type FormPage = { id: string; title: string; next?: PageJump[] };

/**
 * Outcome actions. The Settings tab writes the unconditional one (`when: null`); the Logic tab
 * (#514) the conditional ones. `remove_tag`, `enroll_automation` (only while `settings.enroll`
 * is on) and `notify` are #514's.
 */
export type FormAction =
	| { type: 'add_tag'; tag: string }
	| { type: 'remove_tag'; tag: string }
	| { type: 'add_to_list'; list_id: number }
	| { type: 'add_topic'; list_id: number }
	| { type: 'set_field'; key: string; value: string }
	| { type: 'set_source'; source: string }
	| { type: 'enroll_automation'; automation_id: number }
	| { type: 'notify'; user_ids: number[] }
	| { type: 'message_md'; md: string }
	| { type: 'redirect'; url: string };
export const ACTION_TYPES = [
	'add_tag',
	'remove_tag',
	'add_to_list',
	'add_topic',
	'set_field',
	'set_source',
	'enroll_automation',
	'notify',
	'message_md',
	'redirect'
] as const;
export const ACTION_LABELS: Record<(typeof ACTION_TYPES)[number], string> = {
	add_tag: 'Add tag',
	remove_tag: 'Remove tag',
	add_to_list: 'Add to list',
	add_topic: 'Opt in to topic',
	set_field: 'Set a field',
	set_source: 'Set source',
	enroll_automation: 'Enroll in automation',
	notify: 'Notify',
	message_md: 'Show a message',
	redirect: 'Go to a web address'
};

export type FormOutcome = { id: string; when: FormRuleSet | null; actions: FormAction[] };
/** #514: `all` = every conditional outcome whose rules hold fires; `first` = only the first one. */
export const OUTCOMES_MODES = ['all', 'first'] as const;
export type OutcomesMode = (typeof OUTCOMES_MODES)[number];

// No serif option (2026-10-11: no serif fonts).
export const FONT_KEYS = ['ui', 'system', 'mono'] as const;
export type FormFont = (typeof FONT_KEYS)[number];
export const FONT_LABELS: Record<FormFont, string> = { ui: 'Inter (app)', system: 'System', mono: 'Monospace' };
export const FONT_STACKS: Record<FormFont, string> = {
	ui: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
	system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
	mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
};
export const RADII = [0, 4, 9, 13, 19] as const;
export const WIDTHS = [480, 560, 640, 720] as const;

export type FormStyle = {
	preset: string;
	bg: string;
	surface: string;
	text: string;
	muted: string;
	border: string;
	accent: string;
	/** Text on the accent (button label); '' = black or white by contrast. */
	accent_text: string;
	radius: number;
	width: number;
	font: FormFont;
	/** Show Settings → Branding's logo above the title. */
	logo: boolean;
	/** Questions on a raised card (Google Forms) instead of flat on the page. */
	cards: boolean;
};

export type FormSettings = {
	submit_label: string;
	allow_anonymous: boolean;
	/** Double opt-in (#510): an address that isn't subscribed gets a confirm email; nothing applies until they confirm. */
	double_optin: boolean;
	/** Same meaning as `enroll` everywhere else: list adds fire list-triggered automations. */
	enroll: boolean;
	notify_user_ids: number[];
	/** #620: an https:// URL POSTed (signed `X-DSV-Signature`) on every accepted submission; '' = off. */
	notify_webhook: string;
	retention_days: number;
	noindex: boolean;
	/** Share & embed tab (#515); the CRM host is always allowed. Each is an origin (`originProblem`). */
	allowed_origins: string[];
	/** #514: which conditional outcomes fire — every match (`all`, default) or the first. */
	outcomes_mode: OutcomesMode;
	/** #744: most confirmation emails + first writes of new addresses per UTC day; 0 = no cap. */
	daily_send_cap: number;
};

export type FormSpec = {
	title: string;
	intro_md: string;
	fields: FormField[];
	pages: FormPage[];
	outcomes: FormOutcome[];
	style: FormStyle;
	settings: FormSettings;
};

/** Same shape as the automation `SpecProblem` (#345). */
export type SpecProblem = { path: string; message: string };

export const FORM_LIMITS = {
	name: 120,
	slug: 60,
	title: 200,
	intro: 5000,
	fields: 100,
	pages: 20,
	label: 300,
	help: 500,
	placeholder: 150,
	key: 40,
	options: 50,
	optionLabel: 200,
	outcomes: 10,
	actions: 40,
	jumps: MAX_JUMPS,
	tag: 60,
	metaKey: 50,
	message: 5000,
	url: 2000,
	submitLabel: 40,
	notify: 10,
	origins: 20,
	retentionMin: 1,
	retentionMax: 3650,
	/** #744: upper bound of `settings.daily_send_cap`. */
	dailySendCapMax: 100000,
	shortAnswer: 500,
	longAnswer: 5000,
	source: 60
} as const;

// ---------------------------------------------------------------------------------------
// Style presets

/** "Feedback page": the unsubscribe page's light tokens (app.css), so a form looks like it. */
export const DEFAULT_FORM_STYLE: FormStyle = {
	preset: 'feedback',
	bg: '#f9f9f9',
	surface: '#ffffff',
	text: '#1f1f1f',
	muted: '#737373',
	border: '#e3e3e3',
	accent: '#147793',
	accent_text: '#ffffff',
	radius: 9,
	width: 560,
	font: 'ui',
	logo: true,
	cards: false
};

type PresetColors = Pick<FormStyle, 'bg' | 'surface' | 'text' | 'muted' | 'border' | 'accent' | 'accent_text' | 'cards'>;
export const STYLE_PRESETS: { key: string; label: string; colors: PresetColors }[] = [
	{
		key: 'feedback',
		label: 'Feedback page',
		colors: { bg: '#f9f9f9', surface: '#ffffff', text: '#1f1f1f', muted: '#737373', border: '#e3e3e3', accent: '#147793', accent_text: '#ffffff', cards: false }
	},
	{
		key: 'cards',
		label: 'Cards',
		colors: { bg: '#eef4f7', surface: '#ffffff', text: '#1f1f1f', muted: '#5f6b72', border: '#d8e2e8', accent: '#147793', accent_text: '#ffffff', cards: true }
	},
	{
		key: 'minimal',
		label: 'Minimal',
		colors: { bg: '#ffffff', surface: '#ffffff', text: '#111111', muted: '#6b6b6b', border: '#dddddd', accent: '#111111', accent_text: '#ffffff', cards: false }
	},
	{
		key: 'dark',
		label: 'Dark',
		colors: { bg: '#161b22', surface: '#1f2630', text: '#f2f4f7', muted: '#a3abb5', border: '#333c47', accent: '#4cc3e6', accent_text: '#0b1419', cards: true }
	}
];

/** A preset's colours over `style` — width, radius, font and logo are kept. */
export function applyPreset(style: FormStyle, key: string): FormStyle {
	const p = STYLE_PRESETS.find((x) => x.key === key);
	if (!p) return style;
	return { ...style, ...p.colors, preset: p.key };
}

/** CSS custom properties for the renderer's root (it inherits nothing from the page). */
export function styleVars(style: FormStyle): string {
	const s = normalizeStyle(style);
	const onAccent = s.accent_text || autoTextColor(s.accent);
	return [
		`--f-bg:${s.bg}`,
		`--f-surface:${s.surface}`,
		`--f-text:${s.text}`,
		`--f-muted:${s.muted}`,
		`--f-border:${s.border}`,
		`--f-accent:${s.accent}`,
		`--f-on-accent:${onAccent}`,
		`--f-radius:${s.radius}px`,
		`--f-width:${s.width}px`,
		`--f-font:${FONT_STACKS[s.font]}`
	].join(';');
}

// ---------------------------------------------------------------------------------------
// Helpers

/** Lowercase, hyphenated, ≤ 60 chars — form slugs (`/f/<slug>`). */
export function slugify(s: string, max: number = FORM_LIMITS.slug): string {
	return String(s ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/g, '');
}
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Answer keys: lowercase letters, digits and underscores, starting with a letter. */
export const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** An answer key from a label (`What's your role?` → `whats_your_role`). */
export function keyFromLabel(label: string): string {
	const k = String(label ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, FORM_LIMITS.key)
		.replace(/_+$/g, '');
	return /^[a-z]/.test(k) ? k : k ? `q_${k}`.slice(0, FORM_LIMITS.key) : '';
}

export function newId(prefix = 'f'): string {
	const r = Math.random().toString(36).slice(2, 10);
	return `${prefix}_${r}${Date.now().toString(36).slice(-4)}`;
}

export function blankField(type: FormFieldType, label = ''): FormField {
	const info = fieldTypeInfo(type);
	return {
		id: newId(),
		type,
		key: '',
		label,
		help: '',
		required: false,
		placeholder: '',
		options: info?.options ? [{ value: 'Option 1', label: 'Option 1' }] : [],
		map: null,
		show_when: null,
		...(type === 'rating' ? { rating: { ...DEFAULT_RATING } } : {})
	};
}

export function defaultSettings(): FormSettings {
	return {
		submit_label: 'Submit',
		allow_anonymous: false,
		double_optin: false,
		enroll: false,
		notify_user_ids: [],
		notify_webhook: '',
		retention_days: 365,
		noindex: true,
		allowed_origins: [],
		outcomes_mode: 'all',
		daily_send_cap: DEFAULT_DAILY_SEND_CAP
	};
}

/** #744: the default per-form daily send cap. */
export const DEFAULT_DAILY_SEND_CAP = 500;

/** A new form: a title, an email field mapped to the contact, the default outcome. */
export function emptyForm(title = 'Untitled form'): FormSpec {
	const email: FormField = {
		...blankField('email', 'Email'),
		key: 'email',
		required: true,
		map: { to: 'contact', field: 'email' }
	};
	return {
		title,
		intro_md: '',
		fields: [email],
		pages: [{ id: 'start', title }],
		outcomes: [defaultOutcome()],
		style: { ...DEFAULT_FORM_STYLE },
		settings: defaultSettings()
	};
}

export function defaultOutcome(): FormOutcome {
	return {
		id: 'default',
		when: null,
		actions: [
			{ type: 'set_source', source: 'form' },
			{ type: 'message_md', md: 'Thanks! We got your answers.' }
		]
	};
}

/** The unconditional outcome the Settings tab edits (created when missing). */
export function settingsOutcome(spec: FormSpec): FormOutcome {
	return spec.outcomes.find((o) => o.id === 'default') ?? spec.outcomes.find((o) => o.when === null) ?? { id: 'default', when: null, actions: [] };
}

/** Replace the Settings tab's outcome, keeping any others. */
export function withSettingsOutcome(spec: FormSpec, actions: FormAction[]): FormSpec {
	const cur = settingsOutcome(spec);
	const rest = spec.outcomes.filter((o) => o !== cur && o.id !== 'default');
	return { ...spec, outcomes: [{ id: 'default', when: null, actions }, ...rest] };
}

/**
 * Pages derived from the page breaks: page 1 is `start` (titled with the form title). #514: each
 * keeps the jump rules (`next`, left out when none) of the page with the same id in `prev`; a
 * removed page's rules go with it.
 */
export function pagesOf(fields: FormField[], title: string, prev: { id: string; next?: PageJump[] }[] = []): FormPage[] {
	const pages: FormPage[] = [{ id: 'start', title }, ...fields.filter((f) => f.type === 'page_break').map((f) => ({ id: f.id, title: f.label }))];
	return pages.map((p) => {
		const next = prev.find((x) => x.id === p.id)?.next;
		return next?.length ? { ...p, next } : p;
	});
}

/** #514: a page's number (1-based) by id, '' = unknown. Page 1 is `start`. */
export function pageLabel(pages: Pick<FormPage, 'id' | 'title'>[], id: string): string {
	if (id === JUMP_END) return 'Submit';
	const i = pages.findIndex((p) => p.id === id);
	if (i < 0) return '';
	const t = pages[i].title.trim();
	return `Page ${i + 1}${t && i > 0 ? `: ${t}` : ''}`;
}

/** Fields split into pages at each page break (the break itself starts the next page). */
export function fieldsByPage(fields: FormField[]): FormField[][] {
	const pages: FormField[][] = [[]];
	for (const f of fields) {
		if (f.type === 'page_break') pages.push([f]);
		else pages[pages.length - 1].push(f);
	}
	return pages;
}

/** The field mapped to the contact's email (identifies the contact), if any. */
export function emailField(spec: Pick<FormSpec, 'fields'>): FormField | undefined {
	return spec.fields.find((f) => f.map?.to === 'contact' && f.map.field === 'email');
}

// ---------------------------------------------------------------------------------------
// Lenient read

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown, max: number): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max);
const posInt = (v: unknown): number | null => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

export function normalizeMap(raw: unknown): FieldMap | null {
	const m = obj(raw);
	switch (m.to) {
		case 'contact':
			return (CONTACT_FIELDS as readonly unknown[]).includes(m.field) ? { to: 'contact', field: m.field as ContactFieldKey } : null;
		case 'meta': {
			const key = s(m.key, FORM_LIMITS.metaKey).trim();
			return key ? { to: 'meta', key } : null;
		}
		case 'tag': {
			const name = s(m.name, FORM_LIMITS.tag).trim();
			return name ? { to: 'tag', name } : { to: 'tag' };
		}
		case 'tag_prefix': {
			const prefix = s(m.prefix, FORM_LIMITS.tag).trim();
			return prefix ? { to: 'tag_prefix', prefix } : null;
		}
		case 'list':
		case 'topic': {
			const id = posInt(m.list_id);
			return id ? { to: m.to, list_id: id } : null;
		}
		default:
			return null;
	}
}

function normalizeField(raw: unknown): FormField | null {
	const f = obj(raw);
	if (!isFieldType(f.type)) return null;
	const options = Array.isArray(f.options)
		? f.options
				.map((o) => {
					if (typeof o === 'string') return { value: o.slice(0, FORM_LIMITS.optionLabel), label: o.slice(0, FORM_LIMITS.optionLabel) };
					const oo = obj(o);
					const label = s(oo.label ?? oo.value, FORM_LIMITS.optionLabel);
					const value = s(oo.value ?? oo.label, FORM_LIMITS.optionLabel);
					return { value, label };
				})
				.filter((o) => o.value || o.label)
				.slice(0, FORM_LIMITS.options * 2)
		: [];
	return {
		id: s(f.id, 40) || newId(),
		type: f.type,
		key: s(f.key, FORM_LIMITS.key * 2),
		label: s(f.label, FORM_LIMITS.label * 2),
		help: s(f.help, FORM_LIMITS.help * 2),
		required: f.required === true,
		placeholder: s(f.placeholder, FORM_LIMITS.placeholder),
		options,
		map: normalizeMap(f.map),
		show_when: normalizeRuleSet(f.show_when),
		...(f.type === 'rating' ? { rating: normalizeRating(f.rating) } : {})
	};
}

function normalizeAction(raw: unknown): FormAction | null {
	const a = obj(raw);
	switch (a.type) {
		case 'add_tag':
		case 'remove_tag': {
			const tag = s(a.tag, FORM_LIMITS.tag * 2).trim();
			return tag ? { type: a.type, tag } : null;
		}
		case 'enroll_automation': {
			const id = posInt(a.automation_id);
			return id ? { type: 'enroll_automation', automation_id: id } : null;
		}
		case 'notify': {
			const ids = Array.isArray(a.user_ids) ? [...new Set(a.user_ids.map(posInt).filter((n): n is number => n !== null))] : [];
			return { type: 'notify', user_ids: ids.slice(0, FORM_LIMITS.notify * 2) };
		}
		case 'add_to_list':
		case 'add_topic': {
			const id = posInt(a.list_id);
			return id ? { type: a.type, list_id: id } : null;
		}
		case 'set_field': {
			const key = s(a.key, FORM_LIMITS.metaKey * 2).trim();
			return key ? { type: 'set_field', key, value: s(a.value, FORM_LIMITS.shortAnswer) } : null;
		}
		case 'set_source': {
			const source = s(a.source, FORM_LIMITS.source * 2).trim();
			return source ? { type: 'set_source', source } : null;
		}
		case 'message_md':
			return { type: 'message_md', md: s(a.md, FORM_LIMITS.message * 2) };
		case 'redirect': {
			const url = s(a.url, FORM_LIMITS.url * 2).trim();
			return url ? { type: 'redirect', url } : null;
		}
		default:
			return null;
	}
}

export function normalizeStyle(raw: unknown): FormStyle {
	const st = obj(raw);
	const d = DEFAULT_FORM_STYLE;
	const hex = (v: unknown, def: string) => normalizeHex(v) || def;
	const radius = (RADII as readonly number[]).includes(Number(st.radius)) ? Number(st.radius) : d.radius;
	const width = (WIDTHS as readonly number[]).includes(Number(st.width)) ? Number(st.width) : d.width;
	return {
		preset: st.preset === undefined ? d.preset : STYLE_PRESETS.some((p) => p.key === st.preset) ? String(st.preset) : 'custom',
		bg: hex(st.bg, d.bg),
		surface: hex(st.surface, d.surface),
		text: hex(st.text, d.text),
		muted: hex(st.muted, d.muted),
		border: hex(st.border, d.border),
		accent: hex(st.accent, d.accent),
		accent_text: normalizeHex(st.accent_text) || '',
		radius,
		width,
		font: (FONT_KEYS as readonly unknown[]).includes(st.font) ? (st.font as FormFont) : d.font,
		logo: st.logo === undefined ? d.logo : st.logo === true,
		cards: st.cards === true
	};
}

function normalizeSettings(raw: unknown): FormSettings {
	const st = obj(raw);
	const d = defaultSettings();
	const ret = Number(st.retention_days);
	return {
		submit_label: s(st.submit_label, FORM_LIMITS.submitLabel * 2).trim() || d.submit_label,
		allow_anonymous: st.allow_anonymous === true,
		double_optin: st.double_optin === true,
		enroll: st.enroll === true,
		notify_user_ids: Array.isArray(st.notify_user_ids)
			? [...new Set(st.notify_user_ids.map(posInt).filter((n): n is number => n !== null))].slice(0, FORM_LIMITS.notify * 2)
			: [],
		notify_webhook: s(st.notify_webhook, FORM_LIMITS.url * 2).trim(),
		retention_days: Number.isInteger(ret) && ret >= 0 ? ret : d.retention_days,
		noindex: st.noindex === undefined ? true : st.noindex !== false,
		allowed_origins: Array.isArray(st.allowed_origins)
			? st.allowed_origins.map((o) => s(o, 200).trim()).filter(Boolean).slice(0, FORM_LIMITS.origins * 2)
			: [],
		outcomes_mode: st.outcomes_mode === 'first' ? 'first' : 'all',
		// #744: a spec saved before the cap existed (or junk) gets the default; the save check bounds it.
		daily_send_cap: sendCapOf(st.daily_send_cap, d.daily_send_cap)
	};
}

function sendCapOf(v: unknown, fallback: number): number {
	if (v === null || v === undefined || v === '' || typeof v === 'boolean') return fallback;
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Untrusted / stored JSON → a FormSpec. Junk → defaults; never throws. */
export function normalizeFormSpec(raw: unknown): FormSpec {
	let src: unknown = raw;
	if (typeof raw === 'string') {
		try {
			src = JSON.parse(raw);
		} catch {
			src = {};
		}
	}
	const o = obj(src);
	const title = s(o.title, FORM_LIMITS.title * 2) || 'Untitled form';
	const fields = Array.isArray(o.fields)
		? o.fields.map(normalizeField).filter((f): f is FormField => f !== null).slice(0, FORM_LIMITS.fields * 2)
		: [];
	const outcomes = Array.isArray(o.outcomes)
		? o.outcomes
				.map((x) => {
					const oc = obj(x);
					const actions = Array.isArray(oc.actions)
						? oc.actions.map(normalizeAction).filter((a): a is FormAction => a !== null)
						: [];
					return { id: s(oc.id, 40) || newId('o'), when: normalizeRuleSet(oc.when), actions };
				})
				.slice(0, FORM_LIMITS.outcomes * 2)
		: [defaultOutcome()];
	return {
		title,
		intro_md: s(o.intro_md, FORM_LIMITS.intro * 2),
		fields,
		pages: pagesOf(
			fields,
			title,
			Array.isArray(o.pages) ? o.pages.map((p) => ({ id: s(obj(p).id, 40), next: normalizeJumps(obj(p).next) })) : []
		),
		outcomes,
		style: normalizeStyle(o.style),
		settings: normalizeSettings(o.settings)
	};
}

// ---------------------------------------------------------------------------------------
// Strict save check

export function cleanRedirectUrl(raw: string): string | null {
	const v = raw.trim();
	if (!v || v.length > FORM_LIMITS.url) return null;
	try {
		const u = new URL(v);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		if (u.username || u.password) return null;
		return u.toString();
	} catch {
		return null;
	}
}

/** #619: a key only the app writes (FORM_PROTECTED_KEYS, e.g. `hygiene`) can't be a form target. */
const protectedKeyMessage = (key: string) => `“${key}” is set by the app; a form can’t fill it.`;

/** #514: the rule fields an outcome may read about a known contact. */
export function isOutcomeContactField(field: string): boolean {
	if (field === CONTACT_TAG_FIELD || field === CONTACT_LIST_FIELD) return true;
	if (field.startsWith(CONTACT_META_PREFIX)) return field.length > CONTACT_META_PREFIX.length;
	return field.startsWith('contact:') && field.length > 'contact:'.length;
}

/**
 * #514: the Logic tab's checks. A show rule and a page jump only read answers to questions that
 * come before them (a show rule: earlier in the form; a jump: on its page or an earlier one) —
 * never the contact, which the browser doesn't know. A jump goes to a later page or to Submit.
 * An outcome rule reads any question, or the known contact.
 */
function logicProblems(spec: FormSpec, add: (path: string, message: string) => void): void {
	const answerAt = new Map<string, number>(); // answer key → field index
	spec.fields.forEach((f, i) => {
		if (isAnswerType(f.type) && f.key && !answerAt.has(f.key)) answerAt.set(f.key, i);
	});
	const checkValues = (set: FormRuleSet, base: string) =>
		set.rules.forEach((r, j) => {
			if (UNARY_OPS.includes(r.op)) return;
			const v = r.value;
			if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) add(`${base}.rules[${j}].value`, 'Enter a value for this condition.');
		});

	spec.fields.forEach((f, i) => {
		if (!f.show_when) return;
		const base = `fields[${i}].show_when`;
		f.show_when.rules.forEach((r, j) => {
			const at = answerAt.get(r.field);
			if (isContactRuleField(r.field)) add(`${base}.rules[${j}].field`, 'Show rules read answers only, not the contact.');
			else if (at === undefined) add(`${base}.rules[${j}].field`, `No question uses the key “${r.field}”.`);
			else if (at >= i) add(`${base}.rules[${j}].field`, 'A question can only depend on questions before it.');
		});
		checkValues(f.show_when, base);
	});

	// Page index of each field: page 0 until the first break, etc.
	const pageOfField: number[] = [];
	let pg = 0;
	spec.fields.forEach((f, i) => {
		if (f.type === 'page_break') pg++;
		pageOfField[i] = pg;
	});
	const pageIds = ['start', ...spec.fields.filter((f) => f.type === 'page_break').map((f) => f.id)];
	spec.pages.forEach((p, pi) => {
		const jumps = p.next ?? [];
		if (!jumps.length) return;
		const at = pageIds.indexOf(p.id);
		if (jumps.length > FORM_LIMITS.jumps) add(`pages[${pi}].next`, `At most ${FORM_LIMITS.jumps} jump rules per page.`);
		jumps.forEach((jmp, j) => {
			const base = `pages[${pi}].next[${j}]`;
			const target = jmp.goto === JUMP_END ? pageIds.length : pageIds.indexOf(jmp.goto);
			if (target <= at) add(`${base}.goto`, 'Jump to a later page, or to Submit.');
			if (!jmp.when) return;
			jmp.when.rules.forEach((r, k) => {
				const fi = answerAt.get(r.field);
				if (isContactRuleField(r.field)) add(`${base}.when.rules[${k}].field`, 'Page jumps read answers only, not the contact.');
				else if (fi === undefined) add(`${base}.when.rules[${k}].field`, `No question uses the key “${r.field}”.`);
				else if (pageOfField[fi] > at) add(`${base}.when.rules[${k}].field`, 'A jump can only read questions on this page or before it.');
			});
			checkValues(jmp.when, `${base}.when`);
		});
	});

	spec.outcomes.forEach((o, i) => {
		if (!o.when) return;
		const base = `outcomes[${i}].when`;
		o.when.rules.forEach((r, j) => {
			if (isContactRuleField(r.field)) {
				if (!isOutcomeContactField(r.field)) add(`${base}.rules[${j}].field`, 'Pick what to check about the contact.');
				else if ((r.field === CONTACT_TAG_FIELD || r.field === CONTACT_LIST_FIELD) && r.op !== 'eq' && r.op !== 'neq') {
					add(`${base}.rules[${j}].op`, 'Use “is” or “is not” here.');
				}
			} else if (!answerAt.has(r.field)) add(`${base}.rules[${j}].field`, `No question uses the key “${r.field}”.`);
		});
		checkValues(o.when, base);
	});
}

/** Every problem with a spec, `{ path: 'fields[3].options', message }`. Empty = valid. */
export function validateFormSpec(spec: FormSpec): SpecProblem[] {
	const out: SpecProblem[] = [];
	const add = (path: string, message: string) => out.push({ path, message });
	const L = FORM_LIMITS;

	if (!spec.title.trim()) add('title', 'Give the form a title.');
	if (spec.title.length > L.title) add('title', `Title is over ${L.title} characters.`);
	if (spec.intro_md.length > L.intro) add('intro_md', `Intro is over ${L.intro} characters.`);
	if (spec.fields.length > L.fields) add('fields', `A form can have at most ${L.fields} items.`);
	const breaks = spec.fields.filter((f) => f.type === 'page_break').length;
	if (breaks + 1 > L.pages) add('fields', `A form can have at most ${L.pages} pages.`);

	const keys = new Map<string, number>();
	const contactMaps = new Map<string, number>();
	const metaMaps = new Map<string, number>();
	spec.fields.forEach((f, i) => {
		const p = `fields[${i}]`;
		const info = fieldTypeInfo(f.type)!;
		if (f.label.length > L.label) add(`${p}.label`, `Label is over ${L.label} characters.`);
		if (f.help.length > L.help) add(`${p}.help`, `Help text is over ${L.help} characters.`);
		if (f.type === 'paragraph' && f.label.length > L.intro) add(`${p}.label`, `Paragraph is over ${L.intro} characters.`);
		if (info.answer) {
			if (!f.label.trim() && f.type !== 'hidden') add(`${p}.label`, 'Write the question.');
			if (!KEY_RE.test(f.key) || f.key.length > L.key) {
				add(`${p}.key`, 'The answer key must start with a letter and use only a–z, 0–9 and _.');
			} else if (keys.has(f.key)) {
				add(`${p}.key`, `Another question already uses the key “${f.key}”.`);
			} else keys.set(f.key, i);
		}
		if (f.placeholder.length > L.placeholder) add(`${p}.placeholder`, `Placeholder is over ${L.placeholder} characters.`);
		if (f.required && !info.required) add(`${p}.required`, `${info.label} can't be required.`);

		if (info.options) {
			if (f.options.length === 0) add(`${p}.options`, 'Add at least one option.');
			if (f.options.length > L.options) add(`${p}.options`, `At most ${L.options} options.`);
			const seen = new Set<string>();
			f.options.forEach((o, j) => {
				if (!o.value.trim()) add(`${p}.options[${j}]`, 'An option is empty.');
				if (o.label.length > L.optionLabel) add(`${p}.options[${j}]`, `Option is over ${L.optionLabel} characters.`);
				const k = o.value.trim().toLowerCase();
				if (seen.has(k)) add(`${p}.options[${j}]`, `“${o.value}” is listed twice.`);
				seen.add(k);
			});
		} else if (f.type === 'topics') {
			if (f.options.length === 0) add(`${p}.options`, 'Pick the topics to offer in Settings.');
			f.options.forEach((o, j) => {
				if (!posInt(o.value)) add(`${p}.options[${j}]`, 'A topic option must be a topic list id.');
			});
		}

		if (f.type === 'rating') for (const x of ratingProblems(ratingOf(f))) add(`${p}.${x.path}`, x.message);

		const m = f.map;
		if (m) {
			if (!info.mapping) add(`${p}.map`, `${info.label} can't be mapped.`);
			else if (f.type === 'rating' && m.to !== 'meta') add(`${p}.map`, 'A rating can only fill a custom field.');
			else if (m.to === 'contact') {
				if (!TEXTY.includes(f.type)) add(`${p}.map`, `${info.label} can't fill a contact field.`);
				if (m.field === 'email' && f.type !== 'email' && f.type !== 'hidden') add(`${p}.map`, 'Only an Email question can be the contact email.');
				if (contactMaps.has(m.field)) add(`${p}.map`, `Another question already fills ${CONTACT_FIELD_LABELS[m.field]}.`);
				else contactMaps.set(m.field, i);
			} else if (m.to === 'meta') {
				if (m.key.length > L.metaKey) add(`${p}.map`, `Custom field key is over ${L.metaKey} characters.`);
				if (isFormProtectedKey(m.key)) add(`${p}.map`, protectedKeyMessage(m.key));
				const k = m.key.toLowerCase();
				if (metaMaps.has(k)) add(`${p}.map`, `Another question already fills the custom field “${m.key}”.`);
				else metaMaps.set(k, i);
				if (k === 'phone' && contactMaps.has('phone')) add(`${p}.map`, 'Another question already fills Phone.');
			} else if (m.to === 'tag' || m.to === 'tag_prefix') {
				if (m.to === 'tag' && !m.name && !info.options && !TICK_TYPES.includes(f.type)) {
					add(`${p}.map`, 'Tag mapping needs options, or a tag name for a tick or text answer.');
				}
				if (m.to === 'tag' && TICK_TYPES.includes(f.type) && !m.name) add(`${p}.map`, 'Name the tag a tick adds.');
				if (m.to === 'tag_prefix' && !info.options) add(`${p}.map`, 'A tag prefix needs options.');
				const t = 'prefix' in m ? m.prefix : (m.name ?? '');
				if (t.length > L.tag) add(`${p}.map`, `Tag is over ${L.tag} characters.`);
			}
		}
	});

	logicProblems(spec, add);

	const em = emailField(spec);
	if (!spec.settings.allow_anonymous) {
		if (!em) add('fields', 'Add an Email question mapped to the contact email, or allow anonymous submissions in Settings.');
		else if (!em.required) add(`fields[${spec.fields.indexOf(em)}].required`, 'The email question must be required unless anonymous submissions are allowed.');
	}

	if (spec.outcomes.length > L.outcomes) add('outcomes', `At most ${L.outcomes} outcomes.`);
	spec.outcomes.forEach((o, i) => {
		if (o.actions.length > L.actions) add(`outcomes[${i}].actions`, `At most ${L.actions} actions.`);
		let messages = 0;
		let redirects = 0;
		o.actions.forEach((a, j) => {
			const p = `outcomes[${i}].actions[${j}]`;
			if ((a.type === 'add_tag' || a.type === 'remove_tag') && a.tag.length > L.tag) add(p, `Tag is over ${L.tag} characters.`);
			if (a.type === 'notify') {
				if (!a.user_ids.length) add(p, 'Pick who to notify.');
				if (a.user_ids.length > L.notify) add(p, `Notify at most ${L.notify} people.`);
			}
			if (a.type === 'set_field' && a.key.length > L.metaKey) add(p, `Field key is over ${L.metaKey} characters.`);
			if (a.type === 'set_field' && isFormProtectedKey(a.key)) add(p, protectedKeyMessage(a.key));
			if (a.type === 'set_source' && a.source.length > L.source) add(p, `Source is over ${L.source} characters.`);
			if (a.type === 'message_md') {
				messages++;
				if (a.md.length > L.message) add(p, `Message is over ${L.message} characters.`);
			}
			if (a.type === 'redirect') {
				redirects++;
				if (!cleanRedirectUrl(a.url)) add(p, 'The redirect must be a full http(s) address.');
			}
		});
		if (messages > 1 || redirects > 1 || (messages && redirects)) add(`outcomes[${i}].actions`, 'Pick either a message or a redirect.');
	});

	const st = spec.settings;
	if (!st.submit_label.trim()) add('settings.submit_label', 'Name the submit button.');
	if (st.submit_label.length > L.submitLabel) add('settings.submit_label', `Button label is over ${L.submitLabel} characters.`);
	if (st.notify_user_ids.length > L.notify) add('settings.notify_user_ids', `Notify at most ${L.notify} people.`);
	if (st.notify_webhook) {
		const why = webhookUrlProblem(st.notify_webhook);
		if (why) add('settings.notify_webhook', why);
	}
	if (!Number.isInteger(st.retention_days) || st.retention_days < L.retentionMin || st.retention_days > L.retentionMax) {
		add('settings.retention_days', `Keep submissions between ${L.retentionMin} and ${L.retentionMax} days.`);
	}
	if (!Number.isInteger(st.daily_send_cap) || st.daily_send_cap < 0 || st.daily_send_cap > L.dailySendCapMax) {
		add('settings.daily_send_cap', `Set the daily send limit between 0 (no limit) and ${L.dailySendCapMax}.`);
	}
	if (st.allowed_origins.length > L.origins) add('settings.allowed_origins', `At most ${L.origins} origins.`);
	// #515: each line an origin (`https://example.com`, no path) — they go into a CSP header.
	for (const o of st.allowed_origins) {
		const p = originProblem(o);
		if (p) {
			add('settings.allowed_origins', p);
			break;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------
// Answers

export type AnswerValue = string | string[] | boolean | number;
export type Answers = Record<string, AnswerValue>;
/** A posted value: one string, or every value of a repeated key. */
export type RawAnswers = Record<string, string | string[] | undefined>;

export type AnswerRule = {
	key: string;
	field: FormField;
	/** → `{ value }` (undefined = no answer) or `{ error }`. */
	coerce: (raw: string | string[] | undefined) => { value?: AnswerValue; error?: string };
};

const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw) ?? '';
const all = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw : raw === undefined || raw === '' ? [] : [raw]);

function coerceOne(f: FormField, raw: string | string[] | undefined): { value?: AnswerValue; error?: string } {
	const text = first(raw).trim();
	switch (f.type) {
		case 'short_text':
		case 'hidden':
			return text ? { value: text.slice(0, FORM_LIMITS.shortAnswer) } : {};
		case 'long_text':
			return text ? { value: first(raw).replace(/\r\n/g, '\n').trim().slice(0, FORM_LIMITS.longAnswer) } : {};
		case 'email':
			if (!text) return {};
			// #744: the shared address check (also ingest, newsletter signup, manual add).
			return isEmail(text) ? { value: text.toLowerCase() } : { error: 'Enter a valid email address.' };
		case 'phone':
			if (!text) return {};
			return /^[0-9+().\-\s/x]{3,40}$/i.test(text) && /\d/.test(text) ? { value: text } : { error: 'Enter a valid phone number.' };
		case 'number': {
			if (!text) return {};
			const n = Number(text);
			return Number.isFinite(n) ? { value: n } : { error: 'Enter a number.' };
		}
		case 'url': {
			if (!text) return {};
			const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
			try {
				const u = new URL(withScheme);
				if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.') && withScheme.length <= FORM_LIMITS.url) return { value: u.toString() };
			} catch {
				/* fall through */
			}
			return { error: 'Enter a web address.' };
		}
		case 'date':
			if (!text) return {};
			return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? { value: text } : { error: 'Enter a date.' };
		case 'select':
		case 'radio': {
			if (!text) return {};
			const o = f.options.find((x) => x.value === text);
			return o ? { value: o.value } : { error: 'Pick one of the options.' };
		}
		case 'checkboxes':
		case 'topics': {
			const vals = [...new Set(all(raw).map((v) => v.trim()).filter(Boolean))];
			if (!vals.length) return {};
			const allowed = new Set(f.options.map((o) => o.value));
			if (vals.some((v) => !allowed.has(v))) return { error: 'Pick from the options.' };
			return { value: f.options.map((o) => o.value).filter((v) => vals.includes(v)) };
		}
		case 'checkbox':
		case 'consent':
			return ['on', '1', 'true', 'yes'].includes(text.toLowerCase()) ? { value: true } : {};
		case 'rating':
			return coerceRating(ratingOf(f), text);
		default:
			return {};
	}
}

/** One rule per answer field, in spec order. */
export function answerSchema(spec: Pick<FormSpec, 'fields'>): AnswerRule[] {
	return spec.fields
		.filter((f) => isAnswerType(f.type))
		.map((f) => ({ key: f.key, field: f, coerce: (raw) => coerceOne(f, raw) }));
}

export function isEmptyAnswer(v: AnswerValue | undefined): boolean {
	return v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);
}

/**
 * Coerce posted values for the given fields (default: every answer field). Required fields
 * without an answer get an error. Unknown keys are dropped.
 */
export function coerceAnswers(
	spec: Pick<FormSpec, 'fields'>,
	raw: RawAnswers,
	only?: Set<string>
): { answers: Answers; errors: Record<string, string> } {
	const answers: Answers = {};
	const errors: Record<string, string> = {};
	for (const rule of answerSchema(spec)) {
		if (only && !only.has(rule.field.id)) continue;
		const r = rule.coerce(raw[rule.key]);
		if (r.error) errors[rule.key] = r.error;
		else if (!isEmptyAnswer(r.value)) answers[rule.key] = r.value!;
		else if (rule.field.required) errors[rule.key] = TICK_TYPES.includes(rule.field.type) ? 'Tick this box to continue.' : 'This question is required.';
	}
	return { answers, errors };
}

/** An answer as one line of text (CSV, notification, custom field). */
export function answerText(v: AnswerValue | undefined, field?: FormField): string {
	if (v === undefined) return '';
	if (typeof v === 'boolean') return v ? 'Yes' : 'No';
	if (Array.isArray(v)) {
		if (field) return v.map((x) => field.options.find((o) => o.value === x)?.label ?? x).join(', ');
		return v.join(', ');
	}
	if (field?.type === 'rating' && typeof v === 'number') return ratingText(v, ratingOf(field));
	if (field && (field.type === 'select' || field.type === 'radio')) return field.options.find((o) => o.value === v)?.label ?? String(v);
	return String(v);
}
