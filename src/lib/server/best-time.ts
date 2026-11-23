import { sendCampaignEmail } from './send';
import { autoPublishOnSent } from './newsletter-archive';
import { RECIPIENT_COLS, type SendableRow } from './segments';
import type { EngineConfig } from './automations';

// Send at each contact's best time (#115). A scheduled broadcast with
// campaigns.best_time = 1 doesn't send when it fires: processScheduledCampaigns calls
// queueBestTimeRecipients, which writes one `recipients` row per contact with
// status='queued' and send_after = that contact's best hour (contact_engagement
// .best_hour_utc, #113) within 24 h of the start — or the start itself when there's
// no peak yet (best_hour_utc is NULL until ≥3 real opens/clicks). The heartbeat then
// drains due rows each minute (processBestTimeQueue) through the shared send path.
//
// Exactly-once mirrors the enrollment lease: a conditional UPDATE queued → sending
// claims each row, and only claimed rows are sent. A row left in 'sending' (the Worker
// died mid-send — Postmark may or may not have the message) is never resent: after
// STALE_MINUTES it's closed out as an error. The campaign stays 'sending' until its
// queue is empty, then lands on 'sent'/'failed' like any broadcast (so an auto-resend
// waits for the whole window).

export const BEST_TIME_WINDOW_HOURS = 24;
const DRAIN_LIMIT = 300;
const STALE_MINUTES = 15;
const ID_CHUNK = 90; // D1 caps a statement at 100 bound variables

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function toUtcString(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * When a contact whose opens/clicks peak at `bestHourUtc` should get a send that starts
 * at `start`: the first moment at or after `start` in that UTC hour — always inside
 * [start, start + 24 h). Null when there's no hour guess (→ the default cohort).
 */
export function bestSendAt(start: Date, bestHourUtc: number | null | undefined): Date | null {
	if (bestHourUtc == null || !Number.isInteger(bestHourUtc) || bestHourUtc < 0 || bestHourUtc > 23) return null;
	if (start.getUTCHours() === bestHourUtc) return start;
	const t = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), bestHourUtc));
	if (t.getTime() < start.getTime()) t.setUTCDate(t.getUTCDate() + 1);
	return t;
}

/** Queue every recipient of a best-time campaign. Returns the cohort sizes. */
export async function queueBestTimeRecipients(
	db: D1Database,
	campaignId: number,
	recipients: SendableRow[],
	start: Date = new Date()
): Promise<{ best: number; default: number }> {
	const hours = new Map<number, number | null>();
	for (const ids of chunk(recipients.map((r) => r.id), ID_CHUNK)) {
		const rows = await db
			.prepare(
				`SELECT contact_id, best_hour_utc FROM contact_engagement
				 WHERE contact_id IN (${ids.map(() => '?').join(',')})`
			)
			.bind(...ids)
			.all<{ contact_id: number; best_hour_utc: number | null }>();
		for (const r of rows.results) hours.set(r.contact_id, r.best_hour_utc);
	}

	const insert = db.prepare(
		`INSERT INTO recipients (campaign_id, contact_id, email, status, send_after, send_cohort)
		 VALUES (?, ?, ?, 'queued', ?, ?)`
	);
	let best = 0;
	const stmts = recipients.map((r) => {
		const at = bestSendAt(start, hours.get(r.id));
		if (at) best++;
		return insert.bind(campaignId, r.id, r.email, toUtcString(at ?? start), at ? 'best' : 'default');
	});
	for (const part of chunk(stmts, 50)) await db.batch(part);
	return { best, default: recipients.length - best };
}

type CampaignRow = {
	id: number;
	subject: string;
	body_html: string;
	body_text: string | null;
	body_md: string;
	from_email: string;
};

type ClaimedRow = SendableRow & { row_id: number; subscribed: number; archived_at: string | null };

export type BestTimeSummary = { sent: number; failed: number; dropped: number; finished: number };

