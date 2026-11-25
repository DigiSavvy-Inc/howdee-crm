// Automation engine: enroll contacts into a drip flow, and `tick()` to walk each
// enrollment through its steps over time. See epic #1 / issue #4.
//
// The send is NOT transactional with D1, so two mechanisms make a step exactly-once:
//   1. Claim-before-send: a conditional UPDATE leases the enrollment (pushes
//      next_run_at into the future) keyed on (id, current_step). Only the winner
//      proceeds to call Postmark; a concurrent tick that loses the claim skips.
//   2. Recipient-row guard: a successfully-sent step leaves an `accepted` recipients
//      row for (step_campaign, contact). If a tick crashes after the send but before
//      advancing, the lease expires, the row re-arms as due, and the guard recognizes
//      the step already sent — so it advances without re-sending.
//
// Reuse: one `campaigns` row per step (lazily created) so the existing campaign stats,
// webhook MessageID attribution, and contact history all work for free.
//
// Assumptions (v1):
//   - Concurrent ticks. Since #729 an install may run two clocks (the app's own Cron
//     Trigger and the heartbeat Worker), so two ticks can start in the same minute. The
//     claim (1) is what keeps them apart: only one wins each (enrollment, step). The
//     recipient-row guard (2) is read-before-write, so it is not a hard exactly-once
//     boundary on its own; it only matters after a lease expires (1h, far past a tick's
//     run time). If that window ever matters, add a UNIQUE(campaign_id, contact_id,
//     enrollment_id, enrollment_visit) on recipients and claim-by-insert before the send.
//   - The pointer is a step ID (#74): `current_step_id` survives add/move/reorder, so
//     the builder no longer locks structural edits while enrollments are active. "Next"
//     is still resolved by position order at advance time; deleting a step re-points its
//     in-flight enrollments (handled in the builder's deleteStep action).

import { renderBody, storedBlocks } from './compose-body';
import { getSignature } from './email-signature';
import type { EmailSignature } from '$lib/signature';
import { sendCampaignEmail, type SendableRecipient } from './send';
import type { MailProvider } from './mail';
import { buildCondCtx, checkCondition, formatTagCondition } from '$lib/conditionals';
import { decodeCondition } from '$lib/company-metrics';
import { contactMatchesMetric } from './company-metrics';
import { decodeVisited } from '$lib/site-trigger';
import { contactMatchesVisited } from './site-activity';
import { classifyProxyOpen } from './engagement';
import { addScorePoints } from './scoring/contact';
import { adjustedLabel, parseAdjustScore } from '$lib/score-trigger';
import {
	BRANCH_NOT_CONFIGURED,
	PIPELINE_REMOVED_LABEL,
	STEP_NOT_FINISHED,
	TIER_CLEARED_LABEL,
	TOPIC_OPTED_OUT,
	endAllAutomationsCount,
	numberedStepTitle,
	stepNumbers,
	stepShortTitle
} from '$lib/automation-action-labels';
import { compileSegment, parseRules } from './segment-query';
import { parseGateRules } from '$lib/condition-rules';
import { contactsMatchingRules, evaluateRules } from './condition-eval';
import { addToPipeline, moveCard, removeFromPipeline } from './pipeline';
import { setTierOverride } from './tier-override';
import { TIER_LABELS, isTier } from '$lib/engagement-view';
import { STEP_COLS, nextStep, weekdayDueUtc, type StepRow } from './automation-tree';
import {
	frequencyHold,
	getFrequencyCap,
	goalHit,
	logEnrolled,
	logEvent,
	recordPendingTriggers,
	waitDateTarget,
	fieldDateTarget,
	waitEventHappened,
	windowNextOpen
} from './automation-flow';
import { FIELD_DATE_EXIT_REASON, FIELD_DATE_RECHECK_SECONDS, FREQUENCY_CAP_PREFIX, parseExitRules, parseWait, WAIT_DELAY_DEFAULT, WAIT_TIMEOUT_DEFAULT, type FrequencyCap } from '$lib/automation-flow';
import { getSettings, getTimezone } from './settings';
import { FINISH_SETUP_FROM, FINISH_SETUP_SENDING, isFinishSetupMessage } from '$lib/finish-setup';
import { abVariantFor } from '$lib/automation-ab';
import { applyWeekdayOnly, sqliteUtc } from './businessdays';
import { contactOptedOut } from './topics';
import { SKIPPED_EMAIL_UNSUBSCRIBED, SUBSCRIPTION_KIND } from '$lib/subscription-trigger';

// #345: the step-tree helpers live in automation-tree.ts (engine-free, so the builder's
// write layer can use them without importing the engine); re-exported for existing callers.
export { STEP_COLS, nextStep, weekdayDueUtc, type StepRow };

export type EngineConfig = {
	token: string; // POSTMARK_TOKEN (only used when `provider` is unset)
	/** #700: the active sending provider (Settings → Sending, else the env). Unset = a Postmark
	 *  adapter for `token` + `stream`. */
	provider?: MailProvider | null;
	secret: string; // SESSION_SECRET (signs unsubscribe links)
	baseUrl: string; // PUBLIC_BASE_URL
	stream: string; // POSTMARK_STREAM (broadcast)
	inboundAddress?: string; // POSTMARK_INBOUND_ADDRESS — reply capture (#38)
	/** #731: POSTMARK_FROM, the last stand-in for an email step saved with no From (after
	 *  Settings → General → Default From). Unset = no env stand-in. */
	envFrom?: string;
};

// Postmark recipient-level error codes that won't succeed on retry → fail the
// enrollment immediately rather than burning the attempts budget.
//   300 = Invalid email request (malformed address)
//   406 = Inactive recipient (suppressed / previously hard-bounced)
const HARD_ERROR_CODES = new Set([300, 406]);
const MAX_ATTEMPTS = 5; // transient-failure retries before giving up on a step
const RETRY_DELAY_SECONDS = 600; // 10 min between transient retries
const LEASE_SECONDS = 3600; // claim marker: a crashed mid-step re-arms after 1h
const DEFAULT_BATCH = 50;
const MAX_BATCH = 200;

// #146 goto_step loop guards: jumps per enrollment per tick, and per pass (jump_count).
const MAX_JUMPS_PER_TICK = 3;
const MAX_JUMPS_PER_PASS = 25;

// #395: a contact held at an unfinished step is re-checked this often (saving the step
// releases them immediately; this is the backstop).
const HOLD_RECHECK_SECONDS = 600;

// #731: a pass held by a "Finish setup" hold (no sender / no sending provider) for this long since
// the first such hold fails, like an email with no From did before #731.
export const SETUP_HOLD_MAX_HOURS = 24;
export const SETUP_HOLD_FAILED_FROM = 'No sender configured for 24 hours';
export const SETUP_HOLD_FAILED_SENDING = 'No sending provider configured for 24 hours';

/**
 * #731: when the current "Finish setup" hold of this pass at this step began, from its timeline:
 * the earliest `held` event with a Finish-setup detail for this step after the pass's last event
 * of any other kind (so a hold released by a send, a step change or a loop starts a new clock).
 * The engine logs that event on the first hold (and whenever the reason changes), and logs one
 * again whenever none is found (the log write is best-effort), so the clock never goes missing;
 * at worst it starts one tick late. Null = no such event yet. No migration needed.
 */
async function setupHoldSince(db: D1Database, enrollmentId: number, stepId: number): Promise<{ hours: number } | null> {
	const row = await db
		.prepare(
			`SELECT (julianday('now') - julianday(MIN(at))) * 24 AS hours FROM automation_enrollment_events
			 WHERE enrollment_id = ? AND step_id = ? AND kind = 'held' AND COALESCE(detail, '') IN (?, ?)
			   AND id > COALESCE((SELECT MAX(id) FROM automation_enrollment_events
			                      WHERE enrollment_id = ? AND NOT (kind = 'held' AND COALESCE(detail, '') IN (?, ?))), 0)`
		)
		.bind(enrollmentId, stepId, FINISH_SETUP_SENDING, FINISH_SETUP_FROM, enrollmentId, FINISH_SETUP_SENDING, FINISH_SETUP_FROM)
		.first<{ hours: number | null }>();
	return row?.hours == null ? null : { hours: row.hours };
}

// #397: how often a contact parked at an event wait is re-checked (it also wakes at its timeout).
export const WAIT_POLL_SECONDS = 300;


type ContactRow = {
	id: number;
	email: string;
	name: string | null;
	first_name: string | null;
	last_name: string | null;
	company: string | null;
	meta: string | null;
	tags: string | null;
	subscribed: number;
	archived_at: string | null;
};

type DueRow = {
	id: number;
	automation_id: number;
	contact_id: number;
	current_step_id: number | null;
	attempts: number;
	jump_count: number; // #146: goto_step jumps taken this pass
	enrolled_at?: string; // #397: exit goals count replies / stage moves after this
	last_error?: string | null;
	wait_started_at?: string | null; // #397: when the pass started waiting at its current wait step
	exit_rules?: string | null; // #397: the automation's exit goals (JSON)
	trigger_type?: string | null; // #444: `subscription_changed` passes may run for unsubscribed contacts
};

/** #397: per-tick state shared by every enrollment processed in one tick. */
type TickCtx = {
	actionEnrollGuard: Map<number, number>;
	jumpGuard: Map<number, number>;
	cap: FrequencyCap;
	tz: string | null; // read on first use (date / window waits)
	signature?: EmailSignature | null; // #594: read on first email send (undefined = not yet)
	standInFrom?: string; // #731: Default From, else POSTMARK_FROM — read on first email step with no From
};

// Lifecycle transition for one enrollment this tick. `sent` (whether Postmark was
// actually called) is tracked separately, so a final-step send counts as both a
// `sent` and a `completed`.
type Outcome = 'advanced' | 'completed' | 'cancelled' | 'failed' | 'retried' | 'lost' | 'gated' | 'held' | 'waiting';

export type TickSummary = {
	processed: number;
	sent: number; // steps actually sent via Postmark this tick
	advanced: number; // moved to a later step (with or without a fresh send)
	completed: number; // enrollments that finished their last step
	cancelled: number; // contact unsubscribed mid-flow
	failed: number; // hard failure or attempts exhausted
	retried: number; // transient failure, will retry next tick
	lost: number; // claim race lost to a concurrent tick
	held: number; // #395: waiting at a step that isn't finished (ready = 0); #397: or held by the frequency cap — not persisted to tick_log
	waiting: number; // #397: parked at a wait-until step (no event yet, time not reached, outside the window) — not persisted
	goals: number; // #397: passes that left early on an exit goal (also counted in `completed`) — not persisted
	tagged: number; // tag-action steps applied this tick
	gated: number; // legacy: condition gates (#13) filtered non-matching contacts here. Gates
	//                are unified into branches as of #0029 — always 0 going forward; kept
	//                (with the tick_log column) so historical ticks stay meaningful.
	actions: { enrolled: number; ended: number; skipped: number; jumped: number; pipeline: number; tier: number; score: number }; // #128/#146/#207/#460/#467: action-step outcomes
	//          (`pipeline` = cards added/moved/removed by pipeline action steps)
	//          this tick. NOT persisted to `tick_log` (that table's columns are unchanged by
	//          design) — only reflected in the in-memory TickSummary this call returns.
	//          `end_all_automations` adds N (the number of other active passes it cancelled)
	//          to `ended` in one hit, not just 1 — see `processEnrollment`.
};

