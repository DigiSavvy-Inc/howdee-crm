// Conversations (#157) — threads the app's own sends and the replies captured via Postmark
// Inbound into per-contact conversations. No tables of its own: everything is derived
// from `recipients` + `campaigns` (our sends) and `replies` (theirs) at read time.
//
// Threading rules (one "party" = a contact, or a bare email for unmatched senders):
//   - A broadcast / automation-step send is its own thread root, keyed by campaign.
//   - A reply joins, in order of preference:
//       1. the thread holding the send whose Postmark MessageID its In-Reply-To names (exact);
//       2. the thread rooted at its `campaign_id` (from the MailboxHash Reply-To tag);
//       3. the most recent thread with the same normalised subject (Re:/Fwd: stripped)
//          whose last message is within 30 days;
//     otherwise it starts a thread of its own.
//   - A direct 1:1 send (no list, no automation step) joins a thread by rule 3 too —
//     that's how a follow-up "Re: …" you send threads under their reply — else it's a root.
//     A send from a conversation's Reply box (#159) records the Message-ID it answers
//     (`campaigns.in_reply_to_message_id`) and joins that message's thread exactly first.
//   - A synced Gmail message (#158, `mail_messages`) joins, first rule that matches (#585):
//       1. the thread already holding its Gmail threadId;
//       2. the thread whose message its In-Reply-To names;
//       3. the thread whose message any id in its References names, newest id first;
//       4. the thread of a captured reply whose forward to our inbox (#381,
//          `replies.forward_message_id`) its In-Reply-To or References names — that's how an
//          answer written in Gmail to "<Contact> via <app>" finds the conversation;
//       5. outbound only: a "Re:" subject whose normalised subject equals a thread's subject,
//          whose last message is within 30 days (rule 3 above, the one direct sends use);
//     otherwise it opens a `gmail` thread of its own. A Gmail copy of a message the app already
//     has (same Message-ID — e.g. a BCC of a Reply-box send) is dropped, and its Gmail threadId
//     is registered on the app message's thread so the rest of that Gmail conversation follows.
//
// Archive / delete (#379, conversation-state.ts): state is keyed by the thread `key`
// (`<party>-<root>`, root = the thread's first message). New messages never change it — they
// join the thread or open a new one; it only changes when an older message appears later or
// the root is deleted, and then the state stops applying (the thread shows again). Sends
// from a deleted thread are hidden here, never deleted: Postmark sends by
// `conversation_hidden_sends`, Gmail messages the mailbox sent by `conversation_hidden_gmail`.
//
// Gmail-only threads in the Conversations tab are opt-in (#443, Settings → Mail,
// `mail_in_conversations`). #585: whatever that switch says, `listedThreads` (the tab, its
// counts, the dashboard "awaiting" tile, the contacts `awaiting` filter) loads the Gmail mail of
// contacts with an app thread, so an answer sent from Gmail clears "awaiting" there exactly as
// on the thread page; off, threads made only of Gmail mail are left out. The contact page
// (`conversationsFor`) always loads all Gmail.

import { messageIdKey, parseReferences } from '$lib/message-id';
import { gmailInConversations } from './mail-sync';
import { cleanMessageText, decodeEntities, displayText, looksLikeHtml } from '$lib/email-text';
import { visibleCampaignSql } from './system-mail';
export { messageIdKey };

export const THREAD_WINDOW_DAYS = 30;
const WINDOW_MS = THREAD_WINDOW_DAYS * 86_400_000;
const SQL_ID_CHUNK = 90; // stay under D1's ~100-bound-variable-per-query cap

export type SendKind = 'campaign' | 'automation' | 'direct';

export type SendSignals = {
	opens: number;
	clicks: number;
	first_open: string | null;
	first_click: string | null;
	bounced: number;
	spam: number;
	unsubscribed: number;
};

export type ConvMessage = {
	dir: 'out' | 'in';
	at: string; // UTC 'YYYY-MM-DD HH:MM:SS'
	subject: string | null;
	campaign_id: number | null;
	// Postmark MessageID of our send, or the inbound email's own Message-ID header (#159).
	message_id: string | null;
	// Outbound (our send) only:
	recipient_id: number | null;
	send_kind: SendKind | null;
	status: string | null;
	error: string | null;
	signals: SendSignals | null;
	// Inbound (their reply) only:
	reply_id: number | null;
	text: string | null; // display text (#380: HTML converted, helpdesk markers dropped)
	has_original?: boolean; // #380: an HTML original exists → "View original"
	// Inbound: its In-Reply-To header. Outbound: the Message-ID a Reply-box send answers (#159).
	in_reply_to: string | null;
	campaign_subject: string | null; // subject of the campaign a reply is linked to
	// Synced Gmail message (#158) only — absent on app sends/replies:
	source?: 'gmail';
	mail_message_id?: number;
	gmail_thread_id?: string;
	from?: string | null; // sender display name, else address
	snippet?: string | null;
	references?: string[]; // #585: References header ids, oldest first
	teammate?: string | null; // #585: outbound only — the CRM user who sent it (name, else login)
	// Captured reply (#585) only: Postmark MessageID of its forward to our inbox (#381).
	forward_id?: string | null;
};

