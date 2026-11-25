import { autoPublishOnSent } from './newsletter-archive';
import { sendCampaignEmail } from './send';
import { readAudience, recipientsForAudience } from './campaign-audience';
import { campaignTopicId } from './topics';
import { nonOpenerRecipients, performResend } from './resend';
import type { EngineConfig } from './automations';
import { queueBestTimeRecipients } from './best-time';
import { preflightScheduled, notifyHeldSends, logSafe, type HoldNotifier, type PreflightOpts, type PreflightOutcome } from './preflight';
import { getPresendPolicy } from './presend-policy';
import { fetchBudget, linkLimiter, LINK_CHECK_CONCURRENCY, TICK_LINK_DEADLINE_MS, TICK_MAX_FETCHES, TICK_MIN_FETCHES_PER_CAMPAIGN } from './link-check';
import type { PresendPolicy } from '$lib/presend-policy';

// Scheduled broadcasts (#35). Compose stores a fully-rendered campaign with
// status='scheduled' + scheduled_at (UTC); the heartbeat tick calls
// processScheduledCampaigns() to fire the due ones. Recipients are resolved at
// SEND time (current list membership / subscription state), and the claim is a
// conditional UPDATE so overlapping ticks can't double-send.
//
// #479: before the claim, each due campaign's links are checked again (preflightScheduled),
// while the row is still 'scheduled'. Only a "send" result goes on to the claim and the send.
// The claim also requires the scheduled_at that was read (a campaign rescheduled or reopened
// during the check isn't claimed), and the send uses the content re-read after the claim.
// Every due campaign ends the tick sent / failed (as before), back in 'scheduled' (retry, a
// lost race, a write that failed) or held. Up to 5 due campaigns not retrying plus up to 2
// retrying ones per tick, so retries can't crowd out other sends. Hold notices go out from
// their own pass after the send loop (notifyHeldSends), never inline.

type ScheduledRow = {
	id: number;
	body_html: string;
	list_id: number | null;
	scheduled_at: string | null;
	preflight_retry_until: string | null;
	preflight_override_by: string | null;
	preflight_override_user_id: number | null;
};

/** What the send takes from the row, re-read after the claim. */
type SendContent = {
	subject: string;
	body_html: string;
	body_text: string | null;
	body_md: string;
	list_id: number | null;
	from_email: string;
	best_time: number;
};

/** #479: due campaigns per tick: not retrying, and (separately) in their retry window. */
export const DUE_PER_TICK = 5;
export const RETRYING_PER_TICK = 2;

/** #479: what the tick passes for the fire-time pre-send check. */
export type ScheduledOpts = {
	/** `deadline` / `maxFetches` / `limiter` here replace the tick's own (20 s, 300 fetches and
	 *  6 probes in flight for the whole tick). */
	preflight?: PreflightOpts;
	/** The hold notice (webhook, admin email), sent from the notice pass after the send loop. */
	onHold?: HoldNotifier;
};

/** Race-safe claim: flips scheduled → sending; only one caller wins. A campaign held by a
 *  deliverability alert (#305) or its pre-send checks (#479, held_at set) is never claimed until
 *  it's released. #479: the claim also uses up a "Send anyway" (it counts for one fire), and
 *  with `scheduledAt` it only claims the row while scheduled_at is still the value that was
 *  read (a campaign rescheduled or reopened and rescheduled meanwhile is left alone). */
export async function claimScheduledCampaign(db: D1Database, id: number, scheduledAt?: string): Promise<boolean> {
	const sameTime = scheduledAt === undefined ? '' : ' AND scheduled_at = ?';
	const res = await db
		.prepare(
			`UPDATE campaigns SET status = 'sending', preflight_override_by = NULL, preflight_override_user_id = NULL
			 WHERE id = ? AND status = 'scheduled' AND held_at IS NULL${sameTime}`
		)
		.bind(...(scheduledAt === undefined ? [id] : [id, scheduledAt]))
		.run();
	return res.meta.changes > 0;
}

/** #479: each campaign's share of the tick's fetch budget: equal, at least the minimum. */
export function fetchSlice(total: number, campaigns: number): number {
	return Math.max(TICK_MIN_FETCHES_PER_CAMPAIGN, Math.floor(total / Math.max(1, campaigns)));
}

const DUE_COLS = `id, body_html, list_id, scheduled_at, preflight_retry_until, preflight_override_by, preflight_override_user_id`;
const DUE_WHERE = `status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now') AND held_at IS NULL`;

/** #479: the due rows of this tick: up to 5 not retrying (oldest schedule first) and up to 2 in
 *  their retry window (oldest retry first). A retrying row keeps its old scheduled_at, so one
 *  shared `ORDER BY scheduled_at LIMIT 5` would let five retrying campaigns block every other
 *  due campaign for the whole window. */
export async function dueScheduled(db: D1Database): Promise<ScheduledRow[]> {
	const [fresh, retrying] = await db.batch<ScheduledRow>([
		db.prepare(`SELECT ${DUE_COLS} FROM campaigns WHERE ${DUE_WHERE} AND preflight_retry_until IS NULL ORDER BY scheduled_at, id LIMIT ${DUE_PER_TICK}`),
		db.prepare(`SELECT ${DUE_COLS} FROM campaigns WHERE ${DUE_WHERE} AND preflight_retry_until IS NOT NULL ORDER BY preflight_retry_until, scheduled_at, id LIMIT ${RETRYING_PER_TICK}`)
	]);
	return [...fresh.results, ...retrying.results];
}

