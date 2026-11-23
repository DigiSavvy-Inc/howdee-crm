-- #48 follow-up: per-request log for the form-intake webhook, so the operator can see
-- exactly what each key received and how it was handled (debugging form integrations).
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER REFERENCES webhook_keys(id) ON DELETE SET NULL,  -- null = legacy env INGEST_KEY
  email TEXT,                                                     -- the submitted email (if any)
  status TEXT NOT NULL,                                           -- added | updated | rejected | ignored
  detail TEXT,                                                    -- reason (e.g. "invalid email", "honeypot")
  payload TEXT,                                                   -- truncated JSON of what was received
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_events_created ON webhook_events(created_at DESC);
CREATE INDEX idx_webhook_events_key ON webhook_events(key_id);
