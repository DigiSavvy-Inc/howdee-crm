-- #510: optional double opt-in. A pending contact has subscribed = 0 and confirm_pending = 1,
-- so no send path reaches it; the memberships the sign-up asked for wait in
-- subscription_confirmations.intent (JSON) until the confirm link's button is pressed.
-- (Forms core, #508, takes 0114 — this is the next free number.)
ALTER TABLE contacts ADD COLUMN confirm_pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE subscription_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 hex of the 32-byte token; the token itself is never stored
  source TEXT,                          -- ingest | upsert | form | api | test …
  intent TEXT,                          -- JSON: lists, tags, topics, fields, enroll, source, resubscribe
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  expired_at TEXT,                      -- stamped by the heartbeat once past expires_at (contact stays pending)
  cancelled_at TEXT,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT
);
CREATE INDEX idx_subscription_confirmations_contact ON subscription_confirmations(contact_id);
CREATE INDEX idx_subscription_confirmations_open ON subscription_confirmations(expires_at) WHERE confirmed_at IS NULL AND expired_at IS NULL;
CREATE INDEX idx_contacts_confirm_pending ON contacts(confirm_pending) WHERE confirm_pending = 1;

-- Settings → Webhooks: "Require confirmation" per key.
ALTER TABLE webhook_keys ADD COLUMN require_confirm INTEGER NOT NULL DEFAULT 0;