export async function processScheduledCampaigns(
	db: D1Database,
	cfg: EngineConfig,
	opts: ScheduledOpts = {}
): Promise<{ fired: number; failed: number; retrying?: number; held?: number }> {
	try {
		return await fireDue(db, cfg, opts);
	} finally {
		// #479: the hold-notice pass, however the send loop ended (it never throws).
		if (opts.onHold) {
			try {
				await notifyHeldSends(db, opts.onHold, opts.preflight?.now);
			} catch (e) {
				console.error('held-send notice pass failed:', logSafe(e));
			}
		}
	}
}

async function fireDue(
	db: D1Database,
	cfg: EngineConfig,
	opts: ScheduledOpts
): Promise<{ fired: number; failed: number; retrying?: number; held?: number }> {
	const due = await dueScheduled(db);

	let fired = 0;
	let failed = 0;
	let retrying = 0;
	let held = 0;
	if (!due.length) return { fired, failed };

	// #479: one policy read, one deadline, one fetch budget and one concurrency limiter for the
	// whole tick; each campaign gets an equal slice of the budget so a slow one can't starve the
	// others. The checks run in parallel; a policy that can't be read is treated as the default
	// (Block: fail open).
	const pf = opts.preflight ?? {};
	let policy: PresendPolicy | undefined = pf.policy;
	let policyError: unknown = null;
	if (!policy) {
		try {
			policy = await getPresendPolicy(db);
		} catch (e) {
			policyError = e ?? new Error('policy read failed');
		}
	}
	const deadline = pf.deadline ?? Date.now() + TICK_LINK_DEADLINE_MS;
	const total = pf.maxFetches ?? fetchBudget(TICK_MAX_FETCHES);
	const limiter = pf.limiter ?? linkLimiter(LINK_CHECK_CONCURRENCY);
	const slice = fetchSlice(total.remaining, due.length);
	const settled = await Promise.allSettled(
		due.map(
			async (c): Promise<PreflightOutcome> =>
				await preflightScheduled(db, c, { ...pf, policy, policyError, deadline, limiter, maxFetches: fetchBudget(slice, total) })
		)
	);
	// preflightScheduled never rejects; if it somehow did, Strict leaves the row scheduled and
	// the others send unchecked (as before #479).
	const outcomes = settled.map((r): PreflightOutcome => {
		if (r.status === 'fulfilled') return r.value;
		console.error('preflight task failed:', logSafe(r.reason));
		return policy?.enforcement === 'strict' ? { action: 'skip', report: null } : { action: 'send', report: null, via: 'checker_error' };
	});

	for (const [i, row] of due.entries()) {
		const pre = outcomes[i];
		if (pre.action === 'retry') {
			retrying++;
			continue;
		}
		if (pre.action === 'hold') {
			held++; // the notice goes out from the notice pass (processScheduledCampaigns' finally)
			continue;
		}
		if (pre.action === 'skip') continue; // left as it was (still 'scheduled'), tried next tick

		// From here on: the pre-#479 send path, with the claim pinned to the scheduled_at read
		// above and the content re-read after the claim.
		if (!row.scheduled_at || !(await claimScheduledCampaign(db, row.id, row.scheduled_at))) continue; // lost the race, held, rescheduled
		try {
			const c = await db
				.prepare(`SELECT subject, body_html, body_text, body_md, list_id, from_email, best_time FROM campaigns WHERE id = ?`)
				.bind(row.id)
				.first<SendContent>();
			if (!c) throw new Error('campaign row vanished after the claim');
			// #332: every included list / segment (union) minus the excluded ones, resolved now.
			const recipientRows = await recipientsForAudience(db, await readAudience(db, row.id, c.list_id), {
				topicId: await campaignTopicId(db, row.id) // #414: topic opt-outs hold
			});
			const recipients = { results: recipientRows };

			if (recipients.results.length === 0) {
				await db
					.prepare(`UPDATE campaigns SET status = 'failed', error = 'No subscribed contacts at send time' WHERE id = ?`)
					.bind(row.id)
					.run();
				failed++;
				continue;
			}

			// #115: best-time send — queue each recipient at their best hour; the
			// campaign stays 'sending' while processBestTimeQueue drains it.
			if (c.best_time) {
				await queueBestTimeRecipients(db, row.id, recipients.results);
				await db
					.prepare(`UPDATE campaigns SET recipient_count = ?, sent_at = datetime('now') WHERE id = ?`)
					.bind(recipients.results.length, row.id)
					.run();
				fired++;
				continue;
			}

			// #536: never throws on a Postmark failure; each 500-chunk's rows are written as it
			// returns, so a partial send lands as 'sent' with the failed recipients as error rows.
			const res = await sendCampaignEmail(db, {
				token: cfg.token,
				provider: cfg.provider,
				secret: cfg.secret,
				baseUrl: cfg.baseUrl,
				campaignId: row.id,
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
				.bind(accepted > 0 ? 'sent' : 'failed', accepted, error, row.id)
				.run();
			if (accepted > 0) await autoPublishOnSent(db, row.id); // #481: best-effort, never throws
			if (accepted > 0) fired++;
			else failed++;
		} catch (e) {
			await db
				.prepare(`UPDATE campaigns SET status = 'failed', error = ? WHERE id = ?`)
				.bind(e instanceof Error ? e.message.slice(0, 500) : 'send error', row.id)
				.run();
			failed++;
		}
	}
	// #479: retrying / held only when non-zero (the tick response stays as it was otherwise).
	return { fired, failed, ...(retrying ? { retrying } : {}), ...(held ? { held } : {}) };
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
				{ token: cfg.token, provider: cfg.provider, secret: cfg.secret, baseUrl: cfg.baseUrl, stream: cfg.stream, replyToInbound: cfg.inboundAddress }
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
