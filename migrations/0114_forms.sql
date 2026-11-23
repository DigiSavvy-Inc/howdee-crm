-- #509 (Forms 1/7, epic #508): hosted forms, their submissions and a small rate-limit table.
--
-- forms
--   slug            /f/<slug>, unique (lowercase, hyphens)
--   status          draft | published | archived. Only published forms are served publicly.
--   spec            the FormSpec JSON ($lib/forms.ts: fields, pages, outcomes, style, settings)
--   version         bumped on publish and on every save of a published form — the public
--                   page's cache key and the version stamped on each submission
--   retention_days  copy of spec.settings.retention_days, so the nightly prune is one query
-- form_submissions
--   status          added | updated (a contact was created / updated) | anonymous (no contact,
--                   allowed by the form) | spam (honeypot) | rejected (origin; detail says why)
--   answers         JSON { key: value } of the shown questions only
--   ip_hash         first 16 hex of SHA-256(cf-connecting-ip + SESSION_SECRET); never the raw IP
-- rate_limits       fixed-window counters (`$lib/server/rate-limit.ts`), pruned with submissions
CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  spec TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  retention_days INTEGER NOT NULL DEFAULT 365,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  archived_at TEXT,
  UNIQUE (slug)
);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(status);

CREATE TABLE IF NOT EXISTS form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  form_version INTEGER,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  email TEXT,
  status TEXT NOT NULL CHECK (status IN ('added', 'updated', 'anonymous', 'spam', 'rejected')),
  detail TEXT,
  answers TEXT NOT NULL DEFAULT '{}',
  utm TEXT,
  referrer TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_contact ON form_submissions(contact_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_created ON form_submissions(created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
