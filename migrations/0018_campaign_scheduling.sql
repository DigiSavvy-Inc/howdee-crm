-- #35: schedule a broadcast for a future time. status gains 'scheduled' (and
-- 'canceled' when a schedule is withdrawn). body_text stores the rendered text
-- template alongside body_html so the send is reproduced faithfully at fire time.
-- scheduled_at is UTC, stored 'YYYY-MM-DD HH:MM:SS' to compare with datetime('now').
ALTER TABLE campaigns ADD COLUMN scheduled_at TEXT;
ALTER TABLE campaigns ADD COLUMN body_text TEXT;
