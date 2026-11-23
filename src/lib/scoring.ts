// Contact scoring (#466, epic #465) — universal (client + server): the event catalogue,
// limits, validation, bands and the words the UI uses. Storage and the engine live in
// src/lib/server/scoring/ (store.ts, engine.ts, contact.ts).
//
// A score is a set of point rules. `event` rules award points for each matching source
// row (an open, a click, a reply, …) and are recorded in the `score_points` ledger;
// `condition` rules hold points while the contact matches a segment rule set. A score's
// value is the sum of its unexpired ledger rows — or, in half-life mode, each row decayed
// by 0.5^(age / half-life). Engagement (the hot/warm/cool tier, #111) is separate.

import { RULE_KINDS, normalizeRuleSet, ruleSetProblem, type ConditionRuleSet } from '$lib/condition-rules';
import {
	RULE_OPS as FORM_RULE_OPS,
	RULE_OP_LABELS as FORM_RULE_OP_LABELS,
	UNARY_OPS as FORM_UNARY_OPS,
	type FormRule,
	type FormRuleOp,
	type FormRuleSet
} from '$lib/form-logic';

/** Condition rules use the segment builder's vocabulary (no automation-only kinds, and no
 *  score kinds — a score can't be made of scores, #467). */
export const CONDITION_FIELDS: string[] = [
	...new Set(RULE_KINDS.filter((k) => k.only !== 'automation' && k.group !== 'Scores').map((k) => k.field))
];

export const SCORE_LIMITS = {
	maxScores: 50,
	maxRules: 30,
	minPoints: -1000,
	maxPoints: 1000,
	minExpiryDays: 1,
	maxExpiryDays: 3650,
	maxPerDay: 1000,
	minHalfLife: 1,
	maxHalfLife: 3650,
	maxBands: 10,
	nameMax: 60,
	descriptionMax: 300,
	labelMax: 80,
	bandLabelMax: 30,
	filterTextMax: 200,
	/** #621: answer conditions on a CRM form rule. */
	maxAnswerRules: 10
} as const;

export type DecayMode = 'none' | 'expire' | 'half_life';
export const DECAY_MODES: DecayMode[] = ['expire', 'half_life', 'none'];
export const DECAY_LABELS: Record<DecayMode, string> = {
	expire: 'Points expire per rule',
	half_life: 'Half-life decay',
	none: 'Permanent'
};
/** One sentence per mode, shown at the top of the editor. */
export const DECAY_HELP: Record<DecayMode, string> = {
	expire: 'Each event rule can give its points an expiry (e.g. 30 days); expired points stop counting. Rules without an expiry are permanent.',
	half_life: 'Every point fades smoothly: after the half-life a point counts half, after two half-lives a quarter. Expiry days are ignored.',
	none: 'Points never expire or fade; the score only moves when new points are earned or a condition stops matching.'
};

export type ScoreStatus = 'active' | 'paused';
export type Band = { label: string; min: number };

/** Where an event rule's rows come from — also `score_points.source_type`. */
export type SourceTable =
	| 'events'
	| 'replies'
	| 'webhook_events'
	| 'form_submissions'
	| 'site_events'
	| 'pipeline_history'
	| 'automation_enrollment_events'
	| 'list_members';
export const SOURCE_TABLES: SourceTable[] = [
	'events',
	'replies',
	'webhook_events',
	'form_submissions',
	'site_events',
	'pipeline_history',
	'automation_enrollment_events',
	'list_members'
];

export type FilterKey =
	| 'campaign_id'
	| 'automation_id'
	| 'url_contains'
	| 'any'
	| 'key_id'
	| 'name'
	| 'stage_id'
	| 'pipeline_id'
	| 'list_id'
	| 'form_id'
	| 'answers';

export type RuleFilter = {
	campaign_id?: number;
	automation_id?: number;
	url_contains?: string;
	any?: boolean;
	key_id?: number;
	name?: string;
	stage_id?: number;
	pipeline_id?: number;
	list_id?: number;
	/** #621: a CRM form (`forms.id`); unset = any CRM form. */
	form_id?: number;
	/** #621: conditions on the submission's answers (form-logic rules); only with `form_id`. */
	answers?: FormRuleSet;
};

