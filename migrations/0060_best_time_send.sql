-- #115: send a scheduled broadcast at each contact's best time.
--
-- campaigns.best_time = 1 → when the scheduled send fires, recipients are QUEUED
-- (recipients.status = 'queued') instead of sent: each gets send_after = the next
-- occurrence of its contact_engagement.best_hour_utc within 24 h of the start, or the
-- start itself when there's no confident hour guess. The heartbeat drains due rows
-- (queued → sending claim → accepted/error) through the shared send path.
--
-- recipients.send_cohort: 'best' (timed by the contact's hour) | 'default' (no guess,
-- sent at the start). NULL on every ordinary send. The campaign page's lift report
-- compares the two cohorts' opens/clicks.
ALTER TABLE campaigns ADD COLUMN best_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN send_after TEXT;
ALTER TABLE recipients ADD COLUMN send_cohort TEXT;

CREATE INDEX idx_recipients_queued ON recipients(send_after) WHERE status = 'queued';
