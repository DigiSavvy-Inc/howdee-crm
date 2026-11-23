import { autoPublishOnSent } from './newsletter-archive';
import { sendCampaignEmail } from './send';
import { readAudience, recipientsForAudience } from './campaign-audience';
import { campaignTopicId } from './topics';
import { nonOpenerRecipients, performResend } from './resend';
import type { EngineConfig } from './automations';
import { queueBestTimeRecipients } from './best-time';

// Scheduled broadcasts (#35). Compose stores a fully-rendered campaign with
// status='scheduled' + scheduled_at (UTC); the heartbeat tick calls
// processScheduledCampaigns() to fire the due ones. Recipients are resolved at
// SEND time (current list membership / subscription state), and the claim is a
// conditional UPDATE so overlapping ticks can't double-send.

type ScheduledRow = {
	id: number;
	subject: string;
	body_html: string;
	body_text: string | null;
	body_md: string;
	list_id: number | null;
	from_email: string;
	best_time: number;
};

/** Race-safe claim: flips scheduled → sending; only one caller wins. A campaign held by a
 *  deliverability alert (#305, held_at set) is never claimed until an admin releases it. */
export async function claimScheduledCampaign(db: D1Database, id: number): Promise<boolean> {
	const res = await db
		.prepare(`UPDATE campaigns SET status = 'sending' WHERE id = ? AND status = 'scheduled' AND held_at IS NULL`)
		.bind(id)
		.run();
	return res.meta.changes > 0;
}

export async function processScheduledCampaigns(
	db: D1Database,
	cfg: EngineConfig
): Promise<{ fired: number; failed: number }> {
	const due = await db
		.prepare(
			`SELECT id, subject, body_html, body_text, body_md, list_id, from_email, best_time
			 FROM campaigns
			 WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')
			   AND held_at IS NULL
			 ORDER BY scheduled_at LIMIT 5`
		)
		.all<ScheduledRow>();

	let fired = 0;
	let failed = 0;
	for (const c of due.results) {
		if (!(await claimScheduledCampaign(db, c.id))) continue; // lost the race
		try {
			// #332: every included list / segment (union) minus the excluded ones, resolved now.
			const recipientRows = await recipientsForAudience(db, await readAudience(db, c.id, c.list_id), {
				topicId: await campaignTopicId(db, c.id) // #414: topic opt-outs hold
			});
			const recipients = { results: recipientRows };

			if (recipients.results.length === 0) {
				await db
					.prepare(`UPDATE campaigns SET status = 'failed', error = 'No subscribed contacts at send time' WHERE id = ?`)
					.bind(c.id)
					.run();
				failed++;
				continue;
			}

			// #115: best-time send — queue each recipient at their best hour; the
			// campaign stays 'sending' while processBestTimeQueue drains it.
			if (c.best_time) {
				await queueBestTimeRecipients(db, c.id, recipients.results);
				await db
					.prepare(`UPDATE campaigns SET recipient_count = ?, sent_at = datetime('now') WHERE id = ?`)
					.bind(recipients.results.length, c.id)
					.run();
				fired++;
				continue;
			}

			// #536: never throws on a Postmark failure; each 500-chunk's rows are written as it
			// returns, so a partial send lands as 'sent' with the failed recipients as error rows.
			const res = await sendCampaignEmail(db, {
				token: cfg.token,
				secret: cfg.secret,
				baseUrl: cfg.baseUrl,
				campaignId: c.id,
				recipients: recipients.results,
				subject: c.subject,
				htmlTemplate: c.body_html,
				textTemplate: c.body_text ?? c.body_md,
				from: c.from_email,
				stream: cfg.stream,
				replyToInbound: cfg.inboundAddress,
				skipAlreadySent: true
			});
			const accepted = res.accepted + (res.skipped ?? 0);
			const error =
				accepted === 0 ? res.firstError : res.failed > 0 ? `${res.failed} failed. First error: ${res.firstError}`.slice(0, 500) : null;

			await db
				.prepare(
					`UPDATE campaigns SET status = ?, recipient_count = ?, error = ?, sent_at = datetime('now') WHERE id = ?`
				)
				.bind(accepted > 0 ? 'sent' : 'failed', accepted, error, c.id)
				.run();
			if (accepted > 0) await autoPublishOnSent(db, c.id); // #481: best-effort, never throws
			if (accepted > 0) fired++;
			else failed++;
		} catch (e) {
			await db
				.prepare(`UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?`)
				.bind(e instanceof Error ? e.message.slice(0, 500) : 'send error', c.id)
				.run();
			failed++;
		}
	}
	return { fired, failed };
}

