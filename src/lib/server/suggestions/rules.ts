// Suggestions rules (#712): each rule reads the CRM and returns candidates — who to follow up
// with and what to send. Read-only: nothing here writes, sends, schedules, activates or enrolls
// (tests/suggestions-712.test.ts walks the imports). No model call.
//
// Every contact read goes through the active audience rule (#705): unsubscribed and archived
// contacts are never a subject and never evidence, and they don't count toward a group's size.
// Wording is a fixed template with dates ("on Nov 20"), never "3 days ago", so stored text
// doesn't go stale; the AI layer (#713) rewrites it when it is on.

import {
	FORM_LOOKBACK_DAYS,
	HOT_CLICK_WINDOW_DAYS,
	HOT_SCORE_WINDOW_DAYS,
	HOT_VISIT_WINDOW_DAYS,
	RULE_KIND,
	shortDate,
	type EvidenceItem,
	type RuleKey,
	type SubjectType,
	type SuggestionAction,
	type SuggestionKind,
	type SuggestionsConfig
} from '$lib/suggestions';
import { activeContactSql, segmentAudienceSql } from '../active-audience';
import { compileSegment, parseRules } from '../segment-query';
import { listedThreads, matchesFilter, type Conversation } from '../conversations';
import { activeMemberCount } from '../segments';

export type Candidate = {
	rule: RuleKey;
	kind: SuggestionKind;
	subject_type: SubjectType;
	subject_id: number;
	subject_label: string;
	evidence: EvidenceItem[];
	title: string;
	why: string;
	action: SuggestionAction;
	assigned_user_id: number | null;
	/** When the wait began (oldest first within a rule, for the no-AI order). */
	since_at: string | null;
};

export type RuleContext = {
	db: D1Database;
	cfg: SuggestionsConfig;
	now: Date;
	/** Conversations, loaded once per pass and shared by the two conversation rules. */
	threads: () => Promise<Conversation[]>;
};

// ---- helpers ---------------------------------------------------------------------------------

/** UTC 'YYYY-MM-DD HH:MM:SS', `ms` before `now`. */
export function sqlStamp(now: Date, msBefore = 0): string {
	return new Date(now.getTime() - msBefore).toISOString().slice(0, 19).replace('T', ' ');
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

function toMs(at: string | null | undefined): number {
	if (!at) return NaN;
	const s = at.replace(' ', 'T');
	return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

/** SQL label of a contact aliased `a`: first + last name, else name, else the address. */
export function contactLabelSql(a: string): string {
	return `COALESCE(NULLIF(TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, '')), ''), NULLIF(TRIM(${a}.name), ''), ${a}.email)`;
}

/** A 1:1 campaign row on `a`: no list or audience, not an automation step, not system mail (#668). */
const personalCampaignSql = (a: string) =>
	`${a}.list_id IS NULL AND ${a}.automation_id IS NULL AND ${a}.automation_step_id IS NULL AND ${a}.system_kind IS NULL
	 AND NOT EXISTS (SELECT 1 FROM campaign_audiences cay WHERE cay.campaign_id = ${a}.id)`;

/**
 * "Personal email" = a one-to-one email: a 1:1 send or Conversations reply (a direct campaign),
 * or a message the mailbox sent, synced from Gmail. Never a broadcast or an automation email.
 * True when one went to the contact `contactExpr` at or after `afterExpr` (both SQL expressions
 * from this module — never user input).
 */
export function personalEmailSinceSql(contactExpr: string, afterExpr: string): string {
	return `(EXISTS (SELECT 1 FROM recipients pr JOIN campaigns pc ON pc.id = pr.campaign_id
	           WHERE pr.contact_id = ${contactExpr} AND pr.status = 'accepted' AND ${personalCampaignSql('pc')}
	             AND datetime(COALESCE(pc.sent_at, pc.created_at)) >= datetime(${afterExpr}))
	      OR EXISTS (SELECT 1 FROM mail_message_contacts pmc JOIN mail_messages pmm ON pmm.id = pmc.message_id
	           WHERE pmc.contact_id = ${contactExpr} AND pmm.direction = 'out' AND datetime(pmm.sent_at) >= datetime(${afterExpr})))`;
}

type ActiveContact = { id: number; label: string };

/** `ids` narrowed to the active audience, with their labels. */
async function activeContacts(db: D1Database, ids: number[]): Promise<Map<number, ActiveContact>> {
	const out = new Map<number, ActiveContact>();
	const uniq = [...new Set(ids)];
	for (let i = 0; i < uniq.length; i += 500) {
		const rows = await db
			.prepare(
				`SELECT c.id, ${contactLabelSql('c')} AS label FROM contacts c
				 WHERE c.id IN (SELECT value FROM json_each(?)) AND ${activeContactSql('c')}`
			)
			.bind(JSON.stringify(uniq.slice(i, i + 500)))
			.all<ActiveContact>();
		for (const r of rows.results) out.set(r.id, r);
	}
	return out;
}

const contactUrl = (id: number) => `/contacts/${id}`;
const threadUrl = (key: string) => `/conversations/${encodeURIComponent(key)}`;
// #714: Compose in 1:1 mode for this contact (the panel adds `&opening=` when there is a draft line).
const emailThem = (id: number) => ({ type: 'email_them', label: 'Email them', url: `/compose?direct=1&contact=${id}` });
const openContact = (id: number) => ({ type: 'open_contact', label: 'Open contact', url: contactUrl(id) });

function withIds(items: Omit<EvidenceItem, 'id'>[]): EvidenceItem[] {
	return items.map((e, i) => ({ id: `e${i + 1}`, ...e }));
}

function base(rule: RuleKey) {
	return { rule, kind: RULE_KIND[rule] };
}

// ---- conversation rules ------------------------------------------------------------------------

function lastInbound(t: Conversation) {
	for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].dir === 'in') return t.messages[i];
	return null;
}

