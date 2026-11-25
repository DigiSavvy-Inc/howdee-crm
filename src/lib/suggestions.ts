// Suggestions (#711 / #712) — the vocabulary shared by the server rules, the settings page
// (#715), the panel (#714) and the API (#716). Universal: no server imports.
//
// Spec and user guide: docs/suggestions.md. Every threshold below has a default and an
// allowed range; `normalizeSuggestionsConfig` reads leniently (junk → defaults, numbers
// clamped), `suggestionsConfigProblems` is the strict save check.

export type SuggestionKind = 'follow_up' | 'campaign' | 'marketing';
export const SUGGESTION_KINDS: SuggestionKind[] = ['follow_up', 'campaign', 'marketing'];
export const KIND_LABELS: Record<SuggestionKind, string> = {
	follow_up: 'Follow up',
	campaign: 'Campaign',
	marketing: 'Try something else'
};

export type SubjectType = 'contact' | 'company' | 'deal' | 'group';
export type SuggestionStatus = 'open' | 'done' | 'dismissed' | 'snoozed';
export const SUGGESTION_STATUSES: SuggestionStatus[] = ['open', 'done', 'dismissed', 'snoozed'];

export type RuleKey =
	| 'awaiting_reply'
	| 'quiet_after_reply'
	| 'hot_engagement'
	| 'form_no_followup'
	| 'stalled_deal'
	| 'group_unmailed'
	| 'cold_members';

/** Rules in the order a pass runs them (and the panel's no-AI order: follow-ups first). */
export const RULE_KEYS: RuleKey[] = [
	'awaiting_reply',
	'quiet_after_reply',
	'hot_engagement',
	'form_no_followup',
	'stalled_deal',
	'group_unmailed',
	'cold_members'
];

export const RULE_KIND: Record<RuleKey, SuggestionKind> = {
	awaiting_reply: 'follow_up',
	quiet_after_reply: 'follow_up',
	hot_engagement: 'follow_up',
	form_no_followup: 'follow_up',
	stalled_deal: 'follow_up',
	group_unmailed: 'campaign',
	cold_members: 'marketing'
};

export const RULE_LABELS: Record<RuleKey, string> = {
	awaiting_reply: 'Awaiting our reply',
	quiet_after_reply: 'Gone quiet after replying',
	hot_engagement: 'Warming up',
	form_no_followup: 'Form with no follow-up',
	stalled_deal: 'Stalled deal',
	group_unmailed: 'Group not mailed',
	cold_members: 'Cold group'
};

/** A rule's number settings: default and allowed range (inclusive, whole numbers). */
export type ThresholdSpec = { key: string; label: string; default: number; min: number; max: number };

export const RULE_THRESHOLDS: Record<RuleKey, ThresholdSpec[]> = {
	awaiting_reply: [{ key: 'hours', label: 'Waiting longer than (hours)', default: 48, min: 1, max: 720 }],
	quiet_after_reply: [{ key: 'days', label: 'Quiet for (days)', default: 14, min: 3, max: 180 }],
	hot_engagement: [
		{ key: 'points', label: 'Score up by (points, 7 days)', default: 10, min: 1, max: 1000 },
		{ key: 'clicks', label: 'Campaign clicks (14 days)', default: 2, min: 1, max: 50 },
		{ key: 'visit_days', label: 'Days with site visits (7 days)', default: 2, min: 2, max: 14 },
		{ key: 'quiet_days', label: 'No personal email in (days)', default: 30, min: 1, max: 365 }
	],
	form_no_followup: [{ key: 'days', label: 'No personal email within (days)', default: 3, min: 1, max: 30 }],
	stalled_deal: [{ key: 'days', label: 'Same stage longer than (days)', default: 21, min: 3, max: 365 }],
	group_unmailed: [
		{ key: 'min_members', label: 'At least (active members)', default: 25, min: 1, max: 100_000 },
		{ key: 'days', label: 'No campaign in (days)', default: 30, min: 7, max: 365 }
	],
	cold_members: [{ key: 'campaigns', label: 'Last campaigns looked at', default: 5, min: 2, max: 20 }]
};

