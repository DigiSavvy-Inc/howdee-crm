-- #167: Settings → Integrations. One row per provider sync run (cron or manual).
-- `detail` is JSON: { counts: {…}, errors: [ … ] } — or { error } when the run threw.
-- Per-provider cron throttle, lease lock and last probe live in app_state
-- (integration_cron_at:<provider>, integration_lock:<provider>, integration_probe:<provider>).
CREATE TABLE integration_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok INTEGER,
  detail TEXT
);

CREATE INDEX ix_integration_syncs_provider ON integration_syncs (provider, id DESC);