/** `awaiting_reply`: a conversation whose last message is theirs, waiting longer than N hours. */
export async function awaitingReply(ctx: RuleContext): Promise<Candidate[]> {
	const hours = Number(ctx.cfg.rules.awaiting_reply.hours);
	const cutoff = ctx.now.getTime() - hours * HOUR;
	const byContact = new Map<number, Conversation[]>();
	for (const t of await ctx.threads()) {
		if (t.contact_id == null || !matchesFilter(t, 'awaiting')) continue;
		if (!(toMs(t.last_at) <= cutoff)) continue;
		const list = byContact.get(t.contact_id) ?? [];
		list.push(t);
		byContact.set(t.contact_id, list);
	}
	const active = await activeContacts(ctx.db, [...byContact.keys()]);
	const out: Candidate[] = [];
	for (const [cid, threads] of byContact) {
		const c = active.get(cid);
		if (!c) continue;
		threads.sort((a, b) => toMs(a.last_at) - toMs(b.last_at)); // oldest wait first
		const evidence = withIds(
			threads.map((t) => {
				const m = lastInbound(t);
				return {
					type: 'conversation',
					label: t.subject || '(no subject)',
					url: threadUrl(t.key),
					at: t.last_at,
					ref: `conv:${t.key}:${m?.reply_id ?? m?.mail_message_id ?? t.last_at}`
				};
			})
		);
		const first = threads[0];
		const more = threads.length > 1 ? ` in ${threads.length} conversations` : '';
		out.push({
			...base('awaiting_reply'),
			subject_type: 'contact',
			subject_id: cid,
			subject_label: c.label,
			evidence,
			title: `Reply to ${c.label}`,
			why: `${c.label} wrote on ${shortDate(first.last_at)} and is waiting on us${more}.`,
			action: { type: 'reply', label: 'Reply', url: `${threadUrl(first.key)}?reply=1`, more: [openContact(cid)] },
			assigned_user_id: null,
			since_at: first.last_at
		});
	}
	return out;
}

