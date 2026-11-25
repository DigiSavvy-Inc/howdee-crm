// Forms for the assistant (#517, Forms 5/7): the spec reference the model writes against
// (FORM_SPEC_DOC, in create_form_draft's description — the counterpart of build_automation's
// SPEC_DOC), the model's spec → a checked FormSpec (prepareFormSpec) and a form in words for
// the action card and get_form (formOutline). The save check is $lib/forms' validateFormSpec;
// this module only adds what the lenient read would otherwise drop without a word (unknown
// types, mappings, rules, actions, page ids), resolves list / topic / automation names and
// "me" in notify lists, and keeps the two settings the assistant may never set: allowed
// origins and the notify webhook.

import {
	ACTION_TYPES,
	applyPreset,
	CONTACT_FIELD_LABELS,
	defaultSettings,
	FIELD_TYPE_KEYS,
	FORM_LIMITS,
	fieldTypeInfo,
	isAnswerType,
	isFieldType,
	keyFromLabel,
	normalizeFormSpec,
	normalizeMap,
	pageLabel,
	ratingOf,
	validateFormSpec,
	type FieldMap,
	type FormAction,
	type FormSpec,
	type SpecProblem
} from '$lib/forms';
import { CONTACT_LIST_FIELD, CONTACT_META_PREFIX, CONTACT_TAG_FIELD, JUMP_END, MAX_RULES, RULE_OPS, normalizeRuleSet, ruleSetText } from '$lib/form-logic';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d+$/.test(v.trim()));

// ── The spec reference (in create_form_draft's description; ≤ ~1,200 tokens with examples) ──

const EMAIL_Q = { type: 'email', key: 'email', label: 'Email', required: true, map: { to: 'contact', field: 'email' } };

/** The three worked examples. tests/ai-forms-tools-517.test.ts checks each one saves cleanly. */
export const FORM_EXAMPLES = {
	newsletter: {
		title: 'Get the newsletter',
		fields: [
			EMAIL_Q,
			{ type: 'short_text', key: 'first_name', label: 'First name', map: { to: 'contact', field: 'first_name' } },
			{ type: 'checkboxes', key: 'interests', label: 'What should we send you?', options: ['Product news', 'Tips', 'Events'], map: { to: 'tag_prefix', prefix: 'interest:' } },
			{ type: 'consent', key: 'consent', label: 'Yes, email me the newsletter. I can unsubscribe at any time.', required: true }
		],
		outcomes: [{ id: 'default', when: null, actions: [{ type: 'add_to_list', list_id: 'Newsletter' }, { type: 'message_md', md: 'Thanks! Check your inbox to confirm.' }] }],
		settings: { submit_label: 'Subscribe', double_optin: true }
	},
	nps: {
		title: 'How are we doing?',
		fields: [
			EMAIL_Q,
			{ type: 'rating', key: 'score', label: 'How likely are you to recommend us?', required: true, rating: { style: 'numbers', min: 0, max: 10 } },
			{ type: 'long_text', key: 'why', label: 'What could we do better?', show_when: { match: 'all', rules: [{ field: 'score', op: 'lte', value: 6 }] } }
		],
		outcomes: [
			{ id: 'default', when: null, actions: [{ type: 'set_source', source: 'nps' }, { type: 'message_md', md: 'Thanks for the feedback!' }] },
			{ id: 'promoters', when: { match: 'all', rules: [{ field: 'score', op: 'gte', value: 9 }] }, actions: [{ type: 'add_tag', tag: 'promoter' }, { type: 'redirect', url: 'https://example.com/review' }] },
			{ id: 'detractors', when: { match: 'all', rules: [{ field: 'score', op: 'lte', value: 6 }] }, actions: [{ type: 'add_tag', tag: 'detractor' }, { type: 'notify', user_ids: ['me'] }] }
		]
	},
	rsvp: {
		title: 'RSVP: Spring meetup',
		fields: [
			EMAIL_Q,
			{ type: 'radio', key: 'attending', label: 'Will you come?', required: true, options: ['Yes', 'No'] },
			{ type: 'page_break', id: 'details', label: 'Details' },
			{ type: 'select', key: 'guests', label: 'Bringing anyone?', options: ['Just me', '+1', '+2'] },
			{ type: 'long_text', key: 'dietary', label: 'Dietary needs' }
		],
		pages: [{ id: 'start', next: [{ when: { match: 'all', rules: [{ field: 'attending', op: 'eq', value: 'No' }] }, goto: 'end' }] }],
		outcomes: [
			{ id: 'default', when: null, actions: [{ type: 'message_md', md: 'Thanks for letting us know!' }] },
			{ id: 'going', when: { match: 'all', rules: [{ field: 'attending', op: 'eq', value: 'Yes' }] }, actions: [{ type: 'add_tag', tag: 'rsvp-yes' }] }
		]
	}
};

