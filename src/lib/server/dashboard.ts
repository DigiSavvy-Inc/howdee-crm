// Dashboard tiles + side cards (#133). Read-only queries over existing tables; the math
// that turns raw counts into what the tiles show lives in `tileMath` so it's testable
// without a database.

import { awaitingReplyCount } from './conversations';
import { visibleCampaignSql } from './system-mail';
import { resendPassBreakdown, type PassBreakdown } from './resend-read'; // not './resend' — that reaches send/postmark (MCP graph)
import { multiGroupLabels } from './campaign-audience';
import { formatLocal } from './businessdays';
import { rate, delta } from '../last-campaign';

export type TileCounts = {
	subscribers: number;
	new_subscribed_30d: number; // contacts created in the last 30d that are still subscribed
	unsubscribes_30d: number; // distinct emails unsubscribed in the last 30d
	sent_7d: number; // accepted recipients on campaigns sent in the last 7d
	opens_7d: number; // unique opens among those recipients
	awaiting_reply: number; // conversations whose last message is inbound (#157)
	active_automations: number;
	active_enrollments: number;
};

export type Tiles = TileCounts & {
	subscriber_delta: number; // new − unsubscribed (30d)
	open_rate_7d: number | null; // 0–100, null when nothing was sent (no divide-by-zero)
};

/** Whole-number percentage, or null when the denominator is 0. */
export function pct(n: number, d: number): number | null {
	if (!d) return null;
	return Math.round((n / d) * 100);
}

export function tileMath(c: TileCounts): Tiles {
	return {
		...c,
		subscriber_delta: c.new_subscribed_30d - c.unsubscribes_30d,
		open_rate_7d: pct(c.opens_7d, c.sent_7d)
	};
}

// A campaign's send time. `recipients` has no timestamp, so the 7-day window keys off the
// campaign (same convention as engagement.ts's first/last_sent_at). Automation-step
// campaigns are one lazy row per step whose sent_at is the step's FIRST send, so their
// later sends don't land in the window — the tile is a broadcast/direct count in practice.
const SENT_AT = `COALESCE(cp.sent_at, cp.created_at)`;

