-- #570: a Postmark webhook event is "done" only once its processing ran to the end.
-- events.processed_at is stamped after processEvent succeeds. A retry whose dedupe key hits a row
-- with processed_at NULL runs the processing again instead of returning `duplicate`. Rows from
-- before this migration are marked processed (they were, or the daily suppression sync covers them).
ALTER TABLE events ADD COLUMN processed_at TEXT;
UPDATE events SET processed_at = COALESCE(recorded_at, datetime('now')) WHERE processed_at IS NULL;

-- #570: safety-net Postmark suppression sync ~15 minutes after a broadcast's sent_at, at most once
-- per campaign. NULL = not run yet.
ALTER TABLE campaigns ADD COLUMN post_send_sync_at TEXT;
