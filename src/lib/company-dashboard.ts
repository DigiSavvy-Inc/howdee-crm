// Company dashboard (#564, 1 of 4): the at-a-glance tiles on /companies/[id] and their
// 90-day weekly engagement series. Pure — no DB, no DOM — shared by the loader and the page.
// Bucketing reuses the contacts overview (#423): local days in Settings → Timezone, Monday weeks.

import { bucketOf, growthBuckets, type GrowthBucket } from './contacts-overview';

/** Days the "Engaged" tile and the "Going quiet" rule look back. */
export const ENGAGED_DAYS = 30;
/** The engagement series covers this many days, in Monday weeks. */
export const SERIES_DAYS = 90;

/** `delivered` is context for the trend chart (#565), never a touch; the others are touches. */
export type EngagementKind = 'delivered' | 'opens' | 'clicks' | 'replies' | 'visits';
export const ENGAGEMENT_KINDS: EngagementKind[] = ['delivered', 'opens', 'clicks', 'replies', 'visits'];

/**
 * The trend chart's series (#565): one hue family (`--viz-*`), told apart by dash pattern and the
 * legend, never by colour alone. See CLAUDE.md "Charts (#161)".
 */
export const ENGAGEMENT_SERIES: { key: EngagementKind; label: string; color: string; dash: string | null }[] = [
	{ key: 'delivered', label: 'Delivered', color: 'var(--viz-3)', dash: null },
	{ key: 'opens', label: 'Human opens', color: 'var(--viz-2)', dash: '6 3' },
	{ key: 'clicks', label: 'Clicks', color: 'var(--viz-1)', dash: null },
	{ key: 'replies', label: 'Replies', color: 'var(--viz-1)', dash: '2 3' },
	{ key: 'visits', label: 'Site visits', color: 'var(--viz-2)', dash: '9 3 2 3' }
];

export type EngagementPoint = GrowthBucket & Record<EngagementKind, number>;

/** The series' weekly buckets (oldest first), local days at `offsetMin` from UTC. */
export function engagementBuckets(now: Date, offsetMin: number): GrowthBucket[] {
	return growthBuckets('90d', now, offsetMin);
}

/** Per-local-day counts by kind → one point per weekly bucket (other days dropped). */
export function fillEngagement(buckets: GrowthBucket[], rows: { d: string; kind: string; n: number }[]): EngagementPoint[] {
	const idx = new Map(buckets.map((b, i) => [b.start, i]));
	const points: EngagementPoint[] = buckets.map((b) => ({ ...b, delivered: 0, opens: 0, clicks: 0, replies: 0, visits: 0 }));
	for (const r of rows) {
		if (!ENGAGEMENT_KINDS.includes(r.kind as EngagementKind)) continue;
		const i = idx.get(bucketOf(r.d, 'week'));
		if (i !== undefined) points[i][r.kind as EngagementKind] += r.n;
	}
	return points;
}

/** Which data sources this company has — a tile only shows when its source exists. */
export type DashboardSources = {
	contacts: boolean; // at least one active contact
	pipeline: boolean; // a contact of theirs has a pipeline card (any stage)
	timing: boolean; // Timing synced for this company
	github: boolean; // GitHub synced for this company
	billing: boolean; // the viewer may see billing AND Zoho synced for this company
};

export type TileKey =
	| 'contacts'
	| 'engaged'
	| 'last_touch'
	| 'awaiting'
	| 'deals'
	| 'hours'
	| 'issues'
	| 'outstanding'
	| 'overdue';

const TILE_SOURCE: Record<TileKey, keyof DashboardSources | null> = {
	contacts: null, // always: "0 contacts" is itself the answer
	engaged: 'contacts',
	last_touch: null, // shown whenever there is a touch at all (checked by the caller)
	awaiting: 'contacts',
	deals: 'pipeline',
	hours: 'timing',
	issues: 'github',
	outstanding: 'billing',
	overdue: 'billing'
};

export const TILE_ORDER: TileKey[] = ['contacts', 'engaged', 'last_touch', 'awaiting', 'deals', 'hours', 'issues', 'outstanding', 'overdue'];

/** The visible tiles, in order. `hasTouch` = a last-touch time exists. */
export function visibleTiles(src: DashboardSources, hasTouch: boolean): TileKey[] {
	return TILE_ORDER.filter((k) => {
		if (k === 'last_touch') return hasTouch;
		const s = TILE_SOURCE[k];
		return s === null || src[s];
	});
}

function toMs(v: string | null | undefined): number {
	if (!v) return NaN;
	const s = v.trim();
	// SQLite 'YYYY-MM-DD HH:MM:SS' is UTC; ISO strings carry their own zone.
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
	return Date.parse(iso);
}

/** The newest of several date-times (SQLite UTC or ISO), as given; null when none parse. */
export function newestOf(...values: (string | null | undefined)[]): string | null {
	let best: string | null = null;
	let bestMs = -Infinity;
	for (const v of values) {
		const ms = toMs(v);
		if (Number.isFinite(ms) && ms > bestMs) {
			bestMs = ms;
			best = v!;
		}
	}
	return best;
}

/**
 * "Going quiet" — a rule, not a score: Timing hours in the last 90 days but none in the last
 * 30, and no touch (engagement, reply, visit, Timing entry, GitHub issue) in 30 days either.
 */
export function isGoingQuiet(
	m: { hours_90d: number | null; hours_30d: number | null; last_touch_at: string | null },
	now: Date
): boolean {
	if (!((m.hours_90d ?? 0) > 0) || (m.hours_30d ?? 0) > 0) return false;
	const touch = toMs(m.last_touch_at);
	return !Number.isFinite(touch) || now.getTime() - touch >= ENGAGED_DAYS * 86_400_000;
}
