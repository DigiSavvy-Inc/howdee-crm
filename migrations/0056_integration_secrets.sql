-- #175: provider tokens entered in Settings → Integrations, encrypted at rest with
-- MAIL_TOKEN_KEY (AES-256-GCM, see src/lib/server/crypto-box.ts). `blob` is `v1.<base64url>`;
-- `last4` is the only part of the token the UI ever shows. A row here wins over the Worker
-- secret (TIMING_API_TOKEN / GITHUB_TOKEN), which stays the fallback.
CREATE TABLE integration_secrets (
  provider TEXT PRIMARY KEY,
  blob TEXT NOT NULL,
  last4 TEXT NOT NULL,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at TEXT NOT NULL
);

-- Token set/remove is audited in integration_syncs with trigger='token' (detail = action +
-- last4 only). SQLite can't alter a CHECK, so rebuild the table with the wider constraint.
CREATE TABLE integration_syncs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'token')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok INTEGER,
  detail TEXT
);
INSERT INTO integration_syncs_new (id, provider, trigger, started_at, finished_at, ok, detail)
  SELECT id, provider, trigger, started_at, finished_at, ok, detail FROM integration_syncs;
DROP TABLE integration_syncs;
ALTER TABLE integration_syncs_new RENAME TO integration_syncs;
CREATE INDEX ix_integration_syncs_provider ON integration_syncs (provider, id DESC);
