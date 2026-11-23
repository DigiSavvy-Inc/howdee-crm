-- #388: AI account briefs on company pages. Additive only.
--
-- company_briefs: one row per generation (append-only; the newest row per company + audience
-- is the brief shown). `audience` keeps Zoho money away from people who can't see billing:
--   'all'        — the company has no Zoho billing data, so one brief fits everyone;
--   'billing'    — written with the Zoho figures (admins, or members while the billing switch is on);
--   'no_billing' — the same company without any Zoho figures (everyone else).
-- `input_hash` = SHA-256 of the source data sent to the model; an unchanged hash skips the call.
-- `cost_micros` + `user_id` count the generation toward the assistant spend caps (ai/config.ts
-- spentMicros): user_id NULL = the heartbeat, which only counts toward the app's monthly cap.
CREATE TABLE company_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'billing', 'no_billing')),
  brief_md TEXT NOT NULL,
  one_liner TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  open_items INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  input_hash TEXT NOT NULL,
  -- Last time the heartbeat found the sources unchanged (same hash) — counts as "done today".
  checked_at TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'heartbeat')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_company_briefs_company ON company_briefs(company_id, generated_at);
CREATE INDEX idx_company_briefs_generated ON company_briefs(generated_at);

-- Thumbs up / down on a brief, one vote per user per brief.
CREATE TABLE company_brief_feedback (
  brief_id INTEGER NOT NULL REFERENCES company_briefs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brief_id, user_id)
);