const isPersonalOut = (m: Conversation['messages'][number]) =>
	m.dir === 'out' && (m.send_kind === 'direct' || m.source === 'gmail');

/** `quiet_after_reply`: has replied to us before; our last personal email is ≥ N days old, unanswered. */
export async function quietAfterReply(ctx: RuleContext): Promise<Candidate[]> {
	const days = Number(ctx.cfg.rules.quiet_after_reply.days);
	const cutoff = ctx.now.getTime() - days * DAY;
	type Agg = { lastIn: string | null; lastOut: string | null; outThread: Conversation | null };
	const byContact = new Map<number, Agg>();
	for (const t of await ctx.threads()) {
		if (t.contact_id == null || t.archived) continue;
		const a = byContact.get(t.contact_id) ?? { lastIn: null, lastOut: null, outThread: null };
		for (const m of t.messages) {
			if (m.dir === 'in' && (!a.lastIn || toMs(m.at) > toMs(a.lastIn))) a.lastIn = m.at;
			if (isPersonalOut(m) && (!a.lastOut || toMs(m.at) > toMs(a.lastOut))) {
				a.lastOut = m.at;
				a.outThread = t;
			}
		}
		byContact.set(t.contact_id, a);
	}
	const hits = [...byContact].filter(
		([, a]) => a.lastIn && a.lastOut && toMs(a.lastOut) > toMs(a.lastIn) && toMs(a.lastOut) <= cutoff
	);
	const active = await activeContacts(ctx.db, hits.map(([id]) => id));
	const out: Candidate[] = [];
	for (const [cid, a] of hits) {
		const c = active.get(cid);
		if (!c || !a.outThread) continue;
		out.push({
			...base('quiet_after_reply'),
			subject_type: 'contact',
			subject_id: cid,
			subject_label: c.label,
			evidence: withIds([
				{
					type: 'conversation',
					label: a.outThread.subject || '(no subject)',
					url: threadUrl(a.outThread.key),
					at: a.lastOut,
					ref: `out:${a.outThread.key}:${a.lastOut}`
				},
				{ type: 'reply', label: 'Their last reply', url: contactUrl(cid), at: a.lastIn, ref: `in:${a.lastIn}` }
			]),
			title: `Check in with ${c.label}`,
			why: `${c.label} has replied to us before but hasn't answered our email from ${shortDate(a.lastOut)}.`,
			action: { ...emailThem(cid), more: [{ type: 'reply', label: 'Open the conversation', url: threadUrl(a.outThread.key) }] },
			assigned_user_id: null,
			since_at: a.lastOut
		});
	}
	return out;
}

// ---- engagement + forms -----------------------------------------------------------------------

async function hotScore(db: D1Database, cfg: SuggestionsConfig): Promise<{ id: number; name: string } | null> {
	const row = cfg.score_id
		? await db.prepare(`SELECT id, name FROM score_defs WHERE id = ? AND status = 'active'`).bind(cfg.score_id).first<{ id: number; name: string }>()
		: await db.prepare(`SELECT id, name FROM score_defs WHERE slug = 'lead-score' AND status = 'active'`).first<{ id: number; name: string }>();
	return row ?? null;
}

