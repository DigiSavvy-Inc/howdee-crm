// Campaign engagement breakdown (#161) — the numbers behind the campaign page's
// "Engagement" bar: who interacted with a send vs. who didn't, unique per recipient.
//
// Segments are mutually exclusive by precedence (clicked ⊃ opened):
//   clicked    — accepted recipients with ≥1 click (an open is implied, recorded or not)
//   openedOnly — ≥1 open, no click
//   none       — delivered, no open/click (accepted minus the two above minus bounced)
// Bounced / unsubscribed are NOT segments — the page shows them as a muted note. A
// bounced recipient with no engagement is left out of `none` (never delivered); one that
// somehow also engaged stays in its engagement segment.
//
// Opens are counted as-is (Apple MPP inflates them). `proxyOpens` is how many of the
// openedOnly recipients had ONLY machine opens per `classifyProxyOpen` (#111/#113) —
// surfaced as "incl. N auto-opens" in the legend tooltip; the bar itself doesn't change.
import { classifyProxyOpen } from './engagement';
import type { EngagementCounts } from '$lib/engagement-bar';

export type EngagementBreakdown = EngagementCounts;

export type EngagementSegment = 'clicked' | 'opened' | 'none';

// Correlated per-recipient flags, shared by the counts and the ?who= drill-down lists.
// Keyed on campaign_id too so idx_events_campaign_type (campaign_id, type, recipient_id)
// covers the lookup — events has no recipient_id-leading index.
const HAS = (type: string) =>
	`EXISTS (SELECT 1 FROM events x WHERE x.campaign_id = r.campaign_id AND x.type = '${type}' AND x.recipient_id = r.id)`;

/** SQL predicate (over `recipients r`) selecting one segment's recipients. */
export function segmentWhere(seg: EngagementSegment): string {
	if (seg === 'clicked') return HAS('click');
	if (seg === 'opened') return `${HAS('open')} AND NOT ${HAS('click')}`;
	return `NOT ${HAS('open')} AND NOT ${HAS('click')} AND NOT ${HAS('bounce')}`;
}

export async function engagementBreakdown(db: D1Database, campaignId: number): Promise<EngagementBreakdown> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS sent,
			        COALESCE(SUM(CASE WHEN ${segmentWhere('clicked')} THEN 1 ELSE 0 END), 0) AS clicked,
			        COALESCE(SUM(CASE WHEN ${segmentWhere('opened')} THEN 1 ELSE 0 END), 0) AS opened_only,
			        COALESCE(SUM(CASE WHEN ${segmentWhere('none')} THEN 1 ELSE 0 END), 0) AS none,
			        COALESCE(SUM(CASE WHEN ${HAS('bounce')} THEN 1 ELSE 0 END), 0) AS bounced,
			        COALESCE(SUM(CASE WHEN ${HAS('unsubscribe')} THEN 1 ELSE 0 END), 0) AS unsubscribed
			 FROM recipients r
			 WHERE r.campaign_id = ? AND r.status = 'accepted'`
		)
		.bind(campaignId)
		.first<{ sent: number; clicked: number; opened_only: number; none: number; bounced: number; unsubscribed: number }>();

	// Opens of the openedOnly recipients, with that recipient's delivery time (the
	// FirstOpen-within-60s half of the heuristic needs it).
	const opens = await db
		.prepare(
			`SELECT e.recipient_id, e.detail, e.recorded_at,
			        (SELECT MIN(d.recorded_at) FROM events d
			          WHERE d.campaign_id = r.campaign_id AND d.type = 'delivery' AND d.recipient_id = e.recipient_id) AS delivered_at
			 FROM events e
			 JOIN recipients r ON r.id = e.recipient_id
			 WHERE r.campaign_id = ? AND r.status = 'accepted' AND e.campaign_id = r.campaign_id AND e.type = 'open'
			   AND NOT ${HAS('click')}`
		)
		.bind(campaignId)
		.all<{ recipient_id: number; detail: string | null; recorded_at: string; delivered_at: string | null }>();

	// A recipient counts as an auto-open only when every one of its opens is a proxy open.
	const human = new Map<number, boolean>();
	for (const o of opens.results) {
		let detail: unknown = {};
		if (o.detail) {
			try {
				detail = JSON.parse(o.detail);
			} catch {
				detail = {};
			}
		}
		const isProxy = classifyProxyOpen(detail, o.delivered_at, o.recorded_at);
		human.set(o.recipient_id, (human.get(o.recipient_id) ?? false) || !isProxy);
	}
	let proxyOpens = 0;
	for (const h of human.values()) if (!h) proxyOpens++;

	return {
		sent: row?.sent ?? 0,
		clicked: row?.clicked ?? 0,
		openedOnly: row?.opened_only ?? 0,
		none: row?.none ?? 0,
		bounced: row?.bounced ?? 0,
		unsubscribed: row?.unsubscribed ?? 0,
		proxyOpens
	};
}