// Automatic resend to non-openers (#82). Compose can schedule a resend alongside a
// send: campaigns.resend_at/resend_status/resend_subject (migration 0030). The tick
// fires due ones through the SAME core the manual `?/resend` action uses
// (performResend in resend.ts) — one send path, two triggers.

type ResendRow = {
	id: number;
	subject: string;
	body_html: string;
	body_text: string | null;
	from_email: string;
	status: string;
	resend_subject: string | null;
};

async function acceptedCount(db: D1Database, campaignId: number): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND status = 'accepted'`)
		.bind(campaignId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Race-safe claim: flips resend_status pending → sending; only one caller wins. */
export async function claimScheduledResend(db: D1Database, id: number): Promise<boolean> {
	const res = await db
		.prepare(`UPDATE campaigns SET resend_status = 'sending' WHERE id = ? AND resend_status = 'pending'`)
		.bind(id)
		.run();
	return res.meta.changes > 0;
}

export async function processScheduledResends(
	db: D1Database,
	cfg: EngineConfig
): Promise<{ sent: number; canceled: number; skipped: number; failed: number }> {
	const due = await db
		.prepare(
			`SELECT id, subject, body_html, body_text, from_email, status, resend_subject
			 FROM campaigns
			 WHERE resend_status = 'pending' AND resend_at IS NOT NULL AND resend_at <= datetime('now')
			 ORDER BY resend_at LIMIT 5`
		)
		.all<ResendRow>();

	let sent = 0;
	let canceled = 0;
	let skipped = 0;
	let failed = 0;

	for (const c of due.results) {
		// Parent hasn't sent yet (still scheduled/mid-send) — this handles a scheduled
		// original whose own send is late. Leave pending; a later tick will catch it
		// once the parent lands on 'sent' (or 'failed'/'canceled').
		if (c.status === 'scheduled' || c.status === 'sending') {
			skipped++;
			continue;
		}

		// Parent never went out — nothing to resend.
		if (c.status === 'failed' || c.status === 'canceled') {
			await db
				.prepare(`UPDATE campaigns SET resend_status = 'canceled' WHERE id = ? AND resend_status = 'pending'`)
				.bind(c.id)
				.run();
			canceled++;
			continue;
		}

		if (c.status !== 'sent') {
			// Unexpected status — don't act on it either way; leave pending for a human.
			skipped++;
			continue;
		}

		if (!(await claimScheduledResend(db, c.id))) continue; // lost the race

		// Snapshot the accepted-recipient count before attempting the send, so a thrown
		// error below can tell "nothing went out" from "it actually sent, then something
		// else failed" — see the catch branch.
		let beforeAccepted = 0;
		try {
			const recipients = await nonOpenerRecipients(db, c.id);
			if (recipients.length === 0) {
				await db
					.prepare(
						`UPDATE campaigns SET resend_status = 'sent', resend_recipients = 0, resent_at = datetime('now') WHERE id = ?`
					)
					.bind(c.id)
					.run();
				sent++;
				continue;
			}

			beforeAccepted = await acceptedCount(db, c.id);

			// Same core the manual `?/resend` action uses — same subject fallback,
			// same campaigns-row bookkeeping.
			await performResend(
				db,
				{ id: c.id, subject: c.subject, body_html: c.body_html, body_text: c.body_text, from_email: c.from_email },
				c.resend_subject || c.subject,
				recipients,
				{ token: cfg.token, secret: cfg.secret, baseUrl: cfg.baseUrl, stream: cfg.stream, replyToInbound: cfg.inboundAddress }
			);
			// performResend already updated recipient_count/resent_at/resend_recipients/error —
			// even when nothing was accepted (an in-band Postmark failure), same as the manual
			// action: it's "done", not retried forever.
			await db.prepare(`UPDATE campaigns SET resend_status = 'sent' WHERE id = ?`).bind(c.id).run();
			sent++;
		} catch (e) {
			// A thrown error means a D1 write failed (#536: sendCampaignEmail no longer throws
			// on a Postmark failure, and writes each chunk's rows as it returns). If new
			// `accepted` rows appeared since the snapshot above, treat it as done (never
			// loop-resend) instead of retrying.
			const afterAccepted = await acceptedCount(db, c.id);
			const msg = e instanceof Error ? e.message.slice(0, 500) : 'resend error';
			if (afterAccepted > beforeAccepted) {
				await db
					.prepare(
						`UPDATE campaigns SET resend_status = 'sent', resent_at = datetime('now'), error = COALESCE(error, ?) WHERE id = ?`
					)
					.bind(msg, c.id)
					.run();
			} else {
				await db
					.prepare(`UPDATE campaigns SET resend_status = 'pending', error = COALESCE(error, ?) WHERE id = ?`)
					.bind(msg, c.id)
					.run();
			}
			failed++;
		}
	}

	return { sent, canceled, skipped, failed };
}
