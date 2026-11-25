// Post-send deliverability alerts (#305). Run by the heartbeat tick (runDeliverabilityChecks):
//
// - every broadcast (kind campaign: a list, not an automation step) is checked once 2 h and
//   once 24 h after `sent_at` — only campaigns sent in the last 72 h are looked at, so the
//   first deploy never alerts on old sends; a campaign first seen past 24 h gets only the
//   24 h check;
// - every automation with mail landing in the last 7 days is checked once per UTC day.
//
// A check claims its `deliverability_checks` row with INSERT OR IGNORE on the UNIQUE
// (scope, ref_id, check_key) — only the winner computes, so overlapping ticks can't double
// alert. A failed compute deletes the claim so the next tick retries.
//
// Counts: campaign `sent` = accepted recipients; bounces / hard bounces / complaints =
// distinct recipients with that event on the campaign (hard = the bounce-filter rule).
// Automations have no per-recipient send time, so their 7-day `sent` = distinct messages on
// the automation's step campaigns with a delivery or bounce event in the window.
//
// On warning or critical: the row is the banner (Dashboard + Deliverability, until
// dismissed) and the activity-feed row; an optional webhook POST (the #303 delivery + SSRF
// guard); on critical, when the setting is on, scheduled broadcasts to the same list are
// HELD (campaigns.held_at) until an admin releases them — never cancelled.

import {
	checkLevel,
	checkRates,
	formatRate,
	normalizeAlertConfig,
	type ActiveAlert,
	type AlertConfig,
	type AlertLevel,
	type Reason,
	type CheckCounts,
	type Thresholds
} from '$lib/deliverability-alerts';
import { deliverWebhook, type Delivery } from './ai/jobs-webhook';
import { campaignContactsHref } from './bounce-filter';

export const ALERT_CONFIG_KEY = 'deliverability_alerts_config';
/** Campaigns older than this are never checked (first-deploy guard). */
const CAMPAIGN_LOOKBACK_HOURS = 72;
/** How long an undismissed alert stays on the banner. */
const BANNER_DAYS = 14;
const PER_TICK = 10;
const USER_AGENT = 'ds-email-deliverability/1';

const HARD = `(e.detail LIKE '%"Type":"HardBounce"%' OR e.detail LIKE '%"Type":"BadEmailAddress"%' OR e.detail LIKE '%"Inactive":true%')`;
// One message: the recipient row when the webhook matched one, else Postmark's MessageID.
const MSG = `COALESCE(CAST(e.recipient_id AS TEXT), e.message_id, 'e' || e.id)`;


/** 'YYYY-MM-DD HH:MM:SS' UTC, the format of every timestamp column here. */
export function sqlTime(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---- config ----

export async function getAlertConfig(db: D1Database): Promise<AlertConfig> {
	const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(ALERT_CONFIG_KEY).first<{ value: string | null }>();
	try {
		return normalizeAlertConfig(row?.value ? JSON.parse(row.value) : null);
	} catch {
		return normalizeAlertConfig(null);
	}
}

export async function saveAlertConfig(db: D1Database, cfg: AlertConfig): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(ALERT_CONFIG_KEY, JSON.stringify(normalizeAlertConfig(cfg)))
		.run();
}

// ---- counts ----

