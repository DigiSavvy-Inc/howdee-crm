// #479: pre-send checks at a scheduled send's fire time, and the "preflight" hold.
//
// The full checks already gated the schedule (compose's send action). Content, template and
// headers are frozen in the stored body_html, so at fire time only what changes on its own is
// checked again: the live links (a page that 404'd at schedule time may be live now, or the
// other way round). The policy (Settings → General → Pre-send checks) decides what blocks.
//
// The check runs BEFORE the tick claims the row, while it is still 'scheduled': a request cut
// off mid-check leaves it scheduled (the next tick checks again), and a deliverability hold
// raised during the check still stops it (the claim requires held_at IS NULL). Every write here
// matches `status = 'scheduled' AND held_at IS NULL`, so it never touches a row another tick
// claimed or someone held / edited meanwhile.
//
// A blocking result keeps the campaign 'scheduled' and the tick tries again every minute until
// `preflight_retry_until` (the "keep trying" window); after it the campaign is HELD with the
// #305 mechanism (held_at, held_reason = 'preflight', the report saved) — never cancelled,
// never sent with the problem. Links not checked yet (out of time / budget) only matter under
// Strict, with a window of at least 5 minutes. If the checker itself fails: Warn only / Block
// send as before (fail open); Strict waits, then holds with a "could not be checked" report.
// Fail open covers only producing the report: once a report says retry or hold, a failed write
// is a "skip" (left scheduled, tried next tick), never a send. Merge-tag links are not filled in
// here (that would resolve the audience before the claim; a sample failure only ever warns):
// they're checked when composing. A deliverability hold (#305) always wins over a pre-send one:
// it takes over a pre-send hold, and Re-check now / Send anyway / Edit act only on
// held_reason = 'preflight'. Hold notices go out from their own pass (notifyHeldSends), never
// inline in the send loop.
// Nothing here sends, schedules or enrolls (no send / postmark import).
import { extractLinks, summarize, type ChecksReport } from '$lib/presend-checks';
import { applyPolicy, checkerErrorReport, heldSummary, isUncheckedRow, parseReport, type PresendPolicy } from '$lib/presend-policy';
import { getPresendPolicy } from './presend-policy';
import { liveLinkChecks } from './presend-checks';
import type { FetchBudget, Fetcher, Limiter } from './link-check';
import type { SendableRow } from './segments';
import { readAudience, recipientsForAudience } from './campaign-audience';
import { campaignTopicId } from './topics';
import { getAlertConfig } from './deliverability-alerts';
import { deliverWebhook, type Delivery } from './ai/jobs-webhook';
import type { EmailMessage, JobEmailSender } from './ai/jobs-email';

/** #479: the shortest "keep trying" window when links weren't checked yet (or the checker
 *  failed) under Strict: never an instant hold for "we ran out of time". */
export const MIN_UNCHECKED_RETRY_MINUTES = 5;

export function sqlTime(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

export type PreflightRow = {
	id: number;
	body_html: string;
	list_id: number | null;
	preflight_retry_until: string | null;
	preflight_override_by: string | null;
	preflight_override_user_id: number | null;
};

export type PreflightOpts = {
	policy?: PresendPolicy;
	now?: Date;
	fetcher?: Fetcher;
	retryDelayMs?: number;
	/** Epoch ms: the hard stop for the link probes (the tick's deadline). */
	deadline?: number;
	/** The outbound-fetch budget (the tick passes each campaign its slice of one budget). */
	maxFetches?: FetchBudget;
	/** The probe concurrency limiter (the tick passes one for all its campaigns). */
	limiter?: Limiter;
};

/** `send` → the tick may claim and send. `retry` / `hold` → written, the row stays 'scheduled'
 *  (held for `hold`). `skip` → nothing written (the row changed under us, or a write failed):
 *  left as it was, still 'scheduled' unless someone else moved it. */
export type PreflightOutcome =
	| { action: 'send'; report: ChecksReport | null; via: 'passed' | 'override' | 'warn_only' | 'checker_error' }
	| { action: 'retry' | 'hold'; report: ChecksReport }
	| { action: 'skip'; report: null };

/** URLs can carry personal data in their query strings: never log one. */
export function logSafe(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 200);
}

