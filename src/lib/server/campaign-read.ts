// Campaign page reads shared with the assistant's read tools (#287): link clicks and
// captured replies for one campaign. Moved verbatim out of /campaign/[id]/+page.server.ts.

import { displayText } from '$lib/email-text';

/** `unsubscribe: true` = the collapsed "Unsubscribe page" row (#518); its `url` is that label. */
export type CampaignLink = { url: string; unique_clicks: number; total_clicks: number; unsubscribe?: boolean };
export type CampaignReply = {
	id: number;
	contact_id: number | null;
	from_email: string;
	subject: string | null;
	text: string | null;
	received_at: string;
};

/** Link-level click breakdown (#69) — Postmark puts the clicked URL in the event payload's
 *  OriginalLink; the webhook stored the payload JSON in events.detail. Top 50. */
export async function campaignLinks(db: D1Database, campaignId: number): Promise<CampaignLink[]> {
	const links = await db
		.prepare(
			`SELECT json_extract(detail, '$.OriginalLink') AS url,
			        COUNT(DISTINCT recipient_id) AS unique_clicks,
			        COUNT(*) AS total_clicks
			 FROM events
			 WHERE campaign_id = ? AND type = 'click' AND json_extract(detail, '$.OriginalLink') IS NOT NULL
			 GROUP BY url ORDER BY unique_clicks DESC, total_clicks DESC LIMIT 50`
		)
		.bind(campaignId)
		.all<CampaignLink>();
	// #518: every per-recipient unsubscribe link (`unsubscribe_click` rows) as one last row.
	const unsub = await db
		.prepare(
			`SELECT COUNT(DISTINCT recipient_id) AS unique_clicks, COUNT(*) AS total_clicks
			 FROM events WHERE campaign_id = ? AND type = 'unsubscribe_click'`
		)
		.bind(campaignId)
		.first<{ unique_clicks: number; total_clicks: number }>();
	const out: CampaignLink[] = links.results;
	if (unsub?.total_clicks) out.push({ url: 'Unsubscribe page', unique_clicks: unsub.unique_clicks, total_clicks: unsub.total_clicks, unsubscribe: true });
	return out;
}

/** #518: link fetches by security scanners on this campaign (`scanner_click` rows), hidden from the counts. */
export async function campaignScannerFetches(db: D1Database, campaignId: number): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type = 'scanner_click'`)
		.bind(campaignId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Replies captured for this campaign (inbound), newest first. */
export async function campaignReplies(db: D1Database, campaignId: number): Promise<CampaignReply[]> {
	const replies = await db
		.prepare(
			`SELECT r.id, r.contact_id, r.from_email, r.subject, r.text, r.received_at
			 FROM replies r WHERE r.campaign_id = ? ORDER BY r.received_at DESC`
		)
		.bind(campaignId)
		.all<CampaignReply>();
	// #380: rows stored before the ingest fix may hold HTML as text.
	return replies.results.map((r) => ({ ...r, text: displayText(r.text) || null }));
}
