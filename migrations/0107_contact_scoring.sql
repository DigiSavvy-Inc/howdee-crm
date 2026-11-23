-- #466 (Scoring 1/3, epic #465): named contact scores made of point rules.
--
-- score_defs     one score (name, slug, decay mode, optional bands)
-- score_rules    its point rules: `event` rules award points per source row (an open, a
--                click, a reply, a form submit, a site visit, …), `condition` rules hold
--                points while the contact matches a segment rule set
-- score_points   the ledger — one row per award (UNIQUE per score × rule × contact × source
--                row, so replaying history never double-counts); expired rows are kept and
--                ignored by the cache
-- contact_scores the cache: value + band per contact × score, `dirty` = needs recompute
--
-- The engine (src/lib/server/scoring/engine.ts, `runScoringJob`) runs on the heartbeat tick.
-- Engagement (contact_engagement, #111) is separate and untouched.

CREATE TABLE score_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  decay_mode TEXT NOT NULL DEFAULT 'expire' CHECK (decay_mode IN ('none','expire','half_life')),
  half_life_days INTEGER,                       -- only for half_life
  bands TEXT,                                   -- JSON [{label, min}] highest min first, or NULL
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE score_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id INTEGER NOT NULL REFERENCES score_defs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event','condition')),
  label TEXT NOT NULL DEFAULT '',
  event_type TEXT,                              -- event rules: see EVENT_TYPES in src/lib/scoring.ts
  filter TEXT,                                  -- JSON, event rules only
  rules TEXT,                                   -- JSON segment rule set, condition rules only
  points INTEGER NOT NULL,
  expires_days INTEGER,                         -- NULL = permanent (event rules, expire mode)
  max_per_day INTEGER,                          -- NULL = unlimited (event rules)
  once INTEGER NOT NULL DEFAULT 0,              -- event rules: first match per contact only
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX score_rules_score ON score_rules(score_id, position);
CREATE TABLE score_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id INTEGER NOT NULL REFERENCES score_defs(id) ON DELETE CASCADE,
  rule_id INTEGER REFERENCES score_rules(id) ON DELETE SET NULL,
  contact_id INTEGER NOT NULL,
  points INTEGER NOT NULL,
  source_type TEXT NOT NULL,                    -- 'events','replies','webhook_events','site_events','pipeline_history','automation_enrollment_events','list_members','condition','manual','automation'
  source_id TEXT NOT NULL,                      -- row id of the source, rule id for condition rows, free text for manual
  earned_at TEXT NOT NULL,
  expires_at TEXT,                              -- NULL = never
  note TEXT
);
CREATE UNIQUE INDEX score_points_once ON score_points(score_id, rule_id, contact_id, source_type, source_id);
CREATE INDEX score_points_contact ON score_points(contact_id, score_id, earned_at DESC);
CREATE INDEX score_points_expiry ON score_points(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE contact_scores (
  contact_id INTEGER NOT NULL,
  score_id INTEGER NOT NULL REFERENCES score_defs(id) ON DELETE CASCADE,
  value INTEGER NOT NULL DEFAULT 0,
  band TEXT,
  prev_value INTEGER,
  changed_at TEXT,
  updated_at TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contact_id, score_id)
);
CREATE INDEX contact_scores_score_value ON contact_scores(score_id, value DESC);
CREATE INDEX contact_scores_dirty ON contact_scores(score_id, dirty) WHERE dirty = 1;

-- Defaults (#465). The first heartbeat after this migration replays 365 days of history
-- into both (app_state `scoring_seeded_rebuild`).

INSERT INTO score_defs (name, slug, description, status, decay_mode, half_life_days, bands, position, is_default)
VALUES (
  'Lead score', 'lead-score',
  'How sales-ready a contact looks: recent opens, clicks, replies, form submits, site visits and pipeline moves. Most points expire, so it reflects the last few months.',
  'active', 'expire', NULL,
  '[{"label":"Sales-ready","min":50},{"label":"Warm","min":20},{"label":"Cool","min":1}]',
  0, 1
);
INSERT INTO score_defs (name, slug, description, status, decay_mode, half_life_days, bands, position, is_default)
VALUES (
  'Likely to churn', 'likely-to-churn',
  'Warning signs that a contact is drifting away: a cold engagement tier, no opens in 60 days, bounces and unsubscribes. Recent clicks and replies pull it back down.',
  'active', 'expire', NULL,
  '[{"label":"High risk","min":50},{"label":"At risk","min":25},{"label":"Low risk","min":0}]',
  1, 1
);

-- Lead score rules.
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Opened an email', 'email_open', NULL, NULL, 1, 30, 3, 0, 0 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Clicked a link in an email', 'email_click', NULL, NULL, 5, 60, 5, 0, 1 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Replied to an email', 'email_reply', NULL, NULL, 15, 90, NULL, 0, 2 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Submitted a form', 'form_submit', NULL, NULL, 20, 180, NULL, 0, 3 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Viewed a page on the site', 'site_pageview', NULL, NULL, 1, 30, 10, 0, 4 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Did a site event', 'site_event', NULL, NULL, 5, 60, NULL, 0, 5 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Moved to a pipeline stage', 'pipeline_stage_entered', NULL, NULL, 10, 180, NULL, 0, 6 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Unsubscribed', 'unsubscribe', NULL, NULL, -50, NULL, NULL, 0, 7 FROM score_defs WHERE slug = 'lead-score';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Marked an email as spam', 'email_spam', NULL, NULL, -100, NULL, NULL, 0, 8 FROM score_defs WHERE slug = 'lead-score';

-- Likely to churn rules. Condition rules use the segment vocabulary (RULE_KINDS):
-- `engagement_tier` is cold, and `last_open_within_days` with op `not` (no open in 60 days —
-- also true for contacts who never opened).
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'condition', 'Engagement tier is Cold', NULL, NULL,
  '{"match":"all","rules":[{"field":"engagement_tier","op":"is","value":"cold"}]}', 30, NULL, NULL, 0, 0
FROM score_defs WHERE slug = 'likely-to-churn';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'condition', 'No opens in the last 60 days', NULL, NULL,
  '{"match":"all","rules":[{"field":"last_open_within_days","op":"not","value":"60"}]}', 30, NULL, NULL, 0, 1
FROM score_defs WHERE slug = 'likely-to-churn';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Hard bounce', 'email_bounce', NULL, NULL, 25, 180, NULL, 0, 2 FROM score_defs WHERE slug = 'likely-to-churn';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Unsubscribed', 'unsubscribe', NULL, NULL, 50, NULL, NULL, 0, 3 FROM score_defs WHERE slug = 'likely-to-churn';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Marked an email as spam', 'email_spam', NULL, NULL, 50, NULL, NULL, 0, 4 FROM score_defs WHERE slug = 'likely-to-churn';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Clicked a link in an email', 'email_click', NULL, NULL, -10, 30, 1, 0, 5 FROM score_defs WHERE slug = 'likely-to-churn';
INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, position)
SELECT id, 'event', 'Replied to an email', 'email_reply', NULL, NULL, -20, 60, NULL, 0, 6 FROM score_defs WHERE slug = 'likely-to-churn';
