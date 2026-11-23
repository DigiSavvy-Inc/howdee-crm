-- #48 follow-up: per-key default tags. Contacts arriving via a webhook key get these tags
-- (comma-separated names), which also fire list_added automation triggers — so "everyone
-- through this webhook gets tag X → enrolls in automation Y" works end to end.
ALTER TABLE webhook_keys ADD COLUMN default_tags TEXT;  -- comma-separated tag names, NULL = none
