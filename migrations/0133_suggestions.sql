-- #712 (Suggestions 1/5, epic #711): who to follow up with and what to send next.
--
-- One row per suggestion, built by the rules in src/lib/server/suggestions/ on the heartbeat
-- (no model call in this phase). Each row keeps the rule that made it, the evidence it is
-- built on (JSON list of { id, type, label, url, at, ref?, billing? }) and plain template
-- wording, so the feature works with no AI key. Spec: docs/suggestions.md.
--
--   kind          follow_up | campaign | marketing
--   subject_type  contact | company | deal | group  (+ subject_id; deal = pipeline_cards.id,
--                 group = lists.id). No FKs on purpose: a vanished subject is closed by the
--                 next rules pass, and a closed row is kept as history until pruned.
--   input_hash    SHA-256 of the evidence identities (never of elapsed time). A change is
--                 "new evidence": it refreshes an open row and ends a Done / Dismiss cooldown.
--   action        JSON { type, label, url, more?: [...] } — only a page to open, never a send.
--   status        open | done | dismissed | snoozed; snooze_until for snoozed.
--   closed_by     rules (the condition went away) | user | api — only user / api closes start
--                 the cooldown. closed_by_user_id = the person, NULL otherwise.
--   model / cost_micros / draft_opening — written by the AI layer (#713); NULL / 0 here.
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('follow_up', 'campaign', 'marketing')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('contact', 'company', 'deal', 'group')),
  subject_id INTEGER NOT NULL,
  subject_label TEXT,
  rule TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '{}',
  draft_opening TEXT,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed', 'snoozed')),
  snooze_until TEXT,
  dismiss_reason TEXT,
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ('rules', 'user', 'api')),
  closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT,
  since_at TEXT,
  model TEXT,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One open (or snoozed) suggestion per subject and rule.
CREATE UNIQUE INDEX IF NOT EXISTS ux_suggestions_live
  ON suggestions (subject_type, subject_id, rule) WHERE status IN ('open', 'snoozed');
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions (status, kind);
CREATE INDEX IF NOT EXISTS idx_suggestions_subject ON suggestions (subject_type, subject_id, rule, closed_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_assigned ON suggestions (assigned_user_id) WHERE status = 'open';
