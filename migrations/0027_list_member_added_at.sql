-- Track WHEN a contact joined a list/segment/tag so the member table can show
-- "Date added" and filter on it.
--
-- SQLite can't ALTER TABLE ADD COLUMN with a non-constant default (datetime('now')),
-- so the table is recreated. Nothing references list_members, so the drop is safe.
-- Existing memberships have no recorded join date; they're backfilled with the
-- contact's created_at, which is exact for CSV/manual imports (contact + membership
-- are created together) and an approximation for later hand-picked segment adds.

CREATE TABLE list_members_new (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, contact_id)
);

INSERT INTO list_members_new (list_id, contact_id, added_at)
SELECT lm.list_id, lm.contact_id, COALESCE(c.created_at, datetime('now'))
FROM list_members lm
JOIN contacts c ON c.id = lm.contact_id;

DROP TABLE list_members;
ALTER TABLE list_members_new RENAME TO list_members;

CREATE INDEX idx_list_members_contact ON list_members(contact_id);
CREATE INDEX idx_list_members_added ON list_members(list_id, added_at);
