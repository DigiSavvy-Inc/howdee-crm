// Archive / delete conversations (#379). State is keyed by the thread key (see the header of
// conversations.ts for why that key is stable enough). Migration 0094.
//
// - Archive: any signed-in user. Stores the thread's last-activity time; a newer inbound
//   message brings it back (read-time, `isArchived`).
// - Delete: admins only (checked by the route). Deletes only the thread's inbound rows —
//   `replies` and synced `mail_messages` with direction 'in' — and never touches send history:
//   `recipients` / `campaigns` / `events` stay and are hidden from Conversations by
//   `conversation_hidden_sends`; Gmail messages the mailbox sent (direction 'out') stay and are
//   hidden by `conversation_hidden_gmail` (mailbox + Gmail id, so a re-sync can't bring them
//   back). Each deleted inbound Gmail message gets a tombstone (`conversation_deleted_gmail`)
//   the sync checks. A Gmail message linked to several contacts leaves all of their threads.
import { conversationByKey, listedThreads, type Conversation } from './conversations';
import { bodyKey } from './mail-body';

/** Most thread keys one request may act on. */
export const CONV_BULK_MAX = 200;

// `c<contactId>-<root>` or `e<email>-<root>`; root = c<campaign> | r<reply> | g<gmailThread>.
const KEY_RE = /^(?:c\d+|e\S+)-[crg]\S+$/;
const KEY_MAX_LEN = 400;

export function isThreadKey(v: string): boolean {
	return v.length <= KEY_MAX_LEN && KEY_RE.test(v);
}

/** Validate the posted `key` values: 1–200 well-formed keys, de-duplicated. */
export function parseThreadKeys(raw: unknown[]): { ok: true; keys: string[] } | { ok: false; error: string } {
	const keys = [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))];
	if (!keys.length) return { ok: false, error: 'Select at least one conversation.' };
	if (keys.length > CONV_BULK_MAX) return { ok: false, error: `At most ${CONV_BULK_MAX} conversations at a time.` };
	if (keys.some((k) => !isThreadKey(k))) return { ok: false, error: 'Unknown conversation in the selection — reload and try again.' };
	return { ok: true, keys };
}

const actorLabel = (user: { github_login?: string | null; id?: number } | null | undefined) =>
	user?.github_login ? `@${user.github_login}` : user?.id != null ? `user:${user.id}` : null;

/** The threads for `keys` (the tab's list first, then one lookup per key not on it). */
async function resolveThreads(db: D1Database, keys: string[]): Promise<Conversation[]> {
	const listed = new Map((await listedThreads(db)).map((t) => [t.key, t]));
	const out: Conversation[] = [];
	for (const k of keys) {
		const t = listed.get(k) ?? (await conversationByKey(db, k));
		if (t) out.push(t);
	}
	return out;
}

export type BulkResult = { affected: number; skipped: number };

export async function archiveThreads(
	db: D1Database,
	keys: string[],
	user?: { github_login?: string | null; id?: number } | null
): Promise<BulkResult> {
	const threads = await resolveThreads(db, keys);
	if (threads.length) {
		const by = actorLabel(user);
		await db.batch(
			threads.map((t) =>
				db
					.prepare(
						`INSERT INTO conversation_state (thread_key, archived_at, archived_by, archived_last_at)
						 VALUES (?, datetime('now'), ?, ?)
						 ON CONFLICT(thread_key) DO UPDATE SET archived_at = excluded.archived_at,
						   archived_by = excluded.archived_by, archived_last_at = excluded.archived_last_at`
					)
					.bind(t.key, by, t.last_at)
			)
		);
	}
	return { affected: threads.length, skipped: keys.length - threads.length };
}

