-- #303 (part of #71): scheduled assistant jobs. A job is a saved prompt that the heartbeat
-- tick runs unattended with the read-only tools, then POSTs the result to a webhook.
-- Times are UTC 'YYYY-MM-DD HH:MM:SS'; `next_run_at` is computed in the job's `timezone`.
-- `webhook_secret` is sealed with MAIL_TOKEN_KEY (crypto-box `v1.` blob), never plaintext;
-- `webhook_secret_last4` is the only part the UI shows.
CREATE TABLE ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('hourly', 'daily', 'weekly', 'monthly')),
  schedule_time TEXT NOT NULL DEFAULT '08:00', -- 'HH:MM' local; hourly uses the minute only
  schedule_dow INTEGER,                         -- weekly: 0 = Sunday … 6 = Saturday
  schedule_dom INTEGER,                         -- monthly: 1–31 (a short month runs on its last day)
  timezone TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  webhook_secret TEXT,
  webhook_secret_last4 TEXT,
  payload_format TEXT NOT NULL DEFAULT 'json' CHECK (payload_format IN ('json', 'slack')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_jobs_due ON ai_jobs(enabled, next_run_at);

-- One row per run (scheduled or Run now). `user_id` = the job's creator at run time: the
-- run's cost counts against that user's daily cap and the app's monthly cap, and the row
-- outlives the job (job_id SET NULL) so deleting a job doesn't hand the spend back.
CREATE TABLE ai_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES ai_jobs(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  model TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  output_markdown TEXT,
  webhook_status INTEGER,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_job_runs_job ON ai_job_runs(job_id, id);
CREATE INDEX idx_ai_job_runs_started ON ai_job_runs(started_at);