export const FILTER_LABELS: Record<FilterKey, string> = {
	campaign_id: 'Campaign',
	automation_id: 'Automation',
	url_contains: 'URL contains',
	any: 'Any bounce (not just hard)',
	key_id: 'Form (webhook key)',
	name: 'Event name',
	stage_id: 'Stage',
	pipeline_id: 'Pipeline',
	list_id: 'List, segment or tag',
	form_id: 'Form',
	answers: 'Answers'
};

const ID_KEYS: FilterKey[] = ['campaign_id', 'automation_id', 'key_id', 'stage_id', 'pipeline_id', 'list_id', 'form_id'];
const TEXT_KEYS: FilterKey[] = ['url_contains', 'name'];

export type EventType =
	| 'email_open'
	| 'email_open_proxy'
	| 'email_click'
	| 'email_bounce'
	| 'email_spam'
	| 'unsubscribe'
	| 'email_reply'
	| 'form_submit'
	| 'crm_form_submit'
	| 'site_pageview'
	| 'site_event'
	| 'pipeline_stage_entered'
	| 'automation_completed'
	| 'list_added';

export type EventTypeDef = { type: EventType; label: string; source: SourceTable; filters: FilterKey[] };

export const EVENT_TYPES: EventTypeDef[] = [
	{ type: 'email_open', label: 'Opened an email', source: 'events', filters: ['campaign_id', 'automation_id'] },
	{ type: 'email_open_proxy', label: 'Auto-open (Apple Mail / prefetch)', source: 'events', filters: ['campaign_id', 'automation_id'] },
	{ type: 'email_click', label: 'Clicked a link in an email', source: 'events', filters: ['campaign_id', 'automation_id', 'url_contains'] },
	{ type: 'email_bounce', label: 'Bounced', source: 'events', filters: ['any'] },
	{ type: 'email_spam', label: 'Marked an email as spam', source: 'events', filters: [] },
	{ type: 'unsubscribe', label: 'Unsubscribed', source: 'events', filters: [] },
	{ type: 'email_reply', label: 'Replied to an email', source: 'replies', filters: [] },
	{ type: 'form_submit', label: 'Submitted an external form (webhook)', source: 'webhook_events', filters: ['key_id'] },
	{ type: 'crm_form_submit', label: 'Submitted a CRM form', source: 'form_submissions', filters: ['form_id', 'answers'] },
	{ type: 'site_pageview', label: 'Viewed a page on the site', source: 'site_events', filters: ['url_contains'] },
	{ type: 'site_event', label: 'Did a site event', source: 'site_events', filters: ['name'] },
	{ type: 'pipeline_stage_entered', label: 'Entered a pipeline stage', source: 'pipeline_history', filters: ['stage_id', 'pipeline_id'] },
	{ type: 'automation_completed', label: 'Completed an automation', source: 'automation_enrollment_events', filters: ['automation_id'] },
	{ type: 'list_added', label: 'Added to a list, segment or tag', source: 'list_members', filters: ['list_id'] }
];

export function eventTypeDef(type: string | null | undefined): EventTypeDef | null {
	return EVENT_TYPES.find((e) => e.type === type) ?? null;
}

export function eventTypeLabel(type: string | null | undefined): string {
	return eventTypeDef(type)?.label ?? String(type ?? '');
}

/** `score_points.source_type` in words, for the contact page history. */
export const SOURCE_LABELS: Record<string, string> = {
	events: 'Email event',
	replies: 'Reply',
	webhook_events: 'Form submit',
	form_submissions: 'Form submission',
	site_events: 'Site activity',
	pipeline_history: 'Pipeline move',
	automation_enrollment_events: 'Automation',
	list_members: 'Added to group',
	condition: 'Matches a condition',
	manual: 'Manual adjustment',
	automation: 'Set by an automation'
};

export function sourceText(sourceType: string): string {
	return SOURCE_LABELS[sourceType] ?? sourceType;
}

/** "points expire per rule" / "half-life 60 days" / "permanent". */
export function decayText(mode: DecayMode, halfLifeDays: number | null | undefined): string {
	if (mode === 'half_life') return `half-life ${halfLifeDays ?? '?'} day${halfLifeDays === 1 ? '' : 's'}`;
	if (mode === 'expire') return 'points expire per rule';
	return 'permanent';
}

