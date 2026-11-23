-- #619: defined custom fields. Contact data stays where it is: strings in contacts.meta keyed by
-- the field key. This table only names the keys, gives them a type (text, number, date, yes_no,
-- choice) and an order, so the form builder, the contact page and the rule builder can offer
-- them by label. Archiving a field hides it from pickers; it never touches contact data.
--
-- An install that already holds custom fields gets one `text` row per key found in
-- contacts.meta (label built from the key). A fresh database gets no rows.

CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'number', 'date', 'yes_no', 'choice')),
  options TEXT NOT NULL DEFAULT '[]', -- JSON array of strings (choice fields)
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_custom_fields_position ON custom_fields (position, id);

INSERT OR IGNORE INTO custom_fields (key, label, type, options, position)
SELECT k,
  UPPER(SUBSTR(REPLACE(REPLACE(k, '_', ' '), '-', ' '), 1, 1)) || SUBSTR(REPLACE(REPLACE(k, '_', ' '), '-', ' '), 2),
  'text', '[]', ROW_NUMBER() OVER (ORDER BY k)
FROM (
  SELECT DISTINCT j.key AS k
  FROM contacts c,
    json_each(CASE WHEN json_valid(c.meta) AND json_type(c.meta) = 'object' THEN c.meta ELSE '{}' END) j
  WHERE TRIM(j.key) != ''
);