export const FORM_SPEC_DOC = [
	'spec = { title (default: name), intro_md?, fields, pages?, outcomes?, settings?, style? }.',
	'Field = { type, label (question / heading / Markdown / page title), key (answer key a-z0-9_; from the label if left out; rules use it), required?, help?, placeholder?, options? (["A","B"]), map?, show_when?, id? (each page_break needs one, e.g. "p2"), rating? ({ style: stars|hearts|faces|numbers, min, max }) }.',
	'Types: short_text long_text email phone number url date select radio checkboxes checkbox consent rating topics (options = topic ids or names) hidden heading paragraph page_break (starts the next page).',
	'map (omit = kept on the submission only): { to: "contact", field: email|first_name|last_name|name|company|phone } | { to: "meta", key } (custom field) | { to: "tag" } (chosen options) | { to: "tag", name } (a tick) | { to: "tag_prefix", prefix } | { to: "list"|"topic", list_id } (a tick; id or name). Needs a required email field mapped to contact email unless settings.allow_anonymous.',
	'Rules = { match: all|any, rules: [{ field: <answer key>, op, value? }] }; op eq neq in (array) contains gt gte lt lte empty not_empty checked unchecked. show_when reads only earlier questions.',
	'pages = [{ id: "start" (page 1) | <page_break id>, next: [{ when: Rules, goto: <later page_break id> | "end" (submit) }] }]; first match wins.',
	'outcomes (≤ 10; omit = source "form" + a thank-you) = [{ id, when: Rules | null (every submission), actions }]; their rules may also read contact.has_tag / contact.in_list (eq|neq). Action { type, … }: add_tag|remove_tag { tag }, add_to_list|add_topic { list_id }, set_field { key, value }, set_source { source }, enroll_automation { automation_id } (id or name; needs settings.enroll), notify { user_ids: ["me"] }, message_md { md }, redirect { url } — one message or redirect per outcome.',
	'settings = { submit_label, allow_anonymous, double_optin, enroll, retention_days, outcomes_mode: all|first }; style = { preset: feedback|cards|minimal|dark }. Allowed origins and the notify webhook are set only by the user.',
	`Newsletter sign-up: ${JSON.stringify(FORM_EXAMPLES.newsletter)}`,
	`NPS, branching outcomes: ${JSON.stringify(FORM_EXAMPLES.nps)}`,
	`Event RSVP, page jump: ${JSON.stringify(FORM_EXAMPLES.rsvp)}`
].join('\n');

// ── The model's spec → a checked FormSpec ─────────────────────────────────────────────────

const RULE_HINT = `Each rule needs field (an answer key), op (${RULE_OPS.join(', ')}) and, except for empty / not_empty / checked / unchecked, a value; at most ${MAX_RULES} rules.`;

/** True when the lenient read would drop a rule (or the whole set) of `raw`. */
function rulesDropped(raw: unknown): boolean {
	if (raw === null || raw === undefined) return false;
	if (!isObj(raw) || !Array.isArray(raw.rules)) return true;
	return (normalizeRuleSet(raw)?.rules.length ?? 0) !== raw.rules.length;
}

/** True when the lenient read keeps this outcome action. */
const actionKept = (a: unknown) => normalizeFormSpec({ fields: [], outcomes: [{ actions: [a] }] }).outcomes[0]?.actions.length === 1;

type ListRef = { id: number; label: string };
type ListRow = { id: number; name: string; kind: string; public_topic: number; topic_label: string | null };