/** Fixed windows (not settings). */
export const HOT_SCORE_WINDOW_DAYS = 7;
export const HOT_CLICK_WINDOW_DAYS = 14;
export const HOT_VISIT_WINDOW_DAYS = 7;
export const FORM_LOOKBACK_DAYS = 14;

export const GENERAL_LIMITS = {
	cooldown_days: { default: 30, min: 1, max: 365 },
	daily_cap: { default: 25, min: 1, max: 200 }
} as const;

export type RuleConfig = { on: boolean } & Record<string, number | boolean>;

export type SuggestionsConfig = {
	enabled: boolean;
	kinds: Record<SuggestionKind, boolean>;
	rules: Record<RuleKey, RuleConfig>;
	/** Score the `hot_engagement` rule watches; null = the built-in Lead score (slug `lead-score`). */
	score_id: number | null;
	cooldown_days: number;
	/** Who gets suggestions: admins only (default) or everyone. */
	audience: 'admins' | 'everyone';
	daily_cap: number;
	use_ai: boolean;
};

export function defaultSuggestionsConfig(): SuggestionsConfig {
	const rules = {} as Record<RuleKey, RuleConfig>;
	for (const r of RULE_KEYS) {
		const rc: RuleConfig = { on: true };
		for (const t of RULE_THRESHOLDS[r]) rc[t.key] = t.default;
		rules[r] = rc;
	}
	return {
		enabled: false,
		kinds: { follow_up: true, campaign: true, marketing: true },
		rules,
		score_id: null,
		cooldown_days: GENERAL_LIMITS.cooldown_days.default,
		audience: 'admins',
		daily_cap: GENERAL_LIMITS.daily_cap.default,
		use_ai: true
	};
}

function clampInt(v: unknown, d: number, min: number, max: number): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return d;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v: unknown, d: boolean): boolean {
	return typeof v === 'boolean' ? v : d;
}

/** Lenient read of `app_state.suggestions_config`: anything unreadable falls back to its default. */
export function normalizeSuggestionsConfig(raw: unknown): SuggestionsConfig {
	const d = defaultSuggestionsConfig();
	if (!raw || typeof raw !== 'object') return d;
	const o = raw as Record<string, unknown>;
	const kindsIn = (o.kinds && typeof o.kinds === 'object' ? o.kinds : {}) as Record<string, unknown>;
	const rulesIn = (o.rules && typeof o.rules === 'object' ? o.rules : {}) as Record<string, unknown>;
	const kinds = {} as Record<SuggestionKind, boolean>;
	for (const k of SUGGESTION_KINDS) kinds[k] = bool(kindsIn[k], true);
	const rules = {} as Record<RuleKey, RuleConfig>;
	for (const r of RULE_KEYS) {
		const ri = (rulesIn[r] && typeof rulesIn[r] === 'object' ? rulesIn[r] : {}) as Record<string, unknown>;
		const rc: RuleConfig = { on: bool(ri.on, true) };
		for (const t of RULE_THRESHOLDS[r]) rc[t.key] = clampInt(ri[t.key], t.default, t.min, t.max);
		rules[r] = rc;
	}
	const scoreId = typeof o.score_id === 'number' && Number.isInteger(o.score_id) && o.score_id > 0 ? o.score_id : null;
	return {
		enabled: o.enabled === true,
		kinds,
		rules,
		score_id: scoreId,
		cooldown_days: clampInt(o.cooldown_days, d.cooldown_days, GENERAL_LIMITS.cooldown_days.min, GENERAL_LIMITS.cooldown_days.max),
		audience: o.audience === 'everyone' ? 'everyone' : 'admins',
		daily_cap: clampInt(o.daily_cap, d.daily_cap, GENERAL_LIMITS.daily_cap.min, GENERAL_LIMITS.daily_cap.max),
		use_ai: bool(o.use_ai, true)
	};
}