export type Conversation = {
	key: string;
	contact_id: number | null;
	email: string;
	name: string | null;
	subject: string;
	root_campaign_id: number | null;
	root_kind: SendKind | 'reply' | 'gmail';
	gmail_thread_id: string | null; // first Gmail thread in this conversation (Open in Gmail)
	messages: ConvMessage[]; // oldest first
	count: number;
	sent: number;
	replies: number;
	last_at: string;
	last_dir: 'out' | 'in';
	awaiting: boolean; // last message is inbound → waiting on us
	archived?: boolean; // #379 — set by the Conversations tab's loader only
	preview?: string | null; // #585: the latest message's text (a Gmail one's snippet), else null
};

export type ConvFilter = 'all' | 'awaiting' | 'replied' | 'sent' | 'gmail' | 'archived';
export const CONV_FILTERS: ConvFilter[] = ['all', 'awaiting', 'replied', 'sent', 'gmail', 'archived'];

export function parseConvFilter(v: string | null): ConvFilter {
	return CONV_FILTERS.includes(v as ConvFilter) ? (v as ConvFilter) : 'all';
}

/** Strip any run of leading Re:/Fwd:/Fw: prefixes (incl. "RE[2]:"), keeping the rest as-is. */
export function stripReplyPrefixes(subject: string | null | undefined): string {
	return String(subject ?? '')
		.replace(/^\s*(?:(?:re|fwd?)\s*(?:\[\d+\])?\s*:\s*)+/i, '')
		.trim();
}

