-- #26: tiny key/value store for app health state. First use: the automation tick
-- endpoint records when it last ran, so the dashboard can detect a dead heartbeat.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
