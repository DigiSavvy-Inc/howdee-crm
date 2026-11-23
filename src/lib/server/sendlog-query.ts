/**
 * Filtering for the send log (#106) — pagination + a Filters popover on `/campaigns` (moved off `/` in #132).
 * Mirrors `contacts-query.ts`'s shape (parse / where / params / filterParams) but runs
 * over `campaigns` aliased `c` instead of `contacts` bare.
 *
 * Type derivation (compose's send paths, checked in this order):
 *  - `automation` — `c.automation_step_id IS NOT NULL OR c.automation_id IS NOT NULL` (one campaign row per automation
 *    step, created lazily by the drip engine — see `automations.ts`). Deleting the step
 *    nulls `automation_step_id` but keeps `automation_id`, so that send stays an
 *    automation one (#453).
 *  - `direct` — else `c.list_id IS NULL`. The compose `direct` action (1:1 personal send)
 *    inserts `list_id = NULL` and never sets `automation_step_id` — see the comment above
 *    that INSERT in `src/routes/compose/+page.server.ts` ("Logged as a campaign (list_id
 *    NULL) so it shows in the send log + contact history"). An automation-step campaign
 *    ALSO has `list_id IS NULL` (no list target), which is why the automation check runs
 *    first — `automation_step_id` is the more specific, unambiguous signal.
 *  - `campaign` — else (a broadcast to a list/segment/tag; `list_id IS NOT NULL`).
 */

import { visibleCampaignSql } from './system-mail';

export type SendLogType = 'any' | 'campaign' | 'direct' | 'automation' | 'resent';
export type SendLogStatus = 'any' | 'sent' | 'scheduled' | 'sending' | 'failed' | 'draft';

export type SendLogFilter = {
	status: SendLogStatus;
	type: SendLogType;
	q: string;
	from: string; // YYYY-MM-DD (inclusive)
	to: string; // YYYY-MM-DD (inclusive)
};

/** Anything that can hand back a raw string param (URLSearchParams, FormData). */
type Source = { get(key: string): string | File | null };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: SendLogStatus[] = ['any', 'sent', 'scheduled', 'sending', 'failed', 'draft'];
const TYPES: SendLogType[] = ['any', 'campaign', 'direct', 'automation', 'resent'];

