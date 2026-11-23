-- #48: multiple named, revocable keys for the form-intake webhook (/api/ingest).
-- The legacy INGEST_KEY env secret still works; these are additional keys managed in-app.
-- token is the secret that goes in the webhook URL (?key=...). Stored plaintext so the URL
-- stays re-viewable — single-tenant app, D1 access already implies full access.
CREATE TABLE webhook_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,                              -- human name, e.g. "WS Form — contact page"
  token TEXT NOT NULL UNIQUE,                       -- the ?key= secret
  default_list TEXT,                               -- optional: list to add contacts to (created if new)
  source TEXT,                                     -- optional: stamped on contacts.source
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,                               -- bumped on each accepted POST
  request_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT                                  -- NULL = active
);
CREATE INDEX idx_webhook_keys_token ON webhook_keys(token);
