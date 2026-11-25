import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { recentActivity, parseFeedFilter, feedTypes, getFeedSize, setFeedSize, FEED_FILTERS, FEED_SIZES } from '$lib/server/activity';
import { lastCampaign, loadPipelineTile, loadTiles, recentCampaigns, upcomingSends, recentUnsubscribes, stuckSends } from '$lib/server/dashboard';
import { engagementStatus } from '$lib/server/engagement';
import { GOING_QUIET_FILTER, goingQuietCount } from '$lib/server/company-metrics';
import { tierTrend, engagementHeatmap, goingCold, goingColdIds } from '$lib/server/engagement-insights';
import { getTimezone } from '$lib/server/settings';
import { accountsToLookAt } from '$lib/server/ai/account-brief';
import { canSeeBilling } from '$lib/server/integrations/zoho';
import { authBounces, domainAuthAlert } from '$lib/server/domain-auth';
import { activeAlerts, weeklyDigest } from '$lib/server/deliverability-alerts';
import { preflightHolds } from '$lib/server/preflight';
import { BAND_MOVE_DAYS, scoresOverview } from '$lib/server/scoring/reports';
import { localRequiredAttention } from '$lib/server/setup-checks';
import { autoEnroll, enrollContactsInAutomation, listActiveAutomations } from '$lib/server/automations';