export async function campaignCounts(db: D1Database, campaignId: number): Promise<CheckCounts> {
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM recipients WHERE campaign_id = ?1 AND status = 'accepted') AS sent,
			   (SELECT COUNT(DISTINCT ${MSG}) FROM events e WHERE e.campaign_id = ?1 AND e.type = 'bounce') AS bounces,
			   (SELECT COUNT(DISTINCT ${MSG}) FROM events e WHERE e.campaign_id = ?1 AND e.type = 'bounce' AND ${HARD}) AS hard_bounces,
			   (SELECT COUNT(DISTINCT ${MSG}) FROM events e WHERE e.campaign_id = ?1 AND e.type = 'spam') AS complaints`
		)
		.bind(campaignId)
		.first<CheckCounts>();
	return row ?? { sent: 0, bounces: 0, hard_bounces: 0, complaints: 0 };
}

/** Mail that landed (delivered or bounced) in [since, until) on campaigns matching `scope`. */
async function windowCounts(db: D1Database, scope: string, binds: unknown[], since: string, until: string): Promise<CheckCounts> {
	const base = `FROM events e JOIN campaigns cp ON cp.id = e.campaign_id
		WHERE ${scope} AND e.recorded_at >= ? AND e.recorded_at < ?`;
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(DISTINCT ${MSG}) ${base} AND e.type IN ('delivery', 'bounce')) AS sent,
			   (SELECT COUNT(DISTINCT ${MSG}) ${base} AND e.type = 'bounce') AS bounces,
			   (SELECT COUNT(DISTINCT ${MSG}) ${base} AND e.type = 'bounce' AND ${HARD}) AS hard_bounces,
			   (SELECT COUNT(DISTINCT ${MSG}) ${base} AND e.type = 'spam') AS complaints`
		)
		.bind(...binds, since, until, ...binds, since, until, ...binds, since, until, ...binds, since, until)
		.first<CheckCounts>();
	return row ?? { sent: 0, bounces: 0, hard_bounces: 0, complaints: 0 };
}

export function automationCounts(db: D1Database, automationId: number, now: Date, days = 7): Promise<CheckCounts> {
	const since = sqlTime(new Date(now.getTime() - days * 86_400_000));
	return windowCounts(db, 'cp.automation_id = ?', [automationId], since, sqlTime(new Date(now.getTime() + 1000)));
}

async function topReasons(db: D1Database, where: string, binds: unknown[]): Promise<Reason[]> {
	const rows = await db
		.prepare(
			`SELECT COALESCE(CASE WHEN json_valid(e.detail) THEN json_extract(e.detail, '$.Type') END, 'Unknown') AS reason,
			        COUNT(*) AS n
			 FROM events e JOIN campaigns cp ON cp.id = e.campaign_id
			 WHERE e.type = 'bounce' AND ${where}
			 GROUP BY reason ORDER BY n DESC, reason LIMIT 3`
		)
		.bind(...binds)
		.all<Reason>();
	return rows.results;
}

// ---- webhook payload ----

export type AlertPayloadInput = {
	level: AlertLevel;
	scope: 'campaign' | 'automation';
	check: string;
	campaign: { id: number; subject: string } | null;
	automation: { id: number; name: string } | null;
	counts: CheckCounts;
	thresholds: Thresholds;
	reasons: Reason[];
	held: number[];
	checkedAt: string;
	appUrl: string;
};

