-- #211: per-user passwords as a second credential on the same users rows (GitHub keeps working).
-- password_hash NULL = no password (GitHub-only). password_set_at is the credential-change stamp
-- ('YYYY-MM-DD HH:MM:SS.SSS' UTC): sessions issued before it are rejected by hooks.server.ts.
-- must_change_password = 1 after an admin generates one; every route but /account/password is
-- blocked until the user picks their own. email is optional (future reset mail).
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_set_at TEXT;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;

-- Every username + password sign-in attempt (ok 1/0). Lockout reads the last 15 minutes;
-- the heartbeat prunes rows older than 30 days.
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  ok INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts_username_at ON login_attempts(username, at);
CREATE INDEX idx_login_attempts_ip_at ON login_attempts(ip, at);