/** `hot_engagement`: score up, or campaign clicks, or repeat site visits — and no personal email lately. */
export async function hotEngagement(ctx: RuleContext): Promise<Candidate[]> {
	const r = ctx.cfg.rules.hot_engagement;
	const { db, now } = ctx;
	const score = await hotScore(db, ctx.cfg);
	type Sig = { contact_id: number; n: number; ref: string | number; at: string };
	const [scoreRows, clickRows, visitRows] = await Promise.all([
		score
			? db
					.prepare(
						`SELECT contact_id, SUM(points) AS n, MAX(id) AS ref, MAX(earned_at) AS at FROM score_points
						 WHERE score_id = ? AND datetime(earned_at) >= datetime(?) AND datetime(earned_at) <= datetime(?)
						 GROUP BY contact_id HAVING SUM(points) >= ?`
					)
					.bind(score.id, sqlStamp(now, HOT_SCORE_WINDOW_DAYS * DAY), sqlStamp(now), Number(r.points))
					.all<Sig>()
			: Promise.resolve({ results: [] as Sig[] }),
		db
			.prepare(
				`SELECT contact_id, COUNT(*) AS n, MAX(id) AS ref, MAX(recorded_at) AS at FROM events
				 WHERE type = 'click' AND contact_id IS NOT NULL AND campaign_id IS NOT NULL AND datetime(recorded_at) >= datetime(?)
				 GROUP BY contact_id HAVING COUNT(*) >= ?`
			)
			.bind(sqlStamp(now, HOT_CLICK_WINDOW_DAYS * DAY), Number(r.clicks))
			.all<Sig>(),
		db
			.prepare(
				`SELECT contact_id, COUNT(DISTINCT date(occurred_at)) AS n, MAX(date(occurred_at)) AS ref, MAX(occurred_at) AS at
				 FROM site_events WHERE kind = 'pageview' AND datetime(occurred_at) >= datetime(?)
				 GROUP BY contact_id HAVING COUNT(DISTINCT date(occurred_at)) >= ?`
			)
			.bind(sqlStamp(now, HOT_VISIT_WINDOW_DAYS * DAY), Number(r.visit_days))
			.all<Sig>()
	]);
	const signals = new Map<number, { score?: Sig; clicks?: Sig; visits?: Sig }>();
	const put = (rows: Sig[], k: 'score' | 'clicks' | 'visits') => {
		for (const s of rows) signals.set(s.contact_id, { ...(signals.get(s.contact_id) ?? {}), [k]: s });
	};
	put(scoreRows.results, 'score');
	put(clickRows.results, 'clicks');
	put(visitRows.results, 'visits');
	if (!signals.size) return [];

	// Active, and no personal email in the quiet window.
	const quietSince = sqlStamp(now, Number(r.quiet_days) * DAY);
	const ids = [...signals.keys()];
	const keep = new Map<number, string>();
	for (let i = 0; i < ids.length; i += 500) {
		const rows = await db
			.prepare(
				`SELECT c.id, ${contactLabelSql('c')} AS label FROM contacts c
				 WHERE c.id IN (SELECT value FROM json_each(?)) AND ${activeContactSql('c')}
				   AND NOT ${personalEmailSinceSql('c.id', `'${quietSince}'`)}`
			)
			.bind(JSON.stringify(ids.slice(i, i + 500)))
			.all<{ id: number; label: string }>();
		for (const row of rows.results) keep.set(row.id, row.label);
	}

	const out: Candidate[] = [];
	for (const [cid, s] of signals) {
		const label = keep.get(cid);
		if (!label) continue;
		const items: Omit<EvidenceItem, 'id'>[] = [];
		const parts: string[] = [];
		if (s.score && score) {
			items.push({ type: 'score', label: `${score.name} +${s.score.n} in ${HOT_SCORE_WINDOW_DAYS} days`, url: contactUrl(cid), at: s.score.at, ref: `score:${score.id}:${s.score.ref}` });
			parts.push(`${score.name} up ${s.score.n} points this week`);
		}
		if (s.clicks) {
			items.push({ type: 'clicks', label: `${s.clicks.n} campaign clicks in ${HOT_CLICK_WINDOW_DAYS} days`, url: contactUrl(cid), at: s.clicks.at, ref: `click:${s.clicks.ref}` });
			parts.push(`${s.clicks.n} campaign clicks in ${HOT_CLICK_WINDOW_DAYS} days`);
		}
		if (s.visits) {
			items.push({ type: 'site_visits', label: `Visited the site on ${s.visits.n} days in ${HOT_VISIT_WINDOW_DAYS}`, url: contactUrl(cid), at: s.visits.at, ref: `visit:${s.visits.ref}` });
			parts.push(`site visits on ${s.visits.n} days this week`);
		}
		const latest = items.map((e) => e.at).filter(Boolean).sort((a, b) => toMs(b) - toMs(a))[0] ?? null;
		out.push({
			...base('hot_engagement'),
			subject_type: 'contact',
			subject_id: cid,
			subject_label: label,
			evidence: withIds(items),
			title: `Reach out to ${label}`,
			why: `${label} is warming up (${parts.join(', ')}) and hasn't had a personal email in ${r.quiet_days} days.`,
			action: { ...emailThem(cid), more: [openContact(cid)] },
			assigned_user_id: null,
			since_at: latest
		});
	}
	return out;
}

