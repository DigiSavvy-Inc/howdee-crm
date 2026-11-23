-- #71: external Data API keys — bearer tokens that let other apps read/write this app's
-- data via /api/v1/*. Distinct from webhook_keys (#48), which gate INBOUND form intake at
-- /api/ingest and are stored plaintext (pasteable URLs). These are OUTBOUND data-access
-- keys: the full token is shown ONCE at creation and only its SHA-256 hash is stored, so a
-- DB leak can't reveal a working key. The UI identifies a key by prefix + last4.
-- scope gates writes: 'read' = GET only; 'read_write' = full CRUD.
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,                              -- human name, e.g. "Dashboard app (read)"
  token_hash TEXT NOT NULL UNIQUE,                 -- SHA-256 hex of the full token; the token itself is never stored
  token_prefix TEXT NOT NULL,                      -- e.g. "dk_live_a1b2c3" — shown to identify the key
  token_last4 TEXT NOT NULL,                       -- last 4 chars, shown as dk_live_a1b2c3…wxyz
  scope TEXT NOT NULL DEFAULT 'read',              -- 'read' | 'read_write'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,                               -- bumped on each authenticated request
  request_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT                                  -- NULL = active
);
CREATE INDEX idx_api_keys_token_hash ON api_keys(token_hash);
