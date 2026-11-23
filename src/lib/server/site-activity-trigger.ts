// #434: the "Visits the site often" (`site_activity`) automation trigger, evaluated at ingest
// time by /api/track right after the `site_visit` hook. Config shape + session counting in
// universal `$lib/site-activity-trigger`.

import { countVisits, pageCounts, parseSiteActivityConfig, SITE_ACTIVITY_ROW_CAP, type SiteActivityConfig } from '$lib/site-activity-trigger';
import { enroll } from './automations';
import { sqlTime } from './site-tracking';
import { recordPendingTriggers } from './automation-flow';

export type SiteActivitySummary = { matched: number; enrolled: number; cooling: number };

type TriggerRow = { id: number; status: string; trigger_config: string | null; last_fired: string | null };

/**
 * The contact's count for one trigger: pageviews (`pages`) or visits (`visits`) on the
 * trigger's site (any when null) whose path matches, in the last `days` days. The pageview
 * that called the hook is already stored, so it is counted here exactly once — the window is
 * `occurred_at >= now − days` with no upper bound, and the caller fires on `count >= threshold`.
 * Reads the newest SITE_ACTIVITY_ROW_CAP pageviews only (the threshold is at most 1,000).
 */
export async function siteActivityCount(
	db: D1Database,
	contactId: number,
	cfg: SiteActivityConfig,
	now: Date = new Date()
): Promise<number> {
	const since = sqlTime(now.getTime() - cfg.days * 86_400_000);
	const rows = (
		await db
			.prepare(
				`SELECT occurred_at, path FROM site_events
				 WHERE contact_id = ? AND kind = 'pageview' AND occurred_at >= ? AND (? IS NULL OR site_id = ?)
				 ORDER BY occurred_at DESC LIMIT ?`
			)
			.bind(contactId, since, cfg.site_id, cfg.site_id, SITE_ACTIVITY_ROW_CAP)
			.all<{ occurred_at: string; path: string | null }>()
	).results.filter((r) => pageCounts(r.path, cfg));
	if (cfg.measure === 'pages') return rows.length;
	return countVisits(rows.map((r) => Date.parse(r.occurred_at.replace(' ', 'T') + 'Z')));
}

/**
 * A stored pageview → for every active / paused `site_activity` automation whose site and path
 * filter match this pageview, count the contact's activity in the window; at `threshold` or
 * more, enroll them unless the trigger enrolled them less than `cooldown_hours` ago. `enroll()`
 * applies the rest: unsubscribed / archived skipped, one active pass, the re-entry policy and
 * the automation's entry conditions (#412). Fires are stamped in `site_visit_fires` (keyed by
 * automation, so no clash with `site_visit`) only when a pass was created. A paused automation
 * records the contact as a pending trigger instead (#397).
 */
export async function fireSiteActivityTriggers(
	db: D1Database,
	ev: { siteId: number; contactId: number; path: string | null },
	now: Date = new Date()
): Promise<SiteActivitySummary> {
	const summary: SiteActivitySummary = { matched: 0, enrolled: 0, cooling: 0 };
	const autos = await db
		.prepare(
			`SELECT a.id, a.status, a.trigger_config, f.fired_at AS last_fired
			 FROM automations a
			 LEFT JOIN site_visit_fires f ON f.automation_id = a.id AND f.contact_id = ?
			 WHERE a.status IN ('active', 'paused') AND a.trigger_type = 'site_activity'`
		)
		.bind(ev.contactId)
		.all<TriggerRow>();

	for (const a of autos.results) {
		const cfg = parseSiteActivityConfig(a.trigger_config);
		if (cfg.site_id !== null && cfg.site_id !== ev.siteId) continue;
		if (!pageCounts(ev.path, cfg)) continue;
		if (a.status === 'active' && a.last_fired && cfg.cooldown_hours > 0) {
			const last = Date.parse(a.last_fired.replace(' ', 'T') + 'Z');
			if (Number.isFinite(last) && now.getTime() - last < cfg.cooldown_hours * 3_600_000) {
				summary.cooling++;
				continue;
			}
		}
		if ((await siteActivityCount(db, ev.contactId, cfg, now)) < cfg.threshold) continue;
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, [ev.contactId], 'site_activity');
			continue;
		}
		summary.matched++;
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