/** Name → URL-safe slug (lowercase, a–z 0–9 and dashes, ≤ 48). */
export function slugify(name: string): string {
	return (
		name
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48)
			.replace(/-+$/g, '') || 'score'
	);
}

/** The band a value falls in: the first (highest) band whose `min` it reaches, else null. */
export function bandFor(value: number, bands: Band[] | null | undefined): string | null {
	if (!bands?.length) return null;
	const sorted = [...bands].sort((a, b) => b.min - a.min);
	for (const b of sorted) if (value >= b.min) return b.label;
	return null;
}

/** Stored bands JSON → sorted list (highest min first); junk → []. */
export function parseBands(raw: string | null | undefined): Band[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v
			.filter((b) => b && typeof b.label === 'string' && Number.isFinite(Number(b.min)))
			.map((b) => ({ label: String(b.label), min: Math.trunc(Number(b.min)) }))
			.sort((a, b) => b.min - a.min);
	} catch {
		return [];
	}
}

export function parseFilter(raw: string | null | undefined): RuleFilter {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as RuleFilter) : {};
	} catch {
		return {};
	}
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function intIn(raw: unknown, min: number, max: number): number | null {
	if (raw === null || raw === undefined || raw === '') return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) return NaN;
	return n;
}

export type ScoreInput = {
	name: string;
	description: string;
	status: ScoreStatus;
	decay_mode: DecayMode;
	half_life_days: number | null;
	bands: Band[];
};

/** Untrusted score fields (form values) → a clean score, or the first problem. */
export function validateScore(raw: {
	name?: unknown;
	description?: unknown;
	status?: unknown;
	decay_mode?: unknown;
	half_life_days?: unknown;
	bands?: unknown;
}): Result<ScoreInput> {
	const name = String(raw.name ?? '').trim();
	if (!name) return { ok: false, error: 'Give the score a name.' };
	if (name.length > SCORE_LIMITS.nameMax) return { ok: false, error: `Name: at most ${SCORE_LIMITS.nameMax} characters.` };
	const description = String(raw.description ?? '').trim();
	if (description.length > SCORE_LIMITS.descriptionMax)
		return { ok: false, error: `Description: at most ${SCORE_LIMITS.descriptionMax} characters.` };
	const status: ScoreStatus = raw.status === 'paused' ? 'paused' : 'active';
	const decay_mode = String(raw.decay_mode ?? 'expire') as DecayMode;
	if (!DECAY_MODES.includes(decay_mode)) return { ok: false, error: 'Pick a decay mode.' };
	let half_life_days: number | null = null;
	if (decay_mode === 'half_life') {
		const h = intIn(raw.half_life_days, SCORE_LIMITS.minHalfLife, SCORE_LIMITS.maxHalfLife);
		if (h === null || Number.isNaN(h))
			return { ok: false, error: `Half-life: a whole number of days, ${SCORE_LIMITS.minHalfLife}–${SCORE_LIMITS.maxHalfLife}.` };
		half_life_days = h;
	}
	let bandsRaw: unknown = raw.bands ?? [];
	if (typeof bandsRaw === 'string') {
		try {
			bandsRaw = bandsRaw.trim() ? JSON.parse(bandsRaw) : [];
		} catch {
			return { ok: false, error: 'Bands are not valid.' };
		}
	}
	if (!Array.isArray(bandsRaw)) return { ok: false, error: 'Bands are not valid.' };
	if (bandsRaw.length > SCORE_LIMITS.maxBands) return { ok: false, error: `At most ${SCORE_LIMITS.maxBands} bands.` };
	const bands: Band[] = [];
	for (const [i, b] of bandsRaw.entries()) {
		const label = String((b as Band)?.label ?? '').trim();
		if (!label) return { ok: false, error: `Band ${i + 1} needs a label.` };
		if (label.length > SCORE_LIMITS.bandLabelMax)
			return { ok: false, error: `Band labels: at most ${SCORE_LIMITS.bandLabelMax} characters.` };
		const min = Number((b as Band)?.min);
		if (!Number.isInteger(min) || Math.abs(min) > 1_000_000) return { ok: false, error: `Band “${label}” needs a whole-number minimum.` };
		if (bands.some((x) => x.min === min)) return { ok: false, error: 'Two bands have the same minimum.' };
		if (bands.some((x) => x.label.toLowerCase() === label.toLowerCase())) return { ok: false, error: 'Two bands have the same label.' };
		bands.push({ label, min });
	}
	bands.sort((a, b) => b.min - a.min);
	return { ok: true, value: { name, description, status, decay_mode, half_life_days, bands } };
}