/**
 * Enroll contacts into an automation. Skips unsubscribed and archived (#280) contacts and anyone with an
 * ACTIVE pass (partial unique index ux_enrollments_active + ON CONFLICT). The
 * automation's re-entry policy decides whether a finished pass blocks re-enrollment:
 * 'once' (default) — ANY prior pass (any status) blocks; 'multiple' — only an active
 * pass blocks, history rows accumulate. The first step's delay schedules
 * `next_run_at`. No-op if the automation has no steps.
 *
 * `opts.now` (default `new Date()`) and `opts.tz` (default `getTimezone(db)`) only matter
 * when the first step is `weekday_only` (#119): the due instant is computed in JS
 * (now + delay, shifted off a weekend) and bound as a literal timestamp instead of
 * letting SQLite's `datetime('now', ?)` modifier compute it server-side. The timezone
 * is not read when the flag is off. A failed read falls back to the default zone.
 * When the first step is NOT weekday_only, behavior is unchanged from before #119
 * (same SQL, same `datetime('now', ?)` modifier).
 */
export async function enroll(
	db: D1Database,
	automationId: number,
	contactIds: number[],
	// #412: `ignoreEntryRules` = the operator's "ignore entry conditions" on a manual enroll.
	// #444: `allowUnsubscribed` (set by fireSubscriptionTriggers for `subscription_changed`
	// automations) lets unsubscribed contacts in; the engine then never emails them.
	// #516: `formSubmissionId` (the "Form submitted" trigger) is stamped on each new pass, so a
	// Condition step's `form_answer` rule reads that submission's answers.
	// #673: `ignoreReentry` (the contact page's "Enroll again" / "Restart") treats a once-only
	// automation as `multiple` for this call. The one-active-pass index still applies.
	opts: {
		tz?: string;
		now?: Date;
		ignoreEntryRules?: boolean;
		ignoreReentry?: boolean;
		allowUnsubscribed?: boolean;
		formSubmissionId?: number | null;
	} = {}
): Promise<{ enrolled: number; skipped: number; created: number[]; entryBlocked: number }> {
	if (contactIds.length === 0) return { enrolled: 0, skipped: 0, created: [], entryBlocked: 0 };

	// Resolve the first TRUNK step (lowest position) and seed the id pointer (#74).
	// Branch children (parent_step_id set) are never an entry point (#75).
	const first = await db
		.prepare(
			'SELECT id, delay_before_seconds, weekday_only FROM automation_steps WHERE automation_id = ? AND parent_step_id IS NULL ORDER BY position LIMIT 1'
		)
		.bind(automationId)
		.first<{ id: number; delay_before_seconds: number; weekday_only: number }>();
	if (!first) return { enrolled: 0, skipped: contactIds.length, created: [], entryBlocked: 0 };

	const auto = await db
		.prepare('SELECT reentry, entry_rules FROM automations WHERE id = ?')
		.bind(automationId)
		.first<{ reentry: string; entry_rules: string | null }>();
	const multiple = opts.ignoreReentry === true || auto?.reentry === 'multiple';

	// #412: entry conditions — every trigger path (and manual enrolls unless told to ignore
	// them) only takes the contacts that match.
	let ids = [...new Set(contactIds)];
	let entryBlocked = 0;
	const entry = opts.ignoreEntryRules ? null : parseGateRules(auto?.entry_rules);
	if (entry) {
		const keep = await contactsMatchingRules(db, entry, ids);
		entryBlocked = ids.length - keep.length;
		ids = keep;
		if (ids.length === 0) return { enrolled: 0, skipped: contactIds.length, created: [], entryBlocked };
	}

	// #119: weekday_only computes the due instant in JS so a weekend landing can be
	// pushed to Monday; everything else keeps the original SQL-side modifier untouched.
	// Timezone is read only for that flag, and a failed read cannot fail enrollment.
	let dueExpr: string;
	let dueParam: string;
	const dueLiteral = await weekdayDueUtc(
		db,
		first.delay_before_seconds,
		first.weekday_only,
		opts.now ?? new Date(),
		opts.tz
	);
	if (dueLiteral) {
		dueExpr = '?';
		dueParam = dueLiteral;
	} else {
		dueExpr = `datetime('now', ?)`;
		dueParam = `+${Math.max(0, first.delay_before_seconds)} seconds`;
	}

	// #395: one INSERT OR IGNORE per batch of ENROLL_BATCH ids (≤ 94 bound variables, under
	// D1's 100 cap) instead of one statement per contact. OR IGNORE covers the partial unique
	// index ux_enrollments_active (one ACTIVE pass per contact per automation).
	const once = multiple ? '' : 'AND NOT EXISTS (SELECT 1 FROM automation_enrollments p WHERE p.automation_id = ? AND p.contact_id = c.id)';
	const subscribedSql = opts.allowUnsubscribed ? '' : 'AND c.subscribed = 1';
	const stmts = chunkArr(ids, ENROLL_BATCH).map((part) =>
		db
			.prepare(
				`INSERT OR IGNORE INTO automation_enrollments (automation_id, contact_id, current_step_id, next_run_at, status)
				 SELECT ?, c.id, ?, ${dueExpr}, 'active'
				 FROM contacts c
				 WHERE c.id IN (${part.map(() => '?').join(', ')}) ${subscribedSql} AND c.archived_at IS NULL
				   ${once}
				 RETURNING id`
			)
			.bind(automationId, first.id, dueParam, ...part, ...(multiple ? [] : [automationId]))
	);

	let enrolled = 0;
	const created: number[] = [];
	for (const stmt of stmts) {
		const res = await stmt.all<{ id: number }>();
		created.push(...res.results.map((r) => r.id));
	}
	enrolled = created.length;
	if (opts.formSubmissionId && created.length) {
		await db
			.prepare('UPDATE automation_enrollments SET form_submission_id = ? WHERE id IN (SELECT value FROM json_each(?))')
			.bind(opts.formSubmissionId, JSON.stringify(created))
			.run();
	}
	// #397: each new pass starts its timeline at the entry step.
	await logEnrolled(db, created);
	return { enrolled, skipped: contactIds.length - enrolled, created, entryBlocked };
}

/** #395: contact ids per enroll() INSERT. */
export const ENROLL_BATCH = 90;

export type EnrollResult =
	| { ok: true; enrolled: number; skipped: number; entryBlocked: number; skips: EnrollSkips; automationName: string }
	| { ok: false; error: string };

/**
 * Hand-picked enrollment (#97): enroll specific contact ids into one automation, with
 * the validation the manual `/automations/[id]` enrollList action already does
 * (active status, at least one step) surfaced as a user-facing error instead of a
 * silent no-op. `enroll()` binds one statement per contact id in a loop rather than
 * building a single IN(...) query, so there's no D1 100-var cap to chunk around here.
 */
export async function enrollContactsInAutomation(
	db: D1Database,
	automationId: number,
	contactIds: number[],
	opts: { ignoreEntryRules?: boolean; ignoreReentry?: boolean; allowUnsubscribed?: boolean } = {}
): Promise<EnrollResult> {
	const ids = [...new Set(contactIds.filter((n) => Number.isInteger(n) && n > 0))];
	if (ids.length === 0) return { ok: false, error: 'Select at least one contact.' };

	const automation = await db
		.prepare('SELECT id, name, status FROM automations WHERE id = ?')
		.bind(automationId)
		.first<{ id: number; name: string; status: string }>();
	if (!automation) return { ok: false, error: 'That automation no longer exists.' };
	if (automation.status !== 'active') {
		return {
			ok: false,
			error: `“${automation.name}” is ${automation.status}. Activate it before enrolling contacts.`
		};
	}

	const stepCount = await db
		.prepare('SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ?')
		.bind(automationId)
		.first<{ n: number }>();
	if ((stepCount?.n ?? 0) === 0) {
		return { ok: false, error: `Add at least one step to “${automation.name}” before enrolling contacts.` };
	}

	// #705: why contacts will be skipped, counted before enrolling (read-only; enroll() decides).
	const skips = await enrollSkipBreakdown(db, automationId, ids, opts);
	const { enrolled, skipped, entryBlocked } = await enroll(db, automationId, ids, {
		ignoreEntryRules: opts.ignoreEntryRules,
		ignoreReentry: opts.ignoreReentry,
		allowUnsubscribed: opts.allowUnsubscribed
	});
	// Whatever enroll() skipped beyond those reasons is the contact conditions (entry rules).
	const entryOnly = Math.max(0, skipped - skips.unsubscribed - skips.pending - skips.archived - skips.already);
	return {
		ok: true,
		enrolled,
		skipped,
		entryBlocked,
		skips: { ...skips, entry: Math.min(entryOnly, entryBlocked) },
		automationName: automation.name
	};
}

/** #705: skip reasons for a manual enrol, so notices count them separately. */
export type EnrollSkips = { unsubscribed: number; pending: number; archived: number; already: number; entry: number };

/**
 * Counts, over `ids`, the contacts enroll() will skip and why: archived, unsubscribed, pending
 * double opt-in (not subscribed yet), or already in it (an active pass; any pass under `once`
 * re-entry). With `allowUnsubscribed` the two subscription counts are 0. Mirrors enroll()'s checks.
 */
async function enrollSkipBreakdown(
	db: D1Database,
	automationId: number,
	ids: number[],
	opts: { ignoreReentry?: boolean; allowUnsubscribed?: boolean }
): Promise<Omit<EnrollSkips, 'entry'>> {
	const auto = await db.prepare('SELECT reentry FROM automations WHERE id = ?').bind(automationId).first<{ reentry: string }>();
	const once = opts.ignoreReentry !== true && auto?.reentry !== 'multiple';
	const eligible = opts.allowUnsubscribed ? '1' : 'c.subscribed = 1';
	const out = { unsubscribed: 0, pending: 0, archived: 0, already: 0 };
	for (let i = 0; i < ids.length; i += 500) {
		const row = await db
			.prepare(
				`SELECT COALESCE(SUM(c.archived_at IS NOT NULL), 0) AS archived,
				        COALESCE(SUM(c.archived_at IS NULL AND ? = 0 AND c.subscribed = 0 AND c.confirm_pending = 0), 0) AS unsubscribed,
				        COALESCE(SUM(c.archived_at IS NULL AND ? = 0 AND c.subscribed = 0 AND c.confirm_pending = 1), 0) AS pending,
				        COALESCE(SUM(c.archived_at IS NULL AND ${eligible} AND EXISTS (
				          SELECT 1 FROM automation_enrollments e WHERE e.automation_id = ? AND e.contact_id = c.id
				            AND (e.status = 'active' OR ? = 1))), 0) AS already
				 FROM contacts c WHERE c.id IN (SELECT value FROM json_each(?))`
			)
			.bind(opts.allowUnsubscribed ? 1 : 0, opts.allowUnsubscribed ? 1 : 0, automationId, once ? 1 : 0, JSON.stringify(ids.slice(i, i + 500)))
			.first<typeof out>();
		out.archived += row?.archived ?? 0;
		out.unsubscribed += row?.unsubscribed ?? 0;
		out.pending += row?.pending ?? 0;
		out.already += row?.already ?? 0;
	}
	return out;
}

