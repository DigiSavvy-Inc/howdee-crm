// Gmail sync (#158) — rides the heartbeat tick, bounded per tick. See migration 0058 for the
// account state machine. In short:
//   1. No history_id → (re)list: users.messages.list(`list_query`), page by page, fetching
//      each new message with format=metadata. Only messages with ≥1 participant (From/To/Cc,
//      the mailbox's own address excluded) matching a contact are stored. When the last page
//      is done, history_id = the mailbox historyId captured when the list started.
//   2. history_id set → incremental: users.history.list(startHistoryId) → added messages →
//      the same filter. A 404 (historyId too old) falls back to a 30-day re-list.
//   #443: a message is kept only when a participant OUTSIDE the internal set (connected
//   mailboxes, users' emails, the internal domains) is a contact, and never when it looks
//   automated (`automatedReason` in $lib/mail-filter: category labels, List-Unsubscribe,
//   Precedence, Auto-Submitted, noreply@-style senders). `refilterStoredMail` prunes what was
//   stored before those rules (once on the first tick, then on every Sync now / domains save).
//   3. Nightly re-match: contacts created since the last pass are linked to stored messages
//      they took part in, and their past year of mail is searched for (≤10 per tick).
//   4. #585: messages stored before References was fetched (`references_header` NULL) are
//      fetched again, newest first, with what is left of the tick budget; each is fetched once.
//   Direction (#585) is decided by the mailbox, not only the From address: a message with
//   Gmail's SENT label, or sent from any internal address (a send-as alias, a teammate), is ours.
// Budget: ≤ MAIL_TICK_BUDGET messages looked at per tick, across accounts. A 429 / rate-limit
// 403 sets an exponential backoff (1 min → 1 h). Access tokens are cached per isolate.
// Tokens never appear in logs, errors or the DB (the refresh token is sealed).

import { open, seal, isValidKey } from './crypto-box';
import { decodeEntities, displayText } from '$lib/email-text';
import { REFERENCES_MAX } from '$lib/message-id';
import {
	SKIP_CATEGORY_LABELS,
	automatedReason,
	buildInternalSet,
	isAutomatedSender,
	isInternal,
	parseDomainList,
	type InternalSet
} from '$lib/mail-filter';
import {
	GmailError,
	bareMessageId,
	displayName,
	getMessageMetadata,
	getProfile,
	header,
	listHistory,
	listMessages,
	messageTime,
	parseAddresses,
	refreshGoogleToken,
	revokeGoogleToken,
	googleConfigured,
	type GmailMessage,
	type GoogleEnv
} from './gmail';

export const MAIL_TICK_BUDGET = 200;
export const BACKFILL_QUERY = 'newer_than:1y -category:promotions -category:social -category:updates -category:forums';
export const RELIST_QUERY = 'newer_than:30d -category:promotions -category:social -category:updates -category:forums';
// The re-list query stored before #443 (an account mid-relist keeps its stored query).
const OLD_RELIST_QUERY = 'newer_than:30d -category:promotions -category:social';
const PAGE_MAX = 100;
const MAX_PAGES_PER_TICK = 10; // history pages can be empty; never spin a tick on them
const REMATCH_EVERY_MS = 24 * 3600_000;
const REMATCH_CONTACTS_PER_TICK = 10;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3600_000;
const LOCK_LEASE_MS = 10 * 60_000;
const SQL_CHUNK = 90;
// Labels that the backfill query leaves out — incremental applies the same filter.
const SKIP_LABELS = [...SKIP_CATEGORY_LABELS, 'SPAM', 'TRASH', 'DRAFT'];

// ── Settings (#443, app_state) ──────────────────────────────────────────────────────

export const INTERNAL_DOMAINS_KEY = 'mail_internal_domains';
export const IN_CONVERSATIONS_KEY = 'mail_in_conversations';
const REFILTER_DONE_KEY = 'mail_refilter_443';
const DIRECTION_DONE_KEY = 'mail_direction_585';
// #585: stored messages without a fetched References header, re-fetched per tick (newest first).
const REFS_BACKFILL_PER_TICK = 50;

async function stateValue(db: D1Database, key: string): Promise<string | null> {
	return (await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<string>('value')) ?? null;
}

async function putState(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value)
		.run();
}

/** The saved internal domains, or null when never saved (= each mailbox's domain). */
export async function getInternalDomains(db: D1Database): Promise<string[] | null> {
	const v = await stateValue(db, INTERNAL_DOMAINS_KEY);
	return v == null ? null : parseDomainList(v);
}

export async function setInternalDomains(db: D1Database, domains: string[]): Promise<void> {
	await putState(db, INTERNAL_DOMAINS_KEY, domains.join(', '));
}

/** "Show Gmail threads in Conversations" — default off. */
export async function gmailInConversations(db: D1Database): Promise<boolean> {
	return (await stateValue(db, IN_CONVERSATIONS_KEY)) === '1';
}

export async function setGmailInConversations(db: D1Database, on: boolean): Promise<void> {
	await putState(db, IN_CONVERSATIONS_KEY, on ? '1' : '0');
}