function slackEscape(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function checkLabel(check: string): string {
	if (check === '2h') return '2 hours after sending';
	if (check === '24h') return '24 hours after sending';
	return 'last 7 days';
}

/** The webhook body: `json` (structured) or `slack` (`{ text }` mrkdwn). */
export function buildAlertPayload(format: 'json' | 'slack', p: AlertPayloadInput): string {
	const r = checkRates(p.counts);
	const base = p.appUrl.replace(/\/$/, '');
	const recordUrl = p.campaign ? `${base}/campaign/${p.campaign.id}` : p.automation ? `${base}/automations/${p.automation.id}` : base;
	const bouncedUrl = p.campaign ? `${base}${campaignContactsHref(p.campaign.id, 'bounced')}` : `${base}/contacts?bounced=any`;
	if (format === 'slack') {
		const what = p.campaign ? `campaign “${slackEscape(p.campaign.subject)}”` : `automation “${slackEscape(p.automation?.name ?? '')}”`;
		const lines = [
			`*Deliverability ${p.level}* on ${what} (${checkLabel(p.check)})`,
			`• Hard bounces ${formatRate(r.hardRate)} (warning ${formatRate(p.thresholds.hardWarn)}, critical ${formatRate(p.thresholds.hardCrit)})`,
			`• All bounces ${formatRate(r.bounceRate)} · ${p.counts.bounces} of ${p.counts.sent}`,
			`• Complaints ${formatRate(r.complaintRate)} (warning ${formatRate(p.thresholds.complaintWarn)}, critical ${formatRate(p.thresholds.complaintCrit)})`
		];
		if (p.reasons.length) lines.push(`• Top bounce reasons: ${p.reasons.map((x) => `${slackEscape(x.reason)} ${x.n}`).join(', ')}`);
		if (p.held.length) lines.push(`• Held ${p.held.length} scheduled send${p.held.length === 1 ? '' : 's'} to the same list until an admin releases ${p.held.length === 1 ? 'it' : 'them'}.`);
		lines.push(`<${recordUrl}|Open ${p.campaign ? 'campaign' : 'automation'}> · <${bouncedUrl}|Open bounced contacts>`);
		return JSON.stringify({ text: lines.join('\n') });
	}
	return JSON.stringify({
		event: 'deliverability_alert',
		level: p.level,
		scope: p.scope,
		check: p.check,
		campaign: p.campaign ? { ...p.campaign, url: recordUrl } : null,
		automation: p.automation ? { ...p.automation, url: recordUrl } : null,
		sent: p.counts.sent,
		bounces: p.counts.bounces,
		hard_bounces: p.counts.hard_bounces,
		complaints: p.counts.complaints,
		bounce_rate: r.bounceRate,
		hard_bounce_rate: r.hardRate,
		complaint_rate: r.complaintRate,
		thresholds: {
			hard_bounce_warning: p.thresholds.hardWarn,
			hard_bounce_critical: p.thresholds.hardCrit,
			complaint_warning: p.thresholds.complaintWarn,
			complaint_critical: p.thresholds.complaintCrit
		},
		top_reasons: p.reasons,
		bounced_contacts_url: bouncedUrl,
		held_campaign_ids: p.held,
		checked_at: p.checkedAt,
		app_url: base
	});
}

/** The fixed sample Settings → Deliverability's "Send test alert" posts. */
export function sampleAlertPayload(cfg: AlertConfig, appUrl: string, now: Date): AlertPayloadInput {
	return {
		level: 'critical',
		scope: 'campaign',
		check: '2h',
		campaign: { id: 0, subject: 'Test alert from Settings → Deliverability' },
		automation: null,
		counts: { sent: 1170, bounces: 140, hard_bounces: 120, complaints: 1 },
		thresholds: cfg,
		reasons: [
			{ reason: 'HardBounce', n: 120 },
			{ reason: 'SoftBounce', n: 20 }
		],
		held: [],
		checkedAt: sqlTime(now),
		appUrl
	};
}

export function sendAlertWebhook(cfg: AlertConfig, p: AlertPayloadInput, fetchImpl?: typeof fetch): Promise<Delivery> {
	return deliverWebhook(cfg.webhookUrl, buildAlertPayload(cfg.webhookFormat, p), { fetch: fetchImpl, userAgent: USER_AGENT });
}

// ---- hold / release ----

/** Hold every queued scheduled broadcast to `listId` — incl. one that includes it among several
 *  groups (#332). Returns their ids. #479: a deliverability hold wins over a pre-send one: a
 *  send held by its pre-send checks (held_reason 'preflight') is taken over (reason, this
 *  alert's check id, a fresh held_at), and a send waiting out its pre-send retry window is held
 *  too; the retry window and any "Send anyway" are cleared. So Re-check now / Send anyway (which
 *  act only on 'preflight' holds) can't release it; only an admin's Release can. */
export async function holdScheduledForList(db: D1Database, listId: number, checkId: number, now: Date): Promise<number[]> {
	const rows = await db
		.prepare(
			`UPDATE campaigns SET held_at = ?1, held_check_id = ?2, held_reason = 'deliverability', preflight_retry_until = NULL,
			        preflight_override_by = NULL, preflight_override_user_id = NULL
			 WHERE status = 'scheduled' AND (held_at IS NULL OR held_reason = 'preflight')
			   AND (list_id = ?3 OR EXISTS (SELECT 1 FROM campaign_audiences ca
			          WHERE ca.campaign_id = campaigns.id AND ca.list_id = ?3 AND ca.mode = 'include'))
			 RETURNING id`
		)
		.bind(sqlTime(now), checkId, listId)
		.all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

/** Release one held campaign. It goes back to its schedule (fires next tick if past due). A
 *  #479 preflight hold released this way is checked again when it fires (a fresh window). A
 *  new hold and a release both drop a "Send anyway" (#479: it counts for one fire only). */
export async function releaseHeldCampaign(db: D1Database, campaignId: number): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE campaigns SET held_at = NULL, held_check_id = NULL, held_reason = NULL, preflight_retry_until = NULL,
			        preflight_override_by = NULL, preflight_override_user_id = NULL
			 WHERE id = ? AND held_at IS NOT NULL`
		)
		.bind(campaignId)
		.run();
	return res.meta.changes > 0;
}

export type HeldCampaign = {
	id: number;
	subject: string;
	scheduled_at: string | null;
	status: string;
	held_at: string;
	held_check_id: number | null;
	/** #479: 'deliverability' (#305) | 'preflight' (failed pre-send checks at fire time). */
	held_reason: string | null;
	list_name: string | null;
};

export async function heldCampaigns(db: D1Database): Promise<HeldCampaign[]> {
	const rows = await db
		.prepare(
			`SELECT c.id, c.subject, c.scheduled_at, c.status, c.held_at, c.held_check_id, COALESCE(c.held_reason, 'deliverability') AS held_reason, l.name AS list_name
			 FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id
			 WHERE c.held_at IS NOT NULL ORDER BY c.scheduled_at`
		)
		.all<HeldCampaign>();
	return rows.results;
}

// ---- the tick ----

export type CheckSummary = { checked: number; warnings: number; critical: number; held: number; webhooks: number; errors: number };

type Ctx = { db: D1Database; cfg: AlertConfig; now: Date; appUrl: string; fetch?: typeof fetch; sum: CheckSummary };

async function claim(db: D1Database, scope: 'campaign' | 'automation', refId: number, key: string, now: Date): Promise<number | null> {
	const row = await db
		.prepare(
			`INSERT OR IGNORE INTO deliverability_checks (scope, ref_id, check_key, checked_at) VALUES (?, ?, ?, ?) RETURNING id`
		)
		.bind(scope, refId, key, sqlTime(now))
		.first<{ id: number }>();
	return row?.id ?? null;
}

async function finish(
	ctx: Ctx,
	checkId: number,
	input: Omit<AlertPayloadInput, 'level' | 'thresholds' | 'held' | 'checkedAt' | 'appUrl' | 'reasons'>,
	reasonsWhere: { where: string; binds: unknown[] },
	listId: number | null
): Promise<void> {
	const { db, cfg, now, sum } = ctx;
	const { level } = checkLevel(input.counts, cfg);
	const reasons = input.counts.bounces > 0 ? await topReasons(db, reasonsWhere.where, reasonsWhere.binds) : [];
	let held: number[] = [];
	if (level === 'critical' && cfg.holdOnCritical && input.scope === 'campaign' && listId) {
		held = await holdScheduledForList(db, listId, checkId, now);
	}
	let delivery: Delivery | null = null;
	if (level !== 'ok' && cfg.webhookUrl) {
		delivery = await sendAlertWebhook(
			cfg,
			{ ...input, level, thresholds: cfg, reasons, held, checkedAt: sqlTime(now), appUrl: ctx.appUrl },
			ctx.fetch
		);
		sum.webhooks++;
	}
	await db
		.prepare(
			`UPDATE deliverability_checks SET level = ?, sent = ?, bounces = ?, hard_bounces = ?, complaints = ?,
			   reasons = ?, held_count = ?, webhook_status = ?, webhook_error = ?
			 WHERE id = ?`
		)
		.bind(
			level,
			input.counts.sent,
			input.counts.bounces,
			input.counts.hard_bounces,
			input.counts.complaints,
			JSON.stringify(reasons),
			held.length,
			delivery?.status ?? null,
			delivery?.error ?? null,
			checkId
		)
		.run();
	sum.checked++;
	if (level === 'warning') sum.warnings++;
	if (level === 'critical') sum.critical++;
	sum.held += held.length;
}

async function checkCampaigns(ctx: Ctx): Promise<void> {
	const nowSql = sqlTime(ctx.now);
	const due = await ctx.db
		.prepare(
			`SELECT id, subject, list_id, CASE WHEN sent_at <= datetime(?1, '-24 hours') THEN '24h' ELSE '2h' END AS check_key
			 FROM campaigns c
			 WHERE c.status = 'sent' AND c.list_id IS NOT NULL AND c.automation_step_id IS NULL AND c.sent_at IS NOT NULL
			   AND c.sent_at <= datetime(?1, '-2 hours') AND c.sent_at >= datetime(?1, '-${CAMPAIGN_LOOKBACK_HOURS} hours')
			   AND NOT EXISTS (SELECT 1 FROM deliverability_checks d WHERE d.scope = 'campaign' AND d.ref_id = c.id
			         AND d.check_key = CASE WHEN c.sent_at <= datetime(?1, '-24 hours') THEN '24h' ELSE '2h' END)
			 ORDER BY c.sent_at LIMIT ${PER_TICK}`
		)
		.bind(nowSql)
		.all<{ id: number; subject: string; list_id: number; check_key: '2h' | '24h' }>();
	for (const c of due.results) {
		const checkId = await claim(ctx.db, 'campaign', c.id, c.check_key, ctx.now);
		if (!checkId) continue; // another tick won
		try {
			const counts = await campaignCounts(ctx.db, c.id);
			await finish(
				ctx,
				checkId,
				{ scope: 'campaign', check: c.check_key, campaign: { id: c.id, subject: c.subject }, automation: null, counts },
				{ where: 'e.campaign_id = ?', binds: [c.id] },
				c.list_id
			);
		} catch (e) {
			ctx.sum.errors++;
			console.error('deliverability check failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
			await ctx.db.prepare(`DELETE FROM deliverability_checks WHERE id = ? AND level = 'pending'`).bind(checkId).run();
		}
	}
}

async function checkAutomations(ctx: Ctx): Promise<void> {
	const key = `7d:${sqlTime(ctx.now).slice(0, 10)}`;
	const since = sqlTime(new Date(ctx.now.getTime() - 7 * 86_400_000));
	const due = await ctx.db
		.prepare(
			`SELECT a.id, a.name FROM automations a
			 WHERE EXISTS (SELECT 1 FROM campaigns cp JOIN events e ON e.campaign_id = cp.id
			               WHERE cp.automation_id = a.id AND e.type IN ('delivery', 'bounce') AND e.recorded_at >= ?)
			   AND NOT EXISTS (SELECT 1 FROM deliverability_checks d WHERE d.scope = 'automation' AND d.ref_id = a.id AND d.check_key = ?)
			 ORDER BY a.id LIMIT ${PER_TICK}`
		)
		.bind(since, key)
		.all<{ id: number; name: string }>();
	for (const a of due.results) {
		const checkId = await claim(ctx.db, 'automation', a.id, key, ctx.now);
		if (!checkId) continue;
		try {
			const counts = await automationCounts(ctx.db, a.id, ctx.now);
			await finish(
				ctx,
				checkId,
				{ scope: 'automation', check: '7d', campaign: null, automation: { id: a.id, name: a.name }, counts },
				{ where: 'cp.automation_id = ? AND e.recorded_at >= ?', binds: [a.id, since] },
				null
			);
		} catch (e) {
			ctx.sum.errors++;
			console.error('deliverability check failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
			await ctx.db.prepare(`DELETE FROM deliverability_checks WHERE id = ? AND level = 'pending'`).bind(checkId).run();
		}
	}
}

/** The heartbeat entry: due campaign checks (2 h / 24 h) + today's automation checks. */
export async function runDeliverabilityChecks(
	db: D1Database,
	opts: { appUrl: string; now?: Date; fetch?: typeof fetch }
): Promise<CheckSummary> {
	const sum: CheckSummary = { checked: 0, warnings: 0, critical: 0, held: 0, webhooks: 0, errors: 0 };
	const ctx: Ctx = { db, cfg: await getAlertConfig(db), now: opts.now ?? new Date(), appUrl: opts.appUrl, fetch: opts.fetch, sum };
	await checkCampaigns(ctx);
	await checkAutomations(ctx);
	return sum;
}

// ---- banner + digest reads ----


/** Undismissed warning/critical checks from the last 14 days, newest per campaign/automation. */
export async function activeAlerts(db: D1Database): Promise<ActiveAlert[]> {
	const rows = await db
		.prepare(
			`SELECT d.id, d.scope, d.ref_id, d.check_key, d.level, d.sent, d.bounces, d.hard_bounces, d.complaints,
			        d.reasons, d.held_count, d.checked_at,
			        CASE d.scope WHEN 'campaign' THEN (SELECT subject FROM campaigns WHERE id = d.ref_id)
			                     ELSE (SELECT name FROM automations WHERE id = d.ref_id) END AS title
			 FROM deliverability_checks d
			 WHERE d.level IN ('warning', 'critical') AND d.dismissed_at IS NULL
			   AND d.checked_at >= datetime('now', '-${BANNER_DAYS} days')
			 ORDER BY d.checked_at DESC, d.id DESC LIMIT 50`
		)
		.all<Omit<ActiveAlert, 'reasons' | 'href' | 'bounced_href' | 'held'> & { reasons: string | null }>();
	const seen = new Set<string>();
	const out: ActiveAlert[] = [];
	for (const r of rows.results) {
		const k = `${r.scope}:${r.ref_id}`;
		if (seen.has(k)) continue;
		seen.add(k);
		let reasons: Reason[] = [];
		try {
			reasons = r.reasons ? (JSON.parse(r.reasons) as Reason[]) : [];
		} catch {
			reasons = [];
		}
		out.push({
			...r,
			reasons,
			href: r.scope === 'campaign' ? `/campaign/${r.ref_id}` : `/automations/${r.ref_id}`,
			bounced_href: r.scope === 'campaign' ? campaignContactsHref(r.ref_id, 'bounced') : '/contacts?bounced=any',
			held: []
		});
	}
	const withHolds = out.filter((a) => a.held_count > 0);
	if (withHolds.length) {
		const held = await db
			.prepare(
				`SELECT id, subject, scheduled_at, held_check_id FROM campaigns
				 WHERE held_at IS NOT NULL AND held_check_id IN (SELECT value FROM json_each(?))`
			)
			.bind(JSON.stringify(withHolds.map((a) => a.id)))
			.all<{ id: number; subject: string; scheduled_at: string | null; held_check_id: number }>();
		for (const a of withHolds) a.held = held.results.filter((h) => h.held_check_id === a.id).map(({ held_check_id: _x, ...h }) => h);
	}
	return out;
}

/** Hide one alert (and any older ones for the same record) from the banners. */
export async function dismissAlert(db: D1Database, checkId: number, userId: number | null): Promise<boolean> {
	const row = await db.prepare(`SELECT scope, ref_id FROM deliverability_checks WHERE id = ?`).bind(checkId).first<{ scope: string; ref_id: number }>();
	if (!row) return false;
	await db
		.prepare(
			`UPDATE deliverability_checks SET dismissed_at = datetime('now'), dismissed_by = ?
			 WHERE scope = ? AND ref_id = ? AND id <= ? AND dismissed_at IS NULL`
		)
		.bind(userId, row.scope, row.ref_id, checkId)
		.run();
	return true;
}

export type WeekStats = CheckCounts & { hardRate: number; complaintRate: number; bounceRate: number };
export type WeeklyDigest = {
	current: WeekStats;
	previous: WeekStats;
	hardLevel: AlertLevel;
	complaintLevel: AlertLevel;
	thresholds: Thresholds;
};

/** "Deliverability this week": the last 7 days against the 7 before, every send. */
export async function weeklyDigest(db: D1Database, now: Date = new Date()): Promise<WeeklyDigest> {
	const cfg = await getAlertConfig(db);
	const t = (days: number) => sqlTime(new Date(now.getTime() - days * 86_400_000));
	const until = sqlTime(new Date(now.getTime() + 1000));
	const [cur, prev] = await Promise.all([windowCounts(db, '1', [], t(7), until), windowCounts(db, '1', [], t(14), t(7))]);
	const stats = (c: CheckCounts): WeekStats => ({ ...c, ...checkRates(c) });
	const lv = checkLevel(cur, cfg);
	return {
		current: stats(cur),
		previous: stats(prev),
		hardLevel: lv.hard,
		complaintLevel: lv.complaint,
		thresholds: { hardWarn: cfg.hardWarn, hardCrit: cfg.hardCrit, complaintWarn: cfg.complaintWarn, complaintCrit: cfg.complaintCrit }
	};
}