/**
 * #673: end one contact's running pass in one automation (the contact page's "Restart from the
 * first step"), the same write as the inspector's Cancel. Returns how many passes it ended.
 */
export async function restartEnrollment(db: D1Database, automationId: number, contactId: number): Promise<number> {
	const res = await db
		.prepare(
			`UPDATE automation_enrollments SET status = 'cancelled', next_run_at = NULL, ended_at = datetime('now')
			 WHERE automation_id = ? AND contact_id = ? AND status = 'active'`
		)
		.bind(automationId, contactId)
		.run();
	return res.meta.changes ?? 0;
}

/** Active automations, for the enroll-from-bulk-bar pickers (/contacts, /lists/[id]). */
export async function listActiveAutomations(db: D1Database): Promise<{ id: number; name: string }[]> {
	const rows = await db
		.prepare(`SELECT id, name FROM automations WHERE status = 'active' ORDER BY name COLLATE NOCASE`)
		.all<{ id: number; name: string }>();
	return rows.results;
}

/**
 * Run one pass of the engine: send every enrollment whose next step is due, advance
 * the pointer, and schedule the next step. Idempotent and batched. Driven by the
 * external heartbeat Worker (#7) hitting the tick endpoint (#5).
 */
export async function tick(
	db: D1Database,
	cfg: EngineConfig,
	opts: { batchSize?: number; actionEnrollGuard?: Map<number, number>; jumpGuard?: Map<number, number> } = {}
): Promise<TickSummary> {
	const batchSize = Math.min(Math.max(1, opts.batchSize ?? DEFAULT_BATCH), MAX_BATCH);
	const summary: TickSummary = {
		processed: 0,
		sent: 0,
		advanced: 0,
		completed: 0,
		cancelled: 0,
		failed: 0,
		retried: 0,
		lost: 0,
		held: 0,
		waiting: 0,
		goals: 0,
		tagged: 0,
		gated: 0,
		actions: { enrolled: 0, ended: 0, skipped: 0, jumped: 0, pipeline: 0, tier: 0, score: 0 }
	};

	// #128: per-tick loop guard for `enroll_automation` action steps — a contact may be
	// freshly enrolled by action steps at most 5 times within one tick (counts across ALL
	// action steps/automations for that contact, not per-step). Re-entry 'once' already
	// stops most ping-pong; this stops 'multiple' <-> 'multiple' loops within a single tick.
	// Newly-created passes are only picked up on the NEXT tick (see processEnrollment), so
	// this map only ever needs to defend the current tick's own enrollments. Exposed as an
	// opt-in override (default a fresh Map) mainly for tests that want to inspect it.
	const actionEnrollGuard = opts.actionEnrollGuard ?? new Map<number, number>();
	// #146: per-tick goto_step guard, keyed by enrollment id — at most MAX_JUMPS_PER_TICK
	// jumps per enrollment per tick (the per-pass cap lives in automation_enrollments.jump_count).
	const jumpGuard = opts.jumpGuard ?? new Map<number, number>();

	const due = await db
		.prepare(
			`SELECT e.id, e.automation_id, e.contact_id, e.current_step_id, e.attempts, e.jump_count,
			        e.enrolled_at, e.last_error, e.wait_started_at, a.exit_rules, a.trigger_type
			 FROM automation_enrollments e
			 JOIN automations a ON a.id = e.automation_id
			 WHERE e.status = 'active'
			   AND e.next_run_at IS NOT NULL
			   AND e.next_run_at <= datetime('now')
			   AND a.status = 'active'
			 ORDER BY e.next_run_at
			 LIMIT ?`
		)
		.bind(batchSize)
		.all<DueRow>();

	// #397: the frequency cap is read once per tick (only when something is due).
	const ctx: TickCtx = {
		actionEnrollGuard,
		jumpGuard,
		cap: due.results.length ? await getFrequencyCap(db) : { per_day: null, per_week: null },
		tz: null
	};

	for (const e of due.results) {
		summary.processed++;
		try {
			const { outcome, sent, tagged, action, actionCount, goal } = await processEnrollment(db, cfg, e, ctx);
			if (sent) summary.sent++;
			if (tagged) summary.tagged++;
			if (goal) summary.goals++;
			if (action) summary.actions[action] += actionCount ?? 1;
			summary[outcome]++;
		} catch (err) {
			// Isolate a poison enrollment: never let one throw (e.g. a Postmark network
			// rejection, which surfaces as an exception rather than an ErrorCode) abort the
			// rest of the batch. Count it toward the attempts cap so it eventually fails out
			// instead of retrying forever on the 1h lease.
			summary[await failTransient(db, e, String(err).slice(0, 300))]++;
		}
	}

	// Persist a summary row for this tick when any work was done. Best-effort:
	// a logging failure must never fail the tick itself.
	if (summary.processed > 0) {
		try {
			await db
				.prepare(
					`INSERT INTO tick_log (processed, sent, advanced, completed, cancelled, failed, retried, lost, tagged, gated)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					summary.processed, summary.sent, summary.advanced, summary.completed,
					summary.cancelled, summary.failed, summary.retried, summary.lost,
					summary.tagged, summary.gated
				)
				.run();
			await db
				.prepare(`DELETE FROM tick_log WHERE id NOT IN (SELECT id FROM tick_log ORDER BY id DESC LIMIT 500)`)
				.run();
		} catch {
			/* best-effort — never fail a tick over a log write */
		}
	}

	return summary;
}

async function processEnrollment(
	db: D1Database,
	cfg: EngineConfig,
	e: DueRow,
	ctx: TickCtx
): Promise<{
	outcome: Outcome;
	sent: boolean;
	tagged?: boolean;
	goal?: boolean;
	action?: 'enrolled' | 'ended' | 'skipped' | 'jumped' | 'pipeline' | 'tier' | 'score';
	actionCount?: number; // #128: how much `action` adds to summary.actions[action] (default 1;
	//                       N for an `end_all_automations` hit that ended N other passes).
}> {
	const { actionEnrollGuard, jumpGuard } = ctx;
	// 0. A NULL pointer can't be claimed (`= NULL` never matches) and would re-arm as
	//    'lost' every tick forever — close it out instead. Shouldn't happen for active
	//    enrollments, but a pre-#74 backfill miss or direct DB edit could produce one.
	if (e.current_step_id === null) {
		await db
			.prepare(`UPDATE automation_enrollments SET status='completed', next_run_at=NULL, ended_at=datetime('now') WHERE id=?`)
			.bind(e.id)
			.run();
		await logEvent(db, e, null, 'completed');
		return { outcome: 'completed', sent: false };
	}

	// 1. Claim the enrollment by leasing it. Keyed on current_step_id so a stale racer
	//    (still holding an old pointer) can't win.
	const claim = await db
		.prepare(
			`UPDATE automation_enrollments
			 SET next_run_at = datetime('now', ?)
			 WHERE id = ? AND current_step_id = ? AND status = 'active' AND next_run_at <= datetime('now')`
		)
		.bind(`+${LEASE_SECONDS} seconds`, e.id, e.current_step_id)
		.run();
	if (claim.meta.changes === 0) return { outcome: 'lost', sent: false };

	// 2. Load the step at the current pointer.
	const step = await db
		.prepare(`SELECT ${STEP_COLS} FROM automation_steps WHERE id = ? AND automation_id = ?`)
		.bind(e.current_step_id, e.automation_id)
		.first<StepRow>();
	if (!step) {
		// The step was deleted out from under the pointer (builder re-points on delete,
		// but defend anyway) → nothing left to do here.
		await db
			.prepare(`UPDATE automation_enrollments SET status='completed', next_run_at=NULL, ended_at=datetime('now') WHERE id=?`)
			.bind(e.id)
			.run();
		await logEvent(db, e, null, 'completed');
		return { outcome: 'completed', sent: false };
	}

	// 3. Contact must still be subscribed and not archived (#280).
	const contact = await db
		.prepare(CONTACT_SQL)
		.bind(e.contact_id)
		.first<ContactRow>();
	// #444: a `subscription_changed` automation keeps running for an unsubscribed contact —
	// tags, conditions, waits, actions and End only; an email step ends the pass (step 4').
	const unsubscribedRun = !!contact && contact.subscribed !== 1 && e.trigger_type === SUBSCRIPTION_KIND;
	if (!contact || (contact.subscribed !== 1 && !unsubscribedRun)) {
		await db
			.prepare(`UPDATE automation_enrollments SET status='cancelled', next_run_at=NULL, ended_at=datetime('now') WHERE id=?`)
			.bind(e.id)
			.run();
		await logEvent(db, e, step.id, 'cancelled', contact ? 'unsubscribed' : 'contact deleted');
		return { outcome: 'cancelled', sent: false };
	}
	if (contact.archived_at) {
		await db
			.prepare(`UPDATE automation_enrollments SET status='cancelled', next_run_at=NULL, ended_at=datetime('now'), last_error='archived' WHERE id=?`)
			.bind(e.id)
			.run();
		await logEvent(db, e, step.id, 'cancelled', 'archived');
		return { outcome: 'cancelled', sent: false };
	}

	// 3'. #397: exit goals — checked before every step. The first rule met completes the pass
	//     with completed_reason 'goal:<kind>' (unsubscribe / bounce are the cancel above).
	const rules = parseExitRules(e.exit_rules);
	if (rules.length && e.enrolled_at) {
		const kind = await goalHit(db, rules, { contact_id: contact.id, enrolled_at: e.enrolled_at });
		if (kind) {
			await db
				.prepare(
					`UPDATE automation_enrollments SET status='completed', completed_reason=?, next_run_at=NULL, ended_at=datetime('now') WHERE id=?`
				)
				.bind(`goal:${kind}`, e.id)
				.run();
			await logEvent(db, e, step.id, 'exit', `goal:${kind}`);
			return { outcome: 'completed', sent: false, goal: true };
		}
	}

	// 3a. #395: a step added in the builder but never saved valid (ready = 0) holds the
	//     contact — no send, no advance, attempts untouched. Saving the step releases them at
	//     once (automation-write.ts); this re-check is only the backstop.
	if (step.ready === 0) {
		await db
			.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', ?), last_error = ? WHERE id = ?`)
			.bind(`+${HOLD_RECHECK_SECONDS} seconds`, STEP_NOT_FINISHED, e.id)
			.run();
		return { outcome: 'held', sent: false };
	}

	// 3a'. End step: the flow terminates here by design — complete the enrollment.
	if (step.type === 'end') {
		await db
			.prepare(`UPDATE automation_enrollments SET status='completed', next_run_at=NULL, last_step_at=datetime('now'), ended_at=datetime('now') WHERE id=?`)
			.bind(e.id)
			.run();
		await logEvent(db, e, step.id, 'completed');
		return { outcome: 'completed', sent: false };
	}

	// 3b. Tag-action step: add/remove a tag, then advance. No campaign/send. Idempotent.
	if (step.type === 'tag') {
		await applyTagAction(db, step, contact.id);
		await logEvent(db, e, step.id, 'tag', `${step.tag_action === 'remove' ? 'Removed tag' : 'Added tag'} “${step.tag_name ?? ''}”`);
		return { outcome: await advance(db, e, step), sent: false, tagged: true };
	}

	// 3b'. #397: wait-until step — an event (with a timeout and YES / NO lanes), a date /
	//      time, or a send window. Re-evaluated each time the contact comes due.
	if (step.type === 'wait') return runWaitStep(db, e, step, ctx);

	// 3c. Branch (#75): evaluate the condition, record the decision, and route down the
	// labeled child path — or straight past the branch when the chosen path is empty.
	if (step.type === 'branch') {
		const decided = await branchLabel(db, step, e, contact);
		// #395: a misconfigured legacy condition goes NO (like a rule that can't compile) and
		// says so on the enrollment, so it shows in the inspector.
		const label = decided === 'misconfigured' ? 'no' : decided;
		if (decided === 'misconfigured') {
			await db.prepare('UPDATE automation_enrollments SET last_error = ? WHERE id = ?').bind(BRANCH_NOT_CONFIGURED, e.id).run();
		}
		await db
			.prepare(
				`INSERT INTO automation_branch_hits (step_id, enrollment_id, label) VALUES (?, ?, ?)
				 ON CONFLICT(step_id, enrollment_id) DO UPDATE SET label = excluded.label, decided_at = datetime('now')`
			)
			.bind(step.id, e.id, label)
			.run();
		await logEvent(db, e, step.id, 'branch', label);
		return { outcome: await enterLane(db, e, step, label), sent: false };
	}

	// 3d. Action step (#128): act on the contact's membership in ANOTHER automation —
	// enroll them in it, or end their active pass there. No send, no campaign row; the
	// contact advances to the next step in THIS flow immediately afterward, same as a tag
	// step. A pass newly created by `enroll_automation` here has no due enrollment yet, so
	// it is only picked up by the NEXT tick — never processed within this same loop.
	if (step.type === 'action') {
		// #146: goto_step moves the pointer to another step in THIS automation instead of
		// advancing. Any skip (deleted target, jump limit) records why and advances normally.
		if (step.action_kind === 'goto_step') {
			const jump = await runGotoStep(db, step, e, jumpGuard);
			await recordDecision(db, step.id, e, jump.label);
			if (jump.target) return { outcome: 'advanced', sent: false, action: 'jumped' };
			return { outcome: await advance(db, e, step), sent: false, action: 'skipped' };
		}
		// #207: add/move/remove the contact's pipeline card, then continue like any action.
		if (step.action_kind === 'pipeline_move' || step.action_kind === 'pipeline_remove') {
			const pl = await runPipelineStep(db, step, e);
			await recordDecision(db, step.id, e, pl);
			return { outcome: await advance(db, e, step), sent: false, action: pl.startsWith('skipped') ? 'skipped' : 'pipeline' };
		}
		// #460: set / clear the contact's engagement tier override. Runs for an unsubscribed
		// contact in a subscription_changed automation too (the override wins over
		// unsubscribed-cold).
		if (step.action_kind === 'set_tier') {
			const t = await runSetTierStep(db, step, e);
			await recordDecision(db, step.id, e, t);
			return { outcome: await advance(db, e, step), sent: false, action: t.startsWith('skipped') ? 'skipped' : 'tier' };
		}
		// #467: add / take away points on one of the contact's scores (an `automation` ledger row).
		if (step.action_kind === 'adjust_score') {
			const t = await runAdjustScoreStep(db, step, e);
			await recordDecision(db, step.id, e, t);
			return { outcome: await advance(db, e, step), sent: false, action: t.startsWith('skipped') ? 'skipped' : 'score' };
		}
		const label = await runActionStep(db, step, e, actionEnrollGuard);
		await recordDecision(db, step.id, e, label);
		const endAllCount = endAllAutomationsCount(label);
		const action: 'enrolled' | 'ended' | 'skipped' =
			label === 'enrolled' ? 'enrolled' : label === 'ended' || endAllCount !== null ? 'ended' : 'skipped';
		return { outcome: await advance(db, e, step), sent: false, action, actionCount: endAllCount ?? 1 };
	}

	// 4'. #444: never email an unsubscribed contact — the pass ends here instead.
	if (unsubscribedRun) {
		await db
			.prepare(`UPDATE automation_enrollments SET status='completed', next_run_at=NULL, last_step_at=datetime('now'), ended_at=datetime('now') WHERE id=?`)
			.bind(e.id)
			.run();
		await logEvent(db, e, step.id, 'completed', SKIPPED_EMAIL_UNSUBSCRIBED);
		return { outcome: 'completed', sent: false };
	}

	// 4. The one campaign row for this step, if it exists yet (created below, after the holds).
	// 5. Guard: if an `accepted` recipient row already exists for THIS visit of this step —
	//    same pass (enrollment_id) and same jump_count (a go-to loop back here bumps it, #395)
	//    — the send happened on a prior (crashed) tick → just advance, don't re-send. A row
	//    from before migration 0099 has no enrollment_id: it still counts, but only for the
	//    contact's first pass through this automation (the pre-#395 behaviour), so a second
	//    pass ('multiple' re-entry) gets the email. #731: checked before the "Finish setup"
	//    holds, so a send that already went out is advanced, never held. A step with no
	//    campaign row yet has no recipients, so there is nothing to check.
	const visit = e.jump_count ?? 0;
	const existingCampaign = await db
		.prepare(`SELECT id FROM campaigns WHERE automation_step_id = ? LIMIT 1`)
		.bind(step.id)
		.first<{ id: number }>();
	if (existingCampaign) {
		const alreadySent = await db
			.prepare(
				`SELECT id FROM recipients
				 WHERE campaign_id = ? AND contact_id = ? AND status = 'accepted'
				   AND ((enrollment_id = ? AND COALESCE(enrollment_visit, 0) = ?)
				     OR (enrollment_id IS NULL
				         AND ? = (SELECT MIN(p.id) FROM automation_enrollments p WHERE p.automation_id = ? AND p.contact_id = ?)))
				 LIMIT 1`
			)
			.bind(existingCampaign.id, contact.id, e.id, visit, e.id, e.automation_id, contact.id)
			.first<{ id: number }>();
		if (alreadySent) return { outcome: await advance(db, e, step), sent: false };
	}

	// 5''. #731: "Finish setup" holds. No sending provider configured yet, or no From for this
	//      step (its own, else Settings → General → Default From, else POSTMARK_FROM): nothing is
	//      sent and the pass is held at this step like an unfinished step (3a) — re-checked every
	//      HOLD_RECHECK_SECONDS, `attempts` untouched (never burns the retry budget), the reason in
	//      last_error. A step with its own From and a configured provider never reaches either hold.
	//      Bounded: held this way for SETUP_HOLD_MAX_HOURS since the first such hold → failed.
	let from = step.from_email ?? '';
	if (!from.trim()) {
		if (ctx.standInFrom === undefined) {
			ctx.standInFrom = (await getSettings(db)).default_from?.trim() || cfg.envFrom?.trim() || '';
		}
		from = ctx.standInFrom;
	}
	const setupHold = !cfg.provider && !cfg.token?.trim() ? FINISH_SETUP_SENDING : !from.trim() ? FINISH_SETUP_FROM : null;
	if (setupHold) {
		const since = await setupHoldSince(db, e.id, step.id);
		if (since === null || e.last_error !== setupHold) await logEvent(db, e, step.id, 'held', setupHold);
		if (since !== null && since.hours >= SETUP_HOLD_MAX_HOURS) {
			const errMsg = setupHold === FINISH_SETUP_SENDING ? SETUP_HOLD_FAILED_SENDING : SETUP_HOLD_FAILED_FROM;
			await db
				.prepare(`UPDATE automation_enrollments SET status='failed', next_run_at=NULL, last_error=?, ended_at=datetime('now') WHERE id=?`)
				.bind(errMsg, e.id)
				.run();
			await logEvent(db, e, step.id, 'failed', errMsg);
			return { outcome: 'failed', sent: false };
		}
		await db
			.prepare(`UPDATE automation_enrollments SET next_run_at = datetime('now', ?), last_error = ? WHERE id = ?`)
			.bind(`+${HOLD_RECHECK_SECONDS} seconds`, setupHold, e.id)
			.run();
		return { outcome: 'held', sent: false };
	}
	const sendStep = from === step.from_email ? step : { ...step, from_email: from };

	if (ctx.signature === undefined) ctx.signature = await getSignature(db);
	const campaignId = existingCampaign?.id ?? (await getOrCreateStepCampaign(db, e.automation_id, sendStep, ctx.signature));

	// 5b. #414: the automation's topic — a contact who opted out of it on the preference page
	//     skips the email (no send) and the flow continues.
	const topic = await db.prepare('SELECT topic_list_id FROM automations WHERE id = ?').bind(e.automation_id).first<{ topic_list_id: number | null }>();
	if (topic?.topic_list_id && (await contactOptedOut(db, contact.id, topic.topic_list_id))) {
		await db.prepare('UPDATE automation_enrollments SET last_error = ? WHERE id = ?').bind(TOPIC_OPTED_OUT, e.id).run();
		return { outcome: await advance(db, e, step), sent: false };
	}

	// 5'. #397: frequency cap (Settings → Automations) — hold the email, with the reason in
	//     last_error, until the contact's oldest counted automation email ages out of the window.
	if (ctx.cap.per_day || ctx.cap.per_week) {
		const hold = await frequencyHold(db, contact.id, ctx.cap);
		if (hold) {
			if (!(e.last_error ?? '').startsWith(FREQUENCY_CAP_PREFIX)) await logEvent(db, e, step.id, 'held', hold.reason);
			await db.prepare('UPDATE automation_enrollments SET next_run_at = ?, last_error = ? WHERE id = ?').bind(hold.until, hold.reason, e.id).run();
			return { outcome: 'held', sent: false };
		}
	}

	// 6. Send the step. #398: while an A/B test runs, the pass gets variant A (the step's own
	//    copy) or B (ab_subject, and ab_preheader / ab_body_md when set) by a stable hash.
	const variant = step.ab_enabled && step.ab_subject ? abVariantFor(e.id, step.id) : null;
	const { html, text } = variant === 'b' ? renderVariantBody(step, ctx.signature) : renderStepBody(step, ctx.signature);
	const subject = variant === 'b' ? step.ab_subject! : step.subject;
	const recipient: SendableRecipient = {
		id: contact.id,
		email: contact.email,
		name: contact.name,
		first_name: contact.first_name,
		last_name: contact.last_name,
		company: contact.company,
		tags: contact.tags,
		meta: contact.meta
	};

	const res = await sendCampaignEmail(db, {
		token: cfg.token,
		provider: cfg.provider,
		secret: cfg.secret,
		baseUrl: cfg.baseUrl,
		campaignId,
		recipients: [recipient],
		subject,
		htmlTemplate: html,
		textTemplate: text,
		from,
		stream: cfg.stream,
		trackOpens: true,
		trackLinks: 'HtmlAndText',
		unsubscribe: true,
		replyToInbound: cfg.inboundAddress,
		enrollment: { id: e.id, visit },
		abVariant: variant ?? undefined
	});

	if (res.accepted === 1) {
		await bumpCampaignSent(db, campaignId);
		await logEvent(db, e, step.id, 'sent', variant ? `${subject} (variant ${variant.toUpperCase()})` : subject);
		if ((e.last_error ?? '').startsWith(FREQUENCY_CAP_PREFIX) || isFinishSetupMessage(e.last_error)) {
			await db.prepare('UPDATE automation_enrollments SET last_error = NULL WHERE id = ?').bind(e.id).run();
		}
		return { outcome: await advance(db, e, step), sent: true };
	}

	// 7. Failure. sendCampaignEmail inserted an 'error' recipient row; drop it so the
	//    guard (step 5) and stats don't treat the failed attempt as a real send.
	await db
		.prepare(`DELETE FROM recipients WHERE campaign_id = ? AND contact_id = ? AND status = 'error'`)
		.bind(campaignId, contact.id)
		.run();

	const code = res.results[0]?.ErrorCode ?? -1;
	if (HARD_ERROR_CODES.has(code) || res.results[0]?.Permanent === true) {
		const errMsg = (res.results[0]?.Message ?? `Postmark error ${code}`).slice(0, 300);
		await db
			.prepare(`UPDATE automation_enrollments SET status='failed', next_run_at=NULL, last_error=?, ended_at=datetime('now') WHERE id=?`)
			.bind(errMsg, e.id)
			.run();
		await logEvent(db, e, step.id, 'failed', errMsg);
		return { outcome: 'failed', sent: false };
	}

	const postmarkMsg = res.results[0]?.Message;
	return { outcome: await failTransient(db, e, postmarkMsg ?? undefined), sent: false };
}

/**
 * Transient-failure handling: bump the attempts counter and re-arm the enrollment to
 * retry soon, or give up once the cap is hit. Shared by the in-band transient path
 * (Postmark returned a soft error) and the tick loop's catch (the send threw).
 * Optional `errMsg` is stored in last_error (truncated to 300 chars).
 */
async function failTransient(db: D1Database, e: DueRow, errMsg?: string): Promise<Outcome> {
	const attempts = e.attempts + 1;
	const truncMsg = errMsg !== undefined ? errMsg.slice(0, 300) : undefined;
	if (attempts >= MAX_ATTEMPTS) {
		if (truncMsg !== undefined) {
			await db
				.prepare(`UPDATE automation_enrollments SET status='failed', attempts=?, next_run_at=NULL, last_error=?, ended_at=datetime('now') WHERE id=?`)
				.bind(attempts, truncMsg, e.id)
				.run();
		} else {
			await db
				.prepare(`UPDATE automation_enrollments SET status='failed', attempts=?, next_run_at=NULL, ended_at=datetime('now') WHERE id=?`)
				.bind(attempts, e.id)
				.run();
		}
		await logEvent(db, e, e.current_step_id, 'failed', truncMsg ?? 'attempts exhausted');
		return 'failed';
	}
	if (truncMsg !== undefined) {
		await db
			.prepare(`UPDATE automation_enrollments SET attempts=?, next_run_at=datetime('now', ?), last_error=? WHERE id=?`)
			.bind(attempts, `+${RETRY_DELAY_SECONDS} seconds`, truncMsg, e.id)
			.run();
	} else {
		await db
			.prepare(`UPDATE automation_enrollments SET attempts=?, next_run_at=datetime('now', ?) WHERE id=?`)
			.bind(attempts, `+${RETRY_DELAY_SECONDS} seconds`, e.id)
			.run();
	}
	return 'retried';
}

/** Point the enrollment at `step`, scheduled after its delay. Resets attempts.
 *  #119: a `weekday_only` step computes its due instant in JS (now + delay, shifted off
 *  a weekend) and binds it as a literal timestamp instead of the SQL modifier.
 *  The timezone is read only when that flag is set. */
async function goToStep(db: D1Database, e: DueRow, step: StepRow): Promise<void> {
	// #397: moving the pointer ends any wait in progress and appends `reached` to the timeline.
	const dueLiteral = await weekdayDueUtc(db, step.delay_before_seconds ?? 0, step.weekday_only);
	if (dueLiteral) {
		await db
			.prepare(
				`UPDATE automation_enrollments
				 SET current_step_id=?, next_run_at=?,
				     last_step_at=datetime('now'), attempts=0, wait_started_at=NULL
				 WHERE id=?`
			)
			.bind(step.id, dueLiteral, e.id)
			.run();
	} else {
		await db
			.prepare(
				`UPDATE automation_enrollments
				 SET current_step_id=?, next_run_at=datetime('now', ?),
				     last_step_at=datetime('now'), attempts=0, wait_started_at=NULL
				 WHERE id=?`
			)
			.bind(step.id, `+${Math.max(0, step.delay_before_seconds ?? 0)} seconds`, e.id)
			.run();
	}
	await logEvent(db, e, step.id, 'reached');
}

/** Route into a branch / wait lane (#75, #397): its first step, or — an empty lane — straight
 *  on after the step (re-join). */
async function enterLane(db: D1Database, e: DueRow, step: StepRow, label: 'yes' | 'no'): Promise<Outcome> {
	const child = await db
		.prepare(
			`SELECT ${STEP_COLS} FROM automation_steps
			 WHERE parent_step_id = ? AND branch_label = ? ORDER BY position LIMIT 1`
		)
		.bind(step.id, label)
		.first<StepRow>();
	if (child) {
		await goToStep(db, e, child);
		return 'advanced';
	}
	return advance(db, e, step);
}

function sqlMs(s: string): number {
	return Date.parse(`${s.replace(' ', 'T')}Z`);
}

/**
 * #397: a wait-until step. The first time the contact is evaluated here stamps
 * `wait_started_at`; then:
 *   delay  — (#625) wait_started_at + seconds (weekdays_only: a weekend → Monday, same
 *            time) reached → continue; else wake then. No lanes.
 *   event  — happened → YES lane; timeout passed → NO lane; else re-check every
 *            WAIT_POLL_SECONDS (and exactly at the timeout). Opened / clicked with no
 *            email sent in this pass → NO lane at once ("no previous email, skipped").
 *   field_date — (#627) the contact's date field ± offset; see below.
 *   rules  — (#626) the contact matches the rule set → YES lane; the optional time limit
 *            passed → NO lane; else re-check every WAIT_POLL_SECONDS. No limit = wait until
 *            they match.
 *   date   — target reached → continue; else wake at the target.
 *   window — inside the window → continue; else wake when it next opens.
 * A config that can't be read continues (activation refuses an unconfigured wait).
 */
async function runWaitStep(db: D1Database, e: DueRow, step: StepRow, ctx: TickCtx): Promise<{ outcome: Outcome; sent: boolean }> {
	const w = parseWait(step.wait_config ?? null);
	if (!w) {
		await logEvent(db, e, step.id, 'wait', 'not configured — continued');
		return { outcome: await advance(db, e, step), sent: false };
	}
	const now = new Date();
	let started = e.wait_started_at ?? null;
	if (!started) {
		started = sqliteUtc(now);
		await db.prepare('UPDATE automation_enrollments SET wait_started_at = ? WHERE id = ?').bind(started, e.id).run();
	}
	const park = async (until: Date) => {
		await db.prepare('UPDATE automation_enrollments SET next_run_at = ? WHERE id = ?').bind(sqliteUtc(until), e.id).run();
		return { outcome: 'waiting' as Outcome, sent: false };
	};

	if (w.mode === 'delay') {
		// #625: a set period of time from when the contact reached the step; weekdays_only moves a
		// Saturday / Sunday result to Monday at the same local time.
		let target = new Date(sqlMs(started) + (w.seconds ?? WAIT_DELAY_DEFAULT) * 1000);
		if (w.weekdays_only) {
			ctx.tz ??= await getTimezone(db);
			target = applyWeekdayOnly(target, ctx.tz);
		}
		if (now.getTime() >= target.getTime()) {
			await logEvent(db, e, step.id, 'wait', 'time passed');
			return { outcome: await advance(db, e, step), sent: false };
		}
		return park(target);
	}

	// The lane taken is also a yes / no hit, so the canvas lane percentages work as for a branch.
	const hit = async (label: 'yes' | 'no') =>
		db
			.prepare(
				`INSERT INTO automation_branch_hits (step_id, enrollment_id, label) VALUES (?, ?, ?)
				 ON CONFLICT(step_id, enrollment_id) DO UPDATE SET label = excluded.label, decided_at = datetime('now')`
			)
			.bind(step.id, e.id, label)
			.run();

	if (w.mode === 'rules') {
		// #626: until the contact matches the rule set (the Condition step's evaluator; a rule that
		// can't compile counts false). Time limit set → "Timed out" at the deadline; none → wait
		// until they match, re-checked every WAIT_POLL_SECONDS.
		const { pass } = w.rules ? await evaluateRules(db, e.contact_id, w.rules, { stepId: step.id, enrollmentId: e.id }) : { pass: false };
		if (pass) {
			await hit('yes');
			await logEvent(db, e, step.id, 'wait', 'conditions met');
			return { outcome: await enterLane(db, e, step, 'yes'), sent: false };
		}
		const next = now.getTime() + WAIT_POLL_SECONDS * 1000;
		if (!w.timeout_seconds) return park(new Date(next));
		const deadline = sqlMs(started) + w.timeout_seconds * 1000;
		if (now.getTime() >= deadline) {
			await hit('no');
			await logEvent(db, e, step.id, 'wait', 'timed out');
			return { outcome: await enterLane(db, e, step, 'no'), sent: false };
		}
		return park(new Date(Math.min(deadline, next)));
	}

	if (w.mode === 'event') {
		// #625: opens / clicks the previous email, but this pass was sent none — it can never
		// happen, so take "Timed out" now instead of holding for the whole timeout.
		if (w.event === 'opened' || w.event === 'clicked') {
			const sent = await db
				.prepare(`SELECT 1 FROM recipients WHERE enrollment_id = ? AND status = 'accepted' LIMIT 1`)
				.bind(e.id)
				.first();
			if (!sent) {
				await hit('no');
				await logEvent(db, e, step.id, 'wait', 'no previous email, skipped');
				return { outcome: await enterLane(db, e, step, 'no'), sent: false };
			}
		}
		if (await waitEventHappened(db, w, e, started)) {
			await hit('yes');
			await logEvent(db, e, step.id, 'wait', `${w.event}`);
			return { outcome: await enterLane(db, e, step, 'yes'), sent: false };
		}
		const deadline = sqlMs(started) + (w.timeout_seconds ?? WAIT_TIMEOUT_DEFAULT) * 1000;
		if (now.getTime() >= deadline) {
			await hit('no');
			await logEvent(db, e, step.id, 'wait', 'timed out');
			return { outcome: await enterLane(db, e, step, 'no'), sent: false };
		}
		return park(new Date(Math.min(deadline, now.getTime() + WAIT_POLL_SECONDS * 1000)));
	}

	ctx.tz ??= await getTimezone(db);
	if (w.mode === 'field_date') {
		// #627: re-read the contact's field at every wake, so a changed date moves the wait. A
		// missing / unreadable value counts as passed; a target already past when the contact
		// ARRIVES follows if_passed; later (the wait ran its course) it simply continues.
		const row = await db.prepare('SELECT meta FROM contacts WHERE id = ?').bind(e.contact_id).first<{ meta: string | null }>();
		let value: unknown = null;
		try {
			value = (JSON.parse(row?.meta ?? '{}') ?? {})[w.field ?? ''];
		} catch {
			/* malformed meta — missing */
		}
		const target = fieldDateTarget(w, value, ctx.tz);
		const arrived = !e.wait_started_at;
		if (!target || (arrived && now.getTime() >= target.getTime())) {
			const why = target ? 'date already passed' : 'date missing or unreadable';
			if (w.if_passed === 'exit') {
				await db
					.prepare(
						`UPDATE automation_enrollments SET status='completed', completed_reason=?, next_run_at=NULL, ended_at=datetime('now') WHERE id=?`
					)
					.bind(FIELD_DATE_EXIT_REASON, e.id)
					.run();
				await logEvent(db, e, step.id, 'exit', `${why} — ended`);
				return { outcome: 'completed', sent: false };
			}
			await logEvent(db, e, step.id, 'wait', `${why} — continued`);
			return { outcome: await advance(db, e, step), sent: false };
		}
		if (now.getTime() >= target.getTime()) {
			await logEvent(db, e, step.id, 'wait', 'date reached');
			return { outcome: await advance(db, e, step), sent: false };
		}
		return park(new Date(Math.min(target.getTime(), now.getTime() + FIELD_DATE_RECHECK_SECONDS * 1000)));
	}
	if (w.mode === 'date') {
		const target = waitDateTarget(w, new Date(sqlMs(started)), ctx.tz);
		if (now.getTime() >= target.getTime()) {
			await logEvent(db, e, step.id, 'wait', 'time reached');
			return { outcome: await advance(db, e, step), sent: false };
		}
		return park(target);
	}
	const opens = windowNextOpen(w, now, ctx.tz);
	if (!opens) {
		await logEvent(db, e, step.id, 'wait', 'inside the send window');
		return { outcome: await advance(db, e, step), sent: false };
	}
	return park(opens);
}

/** Move the enrollment to the next step in the tree (or complete it). */
async function advance(db: D1Database, e: DueRow, fromStep: StepRow): Promise<Outcome> {
	const next = await nextStep(db, fromStep);

	if (!next) {
		// Done. The pointer keeps the last executed step's id; status carries the state.
		await db
			.prepare(
				`UPDATE automation_enrollments
				 SET status='completed', next_run_at=NULL,
				     last_step_at=datetime('now'), ended_at=datetime('now'), attempts=0
				 WHERE id=?`
			)
			.bind(e.id)
			.run();
		await logEvent(db, e, fromStep.id, 'completed');
		return 'completed';
	}

	await goToStep(db, e, next);
	return 'advanced';
}

/**
 * Resolve + apply one `action` step (#128): enroll the contact in ANOTHER automation, or
 * end their active pass there. Returns the decision label recorded in
 * `automation_branch_hits` (the same table/helper branch decisions use) so the inspector's
 * history explains what happened. Every outcome here is a no-op from the POV of advancing
 * THIS flow — the contact always continues to the next step in `e.automation_id`
 * immediately afterward (handled by the caller), exactly like a tag step.
 *
 * `enroll_automation` never enrolls into the step's own automation (self-target is also
 * refused at save time in the builder), skips a target that isn't `active` (paused/draft)
 * or was deleted (FK nulled `target_automation_id`), and is capped by a per-tick,
 * per-contact loop guard (`actionEnrollGuard`, shared across all action steps this tick) —
 * at most 5 fresh enrollments per contact per tick, so a 'multiple' <-> 'multiple'
 * enroll-each-other pair can't spin forever within one tick. `enroll()` only reports
 * counts, not a reason for a skip (already mid-flow, unsubscribed, or blocked by the
 * target's re-entry policy are all indistinguishable from here) — labeled honestly as
 * 'skipped: not enrolled' rather than guessing.
 *
 * `end_automation` cancels the contact's ACTIVE pass in the target, if any
 * (`status='cancelled'`, `ended_at` stamped) — a no-op when there isn't one.
 *
 * `end_all_automations` (no `target_automation_id`) cancels EVERY other automation the
 * contact currently has an active pass in — every `automation_enrollments` row for this
 * contact with `status='active'` and `automation_id != e.automation_id` (so it never
 * touches the pass running this very step). Decision label is `ended N automations`
 * (N = rows changed), or `no active pass` when N is 0 — same as `end_automation`'s
 * no-op label, so the two share one "nothing to end" phrase. Never enrolls anything, so
 * the loop guard doesn't apply to it.
 */
async function runActionStep(
	db: D1Database,
	step: StepRow,
	e: DueRow,
	actionEnrollGuard: Map<number, number>
): Promise<string> {
	const target = step.target_automation_id
		? await db
				.prepare('SELECT id, name, status FROM automations WHERE id = ?')
				.bind(step.target_automation_id)
				.first<{ id: number; name: string; status: string }>()
		: null;

	if (step.action_kind === 'end_automation') {
		if (!target) return 'skipped: deleted';
		const changes = await endActiveEnrollment(db, target.id, e.contact_id);
		return changes > 0 ? 'ended' : 'no active pass';
	}

	if (step.action_kind === 'end_all_automations') {
		const changes = await endAllOtherActiveEnrollments(db, e.automation_id, e.contact_id);
		return changes > 0 ? `ended ${changes} automations` : 'no active pass';
	}

	// enroll_automation.
	if (!target) return 'skipped: deleted';
	if (target.id === e.automation_id) return 'skipped: self';
	if (target.status !== 'active') return `skipped: ${target.status}`;

	const guardCount = actionEnrollGuard.get(e.contact_id) ?? 0;
	if (guardCount >= 5) return 'skipped: loop guard';

	const { enrolled } = await enroll(db, target.id, [e.contact_id]);
	if (enrolled === 1) {
		actionEnrollGuard.set(e.contact_id, guardCount + 1);
		return 'enrolled';
	}
	return 'skipped: not enrolled';
}

/**
 * Run one pipeline action step (#207). The actor is this automation (`automation:<id>`),
 * so the pipeline history says who moved the card and the stage-entered trigger skips
 * this automation (no self-loop). Returns the decision label:
 *   pipeline_move   — `moved to «Proposal»` / `added to «Proposal»` (not on the board yet),
 *                     or `skipped: deleted stage`, `skipped: not in «Qualified»` (the
 *                     only-from guard; a contact not on the board never passes it),
 *                     `skipped: already in «Proposal»`
 *   pipeline_remove — `removed from pipeline` / `skipped: not in pipeline`
 */
async function runPipelineStep(db: D1Database, step: StepRow, e: DueRow): Promise<string> {
	const actor = { kind: 'automation' as const, id: e.automation_id };
	if (step.action_kind === 'pipeline_remove') {
		const res = await removeFromPipeline(db, e.contact_id, actor);
		return res.ok && res.removed ? PIPELINE_REMOVED_LABEL : 'skipped: not in pipeline';
	}
	const stageName = async (id: number | null) =>
		id
			? ((await db.prepare('SELECT name FROM pipeline_stages WHERE id = ?').bind(id).first<{ name: string }>())?.name ?? null)
			: null;
	const target = await stageName(step.target_stage_id);
	if (!target) return 'skipped: deleted stage';
	const card = await db
		.prepare('SELECT stage_id FROM pipeline_cards WHERE contact_id = ?')
		.bind(e.contact_id)
		.first<{ stage_id: number }>();
	if (step.only_from_stage_id) {
		const from = await stageName(step.only_from_stage_id);
		if (!from) return 'skipped: deleted stage';
		if (card?.stage_id !== step.only_from_stage_id) return `skipped: not in «${from}»`;
	}
	if (card?.stage_id === step.target_stage_id) return `skipped: already in «${target}»`;
	if (card) {
		const res = await moveCard(db, e.contact_id, step.target_stage_id!, actor);
		return res.ok ? `moved to «${target}»` : `skipped: ${res.error}`;
	}
	const res = await addToPipeline(db, e.contact_id, step.target_stage_id!, actor);
	return res.ok ? `added to «${target}»` : `skipped: ${res.error}`;
}

/**
 * Run one "Set engagement tier" action step (#460) through `setTierOverride` with source
 * `automation:<id>`. Labels: `tier set to «Hot» (until 2026-11-23)` / `tier set to «Hot»`,
 * `tier override cleared`, `skipped: already Hot by override`, `skipped: no tier override`.
 */
async function runSetTierStep(db: D1Database, step: StepRow, e: DueRow): Promise<string> {
	const tier = step.target_tier && step.target_tier !== 'clear' && isTier(step.target_tier) ? step.target_tier : null;
	if (step.target_tier && step.target_tier !== 'clear' && !tier) return 'skipped: unknown tier';
	const res = await setTierOverride(db, [e.contact_id], { tier, days: step.tier_days, source: `automation:${e.automation_id}` });
	if (!res.changed.length) return tier ? `skipped: already ${TIER_LABELS[tier]} by override` : 'skipped: no tier override';
	if (!tier) return TIER_CLEARED_LABEL;
	return `tier set to «${TIER_LABELS[tier]}»${res.until ? ` (until ${res.until.slice(0, 10)})` : ''}`;
}

/**
 * Run one "Adjust score" action step (#467): one `score_points` row with source_type
 * 'automation' and source_id '<automation>:<step>:<enrollment>', recomputed inline (one
 * contact). Labels: `Adjusted Email interest by +5`, `skipped: deleted score`,
 * `skipped: not configured`.
 */
async function runAdjustScoreStep(db: D1Database, step: StepRow, e: DueRow): Promise<string> {
	const cfg = parseAdjustScore(step.action_config ?? null);
	if (!cfg) return 'skipped: not configured';
	const score = await db.prepare('SELECT name FROM score_defs WHERE id = ?').bind(cfg.score_id).first<{ name: string }>();
	if (!score) return 'skipped: deleted score';
	const res = await addScorePoints(db, [e.contact_id], cfg.score_id, {
		points: cfg.points,
		expires_days: cfg.expires_days,
		source_type: 'automation',
		sourceId: () => `${e.automation_id}:${step.id}:${e.id}`,
		note: null
	});
	if (!res.ok) return `skipped: ${res.error}`;
	if (!res.affected) return 'skipped: contact deleted';
	return adjustedLabel(score.name, cfg.points);
}

/** Record an action-step decision in automation_branch_hits (one row per step+enrollment;
 *  a repeat hit overwrites the label and time — kept for the existing stats) and append it to
 *  the pass's timeline (#397, never overwritten). */
async function recordDecision(db: D1Database, stepId: number, e: DueRow, label: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO automation_branch_hits (step_id, enrollment_id, label) VALUES (?, ?, ?)
			 ON CONFLICT(step_id, enrollment_id) DO UPDATE SET label = excluded.label, decided_at = datetime('now')`
		)
		.bind(stepId, e.id, label)
		.run();
	await logEvent(db, e, stepId, 'action', label);
}

/**
 * Run one `goto_step` action (#146): point the enrollment at `target_step_id` (a step in
 * the same automation, trunk or inside a branch lane), scheduled after the TARGET's wait
 * with its `weekday_only` applied — exactly like a normal advance onto that step. No send.
 * Returns the decision label and, when the jump happened, the target.
 *
 * Skips (the caller then advances to the next step as usual):
 *   - `skipped: deleted step` — target deleted (FK nulled), or no longer in this automation
 *   - `skipped: self` — target is the goto step itself (refused at save time too)
 *   - `skipped: jump limit` — MAX_JUMPS_PER_TICK for this enrollment this tick, or
 *     MAX_JUMPS_PER_PASS for this pass (`automation_enrollments.jump_count`), so an
 *     A→B→A loop always ends.
 */
async function runGotoStep(
	db: D1Database,
	step: StepRow,
	e: DueRow,
	jumpGuard: Map<number, number>
): Promise<{ label: string; target: StepRow | null }> {
	const target = step.target_step_id
		? await db
				.prepare(`SELECT ${STEP_COLS} FROM automation_steps WHERE id = ? AND automation_id = ?`)
				.bind(step.target_step_id, e.automation_id)
				.first<StepRow>()
		: null;
	if (!target) return { label: 'skipped: deleted step', target: null };
	if (target.id === step.id) return { label: 'skipped: self', target: null };

	const tickJumps = jumpGuard.get(e.id) ?? 0;
	if (tickJumps >= MAX_JUMPS_PER_TICK || (e.jump_count ?? 0) >= MAX_JUMPS_PER_PASS) {
		return { label: 'skipped: jump limit', target: null };
	}

	// Count the jump first (#395: the target's already-sent guard is keyed on jump_count, so a
	// crash between the two writes can only cost a duplicate jump, never a skipped send).
	await db.prepare('UPDATE automation_enrollments SET jump_count = jump_count + 1 WHERE id = ?').bind(e.id).run();
	await goToStep(db, e, target);
	jumpGuard.set(e.id, tickJumps + 1);

	const all = await db
		.prepare('SELECT id, position, type, parent_step_id, branch_label FROM automation_steps WHERE automation_id = ?')
		.bind(e.automation_id)
		.all<{ id: number; position: number; type: string; parent_step_id: number | null; branch_label: string | null }>();
	const n = stepNumbers(all.results).get(target.id);
	return { label: `jumped to «${numberedStepTitle(n, stepShortTitle(target))}»`, target };
}

const CONTACT_SQL = `SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.meta, c.subscribed, c.archived_at, (SELECT GROUP_CONCAT(l.name) FROM list_members lm2 JOIN lists l ON l.id = lm2.list_id WHERE lm2.contact_id = c.id AND l.kind = 'tag') AS tags FROM contacts c WHERE c.id = ?`;

/**
 * #398: the simulator's read-only view of a branch decision — the engine's own `branchLabel`
 * against today's data, with no hit recorded and nothing written. `enrollmentId` only feeds
 * the split hash (a contact without a pass gets a stand-in). Null = contact not found.
 */
export async function previewBranch(
	db: D1Database,
	step: StepRow,
	contactId: number,
	enrollmentId: number
): Promise<'yes' | 'no' | 'misconfigured' | null> {
	const contact = await db.prepare(CONTACT_SQL).bind(contactId).first<ContactRow>();
	if (!contact) return null;
	const e: DueRow = { id: enrollmentId, automation_id: 0, contact_id: contactId, current_step_id: step.id, attempts: 0, jump_count: 0 };
	return branchLabel(db, step, e, contact);
}

/**
 * Decide which way a branch sends this enrollment (#75). #395: a misconfigured or dangling
 * legacy condition (no tag / field / list / step, a deleted list, an unknown kind) returns
 * 'misconfigured' — the caller routes it NO and records BRANCH_NOT_CONFIGURED — the same as
 * a #221 rule that can't compile counts as false. (Before #395 these failed open to YES.)
 */
async function branchLabel(
	db: D1Database,
	step: StepRow,
	e: DueRow,
	contact: ContactRow
): Promise<'yes' | 'no' | 'misconfigured'> {
	const kind = step.gate_kind ?? '';

	// A/B split: deterministic per (enrollment, step) so a retried tick can't flip sides.
	if (kind === 'split') {
		const pct = Math.min(100, Math.max(0, step.split_pct ?? 50));
		// Knuth multiplicative hash over the ids — stable, uniform enough for A/B.
		const h = Math.abs((e.id * 2654435761 + step.id * 40503) % 100);
		return h < pct ? 'yes' : 'no';
	}

	// #221: a rule set (match all/any) replaces the single gate. NULL = legacy columns below.
	const ruleSet = parseGateRules(step.gate_rules);
	if (ruleSet) {
		const { pass } = await evaluateRules(db, contact.id, ruleSet, { stepId: step.id, enrollmentId: e.id });
		return pass ? 'yes' : 'no';
	}

	// Engagement: did this contact open/click the referenced email step's campaign?
	// #395: Apple Mail / prefetch auto-opens don't count as "opened" (classifyProxyOpen, the
	// campaign stats' filter); a click does, since a click implies a real open.
	if (kind === 'opened' || kind === 'clicked') {
		if (!step.gate_ref_id) return 'misconfigured';
		if (kind === 'opened') return (await contactOpenedStep(db, step.gate_ref_id, contact.id)) ? 'yes' : 'no';
		const hit = await db
			.prepare(
				`SELECT 1 FROM events ev
				 JOIN campaigns c ON c.id = ev.campaign_id
				 WHERE c.automation_step_id = ? AND ev.contact_id = ? AND ev.type = 'click' LIMIT 1`
			)
			.bind(step.gate_ref_id, contact.id)
			.first<{ 1: number }>();
		return hit ? 'yes' : 'no';
	}

	// List/segment membership — dynamic segments resolve through their rules (#66).
	if (kind === 'list-member') {
		if (!step.gate_ref_id) return 'misconfigured';
		const list = await db
			.prepare('SELECT id, kind, rules FROM lists WHERE id = ?')
			.bind(step.gate_ref_id)
			.first<{ id: number; kind: string; rules: string | null }>();
		if (!list) return 'misconfigured'; // list deleted
		const rules = list.kind === 'segment' ? parseRules(list.rules) : null;
		if (rules) {
			const compiled = compileSegment(rules);
			const hit = await db
				.prepare(`SELECT 1 FROM (${compiled.sql}) WHERE id = ? LIMIT 1`)
				.bind(...compiled.binds, contact.id)
				.first<{ 1: number }>();
			return hit ? 'yes' : 'no';
		}
		const hit = await db
			.prepare('SELECT 1 FROM list_members WHERE list_id = ? AND contact_id = ? LIMIT 1')
			.bind(list.id, contact.id)
			.first<{ 1: number }>();
		return hit ? 'yes' : 'no';
	}

	// #154: site activity — visited a page containing … / did event … (in the last N days).
	if (kind === 'visited') {
		const cond = decodeVisited(step.gate_name, step.gate_value);
		if (!cond) return 'misconfigured';
		return (await contactMatchesVisited(db, contact.id, cond)) ? 'yes' : 'no';
	}

	// #207: pipeline stage — gate_value 'in' (gate_ref_id = stage id) | 'any' | 'none'.
	if (kind === 'pipeline-stage') {
		const mode = step.gate_value ?? '';
		if (mode !== 'in' && mode !== 'any' && mode !== 'none') return 'misconfigured';
		if (mode === 'in' && !step.gate_ref_id) return 'misconfigured';
		const card = await db
			.prepare('SELECT stage_id FROM pipeline_cards WHERE contact_id = ?')
			.bind(contact.id)
			.first<{ stage_id: number }>();
		const hit = mode === 'none' ? !card : mode === 'any' ? !!card : card?.stage_id === step.gate_ref_id;
		return hit ? 'yes' : 'no';
	}

	// #170: the contact's company metric (no company / no value = NO).
	if (kind === 'company-metric') {
		const cond = decodeCondition(`${step.gate_name ?? ''}:${step.gate_value ?? ''}`);
		if (!cond) return 'misconfigured';
		return (await contactMatchesMetric(db, contact.id, cond)) ? 'yes' : 'no';
	}

	// Contact-shaped conditions share the gate evaluator (tag / no-tag / field-*).
	const hit = evalContactCondition(step, contact);
	return hit === null ? 'misconfigured' : hit ? 'yes' : 'no';
}

/** #395: did the contact really open this email step's campaign — a click, or an open that
 *  `classifyProxyOpen` doesn't flag as an Apple Mail / prefetch auto-open? */
async function contactOpenedStep(db: D1Database, emailStepId: number, contactId: number): Promise<boolean> {
	const rows = await db
		.prepare(
			`SELECT ev.type, ev.detail, ev.recorded_at,
			        (SELECT MIN(d.recorded_at) FROM events d
			          WHERE d.campaign_id = ev.campaign_id AND d.type = 'delivery' AND d.recipient_id = ev.recipient_id) AS delivered_at
			 FROM events ev
			 JOIN campaigns c ON c.id = ev.campaign_id
			 WHERE c.automation_step_id = ? AND ev.contact_id = ? AND ev.type IN ('open', 'click')
			 ORDER BY ev.type = 'click' DESC
			 LIMIT 50`
		)
		.bind(emailStepId, contactId)
		.all<{ type: string; detail: string | null; recorded_at: string; delivered_at: string | null }>();
	return rows.results.some((r) => r.type === 'click' || !classifyProxyOpen(parseDetail(r.detail), r.delivered_at, r.recorded_at));
}

function parseDetail(raw: string | null): unknown {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * Contact-shaped branch condition (#78; unified with gates #13/0029): the contains kinds
 * are evaluated inline (substring, case-insensitive, against the contact's meta field);
 * everything else goes through the shared conditional grammar. Null = misconfigured (#395:
 * the caller routes it NO).
 */
function evalContactCondition(step: StepRow, contact: ContactRow): boolean | null {
	if (step.gate_kind === 'field-contains' || step.gate_kind === 'field-not-contains') {
		const name = (step.gate_name ?? '').trim();
		const needle = (step.gate_value ?? '').trim();
		if (!name || !needle) return null;
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(contact.meta ?? '{}') ?? {};
		} catch {
			/* malformed meta — treated as empty */
		}
		const hay = String(meta[name] ?? '');
		const hit = hay.toLowerCase().includes(needle.toLowerCase());
		return step.gate_kind === 'field-contains' ? hit : !hit;
	}
	const cond = gateCondition(step);
	return cond ? checkCondition(cond, buildCondCtx(contact.tags, contact.meta)) : null;
}

/**
 * Cancel the contact's active pass in one automation. This is the `end_automation`
 * write (#128): status cancelled, next run cleared, ended_at stamped. A contact with
 * no active pass is unchanged. Returns how many rows changed (0 or 1).
 */
export async function endActiveEnrollment(
	db: D1Database,
	automationId: number,
	contactId: number
): Promise<number> {
	const res = await db
		.prepare(
			`UPDATE automation_enrollments SET status='cancelled', next_run_at=NULL, ended_at=datetime('now')
			 WHERE automation_id=? AND contact_id=? AND status='active'`
		)
		.bind(automationId, contactId)
		.run();
	return res.meta.changes ?? 0;
}

/**
 * Cancel the contact's active pass in EVERY automation except `excludeAutomationId`. This
 * is the `end_all_automations` write (#128) — same per-row effect as `endActiveEnrollment`
 * (status cancelled, next run cleared, ended_at stamped), applied to every other active
 * pass in one statement. `excludeAutomationId` is always the automation the action step
 * itself lives in, so the pass currently running this step is never touched. Returns how
 * many rows changed (0 if the contact had no other active passes).
 */
export async function endAllOtherActiveEnrollments(
	db: D1Database,
	excludeAutomationId: number,
	contactId: number
): Promise<number> {
	const res = await db
		.prepare(
			`UPDATE automation_enrollments SET status='cancelled', next_run_at=NULL, ended_at=datetime('now')
			 WHERE contact_id=? AND automation_id!=? AND status='active'`
		)
		.bind(contactId, excludeAutomationId)
		.run();
	return res.meta.changes ?? 0;
}

/** Branch rule → condition string for the shared evaluator (#13/#75). Misconfigured = null
 *  (#395: the branch goes NO and records that it isn't configured). */
function gateCondition(step: StepRow): string | null {
	const name = (step.gate_name ?? '').trim().replaceAll('}', '').replaceAll('"', '');
	if (!name) return null;
	if (step.gate_kind === 'tag' || step.gate_kind === 'no-tag') {
		const negate = step.gate_kind === 'no-tag';
		// Null would fail this branch open (YES). A name the parser rejects must stay
		// a condition so checkCondition returns false, the same as before #126.
		return formatTagCondition(name, negate) ?? `${negate ? '!' : ''}tag:${name}`;
	}
	if (step.gate_kind === 'field-exists') return `field:${name}`;
	if (step.gate_kind === 'field-not-exists') return `!field:${name}`;
	if (step.gate_kind === 'field-eq')
		return `field:${name} == "${(step.gate_value ?? '').replaceAll('"', '').replaceAll('}', '')}"`;
	return null;
}