/**
 * The internal set: every connected mailbox (plus `extraMailbox`), every `users.email`, and
 * the internal domains (saved list, else each mailbox's domain).
 */
export async function loadInternalSet(db: D1Database, extraMailbox?: string): Promise<InternalSet> {
	const [accounts, users, domains] = await Promise.all([
		db.prepare('SELECT email FROM mail_accounts').all<{ email: string }>(),
		db.prepare('SELECT email FROM users WHERE email IS NOT NULL').all<{ email: string }>(),
		getInternalDomains(db)
	]);
	return buildInternalSet({
		mailboxes: [...accounts.results.map((r) => r.email), extraMailbox],
		userEmails: users.results.map((r) => r.email),
		domains
	});
}

export type MailEnv = GoogleEnv & { MAIL_TOKEN_KEY?: string };
export type MailDeps = { fetch?: typeof fetch; now?: Date; budget?: number };

export type MailAccountRow = {
	id: number;
	provider: string;
	email: string;
	user_id: number | null;
	refresh_blob: string;
	paused: number;
	history_id: string | null;
	history_page_token: string | null;
	list_query: string | null;
	list_page_token: string | null;
	list_start_history_id: string | null;
	scanned: number;
	backoff_until: string | null;
	backoff_count: number;
	last_sync_at: string | null;
	last_error: string | null;
	connected_at: string;
};

const sqlNow = (now: Date) => now.toISOString().slice(0, 19).replace('T', ' ');

function chunks<T>(xs: T[], n = SQL_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
}

/** True when Gmail can be connected: Google client configured and MAIL_TOKEN_KEY valid. */
export function mailReady(env: MailEnv): boolean {
	return googleConfigured(env) && isValidKey(env.MAIL_TOKEN_KEY);
}

// ── Accounts ────────────────────────────────────────────────────────────────────────

/**
 * Store (or re-connect) a mailbox after OAuth. The refresh token is sealed; a reconnect of
 * the same address keeps its sync position and clears any error/backoff. #585: a reconnect
 * keeps the mailbox's owner (an admin reconnecting a teammate's mailbox doesn't take it over).
 */
export async function saveMailAccount(
	db: D1Database,
	env: MailEnv,
	args: { email: string; refreshToken: string; userId: number | null }
): Promise<number> {
	if (!isValidKey(env.MAIL_TOKEN_KEY)) throw new Error('MAIL_TOKEN_KEY is not set');
	const blob = await seal(env.MAIL_TOKEN_KEY, args.refreshToken);
	const email = args.email.trim().toLowerCase();
	const row = await db
		.prepare(
			`INSERT INTO mail_accounts (email, user_id, refresh_blob) VALUES (?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET user_id = COALESCE(mail_accounts.user_id, excluded.user_id), refresh_blob = excluded.refresh_blob,
			   last_error = NULL, backoff_until = NULL, backoff_count = 0
			 RETURNING id`
		)
		.bind(email, args.userId, blob)
		.first<{ id: number }>();
	tokenCache.delete(row!.id);
	// The re-match pass covers contacts created from here on (the backfill covers the rest).
	const maxContact = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM contacts').first<number>('m')) ?? 0;
	const existing = await getRematch(db, row!.id);
	if (!existing) await setRematch(db, row!.id, { at: new Date().toISOString(), cursor: maxContact });
	return row!.id;
}

export async function getMailAccount(db: D1Database, id: number): Promise<MailAccountRow | null> {
	return db.prepare('SELECT * FROM mail_accounts WHERE id = ?').bind(id).first<MailAccountRow>();
}

export async function setMailPaused(db: D1Database, id: number, paused: boolean): Promise<boolean> {
	const r = await db.prepare('UPDATE mail_accounts SET paused = ? WHERE id = ?').bind(paused ? 1 : 0, id).run();
	return (r.meta.changes ?? 0) > 0;
}

/**
 * Disconnect: revoke the refresh token at Google (best-effort — a key or network failure
 * must not block removal), delete the row (threads/messages/links cascade), and drop the
 * cached bodies from R2.
 */
export async function disconnectMailAccount(
	db: D1Database,
	env: MailEnv,
	id: number,
	opts: { fetch?: typeof fetch; media?: R2Bucket } = {}
): Promise<{ removed: boolean; revoked: boolean }> {
	const acct = await getMailAccount(db, id);
	if (!acct) return { removed: false, revoked: false };
	let revoked = false;
	if (isValidKey(env.MAIL_TOKEN_KEY)) {
		try {
			const refresh = await open(env.MAIL_TOKEN_KEY, acct.refresh_blob);
			revoked = await revokeGoogleToken(refresh, opts.fetch ?? fetch);
		} catch {
			revoked = false;
		}
	}
	await db.batch([
		db.prepare('DELETE FROM mail_accounts WHERE id = ?').bind(id),
		db.prepare('DELETE FROM app_state WHERE key IN (?, ?)').bind(rematchKey(id), lockKey(id))
	]);
	tokenCache.delete(id);
	if (opts.media) {
		try {
			for (let i = 0; i < 20; i++) {
				const listed = await opts.media.list({ prefix: `mail/${id}/`, limit: 1000 });
				if (listed.objects.length) await opts.media.delete(listed.objects.map((o) => o.key));
				if (!listed.truncated) break;
			}
		} catch {
			/* cached bodies expire on their own */
		}
	}
	return { removed: true, revoked };
}

