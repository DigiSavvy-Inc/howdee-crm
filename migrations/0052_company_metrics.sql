-- #168: Timing project ↔ company link, plus the per-company integration rollup.
-- company_metrics is shared by Timing (#168) and GitHub (#169); both column sets are created
-- here so neither issue has to ALTER it. All values are derived (re-synced from the APIs) —
-- safe to drop and rebuild.
ALTER TABLE companies ADD COLUMN timing_project_id TEXT;   -- Timing project ref, e.g. "/projects/123"
ALTER TABLE companies ADD COLUMN timing_project_name TEXT; -- display path, e.g. "Clients › Acme"

CREATE TABLE company_metrics (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Timing (#168)
  hours_7d REAL,
  hours_30d REAL,
  hours_90d REAL,
  hours_total REAL,
  last_tracked_at TEXT,
  last_tracked_title TEXT,
  timing_synced_at TEXT,
  -- GitHub (#169)
  issues_open INTEGER,
  issues_closed INTEGER,
  issues_opened_30d INTEGER,
  issues_closed_30d INTEGER,
  last_issue_at TEXT,
  recent_issues TEXT,
  github_synced_at TEXT
);
