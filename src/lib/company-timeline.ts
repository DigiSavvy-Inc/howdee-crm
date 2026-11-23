// Company timeline (#566, 3 of 4): one feed for the whole account — what its contacts did plus
// what happened in the connected tools. Pure vocabulary shared by the loader and the page:
// the source chips (`?tl=`), the page size (`?tl_n=`, "Show more"), and the merge.

import type { ActivityItem, ActivityType } from '$lib/server/activity';

export type TimelineSource =
	| 'email'
	| 'replies'
	| 'gmail'
	| 'site'
	| 'pipeline'
	| 'automations'
	| 'contacts'
	| 'github'
	| 'billing'
	| 'timing';

export type TimelineFilter = 'all' | TimelineSource;

/** Chip order, with the activity types each source covers. */
export const TIMELINE_SOURCES: { key: TimelineSource; label: string; types: ActivityType[] }[] = [
	{ key: 'email', label: 'Email', types: ['open', 'click', 'bounce', 'unsubscribe', 'spam'] },
	{ key: 'replies', label: 'Replies', types: ['reply'] },
	{ key: 'gmail', label: 'Gmail', types: ['gmail'] },
	{ key: 'site', label: 'Site', types: ['visited'] },
	{ key: 'pipeline', label: 'Pipeline', types: ['pipeline'] },
	{ key: 'automations', label: 'Automations', types: ['enrolled', 'completed'] },
	{ key: 'contacts', label: 'Contacts', types: ['contact', 'form', 'confirm_sent', 'confirmed'] },
	{ key: 'github', label: 'GitHub', types: ['github'] },
	{ key: 'billing', label: 'Billing', types: ['invoice', 'payment'] },
	{ key: 'timing', label: 'Timing', types: ['timing'] }
];

/** The sources read from the contacts' own activity (`recentActivity`). */
export const CONTACT_SOURCES: TimelineSource[] = ['email', 'replies', 'site', 'pipeline', 'automations', 'contacts'];

/** `?tl=` → a known source, else `all`. */
export function parseTimelineFilter(v: string | null | undefined): TimelineFilter {
	return TIMELINE_SOURCES.some((s) => s.key === v) ? (v as TimelineSource) : 'all';
}

/** "Show more" steps; `?tl_n=` must be one of them (else the first). */
export const TIMELINE_SIZES = [25, 50, 100, 200];

export function parseTimelineSize(v: string | null | undefined): number {
	const n = Number(v);
	return TIMELINE_SIZES.includes(n) ? n : TIMELINE_SIZES[0];
}

/** The next "Show more" size, null at the largest. */
export function nextTimelineSize(n: number): number | null {
	return TIMELINE_SIZES.find((s) => s > n) ?? null;
}

/** The activity types a filter asks the contact feed for. */
export function contactTypesFor(filter: TimelineFilter): ActivityType[] {
	const keys = filter === 'all' ? CONTACT_SOURCES : CONTACT_SOURCES.includes(filter) ? [filter] : [];
	return TIMELINE_SOURCES.filter((s) => keys.includes(s.key)).flatMap((s) => s.types);
}

/** Whether a filter shows a given source. */
export function wants(filter: TimelineFilter, source: TimelineSource): boolean {
	return filter === 'all' || filter === source;
}

/**
 * A date or date-time from an integration (ISO with a zone, SQLite UTC, or a bare date) as
 * UTC 'YYYY-MM-DD HH:MM:SS' — the feed's sort key. A bare date is midnight UTC. Null when it
 * doesn't parse.
 */
export function toUtcStamp(v: string | null | undefined): string | null {
	const s = (v ?? '').trim();
	if (!s) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
	const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : null;
}

/** Every list merged newest first (ties: type, then the original order), cut to `limit`. */
export function mergeTimeline(lists: ActivityItem[][], limit: number): ActivityItem[] {
	return lists
		.flat()
		.map((it, i) => ({ it, i }))
		.sort((a, b) => {
			if (a.it.at !== b.it.at) return a.it.at < b.it.at ? 1 : -1;
			if (a.it.type !== b.it.type) return a.it.type < b.it.type ? -1 : 1;
			return a.i - b.i;
		})
		.slice(0, limit)
		.map((x) => x.it);
}