/** Apply a tag-action step to the contact. `add` = find-or-create the tag list +
 *  INSERT OR IGNORE membership; `remove` = DELETE membership. Idempotent. No autoEnroll
 *  — tag steps don't trigger other automations in v1 (no chaining). */
async function applyTagAction(db: D1Database, step: StepRow, contactId: number): Promise<void> {
	const name = (step.tag_name ?? '').trim();
	if (!name) return; // misconfigured step → no-op

	if (step.tag_action === 'remove') {
		await db
			.prepare(
				`DELETE FROM list_members
				 WHERE contact_id = ? AND list_id IN (SELECT id FROM lists WHERE name = ? COLLATE NOCASE AND kind = 'tag')`
			)
			.bind(contactId, name)
			.run();
		return;
	}

	await addTag(db, name, contactId);
}

/** Find a tag by name, or create it. Lookup is case-insensitive so a second spelling
 *  does not create another row. Does not add a contact. */
export async function ensureTag(db: D1Database, name: string): Promise<number | null> {
	const tagName = name.trim();
	if (!tagName) return null;
	const existing = await db
		.prepare("SELECT id FROM lists WHERE name = ? COLLATE NOCASE AND kind = 'tag'")
		.bind(tagName)
		.first<{ id: number }>();
	if (existing) return existing.id;
	const created = await db
		.prepare("INSERT INTO lists (name, kind) VALUES (?, 'tag') RETURNING id")
		.bind(tagName)
		.first<{ id: number }>();
	return created?.id ?? null;
}

