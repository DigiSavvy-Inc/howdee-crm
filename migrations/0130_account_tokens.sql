-- #639: invitations, password reset and email verification.
--
-- account_tokens: one row per emailed link. The token (32 random bytes, base64url) is only ever
-- in the link; this table keeps its SHA-256 hex (`token_hash`). Single use (`used_at`), expiring
-- (`expires_at`: invite 7 days, reset 1 hour, verify 24 hours). Issuing a new token of a kind
-- stamps `cancelled_at` on the older unused ones for that user or address; revoking an invite
-- does the same. `user_id` is NULL for an invite (no user yet); `role` is set only for invites.
CREATE TABLE account_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset', 'verify')),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT CHECK (role IS NULL OR role IN ('admin', 'member')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX idx_account_tokens_email_kind ON account_tokens(email, kind);
CREATE INDEX idx_account_tokens_user_kind ON account_tokens(user_id, kind);
CREATE INDEX idx_account_tokens_kind_open ON account_tokens(kind, used_at, cancelled_at);

-- Audit: kind, user id, time and outcome only — never a token, a link, an address or a password.
CREATE TABLE account_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  user_id INTEGER,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_account_token_events_at ON account_token_events(at);

-- NULL = the address in users.email hasn't been confirmed. Existing users count as verified.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
UPDATE users SET email_verified_at = datetime('now');
