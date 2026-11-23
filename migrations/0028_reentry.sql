-- Re-entry policy + completion timestamps for automations.
--
-- `automations.reentry` decides whether a contact can go through a flow again:
--   'once'     (default) — any prior pass (any status) blocks re-enrollment (today's behavior)
--   'multiple' — a contact can re-enter after a pass ends; only one ACTIVE pass at a time
--
-- To support multiple passes, automation_enrollments loses its hard
-- UNIQUE(automation_id, contact_id) constraint (table rebuild — SQLite can't drop a
-- constraint in place) and gains `ended_at` (when the pass reached a terminal status).
-- A partial unique index keeps "one active pass per contact per automation" while
-- history rows accumulate. NOTE (FEATURE_CHECKLIST §1): any ON CONFLICT targeting the
-- partial index must repeat its WHERE predicate.

-- automation_branch_hits references automation_enrollments — defer FK checks across
-- the drop/rename so the rebuild doesn't trip them.
PRAGMA defer_foreign_keys = true;

ALTER TABLE automations ADD COLUMN reentry TEXT NOT NULL DEFAULT 'once'; -- once | multiple

CREATE TABLE automation_enrollments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',          -- active | completed | cancelled | failed
  next_run_at TEXT,                               -- UTC; when the current step is due (NULL when not active)
  attempts INTEGER NOT NULL DEFAULT 0,            -- transient-failure retries for the current step
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_step_at TEXT,
  current_step_id INTEGER REFERENCES automation_steps(id), -- #74: id pointer
  last_error TEXT,                                -- #80: most recent send failure detail
  ended_at TEXT                                   -- UTC; when the pass reached a terminal status
);

INSERT INTO automation_enrollments_new
  (id, automation_id, contact_id, status, next_run_at, attempts, enrolled_at, last_step_at, current_step_id, last_error, ended_at)
SELECT id, automation_id, contact_id, status, next_run_at, attempts, enrolled_at, last_step_at, current_step_id, last_error,
       CASE WHEN status IN ('completed', 'cancelled', 'failed')
            THEN COALESCE(last_step_at, enrolled_at)
            ELSE NULL END
FROM automation_enrollments;

DROP TABLE automation_enrollments;
ALTER TABLE automation_enrollments_new RENAME TO automation_enrollments;

-- The engine's hot query: active enrollments whose next step is due.
CREATE INDEX idx_enrollments_due ON automation_enrollments(status, next_run_at);
-- One ACTIVE pass per contact per automation; terminal passes accumulate as history.
CREATE UNIQUE INDEX ux_enrollments_active ON automation_enrollments(automation_id, contact_id) WHERE status = 'active';
-- Contact-page lookups (enrollment history per contact).
CREATE INDEX idx_enrollments_contact ON automation_enrollments(contact_id);
