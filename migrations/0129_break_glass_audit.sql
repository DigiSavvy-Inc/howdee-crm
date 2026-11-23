-- #533: audit trail for the break-glass sign-in (the shared APP_PASSWORD on /login).
--
-- One row per break-glass attempt: when, a hash of the caller's IP (first 16 hex of
-- SHA-256(ip + SESSION_SECRET), never the raw IP), the outcome and, on success, the admin the
-- session was issued for. The posted password is never stored. Shown to admins on
-- Settings → Users; pruned after 365 days by the heartbeat (pruneLoginAttempts).
--
-- outcome: ok        signed in as user_id
--          failed    wrong password
--          locked    refused by the lockout before the password was checked
--          no_admin  right password, but no active admin to sign in as

CREATE TABLE IF NOT EXISTS break_glass_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'locked', 'no_admin')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_break_glass_events_at ON break_glass_events (at);
