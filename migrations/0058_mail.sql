-- #158: Gmail connect + sync. One row per connected mailbox; the refresh token is sealed
-- with MAIL_TOKEN_KEY (AES-256-GCM, src/lib/server/crypto-box.ts) — never stored in clear.
--
-- Sync state machine (src/lib/server/mail-sync.ts):
--   history_id NULL  → (re)listing: users.messages.list with `list_query` (1-year backfill, or
--                      the 30-day re-list after a too-old historyId), resuming at
--                      `list_page_token`. When the last page is done, history_id becomes
--                      `list_start_history_id` (the mailbox historyId captured at list start).
--   history_id set   → incremental: users.history.list from history_id, resuming a paged run
--                      at `history_page_token`.
CREATE TABLE mail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'gmail',
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  refresh_blob TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  history_id TEXT,
  history_page_token TEXT,
  list_query TEXT,
  list_page_token TEXT,
  list_start_history_id TEXT,
  scanned INTEGER NOT NULL DEFAULT 0,      -- messages looked at in the current (re)list
  backoff_until TEXT,                      -- ISO; set after a 429 / rate-limit 403
  backoff_count INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_error TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mail_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  subject TEXT,
  last_message_at TEXT,
  UNIQUE (account_id, gmail_thread_id)
);

-- Only messages with at least one participant (From/To/Cc, the mailbox's own address
-- excluded) matching a contact are stored. Metadata only — bodies are fetched on demand and
-- cached in R2 under mail/<account>/<gmail_id>.txt.
CREATE TABLE mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  gmail_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  message_id_header TEXT,   -- bare, no angle brackets
  in_reply_to TEXT,         -- bare, no angle brackets
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')), -- out = sent by the mailbox
  from_email TEXT,
  from_name TEXT,
  participants TEXT NOT NULL DEFAULT '[]', -- JSON array of lowercased From/To/Cc addresses
  subject TEXT,
  snippet TEXT,
  sent_at TEXT NOT NULL,    -- UTC 'YYYY-MM-DD HH:MM:SS' (Gmail internalDate)
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, gmail_id)
);
CREATE INDEX ix_mail_messages_thread ON mail_messages (thread_id);

CREATE TABLE mail_message_contacts (
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, contact_id)
);
CREATE INDEX ix_mail_message_contacts_contact ON mail_message_contacts (contact_id);
