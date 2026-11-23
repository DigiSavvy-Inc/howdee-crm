-- #106: the send log's per-row opens/clicks/unsubs are correlated COUNTs over events by
-- (campaign_id, type). Make that index-only so paging the log stays cheap as events grow.
CREATE INDEX IF NOT EXISTS idx_events_campaign_type ON events(campaign_id, type, recipient_id);
