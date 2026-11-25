-- #746: per-user "sessions valid after" stamp ('YYYY-MM-DD HH:MM:SS.SSS' UTC, the same format
-- as password_set_at). hooks.server.ts refuses a session cookie issued before it (or before
-- password_set_at, whichever is later). It is moved forward on sign-out (every device of that
-- user), disable, enable and role change. NULL = no extra limit.
ALTER TABLE users ADD COLUMN sessions_valid_after TEXT;