export type ConfigProblem = { path: string; message: string };

/** Strict save check (#715): every number present must be a whole number inside its range. */
export function suggestionsConfigProblems(raw: unknown): ConfigProblem[] {
	const out: ConfigProblem[] = [];
	if (!raw || typeof raw !== 'object') return [{ path: '', message: 'Settings must be an object.' }];
	const o = raw as Record<string, unknown>;
	const check = (path: string, v: unknown, min: number, max: number) => {
		if (v === undefined) return;
		if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
			out.push({ path, message: `Use a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.` });
		}
	};
	const rulesIn = (o.rules && typeof o.rules === 'object' ? o.rules : {}) as Record<string, unknown>;
	for (const r of RULE_KEYS) {
		const ri = (rulesIn[r] && typeof rulesIn[r] === 'object' ? rulesIn[r] : {}) as Record<string, unknown>;
		for (const t of RULE_THRESHOLDS[r]) check(`rules.${r}.${t.key}`, ri[t.key], t.min, t.max);
	}
	check('cooldown_days', o.cooldown_days, GENERAL_LIMITS.cooldown_days.min, GENERAL_LIMITS.cooldown_days.max);
	check('daily_cap', o.daily_cap, GENERAL_LIMITS.daily_cap.min, GENERAL_LIMITS.daily_cap.max);
	if (o.audience !== undefined && o.audience !== 'admins' && o.audience !== 'everyone') {
		out.push({ path: 'audience', message: 'Pick Admins only or Everyone.' });
	}
	return out;
}

/**
 * The Settings → Suggestions form (#715) as a raw config for `suggestionsConfigProblems`, then
 * `saveSuggestionsConfig`. Field names: `enabled`, `kind_<kind>`, `rule_<rule>_on`,
 * `rule_<rule>_<threshold>`, `score_id` (blank = Lead score), `cooldown_days`, `audience`,
 * `daily_cap`, `use_ai`. A blank or non-numeric number becomes NaN, so the check refuses it.
 */
export function suggestionsConfigFromForm(get: (name: string) => string | null): Record<string, unknown> {
	const num = (name: string) => {
		const v = (get(name) ?? '').trim().replace(/,/g, '');
		return v === '' ? NaN : Number(v);
	};
	const on = (name: string) => get(name) === '1';
	const kinds: Record<string, boolean> = {};
	for (const k of SUGGESTION_KINDS) kinds[k] = on(`kind_${k}`);
	const rules: Record<string, Record<string, number | boolean>> = {};
	for (const r of RULE_KEYS) {
		const rc: Record<string, number | boolean> = { on: on(`rule_${r}_on`) };
		for (const t of RULE_THRESHOLDS[r]) rc[t.key] = num(`rule_${r}_${t.key}`);
		rules[r] = rc;
	}
	const score = (get('score_id') ?? '').trim();
	return {
		enabled: on('enabled'),
		kinds,
		rules,
		score_id: score === '' ? null : Number(score),
		cooldown_days: num('cooldown_days'),
		audience: get('audience') ?? 'admins',
		daily_cap: num('daily_cap'),
		use_ai: on('use_ai')
	};
}

/** One piece of evidence. `ref` identifies it for the input hash; `billing` marks Zoho data. */
export type EvidenceItem = {
	id: string;
	type: string;
	label: string;
	url: string | null;
	at: string | null;
	ref?: string;
	billing?: boolean;
};

export type SuggestionAction = { type: string; label: string; url: string; more?: { type: string; label: string; url: string }[] };

/** "Nov 20" from a UTC 'YYYY-MM-DD HH:MM:SS' / ISO stamp (template wording never says "3 days ago",
 *  so stored text doesn't go stale as time passes). */
export function shortDate(at: string | null | undefined): string {
	if (!at) return '';
	const d = new Date(at.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z'));
	if (Number.isNaN(d.getTime())) return '';
	const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
	return `${m} ${d.getUTCDate()}`;
}
