-- #467 (Scoring 2/3, epic #465): scores in automations.
--
-- score_change_events  written by the scoring engine's cache step (computePairs) when a
--                      contact's value or band changes for a score that an active or paused
--                      `score_changed` automation watches. The heartbeat drains it right
--                      after runScoringJob (src/lib/server/score-trigger.ts) into enroll() /
--                      pending triggers, then deletes the rows. The engine itself never
--                      imports the automation engine (tests/mcp.test.ts, ai-no-send).
CREATE TABLE score_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  score_id INTEGER NOT NULL,
  old_value INTEGER NOT NULL,
  new_value INTEGER NOT NULL,
  old_band TEXT,
  new_band TEXT,
  created_at TEXT NOT NULL
);

-- The "Adjust score" action step (action_kind = 'adjust_score'): JSON
-- { score_id, points, expires_days } (expires_days NULL = never).
ALTER TABLE automation_steps ADD COLUMN action_config TEXT;