// ── Access tokens (cached per isolate) ──────────────────────────────────────────────

const tokenCache = new Map<number, { blob: string; token: string; exp: number }>();

export function clearMailTokenCache(): void {
	tokenCache.clear();
}

export async function accessTokenFor(
	acct: Pick<MailAccountRow, 'id' | 'refresh_blob'>,
	env: MailEnv,
	fetchImpl: typeof fetch,
	now = new Date()
): Promise<string> {
	const hit = tokenCache.get(acct.id);
	if (hit && hit.blob === acct.refresh_blob && hit.exp > now.getTime() + 60_000) return hit.token;
	if (!googleConfigured(env)) throw new GmailError(0, 'not_configured');
	if (!isValidKey(env.MAIL_TOKEN_KEY)) throw new GmailError(0, 'no_token_key');
	let refreshToken: string;
	try {
		refreshToken = await open(env.MAIL_TOKEN_KEY, acct.refresh_blob);
	} catch {
		throw new GmailError(0, 'token_unreadable');
	}
	const t = await refreshGoogleToken(
		{ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, refreshToken },
		fetchImpl
	);
	tokenCache.set(acct.id, { blob: acct.refresh_blob, token: t.accessToken, exp: now.getTime() + t.expiresIn * 1000 });
	return t.accessToken;
}

// ── Participant matching + storage ──────────────────────────────────────────────────

/** Lowercased address → contact id, for the addresses that are contacts. Exact match only. */
export async function matchContacts(db: D1Database, emails: string[]): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	const uniq = [...new Set(emails.map((e) => e.toLowerCase()))];
	for (const chunk of chunks(uniq)) {
		const rows = await db
			.prepare(`SELECT id, LOWER(email) AS email FROM contacts WHERE LOWER(email) IN (${chunk.map(() => '?').join(',')})`)
			.bind(...chunk)
			.all<{ id: number; email: string }>();
		for (const r of rows.results) map.set(r.email, r.id);
	}
	return map;
}

export type ParsedMail = {
	gmail_id: string;
	gmail_thread_id: string;
	from_email: string | null;
	from_name: string | null;
	participants: string[];
	subject: string | null;
	snippet: string | null;
	message_id_header: string | null;
	in_reply_to: string | null;
	references_header: string; // #585: raw References header, '' when absent
	labels: string[];
	sent_at: string;
};

export function parseMail(msg: GmailMessage): ParsedMail {
	const fromHeader = header(msg, 'From');
	const from = parseAddresses(fromHeader)[0] ?? null;
	const participants = [
		...new Set([...(from ? [from] : []), ...parseAddresses(header(msg, 'To')), ...parseAddresses(header(msg, 'Cc'))])
	];
	return {
		gmail_id: msg.id,
		gmail_thread_id: msg.threadId,
		from_email: from,
		from_name: displayName(fromHeader),
		participants,
		subject: header(msg, 'Subject'),
		// Gmail snippets arrive HTML-escaped (&#39;); store readable text (#380).
		snippet: msg.snippet ? displayText(decodeEntities(msg.snippet)).slice(0, 500) : null,
		message_id_header: bareMessageId(header(msg, 'Message-ID')),
		in_reply_to: bareMessageId(header(msg, 'In-Reply-To')),
		references_header: (header(msg, 'References') ?? '').replace(/\s+/g, ' ').trim().slice(0, REFERENCES_MAX),
		labels: msg.labelIds ?? [],
		sent_at: messageTime(msg)
	};
}

/**
 * #585: whose message it is, decided by the mailbox: Gmail's SENT label, the mailbox's own
 * address, or any internal address (a send-as alias, a teammate, an internal domain) → ours.
 */
export function mailDirection(
	m: Pick<ParsedMail, 'from_email' | 'labels'>,
	mailbox: string,
	internal: InternalSet
): 'in' | 'out' {
	if (m.labels.includes('SENT')) return 'out';
	const from = (m.from_email ?? '').toLowerCase();
	if (!from) return 'in';
	return from === mailbox.toLowerCase() || isInternal(from, internal) ? 'out' : 'in';
}

/**
 * The participant filter: for each message, the contact ids among its participants outside
 * the internal set (#443 — the mailbox itself, users, other mailboxes, internal domains).
 * Messages with none are dropped (absent from the result).
 */
export async function filterByContacts(
	db: D1Database,
	accountEmail: string,
	mails: ParsedMail[],
	internal?: InternalSet
): Promise<Map<string, number[]>> {
	const set = internal ?? (await loadInternalSet(db, accountEmail));
	const self = accountEmail.toLowerCase();
	const outside = (p: string) => p !== self && !isInternal(p, set);
	const all = mails.flatMap((m) => m.participants.filter(outside));
	const contacts = await matchContacts(db, all);
	const out = new Map<string, number[]>();
	for (const m of mails) {
		const ids = [...new Set(m.participants.filter(outside).map((p) => contacts.get(p)).filter((x): x is number => x != null))];
		if (ids.length) out.set(m.gmail_id, ids);
	}
	return out;
}