/** A list or public topic named by id or name → its id, or why not. */
async function listRef(db: D1Database, v: unknown, topic: boolean): Promise<ListRef | string> {
	const what = topic ? 'topic' : 'list';
	let rows: ListRow[];
	if (isId(v)) {
		const r = await db.prepare('SELECT id, name, kind, public_topic, topic_label FROM lists WHERE id = ?').bind(Number(v)).first<ListRow>();
		if (!r) return `No ${what} with id ${String(v).trim()}.`;
		rows = [r];
	} else if (typeof v === 'string' && v.trim()) {
		const name = v.trim();
		rows = (
			await db
				.prepare(
					`SELECT id, name, kind, public_topic, topic_label FROM lists
					 WHERE kind = 'list' AND archived_at IS NULL AND (name = ?1 COLLATE NOCASE OR topic_label = ?1 COLLATE NOCASE) ORDER BY id`
				)
				.bind(name)
				.all<ListRow>()
		).results;
		if (!rows.length) return `No ${what} named “${name}”.`;
		if (rows.length > 1) return `More than one list is named “${name}”: ${rows.map((r) => `${r.name} (id ${r.id})`).join(', ')}. Use the id.`;
	} else return `Name the ${what} by id or name.`;
	const r = rows[0];
	if (r.kind !== 'list') return `“${r.name}” is a ${r.kind}, not a list.`;
	if (topic && !r.public_topic) return `“${r.name}” is not a public topic.`;
	return { id: r.id, label: (topic && r.topic_label) || r.name };
}

/** An automation named by id or name → its id, or why not. */
async function automationRef(db: D1Database, v: unknown): Promise<number | string> {
	if (isId(v)) {
		const r = await db.prepare('SELECT id FROM automations WHERE id = ?').bind(Number(v)).first<{ id: number }>();
		return r ? r.id : `No automation with id ${String(v).trim()}.`;
	}
	if (typeof v !== 'string' || !v.trim()) return 'Name the automation by id or name.';
	const rows = (await db.prepare('SELECT id, name FROM automations WHERE name = ? COLLATE NOCASE ORDER BY id').bind(v.trim()).all<{ id: number; name: string }>()).results;
	if (!rows.length) return `No automation named “${v.trim()}”.`;
	if (rows.length > 1) return `More than one automation is named “${v.trim()}”: ${rows.map((r) => `id ${r.id}`).join(', ')}. Use the id.`;
	return rows[0].id;
}

/** `["me", 12]` → user ids ("me" = the signed-in user), or why not. */
function userIdsArg(v: unknown, userId: number): number[] | string {
	if (!Array.isArray(v)) return 'Give user_ids as a list, e.g. ["me"].';
	const out: number[] = [];
	for (const x of v) {
		if (x === 'me') out.push(userId);
		else if (isId(x)) out.push(Number(x));
		else return 'Use "me" (the signed-in user) or a user id.';
	}
	return out;
}

/** List / topic / automation names → ids and "me" → the user, in place. */
async function resolveRefs(db: D1Database, o: Obj, userId: number, add: (path: string, message: string) => void): Promise<void> {
	const fields = Array.isArray(o.fields) ? o.fields : [];
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		if (!isObj(f)) continue;
		const m = f.map;
		if (isObj(m) && (m.to === 'list' || m.to === 'topic')) {
			const r = await listRef(db, m.list_id, m.to === 'topic');
			if (typeof r === 'string') add(`fields[${i}].map.list_id`, r);
			else m.list_id = r.id;
		}
		if (f.type === 'topics' && Array.isArray(f.options)) {
			const opts: { value: string; label: string }[] = [];
			for (let j = 0; j < f.options.length; j++) {
				const raw = f.options[j];
				const r = await listRef(db, isObj(raw) ? (raw.value ?? raw.label) : raw, true);
				if (typeof r === 'string') add(`fields[${i}].options[${j}]`, r);
				else opts.push({ value: String(r.id), label: r.label });
			}
			f.options = opts;
		}
	}
	const outcomes = Array.isArray(o.outcomes) ? o.outcomes : [];
	for (let i = 0; i < outcomes.length; i++) {
		const oc = outcomes[i];
		if (!isObj(oc) || !Array.isArray(oc.actions)) continue;
		for (let j = 0; j < oc.actions.length; j++) {
			const a = oc.actions[j];
			if (!isObj(a)) continue;
			const path = `outcomes[${i}].actions[${j}]`;
			if (a.type === 'add_to_list' || a.type === 'add_topic') {
				const r = await listRef(db, a.list_id, a.type === 'add_topic');
				if (typeof r === 'string') add(`${path}.list_id`, r);
				else a.list_id = r.id;
			} else if (a.type === 'enroll_automation') {
				const r = await automationRef(db, a.automation_id);
				if (typeof r === 'string') add(`${path}.automation_id`, r);
				else a.automation_id = r;
			} else if (a.type === 'notify') {
				const r = userIdsArg(a.user_ids, userId);
				if (typeof r === 'string') add(`${path}.user_ids`, r);
				else a.user_ids = r;
			}
		}
	}
	if (isObj(o.settings) && o.settings.notify_user_ids !== undefined) {
		const r = userIdsArg(o.settings.notify_user_ids, userId);
		if (typeof r === 'string') add('settings.notify_user_ids', r);
		else o.settings.notify_user_ids = r;
	}
}