/** Find-or-create a tag list (kind='tag') and add the contact. Idempotent — membership
 *  PK (list_id, contact_id) makes re-adds a no-op. Shared by tag steps (engine) and
 *  engagement auto-tagging at webhook time (#42). */
export async function addTag(db: D1Database, name: string, contactId: number): Promise<void> {
	const tagId = await ensureTag(db, name);
	if (tagId == null) return;
	await db
		.prepare('INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)')
		.bind(tagId, contactId)
		.run();
}

/** #250: a step's email — its editor blocks when set, else the markdown as before. */
function renderStepBody(step: StepRow, signature: EmailSignature | null): { html: string; text: string } {
	return renderBody(
		{ blocks: storedBlocks(step.body_blocks), md: step.body_md },
		{ preheader: step.preheader ?? undefined, signature }
	);
}

/** #398: variant B of an A/B test — its own body when set (markdown), else the step's body;
 *  its own preheader when set, else the step's. */
export function renderVariantBody(step: StepRow, signature: EmailSignature | null): { html: string; text: string } {
	const ownBody = (step.ab_body_md ?? '').trim();
	return renderBody(
		ownBody ? { blocks: null, md: ownBody } : { blocks: storedBlocks(step.body_blocks), md: step.body_md },
		{ preheader: (step.ab_preheader ?? '').trim() || step.preheader || undefined, signature }
	);
}

