// #396: pure helpers for the automation editor (/automations/[id]) — the unsaved-changes
// guard, delete confirm + undo window, lane reorder, wait nodes and the status strip.
// Universal (no DOM, no server imports) so tests/automation-editor.test.ts covers them.

// ── Unsaved-changes guard ─────────────────────────────────────────────────────────────────

/** Stable JSON (object keys sorted) — two equal edit states give the same string. */
export function fingerprint(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
	);
}

/** The drawer has changes when its current state differs from the one it opened with. */
export function isDirty(baseline: string | null, current: string): boolean {
	return baseline !== null && baseline !== current;
}

export const DISCARD_MESSAGE = 'Discard changes? Your edits to this step haven’t been saved.';
export const LEAVE_MESSAGE = 'You have unsaved step changes. Leave this page and lose them?';

/** May the drawer close? Clean → yes; dirty → only when the user confirms the discard. */
export function mayClose(dirty: boolean, confirm: (message: string) => boolean): boolean {
	return !dirty || confirm(DISCARD_MESSAGE);
}

// ── Delete + undo ─────────────────────────────────────────────────────────────────────────

/** How long the "Step deleted · Undo" toast stays up. */
export const UNDO_MS = 10_000;

/** Every delete asks first (#396) — what it says depends on what goes and who's waiting. */
export function deleteMessage(type: string, waiting: number): string {
	if (type === 'branch') {
		return 'Delete this condition AND every step inside its YES/NO paths? Contacts inside move to the step after it. You can undo for 10 seconds.';
	}
	if (type === 'wait') {
		return 'Delete this wait AND every step inside its “Did it” / “Timed out” paths? Contacts inside move to the step after it. You can undo for 10 seconds.';
	}
	if (waiting > 0) {
		return `${waiting} contact${waiting === 1 ? ' is' : 's are'} waiting on this step. Deleting it moves them to the following step (or completes them if this is the last). Delete? You can undo for 10 seconds.`;
	}
	return 'Delete this step? You can undo for 10 seconds.';
}

// ── Reorder within a lane (drag, mouse or touch) ──────────────────────────────────────────

/** `ids` with `fromId` moved to `toId`'s place; null when nothing would change. */
export function reorderLane(ids: number[], fromId: number, toId: number): number[] | null {
	const from = ids.indexOf(fromId);
	const to = ids.indexOf(toId);
	if (from < 0 || to < 0 || from === to) return null;
	const next = [...ids];
	next.splice(from, 1);
	next.splice(to, 0, fromId);
	return next;
}

// ── Waits ─────────────────────────────────────────────────────────────────────────────────

export type WaitUnit = 'minutes' | 'hours' | 'days';

/** Seconds → the drawer's number + unit (the largest unit that divides it). */
export function splitWait(seconds: number): { value: number; unit: WaitUnit } {
	if (!seconds) return { value: 0, unit: 'days' };
	if (seconds % 86400 === 0) return { value: seconds / 86400, unit: 'days' };
	if (seconds % 3600 === 0) return { value: seconds / 3600, unit: 'hours' };
	return { value: Math.round(seconds / 60), unit: 'minutes' };
}

export function waitSeconds(value: number, unit: string): number {
	const n = Math.max(0, Math.floor(Number(value) || 0));
	return n * (unit === 'days' ? 86400 : unit === 'hours' ? 3600 : 60);
}

/** "Wait 2 days", "Wait 1 hour", "No wait". */
export function humanWait(seconds: number): string {
	if (!seconds) return 'No wait';
	const units: [number, string][] = [
		[86400, 'day'],
		[3600, 'hour'],
		[60, 'minute']
	];
	for (const [size, label] of units) {
		if (seconds % size === 0 || seconds >= size) {
			const n = Math.round(seconds / size);
			return `Wait ${n} ${label}${n === 1 ? '' : 's'}`;
		}
	}
	return `Wait ${seconds} seconds`;
}

/** The wait node's text: "Wait 2 days · weekdays", "No wait"; a condition's wait says the
 *  rules are checked after it. */
export function waitNodeText(seconds: number, weekdayOnly: boolean, stepType: string): string {
	const base = humanWait(seconds) + (seconds && weekdayOnly ? ' · weekdays' : '');
	return stepType === 'branch' && seconds ? `${base}, then check` : base;
}

// ── Status strip ─────────────────────────────────────────────────────────────────────────

/** "2026-10-03 14:05:00" (UTC, SQLite) or ISO → ms; NaN when unreadable. */
function utcMs(s: string): number {
	return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`).getTime();
}

/** "now", "~5 min", "~3 h", "~2 days" until `at` (UTC). */
export function dueIn(at: string, nowIso: string): string {
	const diff = utcMs(at) - utcMs(nowIso);
	if (!Number.isFinite(diff) || diff <= 60_000) return 'now';
	const mins = Math.round(diff / 60_000);
	if (mins < 60) return `~${mins} min`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `~${hours} h`;
	return `~${Math.round(hours / 24)} days`;
}

/** "Oct 3, 2026" in UTC (deterministic for SSR + hydration). */
export function shortDate(s: string): string {
	const ms = utcMs(s);
	if (!Number.isFinite(ms)) return '';
	return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export type StatusInput = {
	status: string;
	/** When it last changed status (draft: created). Null = not recorded. */
	since: string | null;
	waiting: number;
	nextRunAt: string | null;
	now: string;
};

/** The one-line strip under the header: what the status means, since when, and for a live
 *  flow how many are waiting and when the next step is due. */
export function statusLine(s: StatusInput): { title: string; meaning: string; detail: string } {
	const since = s.since ? shortDate(s.since) : '';
	const n = s.waiting;
	const people = `${n.toLocaleString('en-US')} contact${n === 1 ? '' : 's'}`;
	if (s.status === 'active') {
		const next = n > 0 && s.nextRunAt ? ` · next step due ${dueIn(s.nextRunAt, s.now) === 'now' ? 'now' : `in ${dueIn(s.nextRunAt, s.now)}`}` : '';
		return {
			title: since ? `Live since ${since}` : 'Live',
			meaning: 'New enrollments start right away and steps send as they come due.',
			detail: n > 0 ? `${people} waiting${next}` : 'Nobody waiting'
		};
	}
	if (s.status === 'paused') {
		return {
			title: since ? `Paused since ${since}` : 'Paused',
			meaning: 'Nothing sends and nobody new is enrolled until you activate it again.',
			detail: n > 0 ? `${people} held in place` : 'Nobody waiting'
		};
	}
	return {
		title: since ? `Draft · created ${since}` : 'Draft',
		meaning: 'Nothing runs yet. Add steps and a trigger, then activate.',
		detail: ''
	};
}

export type StatusToneInput = {
	status: string;
	failed: number;
	pendingTriggers: number;
	nextRunAt: string | null;
	now: string;
};

/** Minutes past due before a waiting step counts as overdue (the dashboard's rule). */
export const OVERDUE_MINUTES = 30;

/** #427: how the status line is shown. `meta` = a plain muted line (nothing to flag — the
 *  status badge already says it); `warn` = paused or something to act on (contacts triggered
 *  while paused, a step overdue); `err` = failed passes. */
export function statusTone(s: StatusToneInput): 'meta' | 'warn' | 'err' {
	if (s.failed > 0) return 'err';
	if (s.status === 'paused' || s.pendingTriggers > 0) return 'warn';
	if (s.status === 'active' && s.nextRunAt) {
		const late = utcMs(s.now) - utcMs(s.nextRunAt);
		if (Number.isFinite(late) && late > OVERDUE_MINUTES * 60_000) return 'warn';
	}
	return 'meta';
}