/** What the lenient read would drop without a word: say so instead, with the path. */
function structureProblems(o: Obj, pagesGiven: boolean, add: (path: string, message: string) => void): void {
	if (!Array.isArray(o.fields)) {
		add('fields', 'Give the form its questions: fields = [ … ].');
		return;
	}
	const fields = o.fields;
	fields.forEach((f, i) => {
		if (!isObj(f)) return add(`fields[${i}]`, 'Each field must be an object { type, label, … }.');
		if (!isFieldType(f.type)) return add(`fields[${i}].type`, `Unknown type “${String(f.type)}”. Use one of: ${FIELD_TYPE_KEYS.join(', ')}.`);
		if (f.map !== undefined && f.map !== null && !normalizeMap(f.map)) {
			add(`fields[${i}].map`, 'Not a mapping: use { to: contact, field } | { to: meta, key } | { to: tag, name? } | { to: tag_prefix, prefix } | { to: list | topic, list_id }.');
		}
		if (rulesDropped(f.show_when)) add(`fields[${i}].show_when`, RULE_HINT);
	});

	const pageIds = ['start', ...fields.filter((f) => isObj(f) && f.type === 'page_break').map((f) => (isObj(f) && typeof f.id === 'string' ? f.id.trim() : ''))];
	if (pagesGiven && o.pages !== undefined && o.pages !== null) {
		if (!Array.isArray(o.pages)) add('pages', 'pages must be a list: [{ id, next }].');
		else
			o.pages.forEach((p, i) => {
				if (!isObj(p)) return add(`pages[${i}]`, 'Each page must be an object { id, next }.');
				const id = typeof p.id === 'string' ? p.id.trim() : '';
				p.id = id;
				if (!id || !pageIds.includes(id)) add(`pages[${i}].id`, `No page “${id}”. Page 1 is "start"; a later page is the id of its page_break field.`);
				if (p.next === undefined || p.next === null) return;
				if (!Array.isArray(p.next)) return add(`pages[${i}].next`, 'next must be a list of { when, goto }.');
				p.next.forEach((j, k) => {
					if (!isObj(j)) return add(`pages[${i}].next[${k}]`, 'Each jump must be an object { when, goto }.');
					const goto = typeof j.goto === 'string' ? j.goto.trim() : '';
					if (goto !== JUMP_END && (!goto || !pageIds.includes(goto))) add(`pages[${i}].next[${k}].goto`, `No page “${goto}”. Use a later page_break id, or "end" to submit.`);
					if (rulesDropped(j.when)) add(`pages[${i}].next[${k}].when`, RULE_HINT);
				});
			});
	}

	if (o.outcomes !== undefined && o.outcomes !== null) {
		if (!Array.isArray(o.outcomes)) return add('outcomes', 'outcomes must be a list: [{ id, when, actions }].');
		o.outcomes.forEach((oc, i) => {
			if (!isObj(oc)) return add(`outcomes[${i}]`, 'Each outcome must be an object { id, when, actions }.');
			if (rulesDropped(oc.when)) add(`outcomes[${i}].when`, RULE_HINT);
			if (!Array.isArray(oc.actions)) return add(`outcomes[${i}].actions`, 'actions must be a list.');
			oc.actions.forEach((a, j) => {
				if (!actionKept(a)) {
					add(`outcomes[${i}].actions[${j}]`, `Not an action this form understands. Use one of: ${ACTION_TYPES.join(', ')}, each with its own fields.`);
				}
			});
		});
	}
}

