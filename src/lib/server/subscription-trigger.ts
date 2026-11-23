// #444: the "Subscription changes" (`subscription_changed`) automation trigger. Every write
// that changes a contact's subscription calls `subscriptionChanged` after its rows commit:
// the unsubscribe page / one-click (unsubscribe.ts), the Postmark webhook and suppression
// sync, bulk unsubscribe / resubscribe (contact-bulk.ts, also the assistant and the Data API),
// API contact writes (contact-write.ts), the page's self-resubscribe and topic choices
// (`saveTopicChoicesAndFire` below). Config + matching in universal `$lib/subscription-trigger`.

import {
	parseSubscriptionConfig,
	subscriptionMatches,
	type SubscriptionEvent,
	type SubscriptionSource
} from '$lib/subscription-trigger';
import { enroll } from './automations';
import { recordPendingTriggers } from './automation-flow';
import { computeEngagement, markDirty } from './engagement';
import { saveTopicChanges } from './topics';

export type SubscriptionFire = { contactId: number; event: SubscriptionEvent; listId?: number | null; source?: SubscriptionSource | null };
export type SubscriptionSummary = { matched: number; enrolled: number; pending: number };

/** Above this many contacts the tier refresh is left to the heartbeat (marked dirty) instead of done inline. */
const INLINE_RECOMPUTE_MAX = 200;

/**
 * Fire every active `subscription_changed` automation whose events / topic / source match.
 * Enrolls with `allowUnsubscribed` (the engine skips email steps for them) — entry rules,
 * re-entry and the one-active-pass rule still apply; archived contacts are still skipped.
 * Paused automations record the contacts as pending triggers (#397). One enroll per
 * automation per call, so a contact is fired at most once per (automation, event) per call.
 */
export async function fireSubscriptionTriggers(
	db: D1Database,
	ev: Omit<SubscriptionFire, 'contactId'> & { contactId?: number; contactIds?: number[] },
	now: Date = new Date()
): Promise<SubscriptionSummary> {
	const ids = [...new Set([...(ev.contactIds ?? []), ...(ev.contactId ? [ev.contactId] : [])])].filter((n) => Number.isInteger(n) && n > 0);
	const summary: SubscriptionSummary = { matched: 0, enrolled: 0, pending: 0 };
	if (!ids.length) return summary;
	const autos = await db
		.prepare(
			`SELECT id, status, trigger_config FROM automations
			 WHERE status IN ('active', 'paused') AND trigger_type = 'subscription_changed' ORDER BY id`
		)
		.all<{ id: number; status: string; trigger_config: string | null }>();
	for (const a of autos.results) {
		const cfg = parseSubscriptionConfig(a.trigger_config);
		if (!subscriptionMatches(cfg, ev)) continue;
		if (a.status === 'paused') {
			await recordPendingTriggers(db, a.id, ids, `subscription:${ev.event}`);
			summary.pending += ids.length;
			continue;
		}
		summary.matched++;
		const res = await enroll(db, a.id, ids, { now, allowUnsubscribed: true });
		summary.enrolled += res.enrolled;
	}
	return summary;
}

/**
 * The one call the write paths make, best-effort (never throws — a trigger or engagement
 * failure must not fail an unsubscribe): refresh the engagement tier for subscribe-state
 * changes (an unsubscribed contact's tier is `cold`, #444), then fire the triggers.
 * `triggers: false` (#551, the assistant) keeps the tier refresh but fires nothing: no
 * enrollment, no pending trigger.
 */
export async function subscriptionChanged(
	db: D1Database,
	contactIds: number[],
	event: SubscriptionEvent,
	opts: { listId?: number | null; source?: SubscriptionSource | null; now?: Date; triggers?: boolean } = {}
): Promise<void> {
	const ids = [...new Set(contactIds)].filter((n) => Number.isInteger(n) && n > 0);
	if (!ids.length) return;
	if (event !== 'topic_optout' && event !== 'topic_optin') {
		try {
			if (ids.length <= INLINE_RECOMPUTE_MAX) await computeEngagement(db, { contactIds: ids, now: opts.now });
			else await markDirty(db, ids);
		} catch (e) {
			console.error('engagement refresh after subscription change failed:', e);
		}
	}
	if (opts.triggers === false) return;
	try {
		await fireSubscriptionTriggers(db, { contactIds: ids, event, listId: opts.listId ?? null, source: opts.source ?? null }, opts.now);
	} catch (e) {
		console.error('subscription_changed trigger failed:', e);
	}
}

/** The preference page's topic save + `topic_optout` / `topic_optin` for each real change. Returns the kept ids. */
export async function saveTopicChoicesAndFire(db: D1Database, contactId: number, topicIds: number[], keep: Set<number>): Promise<number[]> {
	const { kept, optedOut, optedIn } = await saveTopicChanges(db, contactId, topicIds, keep);
	for (const id of optedOut) await subscriptionChanged(db, [contactId], 'topic_optout', { listId: id });
	for (const id of optedIn) await subscriptionChanged(db, [contactId], 'topic_optin', { listId: id });
	return kept;
}