export async function loadTiles(db: D1Database): Promise<Tiles> {
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM contacts WHERE subscribed = 1 AND archived_at IS NULL) AS subscribers,
			   (SELECT COUNT(*) FROM contacts WHERE subscribed = 1 AND archived_at IS NULL AND created_at >= datetime('now', '-30 days')) AS new_subscribed_30d,
			   (SELECT COUNT(DISTINCT email) FROM unsubscribes WHERE created_at >= datetime('now', '-30 days')) AS unsubscribes_30d,
			   (SELECT COUNT(*) FROM recipients r JOIN campaigns cp ON cp.id = r.campaign_id
			      WHERE r.status = 'accepted' AND ${visibleCampaignSql('cp')} AND ${SENT_AT} >= datetime('now', '-7 days')) AS sent_7d,
			   (SELECT COUNT(DISTINCT e.recipient_id) FROM events e
			      JOIN recipients r ON r.id = e.recipient_id
			      JOIN campaigns cp ON cp.id = r.campaign_id
			      WHERE e.type = 'open' AND r.status = 'accepted' AND ${visibleCampaignSql('cp')} AND ${SENT_AT} >= datetime('now', '-7 days')) AS opens_7d,
			   (SELECT COUNT(*) FROM automations WHERE status = 'active') AS active_automations,
			   (SELECT COUNT(*) FROM automation_enrollments WHERE status = 'active') AS active_enrollments`
		)
		.first<Omit<TileCounts, 'awaiting_reply'>>();
	// Threading is done in JS (conversations.ts), not SQL, so this count is its own call.
	const awaiting_reply = await awaitingReplyCount(db);
	return tileMath({
		...(row ?? {
			subscribers: 0,
			new_subscribed_30d: 0,
			unsubscribes_30d: 0,
			sent_7d: 0,
			opens_7d: 0,
			active_automations: 0,
			active_enrollments: 0
		}),
		awaiting_reply
	});
}

export type PipelineTile = {
	open_count: number; // cards in an open stage
	open_value: number; // their total value
	won_month_count: number; // cards in a won stage that got there this calendar month (UTC)
	won_month_value: number;
};

/** The dashboard Pipeline tile (#207). "Won this month" = cards sitting in a won stage whose
 *  `entered_stage_at` is in the current UTC month (a card moved back out no longer counts). */
export async function loadPipelineTile(db: D1Database): Promise<PipelineTile> {
	const row = await db
		.prepare(
			`SELECT
			   COALESCE(SUM(s.kind = 'open'), 0) AS open_count,
			   COALESCE(SUM(CASE WHEN s.kind = 'open' THEN pc.value END), 0) AS open_value,
			   COALESCE(SUM(s.kind = 'won' AND pc.entered_stage_at >= strftime('%Y-%m-01 00:00:00', 'now')), 0) AS won_month_count,
			   COALESCE(SUM(CASE WHEN s.kind = 'won' AND pc.entered_stage_at >= strftime('%Y-%m-01 00:00:00', 'now') THEN pc.value END), 0) AS won_month_value
			 FROM pipeline_cards pc JOIN pipeline_stages s ON s.id = pc.stage_id`
		)
		.first<PipelineTile>();
	return row ?? { open_count: 0, open_value: 0, won_month_count: 0, won_month_value: 0 };
}

export type RecentCampaign = {
	id: number;
	subject: string;
	recipient_count: number;
	sent_at: string | null;
	direct: number; // 1 = 1:1 direct send (no list)
	open_pct: number | null;
	click_pct: number | null;
};

/** Last 5 sent campaigns (broadcast + direct; automation-step rows are excluded — they
 *  belong to their automation and their sent_at is only the first step send).
 *  Open/click % uses accepted recipients, the same denominator as each `/campaigns` row (#196). */
export async function recentCampaigns(db: D1Database): Promise<RecentCampaign[]> {
	const rows = await db
		.prepare(
			`SELECT cp.id, cp.subject, cp.recipient_count, cp.sent_at,
			        CASE WHEN cp.list_id IS NULL THEN 1 ELSE 0 END AS direct,
			        (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = cp.id AND r.status = 'accepted') AS accepted,
			        (SELECT COUNT(DISTINCT recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'open') AS opens,
			        (SELECT COUNT(DISTINCT recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'click') AS clicks
			 FROM campaigns cp
			 WHERE cp.status = 'sent' AND cp.automation_step_id IS NULL AND ${visibleCampaignSql('cp')}
			 ORDER BY ${SENT_AT} DESC, cp.id DESC
			 LIMIT 5`
		)
		.all<
			Omit<RecentCampaign, 'open_pct' | 'click_pct'> & { accepted: number; opens: number; clicks: number }
		>();
	return rows.results.map(({ opens, clicks, accepted, ...r }) => ({
		...r,
		open_pct: pct(opens, accepted),
		click_pct: pct(clicks, accepted)
	}));
}

export type LastCampaign = {
	id: number;
	subject: string;
	sent_at: string | null; // COALESCE(sent_at, created_at), UTC
	recipient_count: number;
	audience: string; // list / segment name, the multi-group label, or 'direct'
	audience_kind: string | null; // lists.kind, null for a direct send
	resent_at: string | null;
	resend_status: string | null;
	resend_subject: string | null;
	resend_scheduled: string | null; // pending resend time in the operator timezone
	sent: number; // accepted recipients (both passes)
	errored: number;
	opens: number; // unique
	clicks: number; // unique
	unsubs: number;
	bounces: number;
	spam: number;
	replies: number;
	open_rate: number | null;
	click_rate: number | null;
	unsub_rate: number | null;
	passes: PassBreakdown | null; // only once a resend went out
	prev: { id: number; subject: string; open_rate: number | null; click_rate: number | null } | null;
	open_delta: number | null;
	click_delta: number | null;
};

const LAST_STATS = `
	(SELECT COUNT(*) FROM recipients WHERE campaign_id = cp.id AND status = 'accepted') AS sent,
	(SELECT COUNT(*) FROM recipients WHERE campaign_id = cp.id AND status = 'error') AS errored,
	(SELECT COUNT(DISTINCT recipient_id) FROM events WHERE campaign_id = cp.id AND type = 'open') AS opens,
	(SELECT COUNT(DISTINCT recipient_id) FROM events WHERE campaign_id = cp.id AND type = 'click') AS clicks`;

/** The dashboard's "Last campaign" card (#451): the newest sent broadcast (automation steps
 *  never count; ordered like `recentCampaigns`), its report-page stats, the original / resend
 *  split once a resend went out, and the open / click rates of the campaign before it. A resend
 *  is the same campaigns row, so `id` is always the primary campaign. Null = nothing sent. */
export async function lastCampaign(db: D1Database, tz: string): Promise<LastCampaign | null> {
	const rows = await db
		.prepare(
			`SELECT cp.id, cp.subject, ${SENT_AT} AS sent_at, cp.recipient_count, cp.list_id,
			        l.name AS list_name, l.kind AS list_kind,
			        cp.resent_at, cp.resend_status, cp.resend_subject, cp.resend_at,
			        ${LAST_STATS},
			        (SELECT COUNT(*) FROM events WHERE campaign_id = cp.id AND type = 'unsubscribe') AS unsubs,
			        (SELECT COUNT(*) FROM events WHERE campaign_id = cp.id AND type = 'bounce') AS bounces,
			        (SELECT COUNT(*) FROM events WHERE campaign_id = cp.id AND type = 'spam') AS spam,
			        (SELECT COUNT(*) FROM replies WHERE campaign_id = cp.id) AS replies
			 FROM campaigns cp
			 LEFT JOIN lists l ON l.id = cp.list_id
			 WHERE cp.status = 'sent' AND cp.automation_step_id IS NULL AND ${visibleCampaignSql('cp')}
			 ORDER BY ${SENT_AT} DESC, cp.id DESC
			 LIMIT 2`
		)
		.all<{
			id: number;
			subject: string;
			sent_at: string | null;
			recipient_count: number;
			list_id: number | null;
			list_name: string | null;
			list_kind: string | null;
			resent_at: string | null;
			resend_status: string | null;
			resend_subject: string | null;
			resend_at: string | null;
			sent: number;
			errored: number;
			opens: number;
			clicks: number;
			unsubs: number;
			bounces: number;
			spam: number;
			replies: number;
		}>();
	const [c, p] = rows.results;
	if (!c) return null;

	const [passes, multi] = await Promise.all([
		c.resent_at ? resendPassBreakdown(db, c.id) : Promise.resolve(null),
		c.list_id != null ? multiGroupLabels(db, [{ id: c.id, list_id: c.list_id }]) : Promise.resolve(new Map<number, string>())
	]);

	let resend_scheduled: string | null = null;
	if (c.resend_status === 'pending' && c.resend_at) {
		const at = new Date(`${c.resend_at.replace(' ', 'T')}Z`);
		if (!Number.isNaN(at.getTime())) resend_scheduled = formatLocal(at, tz);
	}

	const open_rate = rate(c.opens, c.sent);
	const click_rate = rate(c.clicks, c.sent);
	const prev = p ? { id: p.id, subject: p.subject, open_rate: rate(p.opens, p.sent), click_rate: rate(p.clicks, p.sent) } : null;

	return {
		id: c.id,
		subject: c.subject,
		sent_at: c.sent_at,
		recipient_count: c.recipient_count,
		audience: c.list_id == null ? 'direct' : (multi.get(c.id) ?? c.list_name ?? 'deleted list'),
		audience_kind: c.list_id == null ? null : c.list_kind,
		resent_at: c.resent_at,
		resend_status: c.resend_status,
		resend_subject: c.resend_subject,
		resend_scheduled,
		sent: c.sent,
		errored: c.errored,
		opens: c.opens,
		clicks: c.clicks,
		unsubs: c.unsubs,
		bounces: c.bounces,
		spam: c.spam,
		replies: c.replies,
		open_rate,
		click_rate,
		unsub_rate: rate(c.unsubs, c.sent),
		passes,
		prev,
		open_delta: delta(open_rate, prev?.open_rate ?? null),
		click_delta: delta(click_rate, prev?.click_rate ?? null)
	};
}

export type UpcomingSend = {
	id: number;
	subject: string;
	kind: 'scheduled' | 'resend';
	at: string; // UTC
	weekday_only: number;
};

/** Next 5 pending sends: scheduled campaigns and pending resends, soonest first. */
export async function upcomingSends(db: D1Database): Promise<UpcomingSend[]> {
	const rows = await db
		.prepare(
			`SELECT * FROM (
			   SELECT id, subject, 'scheduled' AS kind, scheduled_at AS at, weekday_only
			   FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL
			   UNION ALL
			   SELECT id, subject, 'resend' AS kind, resend_at AS at, weekday_only
			   FROM campaigns WHERE resend_status = 'pending' AND resend_at IS NOT NULL
			 ) ORDER BY at ASC, id ASC LIMIT 5`
		)
		.all<UpcomingSend>();
	return rows.results;
}

export type StuckSend = { id: number; subject: string; kind: 'sending' | 'overdue'; at: string | null; accepted: number };

/** Minutes a broadcast may sit in 'sending', and a scheduled one past its time, before it's flagged. */
export const STUCK_SENDING_MINUTES = 30;
export const OVERDUE_SCHEDULED_MINUTES = 10;

/**
 * #536: sends that need a look — a broadcast / direct campaign still `sending` 30 min after it
 * started (the Worker died mid-send; nothing recovers it on its own), and a `scheduled` one 10
 * min past its time that the tick hasn't picked up (heartbeat down). Automation step campaigns
 * stay 'sending' by design and are left out, as are best-time sends still draining their queue
 * and campaigns held by a deliverability alert (#305, they have their own banner). Newest 5
 * of each; `accepted` = recipients already recorded as sent.
 */
export async function stuckSends(db: D1Database): Promise<StuckSend[]> {
	const rows = await db
		.prepare(
			`SELECT * FROM (
			   SELECT c.id, c.subject, 'sending' AS kind, COALESCE(c.sent_at, c.scheduled_at, c.created_at) AS at,
			          (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = c.id AND r.status = 'accepted') AS accepted
			   FROM campaigns c
			   WHERE c.status = 'sending' AND c.automation_id IS NULL AND c.automation_step_id IS NULL AND ${visibleCampaignSql('c')}
			     AND COALESCE(c.sent_at, c.scheduled_at, c.created_at) < datetime('now', ?)
			     AND NOT EXISTS (SELECT 1 FROM recipients q WHERE q.campaign_id = c.id AND q.status IN ('queued', 'sending'))
			   ORDER BY at DESC LIMIT 5
			 )
			 UNION ALL
			 SELECT * FROM (
			   SELECT c.id, c.subject, 'overdue' AS kind, c.scheduled_at AS at, 0 AS accepted
			   FROM campaigns c
			   WHERE c.status = 'scheduled' AND c.held_at IS NULL AND c.scheduled_at IS NOT NULL
			     AND c.scheduled_at < datetime('now', ?)
			   ORDER BY at ASC LIMIT 5
			 )`
		)
		.bind(`-${STUCK_SENDING_MINUTES} minutes`, `-${OVERDUE_SCHEDULED_MINUTES} minutes`)
		.all<StuckSend>();
	return rows.results;
}

export type RecentUnsubscribe = {
	id: number;
	email: string;
	contact_id: number | null;
	reason: string | null;
	campaign_id: number | null;
	subject: string | null;
	created_at: string;
};

export async function recentUnsubscribes(db: D1Database): Promise<RecentUnsubscribe[]> {
	const rows = await db
		.prepare(
			`SELECT u.id, u.email, c.id AS contact_id, u.reason, u.campaign_id, cp.subject, u.created_at
			 FROM unsubscribes u
			 LEFT JOIN contacts c ON c.email = u.email
			 LEFT JOIN campaigns cp ON cp.id = u.campaign_id
			 ORDER BY u.created_at DESC, u.id DESC
			 LIMIT 10`
		)
		.all<RecentUnsubscribe>();
	return rows.results;
}
