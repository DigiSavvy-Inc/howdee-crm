-- #305: post-send deliverability alerts. One row per check the heartbeat ran: a broadcast
-- 2 h and 24 h after it went out (check_key '2h' / '24h'), an automation once a day over the
-- last 7 days (check_key '7d:<YYYY-MM-DD>'). The UNIQUE key is the exactly-once claim: the
-- tick INSERT OR IGNOREs a 'pending' row and only the winner computes. No FK on ref_id on
-- purpose: the history outlives a deleted campaign or automation.
CREATE TABLE deliverability_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('campaign', 'automation')),
  ref_id INTEGER NOT NULL,
  check_key TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'pending' CHECK (level IN ('pending', 'ok', 'warning', 'critical')),
  sent INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  hard_bounces INTEGER NOT NULL DEFAULT 0,
  complaints INTEGER NOT NULL DEFAULT 0,
  reasons TEXT,                 -- JSON [{ reason, n }], top bounce reasons
  webhook_status INTEGER,
  webhook_error TEXT,
  held_count INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at TEXT,
  dismissed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (scope, ref_id, check_key)
);
CREATE INDEX idx_deliverability_checks_level ON deliverability_checks(level, checked_at);

-- A scheduled broadcast held by a critical alert (hold only, never cancelled): the scheduler
-- skips it while held_at is set; an admin's Release clears both columns.
ALTER TABLE campaigns ADD COLUMN held_at TEXT;
ALTER TABLE campaigns ADD COLUMN held_check_id INTEGER;