/** The live link check of a stored email, with the policy applied. */
export async function preflightReport(
	html: string,
	recipients: SendableRow[],
	policy: PresendPolicy,
	opts: PreflightOpts & { skipMergeLinks?: boolean } = {}
): Promise<ChecksReport> {
	const rows = await liveLinkChecks(extractLinks(html), recipients, {
		fetcher: opts.fetcher,
		retryDelayMs: opts.retryDelayMs,
		linkDeadline: opts.deadline,
		maxFetches: opts.maxFetches,
		limiter: opts.limiter,
		skipMergeLinks: opts.skipMergeLinks
	});
	return applyPolicy({ ...summarize(rows, true), checkedAt: (opts.now ?? new Date()).toISOString() }, policy);
}

/** Pure: what a fire-time report means. A block on a link that WAS checked → keep trying for
 *  the policy's window (0 = hold now). Only "not checked" blocks (Strict) → keep trying for at
 *  least MIN_UNCHECKED_RETRY_MINUTES. The window starts at the first failure (`storedUntil`). */
export function decidePreflight(
	report: ChecksReport,
	policy: PresendPolicy,
	storedUntil: string | null,
	now: Date
): { action: 'send' } | { action: 'retry'; retryUntil: string } | { action: 'hold' } {
	const blocks = report.checks.filter((c) => c.level === 'block');
	const checkedBlocks = blocks.filter((c) => !isUncheckedRow(c.id)).length;
	if (!blocks.length) return { action: 'send' };
	const minutes = checkedBlocks ? policy.retryMinutes : Math.max(policy.retryMinutes, MIN_UNCHECKED_RETRY_MINUTES);
	const retryUntil = storedUntil ?? sqlTime(new Date(now.getTime() + minutes * 60_000));
	const windowOver = (checkedBlocks > 0 && policy.retryMinutes === 0) || sqlTime(now) >= retryUntil;
	return windowOver ? { action: 'hold' } : { action: 'retry', retryUntil };
}

/** "Send anyway" counts for this fire only while overrides are allowed and the admin who gave
 *  it is still an active admin. */
export async function overrideHonoured(db: D1Database, c: PreflightRow, policy: PresendPolicy): Promise<boolean> {
	if (!c.preflight_override_by || !c.preflight_override_user_id || policy.override !== 'admins') return false;
	const u = await db
		.prepare(`SELECT 1 AS ok FROM users WHERE id = ? AND role = 'admin' AND disabled_at IS NULL`)
		.bind(c.preflight_override_user_id)
		.first<{ ok: number }>();
	return !!u;
}

const LIVE = `status = 'scheduled' AND held_at IS NULL`;