/** `form_no_followup`: a form submission (last 14 days) with no personal email since, after N days. */
export async function formNoFollowup(ctx: RuleContext): Promise<Candidate[]> {
	const days = Number(ctx.cfg.rules.form_no_followup.days);
	const from = sqlStamp(ctx.now, FORM_LOOKBACK_DAYS * DAY);
	const to = sqlStamp(ctx.now, days * DAY);
	type Row = { sid: number; src: 'fs' | 'we'; contact_id: number; label: string; at: string; form_id: number | null; form_name: string };
	const rows = await ctx.db
		.prepare(
			`SELECT fs.id AS sid, 'fs' AS src, c.id AS contact_id, ${contactLabelSql('c')} AS label, fs.created_at AS at,
			        f.id AS form_id, f.name AS form_name
			   FROM form_submissions fs JOIN forms f ON f.id = fs.form_id JOIN contacts c ON c.id = fs.contact_id
			  WHERE fs.status IN ('added', 'updated') AND ${activeContactSql('c')}
			    AND datetime(fs.created_at) >= datetime(?) AND datetime(fs.created_at) <= datetime(?)
			    AND NOT ${personalEmailSinceSql('c.id', 'fs.created_at')}
			 UNION ALL
			 SELECT we.id, 'we', c.id, ${contactLabelSql('c')}, we.created_at, NULL, COALESCE(k.label, 'Website form')
			   FROM webhook_events we JOIN contacts c ON c.email = lower(trim(we.email))
			   LEFT JOIN webhook_keys k ON k.id = we.key_id
			  WHERE we.status IN ('added', 'updated') AND we.email IS NOT NULL AND ${activeContactSql('c')}
			    AND datetime(we.created_at) >= datetime(?) AND datetime(we.created_at) <= datetime(?)
			    AND NOT ${personalEmailSinceSql('c.id', 'we.created_at')}
			 ORDER BY at`
		)
		.bind(from, to, from, to)
		.all<Row>();
	const byContact = new Map<number, Row[]>();
	for (const r of rows.results) byContact.set(r.contact_id, [...(byContact.get(r.contact_id) ?? []), r]);
	const out: Candidate[] = [];
	for (const [cid, subs] of byContact) {
		const first = subs[0];
		out.push({
			...base('form_no_followup'),
			subject_type: 'contact',
			subject_id: cid,
			subject_label: first.label,
			evidence: withIds(
				subs.map((s) => ({
					type: 'form_submission',
					label: s.form_name,
					url: s.form_id ? `/forms/${s.form_id}?tab=submissions` : contactUrl(cid),
					at: s.at,
					ref: `${s.src}:${s.sid}`
				}))
			),
			title: `Follow up with ${first.label}`,
			why: `${first.label} filled in “${first.form_name}” on ${shortDate(first.at)} and hasn't had a personal email since.`,
			action: { ...emailThem(cid), more: [openContact(cid)] },
			assigned_user_id: null,
			since_at: first.at
		});
	}
	return out;
}

// ---- deals ------------------------------------------------------------------------------------

