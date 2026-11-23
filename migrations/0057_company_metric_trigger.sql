-- #170: "Company metric crossed" automation trigger (Integrations 5/5).
-- trigger_type = 'company_metric' reads these three columns; NULL for every other trigger.
ALTER TABLE automations ADD COLUMN trigger_metric TEXT;      -- a numeric company_metrics column, e.g. 'issues_open'
ALTER TABLE automations ADD COLUMN trigger_direction TEXT;   -- 'above' | 'below'
ALTER TABLE automations ADD COLUMN trigger_threshold REAL;

-- The company_metrics values as of the end of the previous integration sync, so a crossing
-- ("was ≤ 10, now > 10") is detected once, not on every sync. JSON object keyed by metric.
-- Derived — safe to drop; the next sync re-baselines (no crossings fire on a missing row).
CREATE TABLE company_metrics_prev (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  metrics TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