export async function unarchiveThreads(db: D1Database, keys: string[]): Promise<BulkResult> {
	const res = await db
		.prepare(
			`UPDATE conversation_state SET archived_at = NULL, archived_by = NULL, archived_last_at = NULL
			 WHERE archived_at IS NOT NULL AND thread_key IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(keys))
		.run();
	const n = res.meta.changes ?? 0;
	return { affected: n, skipped: keys.length - n };
}

/** Archive state of one thread, for the thread page. */
export async function threadArchiveState(
	db: D1Database,
	key: string
): Promise<{ archived_at: string | null; archived_last_at: string | null } | null> {
	return db
		.prepare('SELECT archived_at, archived_last_at FROM conversation_state WHERE thread_key = ?')
		.bind(key)
		.first<{ archived_at: string | null; archived_last_at: string | null }>();
}

export type DeleteResult = BulkResult & { replies: number; gmail: number; hiddenSends: number; hiddenGmail: number };

export async function deleteThreads(
	db: D1Database,
	keys: string[],
	user?: { github_login?: string | null; id?: number } | null,
	media?: R2Bucket | null
): Promise<DeleteResult> {
	const threads = await resolveThreads(db, keys);
	const replyIds: number[] = [];
	const mailIds: number[] = [];
	const sends: { id: number; key: string }[] = [];
	const mailKey = new Map<number, string>();
	for (const t of threads) {
		for (const m of t.messages) {
			if (m.source === 'gmail') {
				if (m.mail_message_id != null) {
					mailIds.push(m.mail_message_id);
					mailKey.set(m.mail_message_id, t.key);
				}
			} else if (m.dir === 'in' && m.reply_id != null) replyIds.push(m.reply_id);
			else if (m.dir === 'out' && m.recipient_id != null) sends.push({ id: m.recipient_id, key: t.key });
		}
	}

	// Direction comes from the row itself, not the thread view: only inbound Gmail messages are
	// deleted; the mailbox's own sends are send history and only get hidden.
	const mailRows = mailIds.length
		? (
				await db
					.prepare(
						`SELECT m.id, m.account_id, m.gmail_id, m.thread_id, m.direction, LOWER(a.email) AS mailbox
						 FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id
						 WHERE m.id IN (SELECT value FROM json_each(?))`
					)
					.bind(JSON.stringify(mailIds))
					.all<{ id: number; account_id: number; gmail_id: string; thread_id: number; direction: string; mailbox: string }>()
			).results
		: [];
	const gmail = mailRows.filter((g) => g.direction === 'in');
	const gmailOut = mailRows.filter((g) => g.direction !== 'in');

	const by = actorLabel(user);
	const stmts: D1PreparedStatement[] = [
		...gmail.map((g) =>
			db
				.prepare('INSERT OR IGNORE INTO conversation_deleted_gmail (mailbox, gmail_id, thread_key) VALUES (?, ?, ?)')
				.bind(g.mailbox, g.gmail_id, mailKey.get(g.id) ?? null)
		),
		...gmailOut.map((g) =>
			db
				.prepare('INSERT OR IGNORE INTO conversation_hidden_gmail (mailbox, gmail_id, thread_key) VALUES (?, ?, ?)')
				.bind(g.mailbox, g.gmail_id, mailKey.get(g.id) ?? null)
		),
		...sends.map((s) =>
			db.prepare('INSERT OR IGNORE INTO conversation_hidden_sends (recipient_id, thread_key) VALUES (?, ?)').bind(s.id, s.key)
		),
		...threads.map((t) =>
			db
				.prepare(
					`INSERT INTO conversation_state (thread_key, deleted_at, deleted_by) VALUES (?, datetime('now'), ?)
					 ON CONFLICT(thread_key) DO UPDATE SET deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
					   archived_at = NULL, archived_by = NULL, archived_last_at = NULL`
				)
				.bind(t.key, by)
		)
	];
	if (replyIds.length) {
		stmts.push(db.prepare('DELETE FROM replies WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(replyIds)));
	}
	if (gmail.length) {
		const ids = JSON.stringify(gmail.map((g) => g.id));
		const threadIds = JSON.stringify([...new Set(gmail.map((g) => g.thread_id))]);
		stmts.push(
			db.prepare('DELETE FROM mail_messages WHERE id IN (SELECT value FROM json_each(?))').bind(ids),
			// A Gmail thread with nothing left in it goes too (it's only a grouping row).
			db
				.prepare(
					`DELETE FROM mail_threads WHERE id IN (SELECT value FROM json_each(?))
					 AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.id)`
				)
				.bind(threadIds)
		);
	}
	if (stmts.length) await db.batch(stmts);

	// Cached bodies (mail-body.ts) — best-effort, never fails the delete.
	if (media && gmail.length) {
		try {
			await media.delete(gmail.map((g) => bodyKey(g.account_id, g.gmail_id)));
		} catch {
			/* ignore */
		}
	}

	return {
		affected: threads.length,
		skipped: keys.length - threads.length,
		replies: replyIds.length,
		gmail: gmail.length,
		hiddenSends: sends.length,
		hiddenGmail: gmailOut.length
	};
}
