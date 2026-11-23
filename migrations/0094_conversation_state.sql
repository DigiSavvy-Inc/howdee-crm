-- #379: archive / delete conversations. Additive only. (0093 is reserved for another branch.)
--
-- Conversations have no table of their own (src/lib/server/conversations.ts derives them
-- from recipients + campaigns, replies and mail_messages), so the state lives here, keyed
-- by the thread key `<party>-<root>`. The root is the thread's first message (campaign,
-- reply or Gmail thread id), so the key does not change when new messages arrive; when it
-- does change (an older message synced in later, the root deleted) the state simply stops
-- applying and the thread shows again — the safe direction.

-- One row per thread that was archived or deleted.
--   archived_at       UTC 'YYYY-MM-DD HH:MM:SS'; NULL = not archived
--   archived_by       '@login' of the user who archived it
--   archived_last_at  the thread's last-activity time when archived — an inbound message
--                     newer than this brings the thread back (read-time, like Gmail)
--   deleted_at / deleted_by  audit of a delete (admin only)
CREATE TABLE conversation_state (
  thread_key TEXT PRIMARY KEY,
  archived_at TEXT,
  archived_by TEXT,
  archived_last_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT
);

-- Our sends from a deleted thread: hidden from Conversations, never deleted or altered
-- (recipients / campaigns / events are campaign history and stats). No FK on purpose.
CREATE TABLE conversation_hidden_sends (
  recipient_id INTEGER PRIMARY KEY,
  thread_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Synced Gmail messages deleted from a thread: the Gmail sync never stores these again.
-- Keyed by the mailbox address (lowercased), not mail_accounts.id, so a disconnect +
-- reconnect doesn't bring them back.
CREATE TABLE conversation_deleted_gmail (
  mailbox TEXT NOT NULL,
  gmail_id TEXT NOT NULL,
  thread_key TEXT,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox, gmail_id)
);

-- Synced Gmail messages the mailbox SENT (direction 'out') in a deleted thread: hidden from
-- Conversations, never deleted (they are send history, like conversation_hidden_sends).
-- Keyed like conversation_deleted_gmail (mailbox lowercased + Gmail id), so a re-sync or a
-- disconnect + reconnect that stores the message again still finds it hidden.
CREATE TABLE conversation_hidden_gmail (
  mailbox TEXT NOT NULL,
  gmail_id TEXT NOT NULL,
  thread_key TEXT,
  hidden_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox, gmail_id)
);