/** Answer fields without a key get one from their label (unique in the form). */
function fillKeys(o: Obj): void {
	if (!Array.isArray(o.fields)) return;
	const used = new Set(o.fields.map((f) => (isObj(f) && typeof f.key === 'string' ? f.key.trim() : '')).filter(Boolean));
	for (const f of o.fields) {
		if (!isObj(f) || !isFieldType(f.type) || !isAnswerType(f.type)) continue;
		if (typeof f.key === 'string' && f.key.trim()) continue;
		const base = keyFromLabel(typeof f.label === 'string' ? f.label : '');
		if (!base) continue;
		let key = base;
		for (let n = 2; used.has(key); n++) key = `${base.slice(0, FORM_LIMITS.key - 4)}_${n}`;
		used.add(key);
		f.key = key;
	}
}

/** validateFormSpec names pages by their place in the derived list; point at the model's own entry instead. */
function rawPagePaths(problems: SpecProblem[], spec: FormSpec, rawPages: unknown): SpecProblem[] {
	if (!Array.isArray(rawPages)) return problems;
	return problems.map((p) => {
		const m = /^pages\[(\d+)\]/.exec(p.path);
		if (!m) return p;
		const id = spec.pages[Number(m[1])]?.id;
		const at = rawPages.findIndex((x) => isObj(x) && x.id === id);
		return at < 0 ? p : { ...p, path: p.path.replace(/^pages\[\d+\]/, `pages[${at}]`) };
	});
}

export type PreparedForm = { ok: true; spec: FormSpec; notes: string[] } | { ok: false; problems: SpecProblem[] };

/**
 * The model's spec (an object, or JSON text) → a FormSpec that saves, or every problem with
 * its path. `current` = the draft being edited: top-level keys the model leaves out keep the
 * form's own, and `settings` / `style` merge key by key. Allowed origins and the notify
 * webhook are always the form's own (none for a new form); a note says when the model tried.
 */
export async function prepareFormSpec(
	db: D1Database,
	raw: unknown,
	opts: { name: string; userId: number; current?: FormSpec | null }
): Promise<PreparedForm> {
	let src: unknown = raw;
	if (typeof raw === 'string') {
		try {
			src = JSON.parse(raw);
		} catch {
			src = null;
		}
	}
	if (!isObj(src)) return { ok: false, problems: [{ path: 'spec', message: 'Pass the form as an object: { title, fields, … }.' }] };

	const o = JSON.parse(JSON.stringify(src)) as Obj;
	const cur = opts.current ?? null;
	if (cur) {
		for (const k of ['title', 'intro_md', 'fields', 'pages', 'outcomes'] as const) if (!(k in o)) o[k] = JSON.parse(JSON.stringify(cur[k]));
		o.style = { ...cur.style, ...(isObj(o.style) ? o.style : {}) };
		o.settings = { ...cur.settings, ...(isObj(o.settings) ? o.settings : {}) };
	}
	if (typeof o.title !== 'string' || !o.title.trim()) o.title = opts.name;

	const problems: SpecProblem[] = [];
	const add = (path: string, message: string) => problems.push({ path, message });
	const name = opts.name.trim();
	if (!name) add('name', 'Give the form a name.');
	if (name.length > FORM_LIMITS.name) add('name', `Name is over ${FORM_LIMITS.name} characters.`);
	await resolveRefs(db, o, opts.userId, add);
	structureProblems(o, 'pages' in src, add);
	if (problems.length) return { ok: false, problems };

	fillKeys(o);
	const spec = normalizeFormSpec(o);
	// A newly chosen preset brings its colours, like the builder's preset picker (the form's own
	// preset sent back unchanged keeps any colours the user picked).
	if (isObj(src.style) && typeof src.style.preset === 'string' && src.style.preset !== cur?.style.preset) {
		spec.style = applyPreset(spec.style, src.style.preset);
	}

	const notes: string[] = [];
	const asked = isObj(src.settings) ? src.settings : {};
	const origins = cur?.settings.allowed_origins ?? [];
	const hook = cur?.settings.notify_webhook ?? '';
	const askedOrigins = Array.isArray(asked.allowed_origins) && asked.allowed_origins.some((x) => String(x ?? '').trim());
	if (askedOrigins && JSON.stringify(spec.settings.allowed_origins) !== JSON.stringify(origins)) {
		notes.push(
			cur
				? 'Allowed origins were kept as they are: the assistant can’t change them (Share & embed tab).'
				: 'Allowed origins were left out: the assistant can’t set them. Add them yourself on the Share & embed tab.'
		);
	}
	if (typeof asked.notify_webhook === 'string' && asked.notify_webhook.trim() && spec.settings.notify_webhook !== hook) {
		notes.push(
			cur
				? 'The notify webhook was kept as it is: the assistant can’t change it (Settings tab).'
				: 'The notify webhook was left out: the assistant can’t set it. Add it yourself on the Settings tab.'
		);
	}
	// #744: the daily send limit is the form's own too (a new draft gets the default).
	const sendCap = cur?.settings.daily_send_cap ?? defaultSettings().daily_send_cap;
	if (asked.daily_send_cap !== undefined && spec.settings.daily_send_cap !== sendCap) {
		notes.push('The daily send limit was kept as it is: the assistant can’t change it (Settings tab).');
	}
	spec.settings = { ...spec.settings, allowed_origins: [...origins], notify_webhook: hook, daily_send_cap: sendCap };

	const invalid = rawPagePaths(validateFormSpec(spec), spec, o.pages);
	if (invalid.length) return { ok: false, problems: invalid };
	return { ok: true, spec, notes };
}