/** One campaign per step. The partial-unique index on automation_step_id makes the
 *  insert race-safe; on conflict we fall through to the re-select. */
async function getOrCreateStepCampaign(
	db: D1Database,
	automationId: number,
	step: StepRow,
	signature: EmailSignature | null
): Promise<number> {
	const existing = await db
		.prepare(`SELECT id FROM campaigns WHERE automation_step_id = ? LIMIT 1`)
		.bind(step.id)
		.first<{ id: number }>();
	if (existing) return existing.id;

	const { html } = renderStepBody(step, signature);
	const created = await db
		.prepare(
			// The conflict target must repeat the partial index's WHERE predicate.
			`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, automation_id, automation_step_id, sent_at)
			 VALUES (?, ?, ?, NULL, ?, 'sending', ?, ?, NULL)
			 ON CONFLICT(automation_step_id) WHERE automation_step_id IS NOT NULL DO NOTHING
			 RETURNING id`
		)
		.bind(step.subject, step.body_md, html, step.from_email, automationId, step.id)
		.first<{ id: number }>();
	if (created) return created.id;

	// Lost the insert race to a concurrent tick — read the winner's row.
	const won = await db
		.prepare(`SELECT id FROM campaigns WHERE automation_step_id = ? LIMIT 1`)
		.bind(step.id)
		.first<{ id: number }>();
	if (!won) throw new Error(`step campaign missing after conflict for step ${step.id}`);
	return won.id;
}

