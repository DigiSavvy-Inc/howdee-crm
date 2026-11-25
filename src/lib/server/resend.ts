import type { MailProvider } from './mail';
import { sendCampaignEmail, type SendableRecipient, type SendResult } from './send';
import { UNSUB_PLACEHOLDER } from './email';
import { campaignTopicId, withoutOptedOut } from './topics';

// "Resend to non-openers" (#81/#82) — Mailchimp-style resend of a sent campaign to
// original recipients who never opened it. Kept in its own file so the filtering
// logic is testable independent of the callers that invoke it.

/** Columns every send recipient needs (incl. tags + meta for conditional content) —
 *  same pattern as RECIPIENT_COLS in segments.ts. */
const RECIPIENT_COLS = `c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.meta,
	(SELECT GROUP_CONCAT(l.name) FROM list_members lm2 JOIN lists l ON l.id = lm2.list_id
	   WHERE lm2.contact_id = c.id AND l.kind = 'tag') AS tags`;

// Original accepted recipients of the campaign, joined to their contact record
// (falling back to an email match when the recipient row has no contact_id),
// excluding anyone with an open/bounce/spam event on this campaign, and requiring
// the contact still be subscribed (can't verify consent for a dropped contact) and not
// archived (#280).
// The event match checks BOTH recipient_id and contact_id (belt-and-braces) since
// webhook ingestion can record either depending on what Postmark's payload carries.
const BASE = `
	FROM recipients r
	JOIN contacts c
	  ON (r.contact_id IS NOT NULL AND c.id = r.contact_id)
	  OR (r.contact_id IS NULL AND c.email = r.email)
	WHERE r.campaign_id = ?
	  AND r.status = 'accepted'
	  AND c.subscribed = 1
	  AND c.archived_at IS NULL
	  AND NOT EXISTS (
	    SELECT 1 FROM events e
	    WHERE e.campaign_id = ?
	      AND e.type IN ('open', 'bounce', 'spam')
	      AND (e.recipient_id = r.id OR (e.contact_id IS NOT NULL AND e.contact_id = c.id))
	  )
`;

/** Original recipients of `campaignId` who never opened it (and didn't bounce/spam-complain),
 *  still subscribed. Shape matches SendableRecipient so it drops straight into sendCampaignEmail.
 *  GROUP BY c.id both dedupes (one row per contact) and satisfies "dedupe by email" (email is
 *  unique per contact). */
export async function nonOpenerRecipients(db: D1Database, campaignId: number): Promise<SendableRecipient[]> {
	const sql = `SELECT ${RECIPIENT_COLS} ${BASE} GROUP BY c.id ORDER BY c.id`;
	const rows = await db.prepare(sql).bind(campaignId, campaignId).all<SendableRecipient>();
	return withoutOptedOut(db, rows.results, await campaignTopicId(db, campaignId)); // #414
}

/** Count-only version of nonOpenerRecipients (page load shouldn't fetch full rows). */
export async function nonOpenerCount(db: D1Database, campaignId: number): Promise<number> {
	const sql = `SELECT COUNT(DISTINCT c.id) AS n ${BASE}`;
	const row = await db.prepare(sql).bind(campaignId, campaignId).first<{ n: number }>();
	return row?.n ?? 0;
}

/** The subset of a `campaigns` row performResend needs — the caller (manual action or
 *  the tick) loads it however fits its own query. */
export type ResendableCampaign = {
	id: number;
	/** The campaign's ORIGINAL subject — used to decide whether resend_subject should
	 *  be recorded (only when the resend subject actually differs, same as #81). */
	subject: string;
	body_html: string;
	body_text: string | null;
	from_email: string;
};

/**
 * Shared "resend this campaign now" core (#81/#82): sends `campaign`'s stored HTML
 * (falling back from body_text to a stripped-HTML text version, same as #81) to
 * `recipients` under `subject`, then records the resend on the campaigns row
 * (recipient_count bump, resend_subject/resent_at/resend_recipients, error COALESCE'd
 * so an earlier error isn't clobbered). Caller resolves `recipients`
 * (nonOpenerRecipients) and decides what to do about an empty list — the manual action
 * fails loudly, the tick marks the row done with 0 — so this never runs for an empty
 * recipient set; it always attempts to send.
 */
export async function performResend(
	db: D1Database,
	campaign: ResendableCampaign,
	subject: string,
	recipients: SendableRecipient[],
	sendOpts: { token: string; provider?: MailProvider | null; secret: string; baseUrl: string; stream: string; replyToInbound?: string }
): Promise<SendResult> {
	const htmlTemplate = campaign.body_html;
	const textTemplate =
		(campaign.body_text ?? '').trim() ||
		`${campaign.body_html
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s{2,}/g, ' ')
			.trim()
			.slice(0, 5000)}\n\nUnsubscribe: ${UNSUB_PLACEHOLDER}`;

	const result = await sendCampaignEmail(db, {
		token: sendOpts.token,
		provider: sendOpts.provider,
		secret: sendOpts.secret,
		baseUrl: sendOpts.baseUrl,
		campaignId: campaign.id,
		recipients,
		subject,
		htmlTemplate,
		textTemplate,
		from: campaign.from_email,
		stream: sendOpts.stream,
		replyToInbound: sendOpts.replyToInbound,
		sendPass: 'resend'
	});

	await db
		.prepare(
			`UPDATE campaigns
			 SET recipient_count = recipient_count + ?,
			     resend_subject = ?,
			     resent_at = datetime('now'),
			     resend_recipients = ?,
			     error = COALESCE(error, ?)
			 WHERE id = ?`
		)
		.bind(
			result.accepted,
			subject === campaign.subject ? null : subject,
			result.accepted,
			result.failed > 0 ? `${result.failed} failed on resend. First error: ${result.firstError}` : null,
			campaign.id
		)
		.run();

	return result;
}

// Per-pass breakdown (#246) lives in the import-free resend-read.ts so read-only callers
// stay off the send path (#451); re-exported here for existing callers.
export { resendPassBreakdown, type PassStats, type PassBreakdown } from './resend-read';
