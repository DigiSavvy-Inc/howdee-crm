// Deliverability numbers shared by /deliverability and the assistant's read tools (#287).
// Moved verbatim out of src/routes/deliverability/+page.server.ts.

import { bouncedClause } from './bounce-filter';

export const BOUNCE_WARN = 0.05; // 5%
export const COMPLAINT_WARN = 0.001; // 0.1%

export type DeliverabilityRates = {
	window: string;
	sent: number;
	bounces: number;
	complaints: number;
	unsubs: number;
	bounceRate: number;
	complaintRate: number;
	bounceWarn: boolean;
	complaintWarn: boolean;
};

/** Rates over the last 90 days of activity (#67). */
export async function deliverabilityRates(db: D1Database): Promise<DeliverabilityRates> {
	const rates = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
			      WHERE r.status = 'accepted' AND COALESCE(c.sent_at, c.created_at) >= datetime('now','-90 days')) AS sent,
			   (SELECT COUNT(*) FROM events WHERE type = 'bounce' AND recorded_at >= datetime('now','-90 days')) AS bounces,
			   (SELECT COUNT(*) FROM events WHERE type = 'spam' AND recorded_at >= datetime('now','-90 days')) AS complaints,
			   (SELECT COUNT(*) FROM events WHERE type = 'unsubscribe' AND recorded_at >= datetime('now','-90 days')) AS unsubs`
		)
		.first<{ sent: number; bounces: number; complaints: number; unsubs: number }>();

	const sent = rates?.sent ?? 0;
	const bounceRate = sent ? (rates?.bounces ?? 0) / sent : 0;
	const complaintRate = sent ? (rates?.complaints ?? 0) / sent : 0;
	return {
		window: '90 days',
		sent,
		bounces: rates?.bounces ?? 0,
		complaints: rates?.complaints ?? 0,
		unsubs: rates?.unsubs ?? 0,
		bounceRate,
		complaintRate,
		bounceWarn: bounceRate > BOUNCE_WARN,
		complaintWarn: complaintRate > COMPLAINT_WARN
	};
}

/** #279: everyone with a bounce, and those of them still subscribed. Those links open the
 *  Active view, so archived contacts (#280) are left out of the counts. */
export async function bouncedCounts(db: D1Database): Promise<{ total: number; subscribed: number }> {
	const bounced = bouncedClause('any', 'c.id').clause;
	const counts = await db
		.prepare(
			`SELECT COUNT(*) AS n, COALESCE(SUM(c.subscribed = 1), 0) AS still FROM contacts c WHERE ${bounced} AND c.archived_at IS NULL`
		)
		.first<{ n: number; still: number }>();
	return { total: counts?.n ?? 0, subscribed: counts?.still ?? 0 };
}

export async function suppressedTotal(db: D1Database): Promise<number> {
	return (await db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE subscribed = 0').first<{ n: number }>())?.n ?? 0;
}