/**
 * Store the messages that pass the filters: not automated (#443), then the participant
 * filter. Returns how many were kept.
 */
export async function storeMessages(
	db: D1Database,
	acct: Pick<MailAccountRow, 'id' | 'email'>,
	msgs: GmailMessage[]
): Promise<number> {
	if (!msgs.length) return 0;
	const deleted = await deletedGmailIds(db, acct.email, msgs.map((m) => m.id));
	const mails = msgs
		.filter((m) => !deleted.has(m.id))
		.map((m) => ({ m, p: parseMail(m) }))
		.filter(({ m, p }) => !automatedReason((n) => header(m, n), p.from_email, m.labelIds ?? []))
		.map(({ p }) => p);
	if (!mails.length) return 0;
	const internal = await loadInternalSet(db, acct.email);
	const links = await filterByContacts(db, acct.email, mails, internal);
	const stmts: D1PreparedStatement[] = [];
	for (const m of mails) {
		const contactIds = links.get(m.gmail_id);
		if (!contactIds) continue;
		stmts.push(
			db
				.prepare(
					`INSERT INTO mail_threads (account_id, gmail_thread_id, subject, last_message_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
					   subject = COALESCE(mail_threads.subject, excluded.subject),
					   last_message_at = MAX(COALESCE(mail_threads.last_message_at, ''), excluded.last_message_at)`
				)
				.bind(acct.id, m.gmail_thread_id, m.subject, m.sent_at),
			db
				.prepare(
					`INSERT OR IGNORE INTO mail_messages
					   (account_id, thread_id, gmail_id, gmail_thread_id, message_id_header, in_reply_to, direction,
					    from_email, from_name, participants, subject, snippet, sent_at, references_header)
					 VALUES (?, (SELECT id FROM mail_threads WHERE account_id = ? AND gmail_thread_id = ?),
					         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					acct.id,
					acct.id,
					m.gmail_thread_id,
					m.gmail_id,
					m.gmail_thread_id,
					m.message_id_header,
					m.in_reply_to,
					mailDirection(m, acct.email, internal),
					m.from_email,
					m.from_name,
					JSON.stringify(m.participants),
					m.subject,
					m.snippet,
					m.sent_at,
					m.references_header
				),
			...contactIds.map((cid) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO mail_message_contacts (message_id, contact_id)
						 SELECT id, ? FROM mail_messages WHERE account_id = ? AND gmail_id = ?`
					)
					.bind(cid, acct.id, m.gmail_id)
			)
		);
	}
	if (stmts.length) await db.batch(stmts);
	return links.size;
}

/**
 * Gmail ids of `mailbox` deleted from a conversation (#379, `conversation_deleted_gmail`):
 * never fetched or stored again.
 */
export async function deletedGmailIds(db: D1Database, mailbox: string, ids: string[]): Promise<Set<string>> {
	const out = new Set<string>();
	if (!ids.length) return out;
	const rows = await db
		.prepare(
			`SELECT gmail_id FROM conversation_deleted_gmail
			 WHERE mailbox = ? AND gmail_id IN (SELECT value FROM json_each(?))`
		)
		.bind(mailbox.toLowerCase(), JSON.stringify(ids))
		.all<{ gmail_id: string }>();
	for (const r of rows.results) out.add(r.gmail_id);
	return out;
}

async function knownIds(db: D1Database, accountId: number, ids: string[]): Promise<Set<string>> {
	const known = new Set<string>();
	for (const chunk of chunks(ids)) {
		const rows = await db
			.prepare(`SELECT gmail_id FROM mail_messages WHERE account_id = ? AND gmail_id IN (${chunk.map(() => '?').join(',')})`)
			.bind(accountId, ...chunk)
			.all<{ gmail_id: string }>();
		for (const r of rows.results) known.add(r.gmail_id);
	}
	return known;
}

/**
 * Fetch metadata for the ids not stored yet and store the matching ones. A message deleted
 * between list and get (404) is skipped. On any other error, what was fetched is stored
 * first, then the error propagates (the caller keeps its cursor, so the page is retried).
 */
async function ingest(
	db: D1Database,
	acct: MailAccountRow,
	token: string,
	ids: string[],
	fetchImpl: typeof fetch
): Promise<number> {
	const known = await knownIds(db, acct.id, ids);
	for (const id of await deletedGmailIds(db, acct.email, ids)) known.add(id); // #379
	const fetched: GmailMessage[] = [];
	let failure: unknown = null;
	for (const id of ids) {
		if (known.has(id)) continue;
		try {
			fetched.push(await getMessageMetadata(token, id, fetchImpl));
		} catch (e) {
			if (e instanceof GmailError && e.status === 404) continue;
			failure = e;
			break;
		}
	}
	// Store whatever arrived before an error, so a retry doesn't re-fetch it.
	const stored = await storeMessages(db, acct, fetched);
	if (failure) throw failure;
	return stored;
}

