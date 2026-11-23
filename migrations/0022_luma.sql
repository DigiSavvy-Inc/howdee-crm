-- #70 Luma webhook integration: a per-delivery log + idempotency key for inbound Luma
-- guest webhooks. `webhook_id` is Luma's `Webhook-Id` header — UNIQUE so retries (Luma
-- redelivers 3x with backoff) are deduped by INSERT OR IGNORE (no insert = already handled).
CREATE TABLE luma_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT UNIQUE,                 -- Luma Webhook-Id header (idempotency key)
  type TEXT,                              -- payload type, e.g. guest.registered / guest.updated
  email TEXT,                             -- the guest email (if any)
  status TEXT NOT NULL,                   -- added | updated | duplicate | rejected | ignored
  detail TEXT,                            -- reason / summary (tags applied, why rejected)
  payload TEXT,                           -- truncated JSON of what was received
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_luma_events_created ON luma_events(created_at DESC);