export type RuleKindName = 'event' | 'condition';

export type RuleInput = {
	kind: RuleKindName;
	label: string;
	event_type: EventType | null;
	filter: RuleFilter | null;
	rules: ConditionRuleSet | null;
	points: number;
	expires_days: number | null;
	max_per_day: number | null;
	once: boolean;
	active: boolean;
};

/** Untrusted rule fields → a clean rule, or the first problem. `decayMode` drops the expiry
 *  outside `expire` mode (it would never apply). */
export function validateRule(
	raw: {
		kind?: unknown;
		label?: unknown;
		event_type?: unknown;
		filter?: unknown;
		rules?: unknown;
		points?: unknown;
		expires_days?: unknown;
		max_per_day?: unknown;
		once?: unknown;
		active?: unknown;
	},
	decayMode: DecayMode = 'expire'
): Result<RuleInput> {
	const kind = raw.kind === 'condition' ? 'condition' : raw.kind === 'event' ? 'event' : null;
	if (!kind) return { ok: false, error: 'Pick an event or a condition rule.' };
	const label = String(raw.label ?? '').trim();
	if (label.length > SCORE_LIMITS.labelMax) return { ok: false, error: `Label: at most ${SCORE_LIMITS.labelMax} characters.` };
	const points = Number(raw.points);
	if (raw.points === '' || raw.points == null || !Number.isInteger(points) || points < SCORE_LIMITS.minPoints || points > SCORE_LIMITS.maxPoints)
		return { ok: false, error: `Points: a whole number from ${SCORE_LIMITS.minPoints} to ${SCORE_LIMITS.maxPoints}.` };
	if (points === 0) return { ok: false, error: 'Points can’t be 0.' };
	const active = raw.active === undefined ? true : raw.active === true || raw.active === '1' || raw.active === 'on' || raw.active === 1;

	if (kind === 'condition') {
		let set: unknown = raw.rules;
		if (typeof set === 'string') {
			try {
				set = JSON.parse(set);
			} catch {
				return { ok: false, error: 'The condition is not valid.' };
			}
		}
		const rules = normalizeRuleSet(set);
		const problem = ruleSetProblem(rules);
		if (problem) return { ok: false, error: problem };
		const bad = rules!.rules.find((r) => !CONDITION_FIELDS.includes(r.field));
		if (bad) return { ok: false, error: `“${bad.field}” can't be used in a score condition.` };
		return {
			ok: true,
			value: { kind, label, event_type: null, filter: null, rules, points, expires_days: null, max_per_day: null, once: false, active }
		};
	}

	const def = eventTypeDef(String(raw.event_type ?? ''));
	if (!def) return { ok: false, error: 'Pick an event.' };
	let f: unknown = raw.filter ?? {};
	if (typeof f === 'string') {
		try {
			f = f.trim() ? JSON.parse(f) : {};
		} catch {
			return { ok: false, error: 'The filter is not valid.' };
		}
	}
	if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: 'The filter is not valid.' };
	const filter: RuleFilter = {};
	for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
		if (v === null || v === undefined || v === '' || v === false) continue;
		const key = k as FilterKey;
		if (!def.filters.includes(key)) return { ok: false, error: `“${def.label}” can't be filtered by ${k}.` };
		if (ID_KEYS.includes(key)) {
			const n = Number(v);
			if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${FILTER_LABELS[key]}: pick one from the list.` };
			(filter as Record<string, unknown>)[key] = n;
		} else if (TEXT_KEYS.includes(key)) {
			const s = String(v).trim();
			if (s.length > SCORE_LIMITS.filterTextMax)
				return { ok: false, error: `${FILTER_LABELS[key]}: at most ${SCORE_LIMITS.filterTextMax} characters.` };
			if (s) (filter as Record<string, unknown>)[key] = s;
		} else if (key === 'answers') {
			const a = answerRuleSet(v);
			if (!a.ok) return a;
			if (a.value) filter.answers = a.value;
		} else if (key === 'any') {
			filter.any = v === true || v === '1' || v === 'on' || v === 1 || v === 'true';
			if (!filter.any) delete filter.any;
		}
	}
	if (filter.answers && filter.form_id == null) return { ok: false, error: 'Answer conditions need one form picked.' };
	let expires_days: number | null = null;
	if (decayMode === 'expire') {
		const e = intIn(raw.expires_days, SCORE_LIMITS.minExpiryDays, SCORE_LIMITS.maxExpiryDays);
		if (Number.isNaN(e))
			return { ok: false, error: `Expiry: ${SCORE_LIMITS.minExpiryDays}–${SCORE_LIMITS.maxExpiryDays} days, or blank for permanent.` };
		expires_days = e;
	}
	const m = intIn(raw.max_per_day, 1, SCORE_LIMITS.maxPerDay);
	if (Number.isNaN(m)) return { ok: false, error: `Max per day: 1–${SCORE_LIMITS.maxPerDay}, or blank for no limit.` };
	const once = raw.once === true || raw.once === '1' || raw.once === 'on' || raw.once === 1;
	return {
		ok: true,
		value: {
			kind,
			label,
			event_type: def.type,
			filter: Object.keys(filter).length ? filter : null,
			rules: null,
			points,
			expires_days,
			max_per_day: m,
			once,
			active
		}
	};
}

/** A rule's title when it has no label: "Opened an email" / "Matches 2 conditions". */
export function ruleTitle(r: { label?: string | null; kind: string; event_type?: string | null; rules?: string | ConditionRuleSet | null }): string {
	if (r.label) return r.label;
	if (r.kind === 'event') return eventTypeLabel(r.event_type);
	const set = typeof r.rules === 'string' ? normalizeRuleSet(safeJson(r.rules)) : r.rules;
	const n = set?.rules.length ?? 0;
	return n === 1 ? 'Matches a condition' : `Matches ${n} conditions`;
}

function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** "+5" / "−10". */
export function pointsText(n: number): string {
	return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

export type AdjustInput = { points: number; expires_days: number | null; note: string };

/** The contact page's "Adjust" form: ± points, optional expiry, optional note. */
export function validateAdjust(raw: { points?: unknown; expires_days?: unknown; note?: unknown }): Result<AdjustInput> {
	const p = String(raw.points ?? '').trim().replace('−', '-');
	const points = Number(p);
	if (!p || !Number.isInteger(points) || points < SCORE_LIMITS.minPoints || points > SCORE_LIMITS.maxPoints || points === 0)
		return { ok: false, error: `Points: a whole number from ${SCORE_LIMITS.minPoints} to ${SCORE_LIMITS.maxPoints}, not 0.` };
	const e = intIn(String(raw.expires_days ?? '').trim(), SCORE_LIMITS.minExpiryDays, SCORE_LIMITS.maxExpiryDays);
	if (Number.isNaN(e))
		return { ok: false, error: `Expiry: ${SCORE_LIMITS.minExpiryDays}–${SCORE_LIMITS.maxExpiryDays} days, or blank for never.` };
	const note = String(raw.note ?? '').trim();
	if (note.length > 200) return { ok: false, error: 'Note: at most 200 characters.' };
	return { ok: true, value: { points, expires_days: e, note } };
}

// ---------------------------------------------------------------------------
// #621: answer conditions on a "Submitted a CRM form" rule — form-logic rules ($lib/form-logic)
// evaluated against the submission's `answers` JSON by the engine.
// ---------------------------------------------------------------------------

/** A question as the rule editor and the words below see it. */
export type AnswerQuestion = { key: string; label: string; type: string; options: { value: string; label: string }[] };

/** Number comparisons (number and rating questions). */
export const NUMBER_ANSWER_OPS: FormRuleOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'not_empty', 'empty'];

/** The comparisons the rule editor offers for a question type. */
export function answerOpsFor(type: string): FormRuleOp[] {
	if (type === 'number' || type === 'rating') return NUMBER_ANSWER_OPS;
	if (type === 'checkbox' || type === 'consent') return ['checked', 'unchecked'];
	if (type === 'select' || type === 'radio') return ['eq', 'neq', 'in', 'not_empty', 'empty'];
	if (type === 'checkboxes' || type === 'topics') return ['contains', 'in', 'not_empty', 'empty'];
	return ['eq', 'neq', 'contains', 'not_empty', 'empty'];
}

/** Untrusted answer conditions (object or JSON) → a clean rule set, null for none, or the problem. */
export function answerRuleSet(raw: unknown): Result<FormRuleSet | null> {
	let v: unknown = raw;
	if (typeof v === 'string') {
		if (!v.trim()) return { ok: true, value: null };
		try {
			v = JSON.parse(v);
		} catch {
			return { ok: false, error: 'The answer conditions are not valid.' };
		}
	}
	if (v === null || v === undefined) return { ok: true, value: null };
	if (typeof v !== 'object' || Array.isArray(v) || !Array.isArray((v as { rules?: unknown }).rules))
		return { ok: false, error: 'The answer conditions are not valid.' };
	const set = v as { match?: unknown; rules: unknown[] };
	if (!set.rules.length) return { ok: true, value: null };
	if (set.rules.length > SCORE_LIMITS.maxAnswerRules)
		return { ok: false, error: `At most ${SCORE_LIMITS.maxAnswerRules} answer conditions.` };
	const rules: FormRule[] = [];
	for (const [i, x] of set.rules.entries()) {
		const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
		const field = typeof o.field === 'string' ? o.field.trim() : '';
		if (!field || field.length > 80 || field.startsWith('contact:'))
			return { ok: false, error: `Answer condition ${i + 1}: pick a question.` };
		if (!(FORM_RULE_OPS as readonly unknown[]).includes(o.op))
			return { ok: false, error: `Answer condition ${i + 1}: pick a comparison.` };
		const op = o.op as FormRuleOp;
		const rule: FormRule = { field, op };
		if (!FORM_UNARY_OPS.includes(op)) {
			let value: string | number | string[];
			if (Array.isArray(o.value)) value = o.value.map((s) => String(s).trim().slice(0, 200)).filter(Boolean).slice(0, 50);
			else if (typeof o.value === 'number' && Number.isFinite(o.value)) value = o.value;
			else value = String(o.value ?? '').trim().slice(0, 200);
			if (value === '' || (Array.isArray(value) && !value.length))
				return { ok: false, error: `Answer condition ${i + 1}: enter a value.` };
			if (['gt', 'gte', 'lt', 'lte'].includes(op) && (Array.isArray(value) || !Number.isFinite(Number(value))))
				return { ok: false, error: `Answer condition ${i + 1}: enter a number.` };
			rule.value = value;
		}
		rules.push(rule);
	}
	return { ok: true, value: { match: set.match === 'any' ? 'any' : 'all', rules } };
}

/** One answer condition in words: `“Role” is “Owner”`. Unknown questions show their key. */
export function answerRuleText(rule: FormRule, questions: AnswerQuestion[] = []): string {
	const q = questions.find((x) => x.key === rule.field);
	const name = `“${q?.label || rule.field}”`;
	const op = FORM_RULE_OP_LABELS[rule.op] ?? rule.op;
	if (FORM_UNARY_OPS.includes(rule.op)) return `${name} ${op}`;
	const show = (v: string | number) => `“${q?.options.find((o) => o.value === String(v))?.label ?? String(v)}”`;
	const vals = Array.isArray(rule.value) ? rule.value : String(rule.value ?? '').includes(',') && rule.op === 'in' ? String(rule.value).split(',').map((s) => s.trim()) : [rule.value ?? ''];
	return `${name} ${op} ${vals.map(show).join(', ')}`;
}

/** A whole answer rule set in words; '' for none. */
export function answerRulesText(set: FormRuleSet | null | undefined, questions: AnswerQuestion[] = []): string {
	if (!set?.rules.length) return '';
	return set.rules.map((r) => answerRuleText(r, questions)).join(set.match === 'any' ? ' or ' : ' and ');
}

/** A form's answer questions, for the rule editor and the words above. */
export function answerQuestions(fields: { key: string; label: string; type: string; options?: { value: string; label: string }[] }[]): AnswerQuestion[] {
	const skip = new Set(['heading', 'paragraph', 'page_break']);
	return fields
		.filter((f) => f.key && !skip.has(f.type))
		.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type, options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })) }));
}