/** One heartbeat pass: send due queued recipients, then close out drained campaigns. */
export async function processBestTimeQueue(
	db: D1Database,
	cfg: EngineConfig,
	opts: { limit?: number } = {}
): Promise<BestTimeSummary> {
	const summary: BestTimeSummary = { sent: 0, failed: 0, dropped: 0, finished: 0 };

	// A claim that never resolved — don't resend (Postmark may already have it).
	await db
		.prepare(
			`UPDATE recipients SET status = 'error', error = 'Send interrupted (not retried)'
			 WHERE status = 'sending' AND send_after IS NOT NULL
			   AND send_after <= datetime('now', '-${STALE_MINUTES} minutes')`
		)
		.run();

	const due = await db
		.prepare(
			`SELECT r.id, r.campaign_id FROM recipients r
			 JOIN campaigns c ON c.id = r.campaign_id
			 WHERE r.status = 'queued' AND r.send_after <= datetime('now') AND c.status = 'sending'
			 ORDER BY r.send_after, r.id LIMIT ?`
		)
		.bind(opts.limit ?? DRAIN_LIMIT)
		.all<{ id: number; campaign_id: number }>();

	const byCampaign = new Map<number, number[]>();
	for (const r of due.results) {
		const list = byCampaign.get(r.campaign_id) ?? [];
		list.push(r.id);
		byCampaign.set(r.campaign_id, list);
	}

	for (const [campaignId, ids] of byCampaign) {
		const c = await db
			.prepare(`SELECT id, subject, body_html, body_text, body_md, from_email FROM campaigns WHERE id = ?`)
			.bind(campaignId)
			.first<CampaignRow>();
		if (!c) continue;

		// Claim: queued → sending. send_after is restamped to the claim time, so the
		// stale sweep above measures from the claim, not the planned slot.
		const claimed: number[] = [];
		for (const part of chunk(ids, ID_CHUNK)) {
			const res = await db
				.prepare(
					`UPDATE recipients SET status = 'sending', send_after = datetime('now')
					 WHERE status = 'queued' AND id IN (${part.map(() => '?').join(',')}) RETURNING id`
				)
				.bind(...part)
				.all<{ id: number }>();
			claimed.push(...res.results.map((r) => r.id));
		}
		if (claimed.length === 0) continue;

		// Re-check the contact at send time: unsubscribed, archived (#280) or deleted since the queue was
		// built → the row is dropped, like a contact who left before a scheduled send.
		const rows: ClaimedRow[] = [];
		for (const part of chunk(claimed, ID_CHUNK)) {
			const res = await db
				.prepare(
					`SELECT r.id AS row_id, c.subscribed, c.archived_at, ${RECIPIENT_COLS}
					 FROM recipients r JOIN contacts c ON c.id = r.contact_id
					 WHERE r.id IN (${part.map(() => '?').join(',')})`
				)
				.bind(...part)
				.all<ClaimedRow>();
			rows.push(...res.results);
		}
		const sendable = rows.filter((r) => r.subscribed === 1 && !r.archived_at);
		const keep = new Set(sendable.map((r) => r.row_id));
		const drop = claimed.filter((id) => !keep.has(id));
		for (const part of chunk(drop, ID_CHUNK)) {
			await db
				.prepare(`DELETE FROM recipients WHERE id IN (${part.map(() => '?').join(',')})`)
				.bind(...part)
				.run();
		}
		summary.dropped += drop.length;
		if (sendable.length === 0) continue;

		try {
			const res = await sendCampaignEmail(db, {
				token: cfg.token,
				secret: cfg.secret,
				baseUrl: cfg.baseUrl,
				campaignId: c.id,
				recipients: sendable,
				subject: c.subject,
				htmlTemplate: c.body_html,
				textTemplate: c.body_text ?? c.body_md,
				from: c.from_email,
				stream: cfg.stream,
				replyToInbound: cfg.inboundAddress,
				recipientRowIds: sendable.map((r) => r.row_id)
			});
			summary.sent += res.accepted;
			summary.failed += res.failed;
		} catch (e) {
			// Thrown before the rows were written (e.g. Postmark unreachable) — same as a
			// broadcast that throws: those recipients are marked failed, not retried.
			const msg = e instanceof Error ? e.message.slice(0, 300) : 'send error';
			for (const part of chunk(sendable.map((r) => r.row_id), ID_CHUNK)) {
				await db
					.prepare(
						`UPDATE recipients SET status = 'error', error = ?
						 WHERE status = 'sending' AND id IN (${part.map(() => '?').join(',')})`
					)
					.bind(msg, ...part)
					.run();
			}
			summary.failed += sendable.length;
		}
	}

	summary.finished = await finishDrainedCampaigns(db);
	return summary;
}

/** Best-time campaigns with nothing left queued/sending → 'sent' (or 'failed'). */
async function finishDrainedCampaigns(db: D1Database): Promise<number> {
	const rows = await db
		.prepare(
			`SELECT c.id,
			        (SELECT COUNT(*) FROM recipients WHERE campaign_id = c.id AND status = 'accepted') AS accepted,
			        (SELECT COUNT(*) FROM recipients WHERE campaign_id = c.id AND status = 'error') AS failed,
			        (SELECT error FROM recipients WHERE campaign_id = c.id AND status = 'error' ORDER BY id LIMIT 1) AS first_error
			 FROM campaigns c
			 WHERE c.status = 'sending' AND c.best_time = 1
			   AND NOT EXISTS (SELECT 1 FROM recipients WHERE campaign_id = c.id AND status IN ('queued', 'sending'))
			 LIMIT 20`
		)
		.all<{ id: number; accepted: number; failed: number; first_error: string | null }>();
	let n = 0;
	for (const r of rows.results) {
		const res = await db
			.prepare(
				`UPDATE campaigns SET status = ?, recipient_count = ?, error = ?
				 WHERE id = ? AND status = 'sending'`
			)
			.bind(
				r.accepted > 0 ? 'sent' : 'failed',
				r.accepted,
				r.failed > 0 ? `${r.failed} failed. First error: ${r.first_error ?? 'unknown'}` : r.accepted > 0 ? null : 'No subscribed contacts at send time',
				r.id
			)
			.run();
		n += res.meta.changes;
		if (res.meta.changes && r.accepted > 0) await autoPublishOnSent(db, r.id); // #481
	}
	return n;
}
