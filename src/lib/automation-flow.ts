// #397: flow capabilities shared by the engine, the write layer and the builder (universal —
// no server imports): wait-until steps, exit conditions (goals), the frequency cap, and the
// per-pass timeline vocabulary.

// ── Wait-until steps ───────────────────────────────────────────────────────────────────────

import { normalizeRuleSet, type ConditionRuleSet } from './condition-rules';

// #625: `delay` (a set period of time) is the default kind for a new wait step.
// #627: `field_date` = until a date custom field matches.
// #626: `rules` = until the contact matches a condition rule set.
export const WAIT_MODES = ['delay', 'event', 'date', 'window', 'field_date', 'rules'] as const;
export type WaitMode = (typeof WAIT_MODES)[number];
export const WAIT_EVENTS = ['opened', 'clicked', 'replied', 'visited'] as const;
export type WaitEvent = (typeof WAIT_EVENTS)[number];
/** `weekday` = the next Mon–Fri; the rest a day of the week. */
export const WAIT_DAYS = ['weekday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WaitDay = (typeof WAIT_DAYS)[number];

export const WAIT_TIMEOUT_MIN = 3600; // 1 hour
export const WAIT_TIMEOUT_MAX = 90 * 86400; // 90 days
export const WAIT_TIMEOUT_DEFAULT = 3 * 86400;

/** #625: a `delay` wait — 1 minute to 365 days; a new wait step waits 1 day. */
export const WAIT_DELAY_MIN = 60;
export const WAIT_DELAY_MAX = 365 * 86400;
export const WAIT_DELAY_DEFAULT = 86400;

/** Events that need an email earlier in the flow ("the previous email"). */
export const WAIT_EMAIL_EVENTS: readonly WaitEvent[] = ['opened', 'clicked'];
export const NO_PREVIOUS_EMAIL =
	'No email comes before this wait, so “opens / clicks the previous email” can never happen. Add an email step before it, or wait for something else.';

/** The kinds the editor offers first (#625, #626, #627), in order, with a one-line example each. */
export const WAIT_KIND_CHOICES: { mode: WaitMode; title: string; example: string }[] = [
	{ mode: 'delay', title: 'A set period of time', example: 'e.g. 5 minutes, 6 hours, 2 days' },
	{ mode: 'date', title: 'Until a day or time', example: 'e.g. next weekday at 9:00, or a fixed date' },
	{ mode: 'event', title: 'Until they do something', example: 'opens or clicks an email, replies, visits a page' },
	{ mode: 'window', title: 'Only inside a send window', example: 'e.g. weekdays 9:00 to 17:00' },
	{ mode: 'field_date', title: 'Until a date field matches', example: 'e.g. 3 days before Webinar date, or on Renewal date' },
	{ mode: 'rules', title: 'Until specific conditions are met', example: 'e.g. tag is customer, or score is at least 50' }
];

/** #627: `field_date` — relation to the contact's date field, offset units, and the "already passed" choice. */
export const FIELD_DATE_RELATIONS = ['on', 'before', 'after'] as const;
export type FieldDateRelation = (typeof FIELD_DATE_RELATIONS)[number];
export const FIELD_DATE_UNITS = ['hours', 'days', 'weeks'] as const;
export type FieldDateUnit = (typeof FIELD_DATE_UNITS)[number];
export const FIELD_DATE_IF_PASSED = ['continue', 'exit'] as const;
export type FieldDateIfPassed = (typeof FIELD_DATE_IF_PASSED)[number];
export const FIELD_DATE_OFFSET_MAX = 3650;
/** How often a parked field-date wait re-reads the contact's field (a changed date moves the wait). */
export const FIELD_DATE_RECHECK_SECONDS = 6 * 3600;
export const FIELD_DATE_EXIT_REASON = 'wait:field_date_passed';

/** #626: a `rules` wait can't use email-step rules ("Until they do something" covers opens / clicks). */
export const WAIT_RULES_NO_STEP =
	'A wait’s conditions can’t use “opened / clicked email step” rules — choose “Until they do something” to wait for an open or a click.';

/**
 * A wait step's configuration (`automation_steps.wait_config`):
 * - `delay` (#625): wait `seconds` (1 minute – 365 days) from when the contact reaches the
 *   step; with `weekdays_only`, a Saturday / Sunday result moves to Monday at the same time.
 * - `event`: wait until `event` (opened / clicked the previous email in this pass, replied,
 *   visited a page whose path contains `path`) — at most `timeout_seconds`. The step's lanes:
 *   YES = it happened, NO = timed out (either may be empty: then the flow continues after it).
 * - `date`: wait until `at` ('YYYY-MM-DDTHH:MM', operator time; a past date doesn't wait), or
 *   the next `day` at `time` ('HH:MM', operator time).
 * - `field_date` (#627): wait until the contact's date custom field `field` (key), `relation`
 *   `on` / `before` / `after` it (`offset` × `unit` for before / after), at `time` ('HH:MM',
 *   operator time; default 09:00). `if_passed`: the target is already past (or the field is
 *   missing / unreadable) when the contact arrives → `continue` to the next step, or `exit` (end
 *   the pass).
 * - `window`: only continue between `start` and `end` ('HH:MM', operator time) on `days`
 *   (`weekdays` = Mon–Fri, `every` = every day); otherwise hold until the window opens.
 * - `rules` (#626): wait until the contact matches `rules` (a Condition step's rule set, no
 *   email-step rules), checked every poll. Lanes like `event`: YES = matched, NO = the optional
 *   `timeout_seconds` (1 hour – 90 days) passed. No `timeout_seconds` = wait until they match.
 */
export type WaitSpec = {
	mode: WaitMode;
	seconds?: number;
	weekdays_only?: boolean;
	event?: WaitEvent;
	path?: string;
	timeout_seconds?: number;
	at?: string;
	day?: WaitDay;
	time?: string;
	start?: string;
	end?: string;
	days?: 'weekdays' | 'every';
	field?: string;
	relation?: FieldDateRelation;
	offset?: number;
	unit?: FieldDateUnit;
	if_passed?: FieldDateIfPassed;
	rules?: ConditionRuleSet;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(s: string | undefined | null): { hour: number; minute: number } | null {
	const m = HHMM.exec(String(s ?? '').trim());
	return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export function parseLocalDateTime(s: string | undefined | null): { y: number; m: number; d: number; hour: number; minute: number } | null {
	const m = LOCAL_DT.exec(String(s ?? '').trim());
	if (!m) return null;
	const out = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
	if (out.m < 1 || out.m > 12 || out.d < 1 || out.d > 31) return null;
	return out;
}

/** Validate + canonicalise a wait config (only the mode's own fields are kept). */
export function normalizeWait(raw: unknown): { ok: true; wait: WaitSpec } | { ok: false; error: string } {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const mode = String(r.mode ?? '');
	if (!(WAIT_MODES as readonly string[]).includes(mode)) return { ok: false, error: 'Choose what this wait waits for.' };
	if (mode === 'delay') {
		const seconds = Math.floor(Number(r.seconds));
		if (!Number.isFinite(seconds) || seconds < WAIT_DELAY_MIN || seconds > WAIT_DELAY_MAX) {
			return { ok: false, error: 'Set a wait between 1 minute and 365 days.' };
		}
		const wait: WaitSpec = { mode, seconds };
		const wd = r.weekdays_only;
		if (wd === true || wd === 1 || wd === '1' || wd === 'true') wait.weekdays_only = true;
		return { ok: true, wait };
	}
	if (mode === 'rules') {
		const set = normalizeRuleSet(r.rules);
		if (!set) return { ok: false, error: 'Add at least one condition to wait for.' };
		if (set.rules.some((x) => x.field === 'step_opened' || x.field === 'step_clicked')) return { ok: false, error: WAIT_RULES_NO_STEP };
		const wait: WaitSpec = { mode, rules: set };
		const t = r.timeout_seconds;
		if (t !== undefined && t !== null && t !== '' && t !== 0 && t !== '0' && t !== false) {
			const timeout = Math.floor(Number(t));
			if (!Number.isFinite(timeout) || timeout < WAIT_TIMEOUT_MIN || timeout > WAIT_TIMEOUT_MAX) {
				return { ok: false, error: 'Set a time limit between 1 hour and 90 days, or turn it off.' };
			}
			wait.timeout_seconds = timeout;
		}
		return { ok: true, wait };
	}
	if (mode === 'event') {
		const event = String(r.event ?? '');
		if (!(WAIT_EVENTS as readonly string[]).includes(event)) return { ok: false, error: 'Choose the event to wait for.' };
		const timeout = Math.floor(Number(r.timeout_seconds));
		if (!Number.isFinite(timeout) || timeout < WAIT_TIMEOUT_MIN || timeout > WAIT_TIMEOUT_MAX) {
			return { ok: false, error: 'Set a timeout between 1 hour and 90 days.' };
		}
		const wait: WaitSpec = { mode, event: event as WaitEvent, timeout_seconds: timeout };
		if (event === 'visited') {
			const path = String(r.path ?? '').trim().slice(0, 200);
			if (!path) return { ok: false, error: 'Set the page path to wait for.' };
			wait.path = path;
		}
		return { ok: true, wait };
	}
	if (mode === 'date') {
		const at = String(r.at ?? '').trim();
		if (at) {
			if (!parseLocalDateTime(at)) return { ok: false, error: 'Set the date and time to wait until.' };
			return { ok: true, wait: { mode, at } };
		}
		const day = String(r.day ?? 'weekday');
		if (!(WAIT_DAYS as readonly string[]).includes(day)) return { ok: false, error: 'Choose a day.' };
		const time = String(r.time ?? '').trim();
		if (!parseHHMM(time)) return { ok: false, error: 'Set a time (HH:MM).' };
		return { ok: true, wait: { mode, day: day as WaitDay, time } };
	}
	if (mode === 'field_date') {
		const field = String(r.field ?? '').trim();
		if (!field || field.length > 50) return { ok: false, error: 'Choose the date field to wait for.' };
		const relation = String(r.relation ?? 'on');
		if (!(FIELD_DATE_RELATIONS as readonly string[]).includes(relation)) return { ok: false, error: 'Choose on, before or after the date.' };
		const time = String(r.time ?? '09:00').trim() || '09:00';
		if (!parseHHMM(time)) return { ok: false, error: 'Set a time (HH:MM).' };
		const ifPassed = String(r.if_passed ?? 'continue');
		if (!(FIELD_DATE_IF_PASSED as readonly string[]).includes(ifPassed)) return { ok: false, error: 'Choose what happens if the date has already passed.' };
		const wait: WaitSpec = { mode, field, relation: relation as FieldDateRelation, time, if_passed: ifPassed as FieldDateIfPassed };
		if (relation !== 'on') {
			const offset = Math.floor(Number(r.offset));
			if (!Number.isFinite(offset) || offset < 1 || offset > FIELD_DATE_OFFSET_MAX) return { ok: false, error: `Set an offset between 1 and ${FIELD_DATE_OFFSET_MAX}.` };
			const unit = String(r.unit ?? 'days');
			if (!(FIELD_DATE_UNITS as readonly string[]).includes(unit)) return { ok: false, error: 'Choose hours, days or weeks.' };
			wait.offset = offset;
			wait.unit = unit as FieldDateUnit;
		}
		return { ok: true, wait };
	}
	const start = String(r.start ?? '09:00').trim();
	const end = String(r.end ?? '17:00').trim();
	const s = parseHHMM(start);
	const e = parseHHMM(end);
	if (!s || !e) return { ok: false, error: 'Set the window’s start and end times (HH:MM).' };
	if (e.hour * 60 + e.minute <= s.hour * 60 + s.minute) return { ok: false, error: 'The window must end after it starts.' };
	return { ok: true, wait: { mode: 'window', start, end, days: r.days === 'every' ? 'every' : 'weekdays' } };
}

/** The stored JSON → a config, or null when missing / unreadable. */
export function parseWait(raw: string | null | undefined): WaitSpec | null {
	if (!raw) return null;
	try {
		const r = normalizeWait(JSON.parse(raw));
		return r.ok ? r.wait : null;
	} catch {
		return null;
	}
}

/** Wait modes with "Did it" / "Timed out" lanes: `event` and (#626) `rules`. */
export const LANE_WAIT_MODES: readonly string[] = ['event', 'rules'];

/** Does a wait of this mode carry YES / NO lanes? */
export function waitModeHasLanes(mode: unknown): boolean {
	return LANE_WAIT_MODES.includes(String(mode ?? ''));
}

/** Does a step of this shape carry YES / NO lanes? Branches always; a wait in event / rules mode. */
export function stepHasLanes(s: { type: string; wait_config?: string | null }): boolean {
	return s.type === 'branch' || (s.type === 'wait' && waitModeHasLanes(parseWait(s.wait_config ?? null)?.mode));
}

/** #625: what `addStep` stores for a new, unconfigured wait step — "A set period of time", 1 day. */
export const DEFAULT_WAIT: WaitSpec = { mode: 'delay', seconds: WAIT_DELAY_DEFAULT };

/** A step as the tree helpers see it (stored rows, or a spec flattened with stand-in ids). */
export type FlowStepRef = { id: number; type: string; parent_step_id: number | null; branch_label: string | null; position: number };

/**
 * #625: "the previous email" of a step — the nearest email step that runs before it on the
 * way down the flow: an earlier step of its own lane (an email itself, or the last email
 * inside an earlier branch / event wait's lanes), else the same one level up, and so on to
 * the trunk. Null when no email can have been sent before the step.
 */
export function previousEmailStep<T extends FlowStepRef>(steps: T[], stepId: number): T | null {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const children = new Map<string, T[]>();
	for (const s of steps) {
		if (s.parent_step_id === null) continue;
		const k = `${s.parent_step_id}:${s.branch_label ?? ''}`;
		children.set(k, [...(children.get(k) ?? []), s]);
	}
	const sortPos = (a: T, b: T) => a.position - b.position || a.id - b.id;
	const lastEmailIn = (s: T, depth: number): T | null => {
		if (s.type === 'email') return s;
		if (depth > 25) return null;
		let found: T | null = null;
		for (const label of ['yes', 'no']) {
			for (const c of [...(children.get(`${s.id}:${label}`) ?? [])].sort(sortPos)) {
				const e = lastEmailIn(c, depth + 1);
				if (e) found = e;
			}
		}
		return found;
	};
	let cur = byId.get(stepId);
	for (let guard = 0; cur && guard < 50; guard++) {
		const at: T = cur;
		const lane = steps
			.filter((s) => s.parent_step_id === at.parent_step_id && (at.parent_step_id === null || s.branch_label === at.branch_label))
			.sort(sortPos);
		const idx = lane.findIndex((s) => s.id === at.id);
		for (let i = idx - 1; i >= 0; i--) {
			const e = lastEmailIn(lane[i], 0);
			if (e) return e;
		}
		cur = at.parent_step_id === null ? undefined : byId.get(at.parent_step_id);
	}
	return null;
}

/** Does this wait need an email before it (opens / clicks the previous email)? */
export function waitNeedsEmail(w: WaitSpec | null | undefined): boolean {
	return !!w && w.mode === 'event' && !!w.event && WAIT_EMAIL_EVENTS.includes(w.event);
}

/** Step types whose children are walked as YES / NO lanes by the tree helpers. */
export const LANE_TYPES = ['branch', 'wait'];

const DAY_NAMES: Record<string, string> = {
	weekday: 'weekday',
	mon: 'Monday',
	tue: 'Tuesday',
	wed: 'Wednesday',
	thu: 'Thursday',
	fri: 'Friday',
	sat: 'Saturday',
	sun: 'Sunday'
};

export function durationText(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s >= 86400 && s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
	if (s >= 86400) {
		const d = Math.round(s / 86400);
		return `${d} day${d === 1 ? '' : 's'}`;
	}
	if (s >= 3600) {
		const h = Math.round(s / 3600);
		return `${h} hour${h === 1 ? '' : 's'}`;
	}
	const m = Math.max(1, Math.round(s / 60));
	return `${m} minute${m === 1 ? '' : 's'}`;
}

/** The editor's value + unit (minutes, hours, days, weeks) for a delay, largest whole unit. */
export function splitDelay(seconds: number): { value: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' } {
	const s = Math.max(0, Math.round(seconds));
	if (s && s % 604800 === 0) return { value: s / 604800, unit: 'weeks' };
	if (s && s % 86400 === 0) return { value: s / 86400, unit: 'days' };
	if (s && s % 3600 === 0) return { value: s / 3600, unit: 'hours' };
	return { value: Math.round(s / 60), unit: 'minutes' };
}

/** A delay in its largest whole unit: "5 minutes", "6 hours", "2 days", "1 week". */
export function delayText(seconds: number): string {
	const { value, unit } = splitDelay(seconds);
	const n = Math.max(1, value);
	return `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
}

function unitText(unit: string, n: number): string {
	return n === 1 ? unit.slice(0, -1) : unit;
}

const EVENT_VERB: Record<'opened' | 'clicked', string> = { opened: 'open', clicked: 'click' };

/**
 * One line for the canvas card, in plain words: "Wait 5 minutes", "Wait until they click
 * “Welcome”, up to 3 days", "Wait until next weekday at 09:00". `emailSubject` names the
 * previous email of an opened / clicked wait (#625; blank = "the previous email").
 */
export function waitText(
	w: WaitSpec | null,
	opts: { emailSubject?: string | null; fieldLabel?: string | null; rulesText?: string | null } = {}
): string {
	if (!w) return 'Wait…';
	if (w.mode === 'rules') {
		// #626: `rulesText` = the conditions in words (the caller has the names); else a count.
		const n = w.rules?.rules.length ?? 0;
		const what = (opts.rulesText ?? '').trim() || `${n} condition${n === 1 ? '' : 's'}${n > 1 ? ` (${w.rules?.match === 'any' ? 'any' : 'all'})` : ''}`;
		const limit = w.timeout_seconds ? `up to ${durationText(w.timeout_seconds)}` : 'no time limit';
		return `Wait until they match: ${what} · ${limit}`;
	}
	if (w.mode === 'delay') return `Wait ${delayText(w.seconds ?? WAIT_DELAY_DEFAULT)}${w.weekdays_only ? ' · weekdays only' : ''}`;
	if (w.mode === 'event') {
		const ev = w.event ?? 'opened';
		let what: string;
		if (ev === 'visited') what = `they visit a page containing “${w.path ?? ''}”`;
		else if (ev === 'replied') what = 'they reply';
		else {
			const subject = (opts.emailSubject ?? '').trim();
			what = `they ${EVENT_VERB[ev]} ${subject ? `“${subject}”` : 'the previous email'}`;
		}
		return `Wait until ${what}, up to ${durationText(w.timeout_seconds ?? WAIT_TIMEOUT_DEFAULT)}`;
	}
	if (w.mode === 'date') {
		if (w.at) return `Wait until ${w.at.replace('T', ' ')}`;
		return `Wait until next ${DAY_NAMES[w.day ?? 'weekday']} at ${w.time}`;
	}
	if (w.mode === 'field_date') {
		const label = opts.fieldLabel || w.field || 'date field';
		const rel = w.relation === 'on' ? '' : `${w.offset ?? 1} ${unitText(w.unit ?? 'days', w.offset ?? 1)} ${w.relation} `;
		return `Wait until ${rel}${label}${w.if_passed === 'exit' ? ' · exit if passed' : ''}`;
	}
	return `Wait for the send window: ${w.days === 'every' ? 'every day' : 'Mon–Fri'} ${w.start}–${w.end}`;
}

/** The lane captions of an event / rules wait. */
export const WAIT_LANE_LABELS = { yes: 'Did it', no: 'Timed out' } as const;

const WAITING_NOUN: Record<WaitEvent, string> = { opened: 'open', clicked: 'click', replied: 'reply', visited: 'page visit' };

function sqlMs(s: string | null | undefined): number {
	if (!s) return NaN;
	return Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

/**
 * What a contact parked at a wait step is waiting for, for the inspector: "Waiting for click
 * (3 days left)", "Waiting until 2026-11-02 09:00", "Waiting for the send window". Null when
 * the step isn't a wait.
 */
export function waitingText(w: WaitSpec | null, startedAt: string | null, nextRunAt: string | null, nowIso: string): string | null {
	if (!w) return null;
	if (w.mode === 'delay') return nextRunAt ? `Waiting until ${nextRunAt.slice(0, 16)} UTC` : `Waiting ${delayText(w.seconds ?? WAIT_DELAY_DEFAULT)}`;
	if (w.mode === 'rules') {
		if (!w.timeout_seconds) return 'Waiting until they match the conditions (no time limit)';
		const start = sqlMs(startedAt);
		if (!Number.isFinite(start)) return 'Waiting until they match the conditions';
		const left = start + w.timeout_seconds * 1000 - sqlMs(nowIso);
		return left > 0 ? `Waiting until they match the conditions (${durationText(left / 1000)} left)` : 'Waiting until they match the conditions (timing out)';
	}
	if (w.mode === 'event') {
		const noun = WAITING_NOUN[w.event ?? 'opened'];
		const start = sqlMs(startedAt);
		if (!Number.isFinite(start)) return `Waiting for ${noun}`;
		const left = start + (w.timeout_seconds ?? WAIT_TIMEOUT_DEFAULT) * 1000 - sqlMs(nowIso);
		return left > 0 ? `Waiting for ${noun} (${durationText(left / 1000)} left)` : `Waiting for ${noun} (timing out)`;
	}
	if (w.mode === 'field_date') return nextRunAt ? `Waiting for ${w.field ?? 'the date field'} (next check ${nextRunAt.slice(0, 16)} UTC)` : `Waiting for ${w.field ?? 'the date field'}`;
	if (w.mode === 'window') return `Waiting for the send window (${w.days === 'every' ? 'every day' : 'Mon–Fri'} ${w.start}–${w.end})`;
	if (nextRunAt) return `Waiting until ${nextRunAt.slice(0, 16)} UTC`;
	return 'Waiting until the set time';
}

// ── Exit conditions (goals) ────────────────────────────────────────────────────────────────

export const EXIT_KINDS = ['reply', 'tag', 'segment', 'stage'] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];
export type ExitRule =
	| { kind: 'reply' }
	| { kind: 'tag'; tag: string }
	| { kind: 'segment'; list_id: number }
	| { kind: 'stage'; stage_id: number };

export const EXIT_RULES_MAX = 10;

/** Validate + canonicalise a list of exit rules (duplicates dropped). */
export function normalizeExitRules(raw: unknown): { ok: true; rules: ExitRule[] } | { ok: false; error: string } {
	if (raw === null || raw === undefined || raw === '') return { ok: true, rules: [] };
	if (!Array.isArray(raw)) return { ok: false, error: 'Exit rules must be a list.' };
	if (raw.length > EXIT_RULES_MAX) return { ok: false, error: `At most ${EXIT_RULES_MAX} exit rules.` };
	const out: ExitRule[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
		let rule: ExitRule;
		if (r.kind === 'reply') rule = { kind: 'reply' };
		else if (r.kind === 'tag') {
			const tag = String(r.tag ?? '').trim();
			if (!tag || tag.length > 60) return { ok: false, error: 'Set the tag for the “tag added” exit (60 characters max).' };
			rule = { kind: 'tag', tag };
		} else if (r.kind === 'segment') {
			const id = Math.floor(Number(r.list_id));
			if (!(id > 0)) return { ok: false, error: 'Choose a list or segment for the “matches” exit.' };
			rule = { kind: 'segment', list_id: id };
		} else if (r.kind === 'stage') {
			const id = Math.floor(Number(r.stage_id));
			if (!(id > 0)) return { ok: false, error: 'Choose a pipeline stage for the “stage entered” exit.' };
			rule = { kind: 'stage', stage_id: id };
		} else return { ok: false, error: 'Unknown exit rule.' };
		const key = JSON.stringify(rule).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(rule);
	}
	return { ok: true, rules: out };
}

export function parseExitRules(raw: string | null | undefined): ExitRule[] {
	if (!raw) return [];
	try {
		const r = normalizeExitRules(JSON.parse(raw));
		return r.ok ? r.rules : [];
	} catch {
		return [];
	}
}

/** "Replies", "Tag “customer” is added", "Matches «VIP»", "Enters pipeline stage «Won»". */
export function exitRuleText(rule: ExitRule, names: { lists?: Map<number, string>; stages?: Map<number, string> } = {}): string {
	if (rule.kind === 'reply') return 'Replies to an email';
	if (rule.kind === 'tag') return `Tag “${rule.tag}” is added`;
	if (rule.kind === 'segment') return `Matches «${names.lists?.get(rule.list_id) ?? `deleted list #${rule.list_id}`}»`;
	return `Enters pipeline stage «${names.stages?.get(rule.stage_id) ?? `deleted stage #${rule.stage_id}`}»`;
}

/** `completed_reason` 'goal:reply' → "Exited by goal: replied". */
export function completedReasonText(reason: string | null | undefined): string | null {
	if (!reason) return null;
	if (!reason.startsWith('goal:')) return reason;
	const kind = reason.slice(5);
	const what: Record<string, string> = { reply: 'replied', tag: 'tag added', segment: 'matched segment', stage: 'entered stage' };
	return `Exited by goal: ${what[kind] ?? kind}`;
}

// ── Frequency cap ─────────────────────────────────────────────────────────────────────────

/** Settings → Automations: at most N automation emails per contact per 24 h / 7 days (null = off). */
export type FrequencyCap = { per_day: number | null; per_week: number | null };
export const FREQUENCY_CAP_OFF: FrequencyCap = { per_day: null, per_week: null };
export const FREQUENCY_CAP_MAX = 100;
/** `last_error` prefix while the engine holds an email step for the cap. */
export const FREQUENCY_CAP_PREFIX = 'Frequency cap';

export function normalizeFrequencyCap(raw: unknown): FrequencyCap {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const one = (v: unknown): number | null => {
		if (v === null || v === undefined || v === '') return null;
		const n = Math.floor(Number(v));
		return Number.isFinite(n) && n >= 1 ? Math.min(n, FREQUENCY_CAP_MAX) : null;
	};
	return { per_day: one(r.per_day), per_week: one(r.per_week) };
}

// ── Timeline ──────────────────────────────────────────────────────────────────────────────

export type TimelineEvent = { step_id: number | null; kind: string; detail: string | null; at: string };

/** One timeline row as text: "Sent «Welcome»", "Condition → yes", "Exited by goal: replied". */
export function timelineText(ev: { kind: string; detail: string | null }, stepTitle?: string | null): string {
	const at = stepTitle ? ` · ${stepTitle}` : '';
	switch (ev.kind) {
		case 'enrolled':
			return `Enrolled${at}`;
		case 'reached':
			return `Reached${at}`;
		case 'sent':
			return `Sent email${ev.detail ? ` «${ev.detail}»` : ''}`;
		case 'tag':
			return ev.detail ?? 'Tag step';
		case 'branch':
			return `Condition → ${ev.detail ?? '?'}`;
		case 'action':
			return `Action: ${ev.detail ?? ''}`;
		case 'wait':
			return `Wait: ${ev.detail ?? 'done'}`;
		case 'held':
			return `Held: ${ev.detail ?? ''}`;
		case 'exit':
			return completedReasonText(ev.detail) ?? 'Exited';
		case 'completed':
			return 'Completed';
		case 'cancelled':
			return `Cancelled${ev.detail ? ` (${ev.detail})` : ''}`;
		case 'failed':
			return `Failed${ev.detail ? `: ${ev.detail}` : ''}`;
		default:
			// #412: what started the pass, e.g. kind `trigger:email_clicked`, detail `clicked https://…`.
			if (ev.kind.startsWith('trigger:')) return `Triggered: ${ev.detail ?? ev.kind.slice('trigger:'.length)}`;
			return ev.kind;
	}
}
