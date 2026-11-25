// Suggestions panel (#714) — pure helpers shared by SuggestionsPanel.svelte, the session-gated
// /api/suggestions endpoints and the pages a next step opens. Universal: no server imports.
//
// A next step only opens a page with things filled in (docs/suggestions.md → "What the next
// steps do"); nothing here saves, sends, schedules, activates or enrolls.

import type { SuggestionAction } from '$lib/suggestions';

/** Snooze choices: label → days. */
export const SNOOZE_CHOICES = [
	{ days: 1, label: '1 day' },
	{ days: 7, label: '1 week' },
	{ days: 30, label: '1 month' }
] as const;
export type SnoozeDays = (typeof SNOOZE_CHOICES)[number]['days'];
export const SNOOZE_DAYS: number[] = SNOOZE_CHOICES.map((c) => c.days);

export const DISMISS_REASON_MAX = 200;
/** The draft opening carried in a prefill URL (`opening=`). */
export const OPENING_MAX = 1000;

export type PanelOp = 'done' | 'snooze' | 'dismiss';

export type PanelActionInput = { op: PanelOp; days?: number; reason?: string };

/** Strict read of the POST body; a string error is a 400. */
export function parsePanelAction(raw: unknown): PanelActionInput | string {
	if (!raw || typeof raw !== 'object') return 'Send a JSON object.';
	const o = raw as Record<string, unknown>;
	if (o.op === 'done') return { op: 'done' };
	if (o.op === 'snooze') {
		if (typeof o.days !== 'number' || !SNOOZE_DAYS.includes(o.days)) return 'Snooze for 1, 7 or 30 days.';
		return { op: 'snooze', days: o.days };
	}
	if (o.op === 'dismiss') {
		if (o.reason !== undefined && o.reason !== null && typeof o.reason !== 'string') return 'The reason must be text.';
		const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
		if (reason.length > DISMISS_REASON_MAX) return `Keep the reason under ${DISMISS_REASON_MAX} characters.`;
		return { op: 'dismiss', reason };
	}
	return 'Unknown action.';
}

/** Next steps that take the draft opening along (`opening=`). */
const OPENING_TYPES = new Set(['reply', 'email_them']);

/** The href a next step opens: the stored app path, plus the draft opening when it fits. */
export function nextStepHref(step: { type: string; url: string }, draftOpening: string | null | undefined): string {
	const url = step.url;
	if (!url.startsWith('/') || url.startsWith('//')) return '/';
	const opening = (draftOpening ?? '').trim().slice(0, OPENING_MAX);
	if (!opening || !OPENING_TYPES.has(step.type)) return url;
	const [path, hash] = url.split('#');
	return `${path}${path.includes('?') ? '&' : '?'}opening=${encodeURIComponent(opening)}${hash !== undefined ? `#${hash}` : ''}`;
}

/** Every next step of an action, the main one first. */
export function allSteps(action: SuggestionAction | null): { type: string; label: string; url: string }[] {
	if (!action) return [];
	return [{ type: action.type, label: action.label, url: action.url }, ...(action.more ?? [])];
}

/** The `opening=` prefill a page reads (trimmed, capped; '' when absent). */
export function readOpening(params: URLSearchParams): string {
	return (params.get('opening') ?? '').trim().slice(0, OPENING_MAX);
}

/** Wraps a carousel index into 0…n-1. */
export function wrapIndex(i: number, n: number): number {
	if (n <= 0) return 0;
	return ((i % n) + n) % n;
}

/** A horizontal swipe: -1 = next (left), 1 = previous (right), 0 = not a swipe. */
export function swipeDirection(dx: number, dy: number, min = 40): -1 | 0 | 1 {
	if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
	return dx < 0 ? -1 : 1;
}

/** The panel is never on these paths (public pages, sign-in, setup, compose). */
const HIDDEN_PREFIXES = ['/compose', '/login', '/setup', '/f/', '/p/', '/newsletter', '/unsubscribe', '/confirm/', '/invite/', '/reset', '/verify/', '/auth/'];

export function panelHiddenOn(pathname: string): boolean {
	return HIDDEN_PREFIXES.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}

/** Per-user memory in this browser: minimised, and the newest suggestion seen. */
export type PanelMemory = { minimized: boolean; seen: string };

export const memoryKey = (userId: number) => `ds-suggestions:${userId}`;
export const SESSION_KEY = 'ds-suggestions-autoopened';

export function readMemory(raw: string | null): PanelMemory {
	try {
		const v = raw ? JSON.parse(raw) : null;
		if (v && typeof v === 'object') return { minimized: v.minimized === true, seen: typeof v.seen === 'string' ? v.seen : '' };
	} catch {
		/* unreadable → defaults */
	}
	return { minimized: false, seen: '' };
}

/** Open by itself? Only when something is newer than what was seen, and once per session. */
export function shouldAutoOpen(o: { count: number; latest: string | null; memory: PanelMemory; openedThisSession: boolean }): boolean {
	if (o.openedThisSession || o.count <= 0 || !o.latest) return false;
	return o.latest > o.memory.seen;
}

export function countLabel(n: number): string {
	return `${n.toLocaleString('en-US')} suggestion${n === 1 ? '' : 's'}`;
}
