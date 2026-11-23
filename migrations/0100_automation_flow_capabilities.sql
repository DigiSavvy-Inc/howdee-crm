-- #397: automation flow capabilities. Additive only.

-- Exit conditions (goals): JSON list of rules checked before every step of an active pass,
-- e.g. [{"kind":"reply"},{"kind":"tag","tag":"customer"},{"kind":"segment","list_id":4},
-- {"kind":"stage","stage_id":2}]. NULL / [] = no goals.
ALTER TABLE automations ADD COLUMN exit_rules TEXT;

-- Why a pass completed early: 'goal:<kind>' when an exit rule matched. NULL otherwise.
ALTER TABLE automation_enrollments ADD COLUMN completed_reason TEXT;

-- Wait-until steps (type = 'wait'): JSON config, e.g. {"mode":"event","event":"clicked",
-- "timeout_seconds":259200} | {"mode":"date","at":"2026-11-02T09:00"} |
-- {"mode":"date","day":"weekday","time":"09:00"} | {"mode":"window","start":"09:00","end":"17:00","days":"weekdays"}.
-- An 'event' wait has the branch lanes: 'yes' = the event happened, 'no' = timed out.
ALTER TABLE automation_steps ADD COLUMN wait_config TEXT;

-- When the pass started waiting at its current wait step (cleared whenever the pointer moves).
ALTER TABLE automation_enrollments ADD COLUMN wait_started_at TEXT;

-- Pause with reason + status history.
CREATE TABLE automation_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_automation_status_history ON automation_status_history(automation_id, id);

-- Trigger events that arrived while the automation was paused: one row per contact (the
-- first time it triggered), offered for enrollment on resume — never enrolled automatically.
CREATE TABLE automation_pending_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (automation_id, contact_id)
);

-- Per-pass timeline: every step a pass reached and what happened there, appended (never
-- overwritten). step_id has no FK on purpose — the history outlives a deleted step.
CREATE TABLE automation_enrollment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
  automation_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  step_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrollment_events_enrollment ON automation_enrollment_events(enrollment_id, id);
CREATE INDEX idx_enrollment_events_funnel ON automation_enrollment_events(automation_id, step_id, kind, at);
CREATE INDEX idx_enrollment_events_contact ON automation_enrollment_events(contact_id, kind, at);