// The send log + campaign tiles moved to /campaigns (#132); the dashboard revamp is a
// follow-up under #131.
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);

	// Dashboard revamp (#133): tiles, activity feed, recent/upcoming sends, unsubscribes,
	// engagement tiers.
	const feed = parseFeedFilter(event.url.searchParams.get('feed'));
	const feedSize = await getFeedSize(db);
	const tz = await getTimezone(db);
	const [tiles, activity, recent, upcoming, unsubscribes, engagement, goingQuiet, trend, heatmap, cold, segments, automations, pipeline, alerts, digest, last, scores, stuck] = await Promise.all([
		loadTiles(db),
		recentActivity(db, { limit: feedSize, types: feedTypes(feed) }),
		recentCampaigns(db),
		upcomingSends(db),
		recentUnsubscribes(db),
		engagementStatus(db),
		goingQuietCount(db),
		// Engagement intelligence (#116).
		tierTrend(db),
		engagementHeatmap(db, tz),
		goingCold(db),
		// Hand-picked segments only: a dynamic (rules) segment has no members to add to.
		db
			.prepare(`SELECT id, name FROM lists WHERE kind = 'segment' AND rules IS NULL AND archived_at IS NULL ORDER BY name COLLATE NOCASE`)
			.all<{ id: number; name: string }>()
			.then((r) => r.results),
		listActiveAutomations(db),
		loadPipelineTile(db), // #207
		activeAlerts(db), // #305
		weeklyDigest(db),
		lastCampaign(db, tz), // #451
		scoresOverview(db), // #468
		stuckSends(db) // #536
	]);

	// Automation health (#26). The heartbeat crons every minute (#92); a tick older than ~10
	// intervals (or never, with active automations) means the heartbeat is down. Overdue =
	// active enrollments whose next step was due >30 min ago and still hasn't run.
	const health = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM automations WHERE status = 'active') AS active_automations,
			   (SELECT updated_at FROM app_state WHERE key = 'last_tick') AS last_tick_at,
			   (SELECT CAST((julianday('now') - julianday(updated_at)) * 1440 AS INTEGER)
			      FROM app_state WHERE key = 'last_tick') AS tick_age_min,
			   (SELECT COUNT(*) FROM automation_enrollments
			      WHERE status = 'active' AND next_run_at IS NOT NULL
			        AND next_run_at < datetime('now', '-30 minutes')) AS overdue`
		)
		.first<{ active_automations: number; last_tick_at: string | null; tick_age_min: number | null; overdue: number }>();

	// Domain authentication (#304): the pass → fail banner and the DMARC / 5.7.x bounce watch.
	const [domainAlert, authBounceRows] = await Promise.all([domainAuthAlert(db), authBounces(db)]);

	// Account briefs (#388): "Accounts to look at" — the variant this user may see.
	const accounts = await accountsToLookAt(db, await canSeeBilling(db, event.locals.user), 5);

	const h = health ?? { active_automations: 0, last_tick_at: null, tick_age_min: null, overdue: 0 };
	// #537: late whether or not an automation is active (scheduled sends, backups and syncs ride it
	// too). A never-ticked heartbeat still only warns once something is waiting on it.
	const heartbeatStale = h.tick_age_min === null ? h.active_automations > 0 : h.tick_age_min > 10;

	// #609: admins see a notice while a required setup check needs attention (local checks only —
	// the dashboard never calls Postmark; Settings → Setup does).
	const setupAttention =
		event.locals.user?.role === 'admin'
			? await localRequiredAttention(db, event.platform?.env as unknown as Record<string, unknown> | undefined).catch(() => 0)
			: 0;

	return {
		tiles,
		pipeline,
		activity,
		feed,
		feedSize,
		feedFilters: FEED_FILTERS.map(({ key, label }) => ({ key, label })),
		feedSizes: FEED_SIZES,
		last,
		recent,
		upcoming,
		unsubscribes,
		tiers: engagement.tiers,
		scores,
		scoreMoveDays: BAND_MOVE_DAYS,
		health: { ...h, heartbeatStale },
		setupAttention,
		stuck,
		domainAlert,
		authBounces: authBounceRows.length,
		// #479: scheduled sends held by their pre-send checks (banner).
		preflightHolds: await preflightHolds(db),
		// #170: companies with hours in 90d but none in 30d → their contacts on /contacts.
		goingQuiet,
		goingQuietHref: `/contacts?cm=${encodeURIComponent(GOING_QUIET_FILTER)}`,
		trend,
		heatmap,
		cold,
		segments,
		automations,
		alerts,
		digest,
		accounts
	};
};

export const actions: Actions = {
	// Activity feed size picker (#133) — persisted in app_state.
	feedSize: async (event) => {
		const data = await event.request.formData();
		const ok = await setFeedSize(getDB(event), Number(data.get('size')));
		if (!ok) return fail(400, { error: 'Pick 25, 50 or 100.' });
		return { ok: true };
	},

	// Going cold (#116): add every going-cold contact to a hand-picked segment (existing or
	// new). Fires list_added automations like any other add-to-segment.
	coldToSegment: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const segmentId = Number(data.get('segment_id')) || null;
		const newName = String(data.get('new_segment') ?? '').trim();
		if (!segmentId && !newName) return fail(400, { coldError: 'Pick a segment or name a new one.' });

		const ids = await goingColdIds(db);
		if (ids.length === 0) return fail(400, { coldError: 'Nobody is going cold right now.' });

		let target: { id: number; name: string } | null;
		if (segmentId) {
			target = await db
				.prepare(`SELECT id, name FROM lists WHERE id = ? AND kind = 'segment' AND rules IS NULL`)
				.bind(segmentId)
				.first<{ id: number; name: string }>();
			if (!target) return fail(400, { coldError: 'That segment no longer exists.' });
		} else {
			target =
				(await db
					.prepare(`SELECT id, name FROM lists WHERE name = ? AND kind = 'segment'`)
					.bind(newName)
					.first<{ id: number; name: string }>()) ??
				(await db
					.prepare(`INSERT INTO lists (name, kind) VALUES (?, 'segment') RETURNING id, name`)
					.bind(newName)
					.first<{ id: number; name: string }>());
		}
		if (!target) return fail(500, { coldError: 'Could not create the segment.' });
		const { id: listId, name: listName } = target;

		const link = db.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)');
		for (let i = 0; i < ids.length; i += 50) {
			await db.batch(ids.slice(i, i + 50).map((cid) => link.bind(listId, cid)));
		}
		try {
			await autoEnroll(db, listId, ids);
		} catch (e) {
			console.error('auto-enroll (going cold → segment) failed:', e);
		}
		return { coldOk: `Added ${ids.length} contact${ids.length === 1 ? '' : 's'} to “${listName}”.`, coldListId: listId };
	},

	// Going cold (#116): enroll every going-cold contact in an active automation (a
	// re-engagement flow). Same rules as the bulk-bar enroll: active + ≥1 step, unsubscribed
	// and already-in-flow contacts skipped.
	coldEnroll: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const automationId = Number(data.get('automation_id'));
		if (!Number.isInteger(automationId) || automationId <= 0) {
			return fail(400, { coldError: 'Pick an automation.' });
		}
		const ids = await goingColdIds(db);
		if (ids.length === 0) return fail(400, { coldError: 'Nobody is going cold right now.' });
		const result = await enrollContactsInAutomation(db, automationId, ids);
		if (!result.ok) return fail(400, { coldError: result.error });
		return {
			coldOk: `Enrolled ${result.enrolled} in “${result.automationName}”${result.skipped ? ` (${result.skipped} skipped — already in it or unsubscribed)` : ''}.`,
			coldAutomationId: automationId
		};
	}
};