/** `stalled_deal`: an open deal in the same stage longer than N days — assigned to its owner. */
export async function stalledDeal(ctx: RuleContext): Promise<Candidate[]> {
	const days = Number(ctx.cfg.rules.stalled_deal.days);
	const rows = await ctx.db
		.prepare(
			`SELECT pc.id, pc.contact_id, pc.entered_stage_at AS at, ps.id AS stage_id, ps.name AS stage,
			        u.id AS owner, ${contactLabelSql('c')} AS label
			   FROM pipeline_cards pc
			   JOIN pipeline_stages ps ON ps.id = pc.stage_id AND ps.kind = 'open'
			   JOIN contacts c ON c.id = pc.contact_id
			   LEFT JOIN users u ON u.id = pc.owner_user_id AND u.disabled_at IS NULL
			  WHERE ${activeContactSql('c')} AND datetime(pc.entered_stage_at) <= datetime(?)
			  ORDER BY datetime(pc.entered_stage_at)`
		)
		.bind(sqlStamp(ctx.now, days * DAY))
		.all<{ id: number; contact_id: number; at: string; stage_id: number; stage: string; owner: number | null; label: string }>();
	return rows.results.map((d) => ({
		...base('stalled_deal'),
		subject_type: 'deal' as const,
		subject_id: d.id,
		subject_label: d.label,
		evidence: withIds([
			{ type: 'deal', label: `${d.stage} since ${shortDate(d.at)}`, url: `${contactUrl(d.contact_id)}#pipeline`, at: d.at, ref: `deal:${d.stage_id}:${d.at}` }
		]),
		title: `Move the deal with ${d.label} along`,
		why: `The deal with ${d.label} has been in ${d.stage} since ${shortDate(d.at)}.`,
		action: { type: 'open_deal', label: 'Open deal', url: `${contactUrl(d.contact_id)}#pipeline`, more: [emailThem(d.contact_id)] },
		assigned_user_id: d.owner ?? null,
		since_at: d.at
	}));
}

// ---- groups -----------------------------------------------------------------------------------

type GroupRow = { id: number; name: string; kind: string; rules: string | null };
type SentCampaign = { group_id: number; id: number; subject: string | null; at: string };

/** Tags the app writes itself (hygiene, exclusions, snapshot, …) and "zz-" / "archived" names
 *  are bookkeeping, not audiences — never suggested. */
export function isInternalGroupName(name: string): boolean {
	const n = name.trim();
	return (
		/^(hygiene|snapshot|source|role|platform|situation|icp):/i.test(n) ||
		/^excluded:/i.test(n) ||
		/^unverified-domain$/i.test(n) ||
		/^zz[\s\-_·.:]/i.test(n) ||
		/\barchived\b/i.test(n)
	);
}

const SENT_BROADCAST = `c.status = 'sent' AND c.automation_id IS NULL AND c.automation_step_id IS NULL AND c.system_kind IS NULL`;

/** Lists, tags and segments that may be suggested, with their sent broadcasts (newest first). */
async function groupData(db: D1Database): Promise<{ groups: GroupRow[]; sent: Map<number, SentCampaign[]>; scheduled: Set<number> }> {
	const [groups, sent, scheduled] = await Promise.all([
		db
			.prepare(`SELECT id, name, kind, rules FROM lists WHERE kind IN ('list', 'tag', 'segment') AND archived_at IS NULL ORDER BY id`)
			.all<GroupRow>(),
		db
			.prepare(
				`SELECT ca.list_id AS group_id, c.id, c.subject, COALESCE(c.sent_at, c.created_at) AS at
				   FROM campaigns c JOIN campaign_audiences ca ON ca.campaign_id = c.id AND ca.mode = 'include'
				  WHERE ${SENT_BROADCAST}
				 UNION
				 SELECT c.list_id, c.id, c.subject, COALESCE(c.sent_at, c.created_at)
				   FROM campaigns c
				  WHERE ${SENT_BROADCAST} AND c.list_id IS NOT NULL
				    AND NOT EXISTS (SELECT 1 FROM campaign_audiences ca WHERE ca.campaign_id = c.id)`
			)
			.all<SentCampaign>(),
		db
			.prepare(
				`SELECT ca.list_id AS group_id FROM campaigns c JOIN campaign_audiences ca ON ca.campaign_id = c.id AND ca.mode = 'include'
				  WHERE c.status IN ('scheduled', 'sending') AND c.automation_id IS NULL AND c.automation_step_id IS NULL
				 UNION
				 SELECT c.list_id FROM campaigns c
				  WHERE c.status IN ('scheduled', 'sending') AND c.list_id IS NOT NULL AND c.automation_id IS NULL AND c.automation_step_id IS NULL`
			)
			.all<{ group_id: number }>()
	]);
	const byGroup = new Map<number, SentCampaign[]>();
	for (const s of sent.results) byGroup.set(s.group_id, [...(byGroup.get(s.group_id) ?? []), s]);
	for (const list of byGroup.values()) list.sort((a, b) => toMs(b.at) - toMs(a.at) || b.id - a.id);
	return {
		groups: groups.results.filter((g) => !isInternalGroupName(g.name)),
		sent: byGroup,
		scheduled: new Set(scheduled.results.map((r) => r.group_id))
	};
}

