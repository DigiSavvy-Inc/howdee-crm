-- #154: "Visits a page" automation trigger (site tracking D).
-- trigger_type = 'site_visit' reads these columns; NULL for every other trigger.
-- NULL = any site. Deliberately no FK: a SET NULL would silently widen the trigger to every
-- site; a dangling id (AUTOINCREMENT never reuses it) simply never matches.
ALTER TABLE automations ADD COLUMN trigger_site_id INTEGER;
ALTER TABLE automations ADD COLUMN trigger_path_op TEXT;         -- 'contains' | 'equals' | 'wildcard'
ALTER TABLE automations ADD COLUMN trigger_path TEXT;            -- the pattern ('*' = any characters for 'wildcard')
ALTER TABLE automations ADD COLUMN trigger_cooldown_hours INTEGER; -- per-contact cooldown, default 24

-- When the site_visit trigger last enrolled a contact into an automation — the cooldown
-- clock, so a refresh (or a second matching page) doesn't re-trigger. Derived/expendable.
CREATE TABLE site_visit_fires (
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automation_id, contact_id)
);
