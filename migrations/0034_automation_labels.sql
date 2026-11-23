-- #74: free-form labels on automations (organisation only). Case-insensitive unique per
-- automation; exact-match filtering. Deliberately NOT lists(kind='tag') — those are
-- contact tags (FEATURE_CHECKLIST §4).
CREATE TABLE automation_labels (
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  label TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automation_id, label)
);
CREATE INDEX idx_automation_labels_label ON automation_labels(label);