function str(src: Source, key: string, max = 120): string {
	const v = src.get(key);
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function isoDate(src: Source, key: string): string {
	const v = str(src, key, 10);
	return ISO_DATE.test(v) ? v : '';
}

export function parseSendLogFilter(src: Source): SendLogFilter {
	const status = str(src, 'status');
	const type = str(src, 'type');
	return {
		status: (STATUSES as string[]).includes(status) ? (status as SendLogStatus) : 'any',
		type: (TYPES as string[]).includes(type) ? (type as SendLogType) : 'any',
		q: str(src, 'q', 100),
		from: isoDate(src, 'from'),
		to: isoDate(src, 'to')
	};
}

/** True when any field narrows the set — drives the Filters-popover dot + heading. */
export function isSendLogFiltered(f: SendLogFilter): boolean {
	return !!(f.status !== 'any' || f.type !== 'any' || f.q || f.from || f.to);
}

/** Serialize back to URL params — for pagination links and form round-trips. Omits defaults. */
export function sendLogFilterParams(f: SendLogFilter): Record<string, string> {
	const p: Record<string, string> = {};
	if (f.status !== 'any') p.status = f.status;
	if (f.type !== 'any') p.type = f.type;
	if (f.q) p.q = f.q;
	if (f.from) p.from = f.from;
	if (f.to) p.to = f.to;
	return p;
}

/** `%term%` with LIKE wildcards in the user's text escaped (paired with ESCAPE '\'). */
function like(term: string): string {
	return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// CASE expression yielding 'automation' | 'direct' | 'campaign' for `SELECT … AS kind`.
// See the module doc comment above for the derivation rule.
export const SENDLOG_TYPE_SQL = `CASE
	WHEN c.automation_step_id IS NOT NULL OR c.automation_id IS NOT NULL THEN 'automation'
	WHEN c.list_id IS NULL THEN 'direct'
	ELSE 'campaign'
END`;

/**
 * SQL fragments over `campaigns c` — `''` when nothing is set, else a full `WHERE ...`
 * clause ready to splice after `FROM campaigns c`.
 */
export function sendLogWhere(f: SendLogFilter): { where: string; params: (string | number)[] } {
	const clauses: string[] = [];
	const params: (string | number)[] = [];

	if (f.status !== 'any') {
		clauses.push('c.status = ?');
		params.push(f.status);
	}
	if (f.type === 'automation') {
		clauses.push('(c.automation_step_id IS NOT NULL OR c.automation_id IS NOT NULL)');
	} else if (f.type === 'direct') {
		clauses.push('c.automation_step_id IS NULL AND c.automation_id IS NULL AND c.list_id IS NULL');
	} else if (f.type === 'campaign') {
		clauses.push('c.automation_step_id IS NULL AND c.automation_id IS NULL AND c.list_id IS NOT NULL');
	} else if (f.type === 'resent') {
		// Independent of kind — a campaign can be both 'campaign' kind and resent.
		clauses.push('c.resend_status = ?');
		params.push('sent');
	}
	if (f.q) {
		clauses.push(`c.subject LIKE ? ESCAPE '\\'`);
		params.push(like(f.q));
	}
	if (f.from) {
		clauses.push('date(COALESCE(c.sent_at, c.scheduled_at, c.created_at)) >= ?');
		params.push(f.from);
	}
	if (f.to) {
		clauses.push('date(COALESCE(c.sent_at, c.scheduled_at, c.created_at)) <= ?');
		params.push(f.to);
	}

	if (clauses.length === 0) return { where: '', params: [] };
	return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

/**
 * `where` (from `sendLogWhere`, may be '') plus the #668 rule: account emails are never in the
 * send log. Kept out of `sendLogWhere` itself so its SQL shape stays the filter's alone.
 */
export function withVisible(where: string): string {
	return where ? `${where} AND ${visibleCampaignSql('c')}` : `WHERE ${visibleCampaignSql('c')}`;
}

/**
 * Sortable Send log columns (#80, #336) — whitelisted map only, never user SQL. Keys match
 * `SENDLOG_COLUMNS` in `$lib/sendlog-columns` (plus `subject`). Each expression is over the
 * columns of `sendLogRows`' inner select (`s.*`), so counts and rates sort by the same
 * numbers the table shows. Rates are NULL when nothing was accepted — sorted last either way.
 */
export const SENDLOG_SORTS: Record<string, string> = {
	subject: 's.subject COLLATE NOCASE',
	status: 's.status',
	sent: 's.recipient_count',
	delivered: 's.accepted',
	open_rate: 'CASE WHEN s.accepted > 0 THEN s.opens * 1.0 / s.accepted END',
	opens: 's.opens',
	click_rate: 'CASE WHEN s.accepted > 0 THEN s.clicks * 1.0 / s.accepted END',
	clicks: 's.clicks',
	ctor: 'CASE WHEN s.opens > 0 THEN s.clicks * 1.0 / s.opens END',
	unsubs: 's.unsubs',
	unsub_rate: 'CASE WHEN s.accepted > 0 THEN s.unsubs * 1.0 / s.accepted END',
	bounces: 's.bounces',
	bounce_rate: 'CASE WHEN s.accepted > 0 THEN s.bounces * 1.0 / s.accepted END',
	replies: 's.replies',
	audience: 'COALESCE(s.list_name, s.automation_name, s.sample_emails) COLLATE NOCASE',
	type: 's.kind',
	date: 's.created_at'
};

/** `ORDER BY` body: NULLs last, then the column, then newest first as the tiebreak. */
export function sendLogOrderBy(sort: string, dir: 'asc' | 'desc'): string {
	const key = SENDLOG_SORTS[sort] ? sort : 'date';
	const expr = SENDLOG_SORTS[key];
	const d = dir === 'asc' ? 'ASC' : 'DESC';
	// date is already the tiebreak column — don't repeat it.
	if (key === 'date') return `s.created_at ${d}, s.id ${d}`;
	return `(${expr}) IS NULL, ${expr} ${d}, s.created_at DESC, s.id DESC`;
}

export type SendLogRow = {
	id: number;
	subject: string;
	status: string;
	recipient_count: number;
	created_at: string;
	sent_at: string | null;
	scheduled_at: string | null;
	list_id: number | null;
	list_name: string | null;
	automation_id: number | null;
	automation_name: string | null;
	resend_status: string | null;
	resent_at: string | null;
	resend_recipients: number | null;
	kind: 'automation' | 'direct' | 'campaign';
	accepted: number;
	opens: number;
	clicks: number;
	unsubs: number;
	bounces: number;
	replies: number;
	sample_emails: string | null;
};

/**
 * One page of the send log. Every count is a correlated subquery per row (indexed on
 * `events(campaign_id, type, recipient_id)`, `recipients(campaign_id)`,
 * `replies(campaign_id)`), computed over every matching row before the page is sliced.
 *
 * Audience hint (#118): list name / automation name, else a cheap sample of
 * `recipients.email` for list-less sends. The derived-table `ORDER BY ... LIMIT` inside
 * GROUP_CONCAT's subquery is valid SQLite/D1.
 */
export async function sendLogRows(
	db: D1Database,
	f: SendLogFilter,
	opts: { sort: string; dir: 'asc' | 'desc'; limit: number; offset: number }
): Promise<SendLogRow[]> {
	const { where, params } = sendLogWhere(f);
	const res = await db
		.prepare(
			`SELECT s.* FROM (
			   SELECT c.id, c.subject, c.status, c.recipient_count, c.created_at, c.sent_at, c.scheduled_at,
			          c.list_id, l.name AS list_name, c.automation_id, a.name AS automation_name,
			          c.resend_status, c.resent_at, c.resend_recipients,
			          ${SENDLOG_TYPE_SQL} AS kind,
			          (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = c.id AND r.status = 'accepted') AS accepted,
			          (SELECT COUNT(DISTINCT recipient_id) FROM events e WHERE e.campaign_id = c.id AND e.type = 'open') AS opens,
			          (SELECT COUNT(DISTINCT recipient_id) FROM events e WHERE e.campaign_id = c.id AND e.type = 'click') AS clicks,
			          (SELECT COUNT(*) FROM events e WHERE e.campaign_id = c.id AND e.type = 'unsubscribe') AS unsubs,
			          (SELECT COUNT(DISTINCT recipient_id) FROM events e WHERE e.campaign_id = c.id AND e.type = 'bounce') AS bounces,
			          (SELECT COUNT(*) FROM replies rp WHERE rp.campaign_id = c.id) AS replies,
			          (SELECT GROUP_CONCAT(email, ', ') FROM (
			             SELECT email FROM recipients WHERE campaign_id = c.id ORDER BY id LIMIT 3
			           )) AS sample_emails
			   FROM campaigns c
			   LEFT JOIN lists l ON l.id = c.list_id
			   LEFT JOIN automations a ON a.id = c.automation_id
			   ${withVisible(where)}
			 ) s
			 ORDER BY ${sendLogOrderBy(opts.sort, opts.dir)}
			 LIMIT ? OFFSET ?`
		)
		.bind(...params, opts.limit, opts.offset)
		.all<SendLogRow>();
	return res.results;
}