/** SQL selecting the active members' ids of a group, with its binds. */
function activeMembersSql(g: GroupRow): { sql: string; binds: unknown[] } {
	const rules = g.kind === 'segment' ? parseRules(g.rules) : null;
	if (rules) {
		const c = compileSegment(rules);
		return { sql: `SELECT c.id FROM contacts c WHERE c.id IN (${c.sql}) AND ${segmentAudienceSql(rules, 'c')}`, binds: c.binds };
	}
	return {
		sql: `SELECT c.id FROM list_members lm JOIN contacts c ON c.id = lm.contact_id WHERE lm.list_id = ? AND ${activeContactSql('c')}`,
		binds: [g.id]
	};
}

const groupUrl = (id: number) => `/lists/${id}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** `group_unmailed`: ≥ N active members and no broadcast in N days (none scheduled either). */
export async function groupUnmailed(ctx: RuleContext, data?: Awaited<ReturnType<typeof groupData>>): Promise<Candidate[]> {
	const r = ctx.cfg.rules.group_unmailed;
	const d = data ?? (await groupData(ctx.db));
	const cutoff = ctx.now.getTime() - Number(r.days) * DAY;
	const out: Candidate[] = [];
	for (const g of d.groups) {
		if (d.scheduled.has(g.id)) continue;
		const last = d.sent.get(g.id)?.[0] ?? null;
		if (last && toMs(last.at) > cutoff) continue;
		const n = await activeMemberCount(ctx.db, g);
		if (n < Number(r.min_members)) continue;
		out.push({
			...base('group_unmailed'),
			subject_type: 'group',
			subject_id: g.id,
			subject_label: g.name,
			evidence: withIds([
				{ type: 'group', label: `${g.name} · ${plural(n, 'active member')}`, url: groupUrl(g.id), at: null, ref: `group:${g.id}` },
				last
					? { type: 'campaign', label: last.subject || '(no subject)', url: `/campaign/${last.id}`, at: last.at, ref: `campaign:${last.id}` }
					: { type: 'campaign', label: 'No campaign sent to it yet', url: null, at: null, ref: 'campaign:none' }
			]),
			title: `Send a campaign to ${g.name}`,
			why: last
				? `${g.name} has ${plural(n, 'active member')} and hasn't had a campaign since ${shortDate(last.at)}.`
				: `${g.name} has ${plural(n, 'active member')} and hasn't had a campaign yet.`,
			action: {
				type: 'send_campaign',
				label: 'Send a campaign',
				url: `/compose?include_id=${g.id}`,
				more: [{ type: 'open_group', label: 'Open group', url: groupUrl(g.id) }]
			},
			assigned_user_id: null,
			since_at: last?.at ?? null
		});
	}
	return out;
}