/** Writes a retry / hold (or the passing report) for a row still scheduled and not held. */
async function record(db: D1Database, c: PreflightRow, report: ChecksReport, d: ReturnType<typeof decidePreflight>, now: Date): Promise<PreflightOutcome> {
	const json = JSON.stringify(report);
	const nowSql = sqlTime(now);
	if (d.action === 'send') {
		// Best effort: a failed write of the passing report never stops the send.
		try {
			await db
				.prepare(`UPDATE campaigns SET preflight_report = ?, preflight_checked_at = ?, preflight_retry_until = NULL WHERE id = ? AND ${LIVE}`)
				.bind(json, nowSql, c.id)
				.run();
		} catch (e) {
			console.error('preflight report write failed:', logSafe(e));
		}
		return { action: 'send', report, via: 'passed' };
	}
	// Both clear "Send anyway": it was not honoured for this fire (or the checks ran anyway).
	const res =
		d.action === 'hold'
			? await db
					.prepare(
						`UPDATE campaigns SET held_at = ?, held_reason = 'preflight', held_check_id = NULL, preflight_report = ?,
						        preflight_checked_at = ?, preflight_retry_until = NULL, preflight_override_by = NULL, preflight_override_user_id = NULL,
						        preflight_notified_at = NULL
						 WHERE id = ? AND ${LIVE}`
					)
					.bind(nowSql, json, nowSql, c.id)
					.run()
			: await db
					.prepare(
						`UPDATE campaigns SET preflight_report = ?, preflight_checked_at = ?, preflight_retry_until = ?,
						        preflight_override_by = NULL, preflight_override_user_id = NULL
						 WHERE id = ? AND ${LIVE}`
					)
					.bind(json, nowSql, d.retryUntil, c.id)
					.run();
	if ((res.meta?.changes ?? 0) === 0) return { action: 'skip', report: null };
	return { action: d.action, report };
}

/**
 * Run by the tick for a due campaign BEFORE it is claimed (the row is still 'scheduled').
 * Never throws and never marks the campaign failed. `policy` null with `policyError` set = the
 * policy could not be read (treated as the default, Block: fail open).
 *
 * Two phases. Producing the report (policy read, override, the checks): a failure here fails
 * open under Warn only / Block, as before #479. Writing a retry / hold: a failure is `skip`
 * (left 'scheduled', logged, tried next tick) and NEVER a send, so a known broken link can't
 * go out because a write failed.
 */
export async function preflightScheduled(
	db: D1Database,
	c: PreflightRow,
	opts: PreflightOpts & { policyError?: unknown } = {}
): Promise<PreflightOutcome> {
	const now = opts.now ?? new Date();
	let policy: PresendPolicy | null = opts.policy ?? null;
	let report: ChecksReport;
	let decision: ReturnType<typeof decidePreflight>;
	try {
		if (opts.policyError) throw opts.policyError;
		if (!policy) policy = await getPresendPolicy(db);
		if (await overrideHonoured(db, c, policy)) return { action: 'send', report: null, via: 'override' };
		if (policy.enforcement === 'warn') return { action: 'send', report: null, via: 'warn_only' };
		// No sample recipients: merge-tag links are left to the compose check (skipMergeLinks).
		report = await preflightReport(c.body_html, [], policy, { ...opts, now, skipMergeLinks: true });
		decision = decidePreflight(report, policy, c.preflight_retry_until, now);
	} catch (e) {
		console.error(`preflight check failed for campaign ${c.id}:`, logSafe(e));
		// Warn only / Block (or a policy we could not read): send as main did, unchecked.
		if (!policy || policy.enforcement !== 'strict') return { action: 'send', report: null, via: 'checker_error' };
		const strict = policy;
		try {
			const errReport = checkerErrorReport(now);
			return await record(db, c, errReport, decidePreflight(errReport, strict, c.preflight_retry_until, now), now);
		} catch (e2) {
			console.error(`preflight retry write failed for campaign ${c.id}:`, logSafe(e2));
			return { action: 'skip', report: null }; // left 'scheduled': the next tick tries again
		}
	}
	try {
		return await record(db, c, report, decision, now);
	} catch (e) {
		// A report exists. 'send' never gets here (its write is best effort inside record);
		// a retry / hold whose write failed is left 'scheduled' and tried again next tick.
		console.error(`preflight ${decision.action} write failed for campaign ${c.id}:`, logSafe(e));
		return { action: 'skip', report: null };
	}
}

type HeldRow = { id: number; status: string; body_html: string; list_id: number | null; held_at: string | null; held_reason: string | null };

async function heldRow(db: D1Database, id: number): Promise<HeldRow | null> {
	return await db
		.prepare(`SELECT id, status, body_html, list_id, held_at, held_reason FROM campaigns WHERE id = ?`)
		.bind(id)
		.first<HeldRow>();
}