export function problemLines(problems: SpecProblem[]): string {
	return problems.map((p) => `- ${p.path}: ${p.message}`).join('\n');
}

// ── A form in words (the action card, get_form) ──────────────────────────────────────────

type Refs = { lists: Map<number, string>; automations: Map<number, string> };

async function refNames(db: D1Database, spec: FormSpec): Promise<Refs> {
	const listIds = new Set<number>();
	const autoIds = new Set<number>();
	for (const f of spec.fields) {
		if (f.map && (f.map.to === 'list' || f.map.to === 'topic')) listIds.add(f.map.list_id);
		if (f.type === 'topics') for (const o of f.options) if (/^\d+$/.test(o.value)) listIds.add(Number(o.value));
	}
	for (const oc of spec.outcomes) {
		for (const a of oc.actions) {
			if (a.type === 'add_to_list' || a.type === 'add_topic') listIds.add(a.list_id);
			if (a.type === 'enroll_automation') autoIds.add(a.automation_id);
		}
	}
	const names = async (table: 'lists' | 'automations', ids: Set<number>): Promise<Map<number, string>> => {
		const list = [...ids].slice(0, 50);
		if (!list.length) return new Map();
		const rows = await db
			.prepare(`SELECT id, name FROM ${table} WHERE id IN (${list.map(() => '?').join(', ')})`)
			.bind(...list)
			.all<{ id: number; name: string }>();
		return new Map(rows.results.map((r) => [r.id, r.name]));
	};
	return { lists: await names('lists', listIds), automations: await names('automations', autoIds) };
}