/** `cold_members`: more than half of the active members reached by the last N campaigns opened none. */
export async function coldMembers(ctx: RuleContext, data?: Awaited<ReturnType<typeof groupData>>): Promise<Candidate[]> {
	const n = Number(ctx.cfg.rules.cold_members.campaigns);
	const minMembers = Number(ctx.cfg.rules.group_unmailed.min_members);
	const d = data ?? (await groupData(ctx.db));
	const out: Candidate[] = [];
	for (const g of d.groups) {
		const sent = d.sent.get(g.id) ?? [];
		if (sent.length < n) continue;
		const lastN = sent.slice(0, n);
		const campaignIds = JSON.stringify(lastN.map((s) => s.id));
		const m = activeMembersSql(g);
		const row = await ctx.db
			.prepare(
				`WITH m AS (${m.sql}),
				      reached AS (SELECT DISTINCT r.contact_id AS id FROM recipients r
				                   WHERE r.status = 'accepted' AND r.campaign_id IN (SELECT value FROM json_each(?))
				                     AND r.contact_id IN (SELECT id FROM m))
				 SELECT (SELECT COUNT(*) FROM m) AS members,
				        (SELECT COUNT(*) FROM reached) AS reached,
				        (SELECT COUNT(*) FROM reached x WHERE NOT EXISTS (
				            SELECT 1 FROM events e WHERE e.contact_id = x.id AND e.type IN ('open', 'click')
				               AND e.campaign_id IN (SELECT value FROM json_each(?)))) AS cold`
			)
			.bind(...m.binds, campaignIds, campaignIds)
			.first<{ members: number; reached: number; cold: number }>();
		if (!row || row.members < minMembers || row.reached === 0 || row.cold * 2 <= row.reached) continue;
		const latest = lastN[0];
		out.push({
			...base('cold_members'),
			subject_type: 'group',
			subject_id: g.id,
			subject_label: g.name,
			evidence: withIds([
				{
					type: 'group',
					label: `${row.cold.toLocaleString('en-US')} of ${plural(row.reached, 'active member')} opened none of the last ${n} campaigns`,
					url: groupUrl(g.id),
					at: null,
					ref: `group:${g.id}`
				},
				{ type: 'campaign', label: latest.subject || '(no subject)', url: `/campaign/${latest.id}`, at: latest.at, ref: `campaign:${latest.id}` }
			]),
			title: `Try something new with ${g.name}`,
			why: `${row.cold.toLocaleString('en-US')} of ${plural(row.reached, 'active member')} in ${g.name} opened none of the last ${n} campaigns. Re-engage them, move them to an automation, or try a personal touch.`,
			action: {
				type: 're_engage',
				label: 'Re-engage',
				url: `/compose?include_id=${g.id}&reengage=1`,
				more: [
					{ type: 'move_to_automation', label: 'Move to an automation', url: `/automations?enroll_list=${g.id}` },
					{ type: 'see_cold', label: "See who's cold", url: groupUrl(g.id) }
				]
			},
			assigned_user_id: null,
			since_at: latest.at
		});
	}
	return out;
}

/** Run one rule. The two group rules share one read of groups + campaigns per call. */
export async function runRule(rule: RuleKey, ctx: RuleContext): Promise<Candidate[]> {
	switch (rule) {
		case 'awaiting_reply':
			return awaitingReply(ctx);
		case 'quiet_after_reply':
			return quietAfterReply(ctx);
		case 'hot_engagement':
			return hotEngagement(ctx);
		case 'form_no_followup':
			return formNoFollowup(ctx);
		case 'stalled_deal':
			return stalledDeal(ctx);
		case 'group_unmailed':
			return groupUnmailed(ctx);
		case 'cold_members':
			return coldMembers(ctx);
	}
}

/** SHA-256 hex over the evidence identities (type + ref), never labels, counts or elapsed time. */
export async function evidenceHash(evidence: EvidenceItem[]): Promise<string> {
	const data = new TextEncoder().encode(JSON.stringify(evidence.map((e) => [e.type, e.ref ?? e.id])));
	const buf = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
