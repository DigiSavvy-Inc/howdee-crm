// #154: the "Visits a page" (`site_visit`) automation trigger, evaluated at ingest time by
// /api/track. Separate from ./site-activity because it enrolls through the engine
// (./automations imports site-activity for the `visited` Condition — avoids an import cycle).

import { DEFAULT_COOLDOWN_HOURS, pathMatches } from '$lib/site-trigger';
import { enroll } from './automations';
import { sqlTime } from './site-tracking';
import { recordPendingTriggers } from './automation-flow';

export type SiteVisitSummary = { matched: number; enrolled: number; cooling: number };

type TriggerRow = {
	id: number;
	status: string;
	trigger_path_op: string | null;
	trigger_path: string | null;
	trigger_cooldown_hours: number | null;
	last_fired: string | null;
};

/**
 * A stored pageview → enroll the contact into every ACTIVE `site_visit` automation whose
 * site (NULL = any) and path pattern match. Per (automation, contact) cooldown: if the
 * trigger enrolled this contact less than `trigger_cooldown_hours` ago (default 24), skip —
 * so a refresh or a second matching page doesn't re-trigger. `enroll()` applies the rest
 * (unsubscribed skipped, one active pass, the automation's re-entry policy). The cooldown
 * clock only starts when a pass was actually created.
 */
export async function fireSiteVisitTriggers(
	db: D1Database,
	ev: { siteId: number; contactId: number; path: string | null },
	now: Date = new Date()
): Promise<SiteVisitSummary> {
	const summary: SiteVisitSummary = { matched: 0, enrolled: 0, cooling: 0 };
	const autos = await db
		.prepare(
			`SELECT a.id, a.status, a.trigger_path_op, a.trigger_path, a.trigger_cooldown_hours, f.fired_at AS last_fired
			 FROM automations a
			 LEFT JOIN site_visit_fires f ON f.automation_id = a.id AND f.contact_id = ?
			 WHERE a.status IN ('active', 'paused') AND a.trigger_type = 'site_visit'
			   AND (a.trigger_site_id IS NULL OR a.trigger_site_id = ?)`
		)
		.bind(ev.contactId, ev.siteId)
		.all<TriggerRow>();

	for (const a of autos.results) {
		if (!a.trigger_path || !pathMatches(ev.path, a.trigger_path_op ?? 'contains', a.trigger_path)) continue;
		// #397: a paused automation records the trigger (offered on resume), never enrolls.
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, [ev.contactId], 'site_visit');
			continue;
		}
		summary.matched++;
		const hours = a.trigger_cooldown_hours ?? DEFAULT_COOLDOWN_HOURS;
		if (a.last_fired && hours > 0) {
			const last = Date.parse(a.last_fired.replace(' ', 'T') + 'Z');
			if (Number.isFinite(last) && now.getTime() - last < hours * 3_600_000) {
				summary.cooling++;
				continue;
			}
		}
		const res = await enroll(db, a.id, [ev.contactId], { now });
		if (res.enrolled === 0) continue;
		summary.enrolled++;
		await db
			.prepare(
				`INSERT INTO site_visit_fires (automation_id, contact_id, fired_at) VALUES (?, ?, ?)
				 ON CONFLICT(automation_id, contact_id) DO UPDATE SET fired_at = excluded.fired_at`
			)
			.bind(a.id, ev.contactId, sqlTime(now.getTime()))
			.run();
	}
	return summary;
}
