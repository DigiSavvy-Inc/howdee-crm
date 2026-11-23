// Read-only half of the resend feature (#246/#451): the per-pass (original vs resend)
// breakdown of a sent campaign. Imports nothing, so read-only callers (the dashboard, which
// the MCP server / Data API reach) can use it without pulling in resend.ts → send.ts →
// postmark.ts. resend.ts re-exports it for its existing callers.

/** One pass of a campaign (#246): the original send or the resend to non-openers. */
export type PassStats = { sent: number; opens: number; clicks: number };
export type PassBreakdown = { original: PassStats; resend: PassStats };

/**
 * Per-pass breakdown of a campaign (#246). Events attribute to a pass through
 * `events.recipient_id` → `recipients.send_pass` ('resend', else original — NULL rows
 * predate 0070). Opens/clicks are recipient rows with at least one such event, so the two
 * passes add up to the combined tiles' COUNT(DISTINCT recipient_id). Sent counts accepted
 * rows, like the Sent tile.
 */
export async function resendPassBreakdown(db: D1Database, campaignId: number): Promise<PassBreakdown> {
	const rows = await db
		.prepare(
			`SELECT CASE WHEN r.send_pass = 'resend' THEN 'resend' ELSE 'original' END AS pass,
			        SUM(CASE WHEN r.status = 'accepted' THEN 1 ELSE 0 END) AS sent,
			        SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.campaign_id = r.campaign_id AND e.type = 'open') THEN 1 ELSE 0 END) AS opens,
			        SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.recipient_id = r.id AND e.campaign_id = r.campaign_id AND e.type = 'click') THEN 1 ELSE 0 END) AS clicks
			 FROM recipients r
			 WHERE r.campaign_id = ?
			 GROUP BY pass`
		)
		.bind(campaignId)
		.all<{ pass: 'original' | 'resend'; sent: number | null; opens: number | null; clicks: number | null }>();
	const out: PassBreakdown = {
		original: { sent: 0, opens: 0, clicks: 0 },
		resend: { sent: 0, opens: 0, clicks: 0 }
	};
	for (const r of rows.results) out[r.pass] = { sent: r.sent ?? 0, opens: r.opens ?? 0, clicks: r.clicks ?? 0 };
	return out;
}
