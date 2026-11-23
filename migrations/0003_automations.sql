-- Automated email flows (drip sequences). See epic #1 / issue #3.
--
-- An automation is a linear, ordered sequence of steps. Each step is a wait
-- (delay_before_seconds) followed by an email. Contacts are *enrolled*, then a
-- tick-based engine (#4) walks each enrollment through the steps over time,
-- creating one campaigns row per step (lazily, on first send) so the existing
-- campaign stats / webhook MessageID attribution / contact history work for free.

CREATE TABLE automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | active | paused
  trigger_type TEXT NOT NULL DEFAULT 'manual',   -- list_added | manual
  trigger_list_id INTEGER REFERENCES lists(id),  -- list/segment that enrolls (list_added)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE automation_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,                      -- 0-based order within the automation
  delay_before_seconds INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  body_md TEXT NOT NULL,
  preheader TEXT,
  from_email TEXT NOT NULL
);
CREATE INDEX idx_steps_automation ON automation_steps(automation_id, position);

CREATE TABLE automation_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',          -- active | completed | cancelled | failed
  current_step INTEGER NOT NULL DEFAULT 0,        -- next step position to send
  next_run_at TEXT,                               -- UTC; when current_step is due (NULL when not active)
  attempts INTEGER NOT NULL DEFAULT 0,            -- transient-failure retries for the current step
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_step_at TEXT,
  UNIQUE(automation_id, contact_id)               -- one enrollment per contact per automation
);
-- The engine's hot query: active enrollments whose next step is due.
CREATE INDEX idx_enrollments_due ON automation_enrollments(status, next_run_at);

-- Attribute per-step sends back to the automation. One campaigns row per
-- (automation_id, automation_step_id); recipients accumulate as contacts reach it.
ALTER TABLE campaigns ADD COLUMN automation_id INTEGER REFERENCES automations(id);
ALTER TABLE campaigns ADD COLUMN automation_step_id INTEGER REFERENCES automation_steps(id);
