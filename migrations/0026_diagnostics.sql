-- #80: automation diagnostics — persist per-tick engine summaries and failure detail.
CREATE TABLE tick_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  advanced INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  retried INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  tagged INTEGER NOT NULL DEFAULT 0,
  gated INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE automation_enrollments ADD COLUMN last_error TEXT; -- most recent send failure detail