/** #479: what Re-check now / Send anyway say when the send isn't held by its pre-send checks. */
export const DELIVERABILITY_HOLD_MESSAGE =
	'This send is held by a deliverability alert, not by its pre-send checks. Only an admin can release it (Release on this page); it is checked again when it fires.';
export const NOT_PREFLIGHT_HOLD_MESSAGE = 'This send is not held by its pre-send checks.';

/** Why a pre-send hold action can't act on this campaign (null = it is held by its pre-send checks). */
export async function preflightHoldRefusal(db: D1Database, id: number): Promise<string | null> {
	const c = await heldRow(db, id);
	if (c && c.held_at && c.status === 'scheduled' && c.held_reason === 'preflight') return null;
	return c && c.held_at && c.held_reason !== 'preflight' ? DELIVERABILITY_HOLD_MESSAGE : NOT_PREFLIGHT_HOLD_MESSAGE;
}

const PREFLIGHT_HELD = `held_at IS NOT NULL AND held_reason = 'preflight' AND status = 'scheduled'`;

const RELEASE_SQL = `UPDATE campaigns SET held_at = NULL, held_reason = NULL, held_check_id = NULL, preflight_retry_until = NULL,
	        preflight_override_by = NULL, preflight_override_user_id = NULL
	WHERE id = ? AND ${PREFLIGHT_HELD}`;

/**
 * Re-check now on a send held by its pre-send checks (20 s, 200 fetches at most). Passing → the
 * hold is released and the tick sends it (within a minute when it's past due), checking it once
 * more at fire time. Failing → it stays held with the new report. Never sends from here.
 */
export async function recheckHeld(db: D1Database, id: number, opts: PreflightOpts = {}): Promise<{ ok: false; error: string } | { ok: true; released: boolean; report: ChecksReport }> {
	const c = await heldRow(db, id);
	if (!c || !c.held_at || c.held_reason !== 'preflight' || c.status !== 'scheduled') {
		return { ok: false, error: c?.held_at && c.held_reason !== 'preflight' ? DELIVERABILITY_HOLD_MESSAGE : NOT_PREFLIGHT_HOLD_MESSAGE };
	}
	const policy = opts.policy ?? (await getPresendPolicy(db));
	const recipients = await recipientsForAudience(db, await readAudience(db, c.id, c.list_id), { topicId: await campaignTopicId(db, c.id) });
	const now = opts.now ?? new Date();
	const report = await preflightReport(c.body_html, recipients, policy, { ...opts, now });
	// Only while it is still a pre-send hold: a deliverability alert may have taken it over
	// during the check (then neither the report nor the release is written).
	const wrote = await db
		.prepare(`UPDATE campaigns SET preflight_report = ?, preflight_checked_at = ? WHERE id = ? AND ${PREFLIGHT_HELD}`)
		.bind(JSON.stringify(report), sqlTime(now), id)
		.run();
	if ((wrote.meta?.changes ?? 0) === 0) return { ok: false, error: (await preflightHoldRefusal(db, id)) ?? NOT_PREFLIGHT_HOLD_MESSAGE };
	// Same rule as the tick: a block (incl. links not checked yet under Strict) keeps it held.
	if (report.blocks > 0) return { ok: true, released: false, report };
	const res = await db.prepare(RELEASE_SQL).bind(id).run();
	return { ok: true, released: (res.meta?.changes ?? 0) > 0, report };
}

/** "Send anyway" on a held send — the caller checks the user may (canSendAnyway). Stored as
 *  `@login at <UTC>` in preflight_override_by with the admin's id; good for the next fire only
 *  (see overrideHonoured; cleared on claim, edit, a new hold or a release). The same text is
 *  kept in the saved report (`overriddenBy`) as the lasting record of who did it. */
