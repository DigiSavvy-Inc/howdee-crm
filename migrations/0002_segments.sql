-- Distinguish full imported lists from manually-curated segments (smaller sub-groups).
ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'list';
