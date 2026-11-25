-- #479: scheduled sends re-check their links when they fire; a send that still fails after the
-- "keep trying" window is HELD (the #305 mechanism: held_at), never cancelled, never sent with
-- the problem.
--   held_reason            'deliverability' (#305) | 'preflight' (#479); NULL on rows held
--                          before this migration = deliverability.
--   preflight_report       the JSON ChecksReport of the last check at fire time.
--   preflight_checked_at   when that check ran (UTC 'YYYY-MM-DD HH:MM:SS').
--   preflight_retry_until  end of the keep-trying window (set on the first failing check).
--   preflight_override_by  "Send anyway" on a held send: '@login at <UTC time>' of the admin.
--                          Good for ONE fire: cleared when the send is claimed, edited, held
--                          again (any reason) or released; honoured at fire time only while
--                          overrides are allowed and that user is still an active admin.
--   preflight_override_user_id  users.id of that admin (no FK: the row outlives the user; a
--                          missing / disabled / demoted user means the override is ignored).
--   preflight_notified_at  when the hold notice (webhook / admin email) for the current pre-send
--                          hold was attempted. NULL on a held row = not yet: the tick's notice
--                          pass picks it up. Cleared by every new pre-send hold.
ALTER TABLE campaigns ADD COLUMN held_reason TEXT;
ALTER TABLE campaigns ADD COLUMN preflight_report TEXT;
ALTER TABLE campaigns ADD COLUMN preflight_checked_at TEXT;
ALTER TABLE campaigns ADD COLUMN preflight_retry_until TEXT;
ALTER TABLE campaigns ADD COLUMN preflight_override_by TEXT;
ALTER TABLE campaigns ADD COLUMN preflight_override_user_id INTEGER;
ALTER TABLE campaigns ADD COLUMN preflight_notified_at TEXT;

UPDATE campaigns SET held_reason = 'deliverability' WHERE held_at IS NOT NULL AND held_reason IS NULL;