export async function sendAnywayHeld(db: D1Database, id: number, who: { login: string; userId: number }, now: Date = new Date()): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE campaigns SET held_at = NULL, held_reason = NULL, held_check_id = NULL, preflight_retry_until = NULL,
			        preflight_override_by = ?1, preflight_override_user_id = ?2,
			        preflight_report = CASE WHEN json_valid(preflight_report) THEN json_set(preflight_report, '$.overriddenBy', ?1) ELSE preflight_report END
			 WHERE id = ?3 AND ${PREFLIGHT_HELD}`
		)
		.bind(`@${who.login} at ${sqlTime(now)} UTC`.slice(0, 120), who.userId, id)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

export type PreflightHold = { id: number; subject: string; scheduled_at: string | null; held_at: string; summary: string };

/** Sends held by their pre-send checks (dashboard banner, campaigns list). */
export async function preflightHolds(db: D1Database): Promise<PreflightHold[]> {
	const rows = await db
		.prepare(
			`SELECT id, subject, scheduled_at, held_at, preflight_report FROM campaigns
			 WHERE held_at IS NOT NULL AND held_reason = 'preflight' AND status = 'scheduled' ORDER BY scheduled_at LIMIT 20`
		)
		.all<{ id: number; subject: string; scheduled_at: string | null; held_at: string; preflight_report: string | null }>();
	return rows.results.map((r) => ({ id: r.id, subject: r.subject, scheduled_at: r.scheduled_at, held_at: r.held_at, summary: heldSummary(parseReport(r.preflight_report)) }));
}

// ---- notifications (the activity feed row and dashboard banner come from the row itself) ----

export type HoldNotice = { id: number; subject: string; scheduledAt: string | null; report: ChecksReport | null; appUrl: string };

export function holdPayload(format: 'json' | 'slack', n: HoldNotice): string {
	const url = `${n.appUrl}/campaign/${n.id}`;
	const summary = heldSummary(n.report);
	const failing = (n.report?.checks ?? []).filter((c) => c.level === 'block').map((c) => c.title);
	if (format === 'slack') {
		const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const lines = [`*Scheduled send held: ${esc(summary)}*`, `<${url}|${esc(n.subject)}>${n.scheduledAt ? ` (scheduled ${n.scheduledAt} UTC)` : ''}`, ...failing.map((t) => `• ${esc(t)}`), 'It will not send until someone re-checks it or an admin sends it anyway.'];
		return JSON.stringify({ text: lines.join('\n') });
	}
	return JSON.stringify({ type: 'send_held', reason: 'preflight', campaign_id: n.id, subject: n.subject, scheduled_at: n.scheduledAt, summary, failing, url });
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The optional admin email. Subject and titles are escaped; no merge tags are filled. */
export function holdEmail(n: HoldNotice): EmailMessage {
	const url = `${n.appUrl}/campaign/${n.id}`;
	const summary = heldSummary(n.report);
	const failing = (n.report?.checks ?? []).filter((c) => c.level === 'block');
	const lines = failing.flatMap((c) => [c.title, ...(c.items ?? []).map((i) => `  ${i}`)]);
	const text = [`A scheduled send was held: ${summary}.`, '', `“${n.subject}”${n.scheduledAt ? `, scheduled ${n.scheduledAt} UTC` : ''}`, '', ...lines, '', `Re-check it, edit it or send it anyway: ${url}`].join('\n');
	const html = `<p>A scheduled send was held: <strong>${escHtml(summary)}</strong>.</p>