/** Subject key for threading: prefixes stripped, case- and whitespace-insensitive. */
export function normalizeSubject(subject: string | null | undefined): string {
	return stripReplyPrefixes(subject).replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The first message id in an inbound payload's In-Reply-To header, angle brackets
 * stripped. `headers` is Postmark's `Headers` array of `{ Name, Value }`.
 */
export function inReplyToFromHeaders(headers: unknown): string | null {
	return messageIdFromHeaders(headers, 'in-reply-to');
}

/** The first message id in the named header (e.g. `message-id`), angle brackets stripped. */
export function messageIdFromHeaders(headers: unknown, header: string): string | null {
	if (!Array.isArray(headers)) return null;
	for (const h of headers) {
		if (!h || typeof h !== 'object') continue;
		const name = String((h as { Name?: unknown }).Name ?? '').trim().toLowerCase();
		if (name !== header) continue;
		const value = String((h as { Value?: unknown }).Value ?? '').trim();
		const m = value.match(/<([^<>\s]+)>/);
		const id = (m ? m[1] : value.split(/\s+/)[0] ?? '').trim();
		return id ? id.slice(0, 500) : null;
	}
	return null;
}

/** #585: the subject starts with a reply prefix ("Re:", "RE[2]:"). */
export function hasReplyPrefix(subject: string | null | undefined): boolean {
	return /^\s*re\s*(?:\[\d+\])?\s*:/i.test(String(subject ?? ''));
}

const PREVIEW_MAX = 200;

function ms(at: string): number {
	return Date.parse(at.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z'));
}

/**
 * Group ONE party's messages into threads (see the rules at the top of this file).
 * Pure — the unit the tests drive. Returns threads newest-activity first.
 */
export function threadMessages(
	messages: ConvMessage[],
	party: { contact_id: number | null; email: string; name: string | null }
): Conversation[] {
	// Oldest first; on a tie our send comes before their reply.
	const sorted = [...messages].sort((a, b) =>
		a.at === b.at ? (a.dir === b.dir ? 0 : a.dir === 'out' ? -1 : 1) : a.at < b.at ? -1 : 1
	);

	const threads: Conversation[] = [];
	const byCampaign = new Map<number, Conversation>();
	const byMessageId = new Map<string, Conversation>();
	const byGmailThread = new Map<string, Conversation>();
	// #585: Postmark MessageID of a captured reply's forward → that reply's thread.
	const byForward = new Map<string, Conversation>();
	// #585: Message-ID of a dropped Gmail duplicate whose app message isn't placed yet → its
	// Gmail threadId, registered on the app message's thread once that is placed.
	const pendingDup = new Map<string, string>();
	const partyKey = party.contact_id != null ? `c${party.contact_id}` : `e${party.email}`;
	// Message-IDs the app itself holds: a Gmail copy of one of these is a duplicate.
	const appIds = new Set(
		sorted.filter((m) => m.source !== 'gmail' && m.message_id).map((m) => messageIdKey(m.message_id))
	);

	function bySubject(m: ConvMessage): Conversation | null {
		const norm = normalizeSubject(m.subject);
		if (!norm) return null;
		const t = ms(m.at);
		let best: Conversation | null = null;
		for (const th of threads) {
			if (normalizeSubject(th.subject) !== norm) continue;
			if (t - ms(th.last_at) > WINDOW_MS) continue;
			if (!best || th.last_at >= best.last_at) best = th;
		}
		return best;
	}

	function open(root: string, m: ConvMessage, subject: string, kind: Conversation['root_kind']): Conversation {
		const th: Conversation = {
			key: `${partyKey}-${root}`,
			contact_id: party.contact_id,
			email: party.email,
			name: party.name,
			subject: stripReplyPrefixes(subject) || '(no subject)',
			root_campaign_id: m.campaign_id,
			root_kind: kind,
			gmail_thread_id: null,
			messages: [],
			count: 0,
			sent: 0,
			replies: 0,
			last_at: m.at,
			last_dir: m.dir,
			awaiting: false
		};
		threads.push(th);
		if (m.campaign_id != null) byCampaign.set(m.campaign_id, th);
		return th;
	}

	/** A placed app message: the Gmail copy of it dropped earlier (#585) now follows its thread. */
	function claimPendingDup(th: Conversation, messageId: string | null) {
		if (!messageId) return;
		const k = messageIdKey(messageId);
		const gt = pendingDup.get(k);
		if (gt == null) return;
		pendingDup.delete(k);
		if (!byGmailThread.has(gt)) byGmailThread.set(gt, th);
		th.gmail_thread_id ??= gt;
	}

	for (const m of sorted) {
		let th: Conversation | null = null;
		if (m.source === 'gmail') {
			const gt = m.gmail_thread_id ?? '';
			if (m.message_id && appIds.has(messageIdKey(m.message_id))) {
				// #585: a copy of a message the app holds — dropped, but the rest of its Gmail
				// conversation follows the app message's thread.
				const host = byMessageId.get(messageIdKey(m.message_id));
				if (host) {
					if (gt && !byGmailThread.has(gt)) byGmailThread.set(gt, host);
					if (gt) host.gmail_thread_id ??= gt;
				} else if (gt) pendingDup.set(messageIdKey(m.message_id), gt);
				continue;
			}
			// What this message answers: In-Reply-To, then References newest first (#585).
			const refs = [...(m.references ?? [])].reverse();
			const answers = [...(m.in_reply_to ? [m.in_reply_to] : []), ...refs];
			th = byGmailThread.get(gt) ?? null;
			if (!th && m.in_reply_to) th = byMessageId.get(messageIdKey(m.in_reply_to)) ?? null;
			for (const id of refs) {
				if (th) break;
				th = byMessageId.get(messageIdKey(id)) ?? null;
			}
			for (const id of answers) {
				if (th) break;
				th = byForward.get(messageIdKey(id)) ?? null;
			}
			if (!th && m.dir === 'out' && hasReplyPrefix(m.subject)) th = bySubject(m);
			if (!th) th = open(`g${gt}`, m, m.subject ?? '', 'gmail');
			th.gmail_thread_id ??= gt;
			byGmailThread.set(gt, th);
			if (m.message_id) byMessageId.set(messageIdKey(m.message_id), th);
		} else if (m.dir === 'out') {
			if (m.campaign_id != null) th = byCampaign.get(m.campaign_id) ?? null;
			if (!th && m.in_reply_to) th = byMessageId.get(messageIdKey(m.in_reply_to)) ?? null;
			if (!th && m.send_kind === 'direct') th = bySubject(m);
			if (!th) th = open(`c${m.campaign_id}`, m, m.subject ?? '', m.send_kind ?? 'campaign');
			else if (m.campaign_id != null && !byCampaign.has(m.campaign_id)) byCampaign.set(m.campaign_id, th);
			if (m.message_id) byMessageId.set(messageIdKey(m.message_id), th);
			claimPendingDup(th, m.message_id);
		} else {
			if (m.in_reply_to) th = byMessageId.get(messageIdKey(m.in_reply_to)) ?? null;
			if (!th && m.campaign_id != null) {
				th = byCampaign.get(m.campaign_id) ?? null;
				if (!th) th = open(`c${m.campaign_id}`, m, m.campaign_subject ?? m.subject ?? '', 'campaign');
			}
			if (!th) th = bySubject(m);
			if (!th) th = open(`r${m.reply_id}`, m, m.subject ?? '', 'reply');
			if (m.message_id) byMessageId.set(messageIdKey(m.message_id), th);
			if (m.forward_id) byForward.set(messageIdKey(m.forward_id), th);
			claimPendingDup(th, m.message_id);
		}
		th.messages.push(m);
		th.count += 1;
		if (m.dir === 'out') th.sent += 1;
		else th.replies += 1;
		th.last_at = m.at;
		th.last_dir = m.dir;
		th.awaiting = m.dir === 'in';
		const pv = (m.source === 'gmail' ? m.snippet : m.text)?.replace(/\s+/g, ' ').trim();
		th.preview = pv ? pv.slice(0, PREVIEW_MAX) : null;
	}

	return threads.sort((a, b) => (a.last_at === b.last_at ? 0 : a.last_at < b.last_at ? 1 : -1));
}

// ── Loading ───────────────────────────────────────────────────────────────────────────

const CONTACT_NAME_SQL = `COALESCE(
	NULLIF(ct.name, ''),
	NULLIF(TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')), '')
)`;

// Same send-kind derivation as the send log (SENDLOG_TYPE_SQL): automation first, since an
// automation-step campaign also has list_id NULL.
const OUT_SQL = `SELECT r.id AS recipient_id, r.contact_id, LOWER(COALESCE(ct.email, r.email)) AS email,
	       r.message_id, r.status, r.error,
	       c.id AS campaign_id, c.subject, COALESCE(c.sent_at, c.created_at) AS at,
	       c.in_reply_to_message_id AS in_reply_to,
	       CASE WHEN c.automation_step_id IS NOT NULL THEN 'automation'
	            WHEN c.list_id IS NULL THEN 'direct' ELSE 'campaign' END AS send_kind,
	       ${CONTACT_NAME_SQL} AS name
	FROM recipients r
	JOIN campaigns c ON c.id = r.campaign_id
	  AND ${visibleCampaignSql('c')} -- #668: account emails (invite / reset / verify) are not conversations
	  AND COALESCE(r.status, '') NOT IN ('queued', 'sending') -- #115: best-time rows not sent yet
	  AND r.id NOT IN (SELECT recipient_id FROM conversation_hidden_sends) -- #379: deleted threads
	LEFT JOIN contacts ct ON ct.id = r.contact_id`;

const IN_SQL = `SELECT rp.id AS reply_id, rp.contact_id, LOWER(COALESCE(ct.email, rp.from_email)) AS email,
	       rp.subject, rp.text, rp.received_at AS at, rp.campaign_id,
	       camp.subject AS campaign_subject, rp.in_reply_to_message_id AS in_reply_to,
	       rp.message_id_header AS message_id, (rp.html_body IS NOT NULL) AS has_html,
	       rp.forward_message_id AS forward_id,
	       ${CONTACT_NAME_SQL} AS name
	FROM replies rp
	LEFT JOIN campaigns camp ON camp.id = rp.campaign_id
	LEFT JOIN contacts ct ON ct.id = rp.contact_id`;

// Synced Gmail messages (#158): one row per (message, linked contact). #585: `teammate` = the
// CRM user who sent an outbound one — by From address, else the mailbox's owner (send-as alias).
const TEAMMATE_SQL = `CASE WHEN mm.direction = 'out' THEN COALESCE(
	       (SELECT COALESCE(NULLIF(u.name, ''), u.github_login) FROM users u
	        WHERE u.email IS NOT NULL AND LOWER(u.email) = LOWER(mm.from_email) LIMIT 1),
	       (SELECT COALESCE(NULLIF(u.name, ''), u.github_login) FROM mail_accounts ma JOIN users u ON u.id = ma.user_id
	        WHERE ma.id = mm.account_id)) END`;
const GMAIL_SQL = `SELECT mm.id AS mail_message_id, mmc.contact_id, LOWER(ct.email) AS email,
	       mm.gmail_thread_id, mm.message_id_header AS message_id, mm.in_reply_to, mm.subject,
	       mm.snippet, mm.sent_at AS at, mm.direction, COALESCE(mm.from_name, mm.from_email) AS sender,
	       mm.references_header, ${TEAMMATE_SQL} AS teammate,
	       ${CONTACT_NAME_SQL} AS name
	FROM mail_message_contacts mmc
	JOIN mail_messages mm ON mm.id = mmc.message_id
	  AND NOT EXISTS (SELECT 1 FROM conversation_hidden_gmail hg -- #379: our sends from deleted threads
	    WHERE hg.gmail_id = mm.gmail_id
	      AND hg.mailbox = (SELECT LOWER(ma.email) FROM mail_accounts ma WHERE ma.id = mm.account_id))
	JOIN contacts ct ON ct.id = mmc.contact_id`;

type GmailRow = {
	mail_message_id: number;
	contact_id: number;
	email: string;
	gmail_thread_id: string;
	message_id: string | null;
	in_reply_to: string | null;
	subject: string | null;
	snippet: string | null;
	at: string;
	direction: 'in' | 'out';
	sender: string | null;
	references_header: string | null;
	teammate: string | null;
	name: string | null;
};

type OutRow = {
	recipient_id: number;
	contact_id: number | null;
	email: string;
	message_id: string | null;
	status: string | null;
	error: string | null;
	campaign_id: number;
	subject: string;
	at: string;
	in_reply_to: string | null;
	send_kind: SendKind;
	name: string | null;
};

type InRow = {
	reply_id: number;
	contact_id: number | null;
	email: string;
	subject: string | null;
	text: string | null;
	at: string;
	campaign_id: number | null;
	campaign_subject: string | null;
	in_reply_to: string | null;
	message_id: string | null;
	has_html: number;
	forward_id: string | null;
	name: string | null;
};

function outMessage(r: OutRow): ConvMessage {
	return {
		dir: 'out',
		at: r.at,
		subject: r.subject,
		campaign_id: r.campaign_id,
		recipient_id: r.recipient_id,
		message_id: r.message_id,
		send_kind: r.send_kind,
		status: r.status,
		error: r.error,
		signals: null,
		reply_id: null,
		text: null,
		in_reply_to: r.in_reply_to,
		campaign_subject: null
	};
}

function inMessage(r: InRow): ConvMessage {
	// #380: rows stored before the ingest fix may hold HTML as text — clean at render too.
	const clean = cleanMessageText(r.text);
	return {
		dir: 'in',
		at: r.at,
		subject: r.subject,
		campaign_id: r.campaign_id,
		recipient_id: null,
		message_id: r.message_id,
		send_kind: null,
		status: null,
		error: null,
		signals: null,
		reply_id: r.reply_id,
		text: clean.text || null,
		has_original: clean.converted || !!r.has_html,
		in_reply_to: r.in_reply_to,
		campaign_subject: r.campaign_subject,
		forward_id: r.forward_id ?? null
	};
}

function gmailMessage(r: GmailRow): ConvMessage {
	return {
		dir: r.direction,
		at: r.at,
		subject: r.subject,
		campaign_id: null,
		recipient_id: null,
		message_id: r.message_id,
		send_kind: null,
		status: null,
		error: null,
		signals: null,
		reply_id: null,
		text: null,
		in_reply_to: r.in_reply_to,
		campaign_subject: null,
		source: 'gmail',
		mail_message_id: r.mail_message_id,
		gmail_thread_id: r.gmail_thread_id,
		from: r.sender,
		snippet: r.snippet == null ? null : displayText(decodeEntities(r.snippet)),
		references: parseReferences(r.references_header),
		teammate: r.teammate ?? null
	};
}

/** Split raw rows into parties (contact, else bare email) and thread each one. */
function threadAll(
	outRows: OutRow[],
	inRows: InRow[],
	signals?: Map<number, SendSignals>,
	gmailRows: GmailRow[] = []
): Conversation[] {
	type Party = { contact_id: number | null; email: string; name: string | null; messages: ConvMessage[] };
	const parties = new Map<string, Party>();
	const party = (r: { contact_id: number | null; email: string; name: string | null }) => {
		const k = r.contact_id != null ? `c${r.contact_id}` : `e${r.email}`;
		let p = parties.get(k);
		if (!p) {
			p = { contact_id: r.contact_id, email: r.email, name: r.name, messages: [] };
			parties.set(k, p);
		}
		return p;
	};
	for (const r of outRows) {
		const m = outMessage(r);
		m.signals = signals?.get(r.recipient_id) ?? null;
		party(r).messages.push(m);
	}
	for (const r of inRows) party(r).messages.push(inMessage(r));
	for (const r of gmailRows) party(r).messages.push(gmailMessage(r));

	const out: Conversation[] = [];
	for (const p of parties.values()) out.push(...threadMessages(p.messages, p));
	return out.sort((a, b) => (a.last_at === b.last_at ? 0 : a.last_at < b.last_at ? 1 : -1));
}

/** Per-send open/click/bounce badges, for the contact page. */
async function loadSignals(db: D1Database, recipientIds: number[]): Promise<Map<number, SendSignals>> {
	const map = new Map<number, SendSignals>();
	for (let i = 0; i < recipientIds.length; i += SQL_ID_CHUNK) {
		const chunk = recipientIds.slice(i, i + SQL_ID_CHUNK);
		const rows = await db
			.prepare(
				`SELECT e.recipient_id,
				        SUM(CASE WHEN e.type = 'open' THEN 1 ELSE 0 END) AS opens,
				        SUM(CASE WHEN e.type = 'click' THEN 1 ELSE 0 END) AS clicks,
				        MIN(CASE WHEN e.type = 'open' THEN e.recorded_at END) AS first_open,
				        MIN(CASE WHEN e.type = 'click' THEN e.recorded_at END) AS first_click,
				        MAX(CASE WHEN e.type = 'bounce' THEN 1 ELSE 0 END) AS bounced,
				        MAX(CASE WHEN e.type = 'spam' THEN 1 ELSE 0 END) AS spam,
				        MAX(CASE WHEN e.type = 'unsubscribe' THEN 1 ELSE 0 END) AS unsubscribed
				 FROM events e
				 WHERE e.recipient_id IN (${chunk.map(() => '?').join(',')})
				 GROUP BY e.recipient_id`
			)
			.bind(...chunk)
			.all<SendSignals & { recipient_id: number }>();
		for (const { recipient_id, ...s } of rows.results) map.set(recipient_id, s);
	}
	return map;
}

/** Every conversation with one contact, newest activity first, with per-send badges. */
export async function conversationsFor(db: D1Database, contactId: number): Promise<Conversation[]> {
	const [outRows, inRows, gmailRows] = await Promise.all([
		db.prepare(`${OUT_SQL} WHERE r.contact_id = ?`).bind(contactId).all<OutRow>(),
		db.prepare(`${IN_SQL} WHERE rp.contact_id = ?`).bind(contactId).all<InRow>(),
		db.prepare(`${GMAIL_SQL} WHERE mmc.contact_id = ?`).bind(contactId).all<GmailRow>()
	]);
	const signals = await loadSignals(
		db,
		outRows.results.map((r) => r.recipient_id)
	);
	return threadAll(outRows.results, inRows.results, signals, gmailRows.results);
}

/**
 * #566 (company timeline): the thread key of every reply and synced Gmail message of these
 * contacts, threaded exactly like their contact pages (`conversationsFor`). Gmail is read
 * whatever the Conversations-tab setting says, like the contact page. A Gmail copy of a message
 * the app already holds is dropped by the threading, so it has no key.
 */
export async function conversationKeys(
	db: D1Database,
	contactIds: number[]
): Promise<{ replies: Map<number, string>; gmail: Map<number, string> }> {
	const replies = new Map<number, string>();
	const gmail = new Map<number, string>();
	if (!contactIds.length) return { replies, gmail };
	const ids = JSON.stringify([...new Set(contactIds)]);
	const IN_IDS = 'IN (SELECT value FROM json_each(?))';
	const [outRows, inRows, gmailRows] = await Promise.all([
		db.prepare(`${OUT_SQL} WHERE r.contact_id ${IN_IDS}`).bind(ids).all<OutRow>(),
		db.prepare(`${IN_SQL} WHERE rp.contact_id ${IN_IDS}`).bind(ids).all<InRow>(),
		db.prepare(`${GMAIL_SQL} WHERE mmc.contact_id ${IN_IDS}`).bind(ids).all<GmailRow>()
	]);
	for (const t of threadAll(outRows.results, inRows.results, undefined, gmailRows.results)) {
		for (const m of t.messages) {
			if (m.reply_id != null) replies.set(m.reply_id, t.key);
			if (m.mail_message_id != null && !gmail.has(m.mail_message_id)) gmail.set(m.mail_message_id, t.key);
		}
	}
	return { replies, gmail };
}

/**
 * One conversation by its key, for the Reply box (#159). The party is a contact, or — for
 * a sender we never matched to a contact — a bare email. Re-threaded server-side so the
 * reply's headers come from the stored messages, never from the form.
 */
export async function findConversation(
	db: D1Database,
	party: { contactId: number | null; email: string | null },
	key: string
): Promise<Conversation | null> {
	let threads: Conversation[];
	if (party.contactId != null) {
		threads = await conversationsFor(db, party.contactId);
	} else {
		const email = (party.email ?? '').trim().toLowerCase();
		if (!email) return null;
		const [outRows, inRows] = await Promise.all([
			db.prepare(`${OUT_SQL} WHERE r.contact_id IS NULL AND LOWER(r.email) = ?`).bind(email).all<OutRow>(),
			db.prepare(`${IN_SQL} WHERE rp.contact_id IS NULL AND LOWER(rp.from_email) = ?`).bind(email).all<InRow>()
		]);
		threads = threadAll(outRows.results, inRows.results);
	}
	return threads.find((t) => t.key === key) ?? null;
}

/** Postmark's outbound Message-ID header is `<MessageID@mtasv.net>`; recipients store the bare id. */
const POSTMARK_MSGID_DOMAIN = 'mtasv.net';
const MAX_REFERENCES = 20;

/**
 * Threading headers for a reply to `conv` (#159): `inReplyTo` is the newest message with a
 * known Message-ID (our accepted sends, their replies with a captured header), `references`
 * the thread's ids oldest first (capped, newest kept). Ids are bare — no angle brackets.
 */
export function replyThreadingIds(conv: Conversation): { inReplyTo: string | null; references: string[] } {
	const ids: string[] = [];
	for (const m of conv.messages) {
		if (!m.message_id) continue;
		if (m.dir === 'out') {
			if (m.status === 'error') continue;
			const bare = m.message_id.replace(/^<|>$/g, '');
			ids.push(bare.includes('@') ? bare : `${bare}@${POSTMARK_MSGID_DOMAIN}`);
		} else {
			ids.push(m.message_id.replace(/^<|>$/g, ''));
		}
	}
	const seen = new Set<string>();
	const unique = ids.filter((id) => {
		const k = id.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	return { inReplyTo: unique.at(-1) ?? null, references: unique.slice(-MAX_REFERENCES) };
}

export type RecentConversations = {
	rows: Conversation[];
	total: number; // matching the filter + search
	counts: Record<ConvFilter, number>; // per chip, after search
	gmail: boolean; // #443: Gmail threads are listed (Settings → Mail switch) → show the Gmail chip
};

/**
 * Conversations across every contact for the Conversations tab, newest activity first.
 * A broadcast or automation send nobody replied to is bulk mail, not a conversation, so
 * the tab lists only threads with a reply or rooted in a direct 1:1 send ("Sent only" =
 * your 1:1s still waiting on an answer), plus synced Gmail threads (#158). Loads direct
 * sends + every send to anyone who has replied or has Gmail mail — small next to the
 * broadcast volume — and threads them in JS.
 */
export async function recentConversations(
	db: D1Database,
	opts: { limit?: number; offset?: number; q?: string; filter?: ConvFilter } = {}
): Promise<RecentConversations> {
	const gmail = await gmailInConversations(db);
	const threads = await listedThreads(db, opts.q, gmail);

	const counts: Record<ConvFilter, number> = { all: 0, awaiting: 0, replied: 0, sent: 0, gmail: 0, archived: 0 };
	for (const t of threads) for (const f of CONV_FILTERS) if (matchesFilter(t, f)) counts[f] += 1;

	const filter = opts.filter ?? 'all';
	const matching = threads.filter((t) => matchesFilter(t, filter));
	const offset = Math.max(0, opts.offset ?? 0);
	const limit = Math.max(0, opts.limit ?? 25);
	return { rows: matching.slice(offset, offset + limit), total: matching.length, counts, gmail };
}

// #585: contacts with an app conversation (a captured reply or a direct 1:1 send) — whose
// Gmail mail is loaded even with Gmail-only threads off, so an answer sent from Gmail counts.
const APP_THREAD_CONTACTS_SQL = `SELECT contact_id FROM replies WHERE contact_id IS NOT NULL
	UNION SELECT r2.contact_id FROM recipients r2 JOIN campaigns c2 ON c2.id = r2.campaign_id
	      WHERE r2.contact_id IS NOT NULL AND c2.list_id IS NULL AND c2.automation_step_id IS NULL`;

/**
 * Every thread the Conversations tab lists (see recentConversations), narrowed by search,
 * each with `archived` set (#379). Threads made only of Gmail mail only when `withGmail`
 * (default: the Settings → Mail switch, #443); Gmail messages that join an app thread are
 * always there (#585), so "awaiting", counts and previews match the thread page.
 */
export async function listedThreads(db: D1Database, search?: string, withGmail?: boolean): Promise<Conversation[]> {
	const gmail = withGmail ?? (await gmailInConversations(db));
	const [outRows, inRows, gmailRows, archived] = await Promise.all([
		db
			.prepare(
				`${OUT_SQL}
				 WHERE (c.list_id IS NULL AND c.automation_step_id IS NULL)
				    OR r.contact_id IN (SELECT contact_id FROM replies WHERE contact_id IS NOT NULL)
				    ${gmail ? 'OR r.contact_id IN (SELECT contact_id FROM mail_message_contacts)' : ''}`
			)
			.all<OutRow>(),
		db.prepare(IN_SQL).all<InRow>(),
		db
			.prepare(gmail ? GMAIL_SQL : `${GMAIL_SQL} WHERE mmc.contact_id IN (${APP_THREAD_CONTACTS_SQL})`)
			.all<GmailRow>(),
		archivedStates(db)
	]);

	let threads = threadAll(outRows.results, inRows.results, undefined, gmailRows.results).filter(
		(t) =>
			(t.replies > 0 || t.root_kind === 'direct' || t.root_kind === 'gmail') &&
			(gmail || t.messages.some((m) => m.source !== 'gmail'))
	);

	const q = (search ?? '').trim().toLowerCase();
	if (q) {
		threads = threads.filter(
			(t) =>
				t.email.includes(q) ||
				(t.name ?? '').toLowerCase().includes(q) ||
				t.subject.toLowerCase().includes(q) ||
				t.messages.some(
					(m) => (m.subject ?? '').toLowerCase().includes(q) || (m.snippet ?? '').toLowerCase().includes(q)
				)
		);
	}
	for (const t of threads) t.archived = isArchived(t, archived.get(t.key));
	return threads;
}

export type ArchiveState = { archived_at: string | null; archived_last_at: string | null };

/** Every currently-archived thread's state, by key. */
export async function archivedStates(db: D1Database): Promise<Map<string, ArchiveState>> {
	const rows = await db
		.prepare('SELECT thread_key, archived_at, archived_last_at FROM conversation_state WHERE archived_at IS NOT NULL')
		.all<ArchiveState & { thread_key: string }>();
	return new Map(rows.results.map((r) => [r.thread_key, r]));
}

/**
 * Archived = archived, and no inbound message newer than the thread's last activity at the
 * time it was archived (#379: a new message from them brings it back, like Gmail).
 */
export function isArchived(t: Pick<Conversation, 'messages'>, st: ArchiveState | null | undefined): boolean {
	if (!st?.archived_at) return false;
	const since = st.archived_last_at ?? st.archived_at;
	return !t.messages.some((m) => m.dir === 'in' && m.at > since);
}

/**
 * One conversation by its key (#226, the thread page): `c<contactId>-<root>` for a contact,
 * `e<email>-<root>` for a sender never matched to one. Any thread of that party — including
 * an unreplied broadcast the tab doesn't list (the contact page links to those too).
 */
export async function conversationByKey(db: D1Database, key: string): Promise<Conversation | null> {
	const c = /^c(\d+)-[^-]+$/.exec(key);
	if (c) return findConversation(db, { contactId: Number(c[1]), email: null }, key);
	const e = /^e(.+)-[^-]+$/.exec(key);
	if (e) return findConversation(db, { contactId: null, email: e[1] }, key);
	return null;
}

export type ThreadNeighbors = {
	prev: { key: string; subject: string } | null; // newer activity (above it in the list)
	next: { key: string; subject: string } | null; // older activity (below it)
	index: number; // 0-based position in the filtered list, -1 = not in it
	total: number;
};

/** Previous / Next thread around `key` within the Conversations tab's filter + search. */
export async function conversationNeighbors(
	db: D1Database,
	key: string,
	opts: { q?: string; filter?: ConvFilter } = {}
): Promise<ThreadNeighbors> {
	const filter = opts.filter ?? 'all';
	const list = (await listedThreads(db, opts.q)).filter((t) => matchesFilter(t, filter));
	const index = list.findIndex((t) => t.key === key);
	const pick = (t: Conversation | undefined) => (t ? { key: t.key, subject: t.subject } : null);
	return {
		prev: index > 0 ? pick(list[index - 1]) : null,
		next: index >= 0 ? pick(list[index + 1]) : null,
		index,
		total: list.length
	};
}

export function matchesFilter(t: Conversation, filter: ConvFilter): boolean {
	if (filter === 'archived') return !!t.archived;
	if (t.archived) return false;
	if (filter === 'awaiting') return t.awaiting;
	if (filter === 'replied') return t.replies > 0;
	if (filter === 'gmail') return t.messages.some((m) => m.source === 'gmail');
	if (filter === 'sent') return t.replies === 0;
	return true;
}

/**
 * #423: contacts with a listed conversation whose last message is theirs (archived threads
 * excluded) — the `/contacts?awaiting=1` filter. `olderThanDays` > 0 keeps only threads whose
 * last message is at least that old ("awaiting reply > 3 days"). `awaitingIdsFrom` is the pure
 * part, for callers that already hold `listedThreads`.
 */
export function awaitingIdsFrom(threads: Conversation[], olderThanDays = 0, now: Date = new Date()): number[] {
	const days = Math.max(0, olderThanDays);
	const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
	const ids = new Set<number>();
	for (const t of threads) {
		if (t.contact_id == null || !matchesFilter(t, 'awaiting')) continue;
		if (days > 0 && t.last_at.replace('T', ' ').slice(0, 19) > cutoff) continue;
		ids.add(t.contact_id);
	}
	return [...ids].sort((a, b) => a - b);
}

export async function awaitingContactIds(
	db: D1Database,
	opts: { olderThanDays?: number; now?: Date } = {}
): Promise<number[]> {
	return awaitingIdsFrom(await listedThreads(db), opts.olderThanDays ?? 0, opts.now);
}

/** Dashboard tile: conversations whose last message is theirs (archived / deleted excluded). */
export async function awaitingReplyCount(db: D1Database): Promise<number> {
	return (await recentConversations(db, { filter: 'awaiting', limit: 0 })).counts.awaiting;
}

/**
 * The HTML original of a captured reply, for "View original" (#380): the stored `html_body`,
 * else the stored text when it is itself HTML (rows from before the ingest fix). Null = none.
 */
export async function replyOriginalHtml(db: D1Database, replyId: number): Promise<string | null> {
	const row = await db
		.prepare('SELECT html_body, text FROM replies WHERE id = ?')
		.bind(replyId)
		.first<{ html_body: string | null; text: string | null }>();
	if (!row) return null;
	if (row.html_body) return row.html_body;
	return row.text && looksLikeHtml(row.text) ? row.text : null;
}