// ── Sync ────────────────────────────────────────────────────────────────────────────

export type MailSyncResult = {
	account_id: number;
	mode: 'backfill' | 'relist' | 'incremental' | 'skipped';
	scanned: number;
	stored: number;
	done?: boolean; // the (re)list finished this tick
	fallback?: boolean; // historyId was too old → switched to the 30-day re-list
	rematched?: number;
	refs?: number; // #585: stored messages whose References header was backfilled this run
	error?: string;
	skipped?: 'paused' | 'backoff' | 'locked';
};

async function update(db: D1Database, id: number, fields: Partial<MailAccountRow>): Promise<void> {
	const keys = Object.keys(fields);
	if (!keys.length) return;
	await db
		.prepare(`UPDATE mail_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
		.bind(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), id)
		.run();
}

const lockKey = (id: number) => `mail_lock:${id}`;

async function claimLock(db: D1Database, id: number, now: Date): Promise<boolean> {
	const res = await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
			 WHERE app_state.value IS NULL OR app_state.value < ?`
		)
		.bind(lockKey(id), new Date(now.getTime() + LOCK_LEASE_MS).toISOString(), now.toISOString())
		.run();
	return (res.meta.changes ?? 0) > 0;
}

async function releaseLock(db: D1Database, id: number): Promise<void> {
	await db.prepare(`UPDATE app_state SET value = '' WHERE key = ?`).bind(lockKey(id)).run();
}

function errorText(e: unknown): string {
	if (e instanceof GmailError) {
		if (e.reason === 'invalid_grant') return 'Google access was revoked or expired — reconnect Gmail.';
		if (e.reason === 'not_configured') return 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.';
		if (e.reason === 'no_token_key' || e.reason === 'token_unreadable')
			return 'The stored Gmail token can’t be opened (MAIL_TOKEN_KEY missing or changed) — reconnect Gmail.';
		if (e.rateLimited) return 'Gmail rate limit — backing off.';
		return e.message;
	}
	return 'Sync failed.';
}

/** One bounded sync pass for one account. Never throws; errors land in last_error. */
export async function syncMailAccount(
	db: D1Database,
	env: MailEnv,
	accountId: number,
	deps: MailDeps & { force?: boolean } = {}
): Promise<MailSyncResult> {
	const now = deps.now ?? new Date();
	const fetchImpl = deps.fetch ?? fetch;
	let remaining = deps.budget ?? MAIL_TICK_BUDGET;
	const acct = await getMailAccount(db, accountId);
	const base: MailSyncResult = { account_id: accountId, mode: 'skipped', scanned: 0, stored: 0 };
	if (!acct) return { ...base, error: 'not found' };
	if (acct.paused && !deps.force) return { ...base, skipped: 'paused' };
	if (!deps.force && acct.backoff_until && Date.parse(acct.backoff_until) > now.getTime()) {
		return { ...base, skipped: 'backoff' };
	}
	if (!(await claimLock(db, accountId, now))) return { ...base, skipped: 'locked' };

	const result: MailSyncResult = { ...base, mode: acct.history_id ? 'incremental' : isRelist(acct.list_query) ? 'relist' : 'backfill' };
	try {
		const token = await accessTokenFor(acct, env, fetchImpl, now);

		if (acct.history_id) {
			let pages = 0;
			while (remaining > 0 && pages++ < MAX_PAGES_PER_TICK) {
				let h;
				try {
					h = await listHistory(
						token,
						{ startHistoryId: acct.history_id, pageToken: acct.history_page_token, maxResults: Math.min(PAGE_MAX, remaining) },
						fetchImpl
					);
				} catch (e) {
					if (e instanceof GmailError && e.status === 404) {
						// historyId too old (Gmail keeps roughly a week) → re-list the last 30 days.
						const profile = await getProfile(token, fetchImpl);
						Object.assign(acct, {
							history_id: null,
							history_page_token: null,
							list_query: RELIST_QUERY,
							list_page_token: null,
							list_start_history_id: profile.historyId,
							scanned: 0
						});
						await update(db, acct.id, {
							history_id: null,
							history_page_token: null,
							list_query: RELIST_QUERY,
							list_page_token: null,
							list_start_history_id: profile.historyId,
							scanned: 0
						});
						result.mode = 'relist';
						result.fallback = true;
						break;
					}
					throw e;
				}
				const ids: string[] = [];
				for (const rec of h.history ?? []) {
					for (const a of rec.messagesAdded ?? []) {
						const labels = a.message.labelIds ?? [];
						if (labels.some((l) => SKIP_LABELS.includes(l))) continue;
						if (!ids.includes(a.message.id)) ids.push(a.message.id);
					}
				}
				result.stored += await ingest(db, acct, token, ids, fetchImpl);
				result.scanned += ids.length;
				remaining -= ids.length;
				if (h.nextPageToken) {
					acct.history_page_token = h.nextPageToken;
					await update(db, acct.id, { history_page_token: h.nextPageToken });
				} else {
					acct.history_id = h.historyId;
					acct.history_page_token = null;
					await update(db, acct.id, { history_id: h.historyId, history_page_token: null });
					break;
				}
			}
		}

		if (!acct.history_id) {
			if (!acct.list_start_history_id) {
				const profile = await getProfile(token, fetchImpl);
				acct.list_start_history_id = profile.historyId;
				acct.list_query = acct.list_query ?? BACKFILL_QUERY;
				await update(db, acct.id, { list_start_history_id: profile.historyId, list_query: acct.list_query });
			}
			const q = acct.list_query ?? BACKFILL_QUERY;
			while (remaining > 0) {
				const page = await listMessages(token, { q, pageToken: acct.list_page_token, maxResults: Math.min(PAGE_MAX, remaining) }, fetchImpl);
				const ids = (page.messages ?? []).map((m) => m.id);
				result.stored += await ingest(db, acct, token, ids, fetchImpl);
				result.scanned += ids.length;
				remaining -= ids.length;
				acct.scanned += ids.length;
				if (page.nextPageToken && ids.length) {
					acct.list_page_token = page.nextPageToken;
					await update(db, acct.id, { list_page_token: page.nextPageToken, scanned: acct.scanned });
				} else {
					// Done: everything since the list started arrives through history from here.
					acct.history_id = acct.list_start_history_id;
					await update(db, acct.id, {
						history_id: acct.list_start_history_id,
						history_page_token: null,
						list_query: null,
						list_page_token: null,
						list_start_history_id: null,
						scanned: acct.scanned
					});
					result.done = true;
					break;
				}
			}
		}

		if (acct.history_id && remaining > 0) {
			result.rematched = await rematchPass(db, acct, token, fetchImpl, now, () => remaining, (n) => (remaining -= n));
		}

		if (remaining > 0) {
			const refs = await backfillReferences(db, acct, token, fetchImpl, Math.min(remaining, REFS_BACKFILL_PER_TICK));
			remaining -= refs;
			if (refs) result.refs = refs;
		}

		await update(db, acct.id, { last_sync_at: sqlNow(now), last_error: null, backoff_until: null, backoff_count: 0 });
	} catch (e) {
		const count = acct.backoff_count + 1;
		const wait = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS);
		result.error = errorText(e);
		await update(db, acct.id, {
			last_error: result.error,
			backoff_count: count,
			backoff_until: new Date(now.getTime() + wait).toISOString()
		});
	} finally {
		await releaseLock(db, accountId);
	}
	return result;
}