const q = (s: string) => `“${s}”`;
const clip = (s: string, n = 60) => {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function mapText(m: FieldMap, refs: Refs): string {
	switch (m.to) {
		case 'contact':
			return `contact ${CONTACT_FIELD_LABELS[m.field].toLowerCase()}`;
		case 'meta':
			return `custom field ${q(m.key)}`;
		case 'tag':
			return m.name ? `tag ${q(m.name)}` : 'tags (the chosen options)';
		case 'tag_prefix':
			return `tags ${q(`${m.prefix}<option>`)}`;
		case 'list':
			return `list ${q(refs.lists.get(m.list_id) ?? `#${m.list_id}`)}`;
		case 'topic':
			return `topic ${q(refs.lists.get(m.list_id) ?? `#${m.list_id}`)}`;
	}
}

function actionText(a: FormAction, refs: Refs): string {
	switch (a.type) {
		case 'add_tag':
			return `add tag ${q(a.tag)}`;
		case 'remove_tag':
			return `remove tag ${q(a.tag)}`;
		case 'add_to_list':
			return `add to list ${q(refs.lists.get(a.list_id) ?? `#${a.list_id}`)}`;
		case 'add_topic':
			return `opt in to topic ${q(refs.lists.get(a.list_id) ?? `#${a.list_id}`)}`;
		case 'set_field':
			return `set ${q(a.key)} to ${q(a.value)}`;
		case 'set_source':
			return `set source ${q(a.source)}`;
		case 'enroll_automation':
			return `enroll in automation ${q(refs.automations.get(a.automation_id) ?? `#${a.automation_id}`)}`;
		case 'notify':
			return `notify ${plural(a.user_ids.length, 'person', 'people')}`;
		case 'message_md':
			return `show the message ${q(clip(a.md))}`;
		case 'redirect':
			return `go to ${a.url}`;
	}
}

/** A rule field in words: the question's label, or what it reads about the contact. */
function ruleLabeler(spec: FormSpec): (field: string) => string {
	const byKey = new Map(spec.fields.filter((f) => f.key).map((f) => [f.key, clip(f.label || f.key, 40)]));
	return (field) => {
		if (field === CONTACT_TAG_FIELD) return 'Contact tag';
		if (field === CONTACT_LIST_FIELD) return 'Contact list';
		if (field.startsWith(CONTACT_META_PREFIX)) return `Contact field ${q(field.slice(CONTACT_META_PREFIX.length))}`;
		return byKey.get(field) ?? field;
	};
}

/** "3 questions · 2 pages · 2 conditional outcomes" */
export function formCounts(spec: FormSpec): string {
	const questions = spec.fields.filter((f) => isAnswerType(f.type)).length;
	const parts = [plural(questions, 'question')];
	if (spec.pages.length > 1) parts.push(plural(spec.pages.length, 'page'));
	const conditional = spec.outcomes.filter((o) => o.when).length;
	if (conditional) parts.push(plural(conditional, 'conditional outcome'));
	return parts.join(' · ');
}

/**
 * The form in words, one line each: pages, numbered questions (type, required, options,
 * where the answer goes), show rules ("Show “Platform” when Role is not “Developer”"), page
 * jumps, outcomes and the settings that matter.
 */
export async function formOutline(db: D1Database, spec: FormSpec): Promise<string[]> {
	const refs = await refNames(db, spec);
	const label = ruleLabeler(spec);
	const lines: string[] = [];
	let page = 0;
	let n = 0;
	const jumps = (i: number) => {
		for (const j of spec.pages[i]?.next ?? []) lines.push(`   After this page, go to ${pageLabel(spec.pages, j.goto) || j.goto} when ${ruleSetText(j.when, label)}`);
	};
	if (spec.pages.length > 1) lines.push(pageLabel(spec.pages, 'start'));
	for (const f of spec.fields) {
		if (f.type === 'page_break') {
			jumps(page);
			page++;
			lines.push(pageLabel(spec.pages, f.id) || `Page ${page + 1}`);
			continue;
		}
		if (f.type === 'heading') lines.push(`Heading ${q(clip(f.label))}`);
		else if (f.type === 'paragraph') lines.push(`Text ${q(clip(f.label))}`);
		else {
			n++;
			const bits = [fieldTypeInfo(f.type)?.label ?? f.type];
			if (f.required) bits.push('required');
			let line = `${n}. ${q(clip(f.label || f.key))} (${bits.join(', ')})`;
			if (f.type === 'topics') line += `: ${f.options.map((o) => refs.lists.get(Number(o.value)) ?? o.label).join(' / ')}`;
			else if (f.options.length) {
				line += `: ${f.options.slice(0, 6).map((o) => o.label || o.value).join(' / ')}${f.options.length > 6 ? ` +${f.options.length - 6} more` : ''}`;
			}
			if (f.type === 'rating') {
				const r = ratingOf(f);
				line += `: ${r.style} ${r.min}–${r.max}`;
			}
			if (f.map) line += ` → ${mapText(f.map, refs)}`;
			lines.push(line);
		}
		if (f.show_when) lines.push(`   Show ${q(clip(f.label || f.key, 40))} when ${ruleSetText(f.show_when, label)}`);
	}
	jumps(page);

	for (const oc of spec.outcomes) {
		const what = oc.actions.length ? oc.actions.map((a) => actionText(a, refs)).join(', ') : 'nothing';
		lines.push(oc.when ? `When ${ruleSetText(oc.when, label)}: ${what}` : `Every submission: ${what}`);
	}
	if (spec.settings.outcomes_mode === 'first' && spec.outcomes.some((o) => o.when)) lines.push('Only the first matching outcome runs.');

	const s = spec.settings;
	const bits = [`button ${q(s.submit_label)}`];
	if (s.double_optin) bits.push('double opt-in');
	if (s.allow_anonymous) bits.push('anonymous submissions allowed');
	if (s.enroll) bits.push('starts automations');
	if (s.notify_user_ids.length) bits.push(`emails ${plural(s.notify_user_ids.length, 'person', 'people')} on each submission`);
	bits.push(`keeps submissions ${s.retention_days} days`);
	if (spec.style.preset !== 'feedback') bits.push(`style ${spec.style.preset}`);
	lines.push(`Settings: ${bits.join(', ')}`);
	return lines;
}