<p>“${escHtml(n.subject)}”${n.scheduledAt ? `, scheduled ${escHtml(n.scheduledAt)} UTC` : ''}</p>
${failing.map((c) => `<p><strong>${escHtml(c.title)}</strong></p>${c.items?.length ? `<ul>${c.items.map((i) => `<li>${escHtml(i)}</li>`).join('')}</ul>` : ''}`).join('\n')}
<p><a href="${escHtml(url)}">Re-check it, edit it or send it anyway</a></p>`;
	return { subject: `Scheduled send held: ${n.subject}`.slice(0, 200), html, text };
}

/** What the tick calls when a send gets held: the alert webhook (when set) and, when Settings →
 *  General → Pre-send checks asks for it, an email to the admins of this CRM (their own
 *  users.email; the sender is injected by the tick so this module never imports a send path). */
export function holdNotifier(db: D1Database, appUrl: string, emailSender: JobEmailSender | null, fetchImpl?: typeof fetch) {
	return async (c: { id: number; subject: string; scheduledAt: string | null }, report: ChecksReport | null): Promise<void> => {
		const n: HoldNotice = { id: c.id, subject: c.subject, scheduledAt: c.scheduledAt, report, appUrl };
		try {
			await notifyHoldWebhook(db, n, fetchImpl);
		} catch (e) {
			console.error('held-send webhook failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
		if (!emailSender || !(await getPresendPolicy(db)).notifyEmail) return;
		const admins = await db
			.prepare(`SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL AND email IS NOT NULL AND email != ''`)
			.all<{ id: number }>();
		if (admins.results.length) await emailSender(admins.results.map((a) => a.id), holdEmail(n));
	};
}

export type HoldNotifier = (c: { id: number; subject: string; scheduledAt: string | null }, report: ChecksReport | null) => Promise<void>;

/** #479: how many hold notices one tick sends at most. */
export const HOLD_NOTICES_PER_TICK = 5;

/**
 * The hold-notice pass, run by the tick after its send loop however that ended. Up to 5 sends
 * held by their pre-send checks and not notified yet (`preflight_notified_at IS NULL`); each
 * notice in its own try/catch; stamped after the attempt, also when the notifier threw (logged),
 * so a broken webhook can't loop forever. At least once: a notice a tick never reached (cut
 * off, out of rows) is picked up by the next one; overlapping ticks may rarely send one twice.
 * A new pre-send hold clears the stamp; a deliverability hold is never a pre-send notice.
 */
export async function notifyHeldSends(db: D1Database, notify: HoldNotifier, now: Date = new Date(), limit = HOLD_NOTICES_PER_TICK): Promise<number> {
	const rows = await db
		.prepare(
			`SELECT id, subject, scheduled_at, preflight_report FROM campaigns
			 WHERE held_at IS NOT NULL AND held_reason = 'preflight' AND preflight_notified_at IS NULL AND status = 'scheduled'
			 ORDER BY held_at, id LIMIT ?`
		)
		.bind(limit)
		.all<{ id: number; subject: string; scheduled_at: string | null; preflight_report: string | null }>();
	let sent = 0;
	for (const r of rows.results) {
		try {
			await notify({ id: r.id, subject: r.subject, scheduledAt: r.scheduled_at }, parseReport(r.preflight_report));
			sent++;
		} catch (e) {
			console.error(`held-send notice failed for campaign ${r.id}:`, logSafe(e));
		}
		try {
			await db
				.prepare(`UPDATE campaigns SET preflight_notified_at = ? WHERE id = ? AND preflight_notified_at IS NULL`)
				.bind(sqlTime(now), r.id)
				.run();
		} catch (e) {
			console.error(`held-send notice stamp failed for campaign ${r.id}:`, logSafe(e));
		}
	}
	return sent;
}

/** The deliverability alert webhook (Settings → Deliverability), when one is set. */
export async function notifyHoldWebhook(db: D1Database, n: HoldNotice, fetchImpl?: typeof fetch): Promise<Delivery | null> {
	const cfg = await getAlertConfig(db);
	if (!cfg.webhookUrl) return null;
	return await deliverWebhook(cfg.webhookUrl, holdPayload(cfg.webhookFormat, n), { fetch: fetchImpl, userAgent: 'ds-email-preflight/1' });
}