const isRelist = (q: string | null) => q === RELIST_QUERY || q === OLD_RELIST_QUERY;

/**
 * Heartbeat entry: every connected, unpaused account, sharing one per-tick budget. The first
 * tick after #443 shipped runs the stored-mail cleanup once (flag `mail_refilter_443`).
 */
export async function runMailTick(
	db: D1Database,
	env: MailEnv & { MEDIA?: R2Bucket },
	deps: MailDeps = {}
): Promise<MailSyncResult[] | { skipped: string }> {
	if ((await stateValue(db, REFILTER_DONE_KEY)) == null) {
		try {
			const purged = await refilterStoredMail(db, env.MEDIA);
			await putState(db, REFILTER_DONE_KEY, JSON.stringify({ at: (deps.now ?? new Date()).toISOString(), ...purged }));
		} catch (e) {
			console.error('mail refilter failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
	}
	if ((await stateValue(db, DIRECTION_DONE_KEY)) == null) {
		try {
			const fixed = await correctMailDirections(db);
			await putState(db, DIRECTION_DONE_KEY, JSON.stringify({ at: (deps.now ?? new Date()).toISOString(), fixed }));
		} catch (e) {
			console.error('mail direction fix failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
	}
	if (!googleConfigured(env)) return { skipped: 'not_configured' };
	const accounts = await db.prepare('SELECT id FROM mail_accounts WHERE paused = 0 ORDER BY id').all<{ id: number }>();
	let budget = deps.budget ?? MAIL_TICK_BUDGET;
	const out: MailSyncResult[] = [];
	for (const a of accounts.results) {
		if (budget <= 0) break;
		const r = await syncMailAccount(db, env, a.id, { ...deps, budget });
		budget -= r.scanned;
		out.push(r);
	}
	return out;
}

// ── References backfill + direction fix (#585) ──────────────────────────────────────

/**
 * Re-fetch up to `max` stored messages of this mailbox whose References header was never
 * fetched (stored before #585), newest first, and store it ('' when the message has none or
 * is gone from Gmail, so it is never fetched again). The SENT label read on the way corrects
 * the message's direction. On an error, what was fetched is saved first, then it propagates.
 * Returns how many messages were updated.
 */
export async function backfillReferences(
	db: D1Database,
	acct: Pick<MailAccountRow, 'id' | 'email'>,
	token: string,
	fetchImpl: typeof fetch,
	max: number
): Promise<number> {
	if (max <= 0) return 0;
	const rows = await db
		.prepare(
			`SELECT id, gmail_id FROM mail_messages WHERE account_id = ? AND references_header IS NULL
			 ORDER BY sent_at DESC, id DESC LIMIT ?`
		)
		.bind(acct.id, max)
		.all<{ id: number; gmail_id: string }>();
	if (!rows.results.length) return 0;
	const internal = await loadInternalSet(db, acct.email);
	const stmts: D1PreparedStatement[] = [];
	let failure: unknown = null;
	for (const r of rows.results) {
		let msg: GmailMessage;
		try {
			msg = await getMessageMetadata(token, r.gmail_id, fetchImpl);
		} catch (e) {
			if (e instanceof GmailError && e.status === 404) {
				stmts.push(db.prepare(`UPDATE mail_messages SET references_header = '' WHERE id = ?`).bind(r.id));
				continue;
			}
			failure = e;
			break;
		}
		const p = parseMail(msg);
		stmts.push(
			db
				.prepare('UPDATE mail_messages SET references_header = ?, direction = ? WHERE id = ?')
				.bind(p.references_header, mailDirection(p, acct.email, internal), r.id)
		);
	}
	if (stmts.length) await db.batch(stmts);
	if (failure) throw failure;
	return stmts.length;
}

/**
 * #585: stored inbound messages whose From is an internal address (a send-as alias, a
 * teammate, an internal domain) are ours — mark them outbound. Runs once on the first tick
 * after #585 and again whenever the internal set may have changed (refilterStoredMail).
 * Returns how many rows changed.
 */
export async function correctMailDirections(db: D1Database, internal?: InternalSet): Promise<number> {
	const set = internal ?? (await loadInternalSet(db));
	const senders = await db
		.prepare(`SELECT DISTINCT LOWER(from_email) AS email FROM mail_messages WHERE direction = 'in' AND from_email IS NOT NULL`)
		.all<{ email: string }>();
	const ours = senders.results.map((r) => r.email).filter((e) => isInternal(e, set));
	let fixed = 0;
	for (const chunk of chunks(ours, 500)) {
		const r = await db
			.prepare(
				`UPDATE mail_messages SET direction = 'out'
				 WHERE direction = 'in' AND LOWER(from_email) IN (SELECT value FROM json_each(?))`
			)
			.bind(JSON.stringify(chunk))
			.run();
		fixed += r.meta.changes ?? 0;
	}
	return fixed;
}

// ── Nightly re-match ────────────────────────────────────────────────────────────────

type RematchState = { at: string; cursor: number };
const rematchKey = (id: number) => `mail_rematch:${id}`;

async function getRematch(db: D1Database, id: number): Promise<RematchState | null> {
	const v = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(rematchKey(id)).first<string>('value');
	try {
		return v ? (JSON.parse(v) as RematchState) : null;
	} catch {
		return null;
	}
}

async function setRematch(db: D1Database, id: number, s: RematchState): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(rematchKey(id), JSON.stringify(s))
		.run();
}

/** Gmail search for one address's mail (From/To/Cc) in the backfill window. */
export function contactQuery(email: string): string | null {
	if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+$/i.test(email)) return null;
	return `{from:${email} to:${email} cc:${email}} ${BACKFILL_QUERY}`;
}

/**
 * Once per 24h: for contacts created since the last pass (id > cursor), link stored
 * messages they took part in, then search the mailbox for their past year of mail (one
 * page each, counted against the tick budget). ≤10 contacts per tick; a pass that doesn't
 * finish continues next tick before the stamp moves.
 */
async function rematchPass(
	db: D1Database,
	acct: MailAccountRow,
	token: string,
	fetchImpl: typeof fetch,
	now: Date,
	left: () => number,
	spend: (n: number) => void
): Promise<number> {
	const state = (await getRematch(db, acct.id)) ?? { at: new Date(0).toISOString(), cursor: 0 };
	if (now.getTime() - Date.parse(state.at) < REMATCH_EVERY_MS) return 0;
	const contacts = await db
		.prepare('SELECT id, LOWER(email) AS email FROM contacts WHERE id > ? ORDER BY id LIMIT ?')
		.bind(state.cursor, REMATCH_CONTACTS_PER_TICK)
		.all<{ id: number; email: string }>();
	let linked = 0;
	let cursor = state.cursor;
	const internal = await loadInternalSet(db, acct.email);
	let outOfBudget = false;
	for (const c of contacts.results) {
		if (left() <= 0) {
			outOfBudget = true;
			break;
		}
		// #443: an internal contact (our own people / domains) is never linked or searched for.
		if (c.email !== acct.email.toLowerCase() && !isInternal(c.email, internal)) {
			const r = await db
				.prepare(
					`INSERT OR IGNORE INTO mail_message_contacts (message_id, contact_id)
					 SELECT m.id, ? FROM mail_messages m
					 WHERE m.account_id = ? AND EXISTS (SELECT 1 FROM json_each(m.participants) WHERE value = ?)`
				)
				.bind(c.id, acct.id, c.email)
				.run();
			linked += r.meta.changes ?? 0;
			const q = contactQuery(c.email);
			if (q) {
				const page = await listMessages(token, { q, maxResults: Math.min(50, left()) }, fetchImpl);
				const ids = (page.messages ?? []).map((m) => m.id);
				spend(Math.max(1, ids.length));
				linked += await ingest(db, acct, token, ids, fetchImpl);
			}
		}
		cursor = c.id;
	}
	const finished = !outOfBudget && contacts.results.length < REMATCH_CONTACTS_PER_TICK;
	await setRematch(db, acct.id, finished ? { at: now.toISOString(), cursor } : { at: state.at, cursor });
	return linked;
}

// ── Cleanup of stored noise (#443) ──────────────────────────────────────────────────

export type RefilterResult = { links: number; messages: number; threads: number };

/**
 * Re-apply the rules to what is stored: drop links to internal contacts and to messages from
 * automated senders (noreply@-style From), then messages left with no link, then threads left
 * with no message, then those messages' cached bodies in R2 (like disconnect). Idempotent;
 * the counts are what this pass removed.
 */
export async function refilterStoredMail(db: D1Database, media?: R2Bucket | null): Promise<RefilterResult> {
	const internal = await loadInternalSet(db);
	await correctMailDirections(db, internal); // #585: the internal set may have changed
	const linked = await db
		.prepare(
			`SELECT DISTINCT mmc.contact_id AS id, LOWER(c.email) AS email
			 FROM mail_message_contacts mmc JOIN contacts c ON c.id = mmc.contact_id`
		)
		.all<{ id: number; email: string }>();
	const internalIds = linked.results.filter((r) => isInternal(r.email, internal)).map((r) => r.id);
	let links = 0;
	for (const chunk of chunks(internalIds, 500)) {
		const r = await db
			.prepare('DELETE FROM mail_message_contacts WHERE contact_id IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(chunk))
			.run();
		links += r.meta.changes ?? 0;
	}
	const senders = await db
		.prepare('SELECT DISTINCT LOWER(from_email) AS email FROM mail_messages WHERE from_email IS NOT NULL')
		.all<{ email: string }>();
	const automated = senders.results.map((r) => r.email).filter((e) => isAutomatedSender(e));
	for (const chunk of chunks(automated, 500)) {
		const r = await db
			.prepare(
				`DELETE FROM mail_message_contacts WHERE message_id IN
				   (SELECT id FROM mail_messages WHERE LOWER(from_email) IN (SELECT value FROM json_each(?)))`
			)
			.bind(JSON.stringify(chunk))
			.run();
		links += r.meta.changes ?? 0;
	}
	const gone = await db
		.prepare(
			`DELETE FROM mail_messages
			 WHERE NOT EXISTS (SELECT 1 FROM mail_message_contacts mmc WHERE mmc.message_id = mail_messages.id)
			 RETURNING account_id, gmail_id`
		)
		.all<{ account_id: number; gmail_id: string }>();
	const threads = await db
		.prepare('DELETE FROM mail_threads WHERE NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.id)')
		.run();
	if (media && gone.results.length) {
		try {
			// Same key as mail-body.ts `bodyKey` (not imported: mail-body imports this module).
			const keys = gone.results.map((r) => `mail/${r.account_id}/${r.gmail_id}.txt`);
			for (const chunk of chunks(keys, 1000)) await media.delete(chunk);
		} catch {
			/* cached bodies expire on their own */
		}
	}
	return { links, messages: gone.results.length, threads: threads.meta.changes ?? 0 };
}

// ── Status (Settings → Mail) ────────────────────────────────────────────────────────

export type MailAccountStatus = {
	id: number;
	email: string;
	user_id: number | null; // #585: the user who connected it (each teammate connects their own)
	connected_by: string | null;
	connected_at: string;
	paused: boolean;
	mode: 'backfill' | 'relist' | 'incremental';
	scanned: number;
	last_sync_at: string | null;
	last_error: string | null;
	backoff_until: string | null;
	threads: number;
	messages: number;
};

/** Every mailbox, or (#585, a member's view) only the ones `userId` connected. */
export async function mailStatus(db: D1Database, opts: { userId?: number } = {}): Promise<MailAccountStatus[]> {
	const own = opts.userId != null;
	const rows = await db
		.prepare(
			`SELECT a.*, u.github_login AS connected_by,
			        (SELECT COUNT(*) FROM mail_threads t WHERE t.account_id = a.id) AS threads,
			        (SELECT COUNT(*) FROM mail_messages m WHERE m.account_id = a.id) AS messages
			 FROM mail_accounts a LEFT JOIN users u ON u.id = a.user_id
			 ${own ? 'WHERE a.user_id = ?' : ''}
			 ORDER BY a.id`
		)
		.bind(...(own ? [opts.userId] : []))
		.all<MailAccountRow & { connected_by: string | null; threads: number; messages: number }>();
	return rows.results.map((r) => ({
		id: r.id,
		email: r.email,
		user_id: r.user_id,
		connected_by: r.connected_by,
		connected_at: r.connected_at,
		paused: !!r.paused,
		mode: r.history_id ? 'incremental' : isRelist(r.list_query) ? 'relist' : 'backfill',
		scanned: r.scanned,
		last_sync_at: r.last_sync_at,
		last_error: r.last_error,
		backoff_until: r.backoff_until,
		threads: r.threads,
		messages: r.messages
	}));
}