// --- Auto-enrollment for the `list_added` trigger (#6) --------------------------
// Called from every path that adds a contact to a list (CSV import, manual add,
// bulk add-to-list/segment, and the ingest API). Best-effort: callers wrap these
// so a failure never breaks the contact-add happy path.

function chunkArr<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

async function listAddedAutomations(db: D1Database, listId: number): Promise<{ id: number; status: string }[]> {
	const rows = await db
		.prepare(
			`SELECT id, status FROM automations
			 WHERE status IN ('active', 'paused') AND trigger_type = 'list_added' AND trigger_list_id = ?`
		)
		.bind(listId)
		.all<{ id: number; status: string }>();
	return rows.results;
}

/** Enroll the given contact ids into any active list_added automation on `listId`. #397: a
 *  PAUSED one records them instead (offered for enrollment on resume, never automatic). */
export async function autoEnroll(db: D1Database, listId: number, contactIds: number[]): Promise<void> {
	if (!listId || contactIds.length === 0) return;
	const autos = await listAddedAutomations(db, listId);
	if (autos.length === 0) return;
	for (const a of autos) {
		if (a.status === 'paused') await recordPendingTriggers(db, a.id, contactIds, 'list_added');
		else await enroll(db, a.id, contactIds);
	}
}

/** Same, but for callers that hold emails (import/manual add). Resolves ids only if
 *  a triggered automation actually exists, so the common case is one cheap query. */
export async function autoEnrollByEmails(db: D1Database, listId: number, emails: string[]): Promise<void> {
	if (!listId || emails.length === 0) return;
	const autos = await listAddedAutomations(db, listId);
	if (autos.length === 0) return;

	const ids: number[] = [];
	for (const part of chunkArr(emails, 100)) {
		const placeholders = part.map(() => '?').join(',');
		const rows = await db
			.prepare(`SELECT id FROM contacts WHERE email IN (${placeholders})`)
			.bind(...part)
			.all<{ id: number }>();
		ids.push(...rows.results.map((r) => r.id));
	}
	for (const a of autos) {
		if (a.status === 'paused') await recordPendingTriggers(db, a.id, ids, 'list_added');
		else await enroll(db, a.id, ids);
	}
}

async function bumpCampaignSent(db: D1Database, campaignId: number): Promise<void> {
	await db
		.prepare(
			`UPDATE campaigns
			 SET recipient_count = recipient_count + 1,
			     status = 'sent',
			     sent_at = COALESCE(sent_at, datetime('now'))
			 WHERE id = ?`
		)
		.bind(campaignId)
		.run();
}
