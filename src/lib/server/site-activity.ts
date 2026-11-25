// Site tracking read side (#153): what the contact page shows from `site_events` — the
// rows merged into the Activity timeline, and the Site activity card's summary. Ingest,
// identity and pruning live in site-tracking.ts / track-token.ts.

import { containsSql } from './sql-match';

export type TimelineItem = { kind: string; at: string; campaign_id: number | null; label: string; url: string | null };

/** Newest first, rows without a time dropped, cut to `limit`. Stable for equal times. */
export function mergeTimeline(sources: TimelineItem[][], limit: number): TimelineItem[] {
	return sources
		.flat()
		.filter((a) => a.at)
		.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
		.slice(0, limit);
}

/** `{"plan":"pro","seats":3}` → `plan: pro, seats: 3` (first 3 keys, ≤80 chars). */
export function propsSummary(props: string | null): string {
	if (!props) return '';
	let obj: unknown;
	try {
		obj = JSON.parse(props);
	} catch {
		return '';
	}
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
	const parts = Object.entries(obj as Record<string, unknown>)
		.slice(0, 3)
		.map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
	const s = parts.join(', ');
	return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

type SiteEventRow = {
	kind: string;
	name: string;
	path: string | null;
	props: string | null;
	occurred_at: string;
	site_domain: string | null;
};

/** Timeline rows: pageview → `Visited /pricing · example.com`, event → `Did «booked_call» · props`. */
export async function siteTimeline(db: D1Database, contactId: number, limit = 100): Promise<TimelineItem[]> {
	const rows = await db
		.prepare(
			`SELECT se.kind, se.name, se.path, se.props, se.occurred_at, ts.domain AS site_domain
			 FROM site_events se LEFT JOIN tracking_sites ts ON ts.id = se.site_id
			 WHERE se.contact_id = ? ORDER BY se.occurred_at DESC, se.id DESC LIMIT ?`
		)
		.bind(contactId, limit)
		.all<SiteEventRow>();
	return rows.results.map((r) => {
		if (r.kind === 'event') {
			const props = propsSummary(r.props);
			return { kind: 'site_event', at: r.occurred_at, campaign_id: null, label: `«${r.name}»${props ? ` · ${props}` : ''}`, url: null };
		}
		const site = r.site_domain ? ` · ${r.site_domain}` : '';
		return { kind: 'visited', at: r.occurred_at, campaign_id: null, label: `${r.path ?? '/'}${site}`, url: null };
	});
}

export type SiteActivitySummary = {
	lastSeen: string | null;
	pageviews30d: number;
	topPaths: { path: string; n: number }[];
	firstTouch: { at: string; utm: Record<string, string> } | null;
};

/** The Site activity card: last seen, pageviews in 30 days, top 5 paths, first-touch UTM. */
export async function siteActivitySummary(db: D1Database, contactId: number): Promise<SiteActivitySummary> {
	const [stats, paths, first] = await Promise.all([
		db
			.prepare(
				`SELECT MAX(occurred_at) AS last_seen,
				        SUM(CASE WHEN kind = 'pageview' AND occurred_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS pv30
				 FROM site_events WHERE contact_id = ?`
			)
			.bind(contactId)
			.first<{ last_seen: string | null; pv30: number | null }>(),
		db
			.prepare(
				`SELECT COALESCE(path, '/') AS path, COUNT(*) AS n FROM site_events
				 WHERE contact_id = ? AND kind = 'pageview'
				 GROUP BY COALESCE(path, '/') ORDER BY n DESC, MAX(occurred_at) DESC LIMIT 5`
			)
			.bind(contactId)
			.all<{ path: string; n: number }>(),
		db
			.prepare(
				`SELECT occurred_at, utm FROM site_events WHERE contact_id = ? AND utm IS NOT NULL
				 ORDER BY occurred_at ASC, id ASC LIMIT 1`
			)
			.bind(contactId)
			.first<{ occurred_at: string; utm: string }>()
	]);

	let firstTouch: SiteActivitySummary['firstTouch'] = null;
	if (first) {
		try {
			const utm = JSON.parse(first.utm);
			if (utm && typeof utm === 'object' && !Array.isArray(utm)) firstTouch = { at: first.occurred_at, utm };
		} catch {
			/* malformed utm — skip */
		}
	}

	return {
		lastSeen: stats?.last_seen ?? null,
		pageviews30d: stats?.pv30 ?? 0,
		topPaths: paths.results,
		firstTouch
	};
}

/**
 * The `visited` Condition kind (#154): has the contact viewed a page whose path contains
 * `match` (mode `page`) or done the named custom event (mode `event`, exact name) — within
 * the last `days` days, or ever when `days` is 0. Same matching as the segment rules.
 */
export async function contactMatchesVisited(
	db: D1Database,
	contactId: number,
	c: { mode: 'page' | 'event'; match: string; days: number }
): Promise<boolean> {
	const page = c.mode === 'page';
	// #485: the path match is instr, not LIKE (D1 caps LIKE patterns at 50 bytes).
	const binds: unknown[] = [contactId, page ? 'pageview' : 'event', c.match];
	if (c.days > 0) binds.push(`-${c.days} days`);
	const row = await db
		.prepare(
			`SELECT 1 FROM site_events
			 WHERE contact_id = ? AND kind = ? AND ${page ? containsSql("COALESCE(path, '')") : 'name = ?'}
			 ${c.days > 0 ? `AND occurred_at >= datetime('now', ?)` : ''} LIMIT 1`
		)
		.bind(...binds)
		.first();
	return !!row;
}

/** Per-contact Stop tracking toggle (`contacts.tracking_optout`): beacons are dropped while set. */
export async function setTrackingOptout(db: D1Database, contactId: number, optout: boolean): Promise<boolean> {
	const r = await db
		.prepare('UPDATE contacts SET tracking_optout = ? WHERE id = ?')
		.bind(optout ? 1 : 0, contactId)
		.run();
	return (r.meta.changes ?? 0) > 0;
}
