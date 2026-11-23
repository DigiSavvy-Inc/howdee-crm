-- #332: a campaign's audience = several lists and/or segments (union) minus optional
-- exclusions. A table rather than a JSON column so a group's references stay queryable
-- (group delete / merge, deliverability holds) and get a real FK. Lists, segments and tags
-- all live in `lists`, so one `list_id` covers every "group type" — no separate type column.
--
-- `campaigns.list_id` stays: it mirrors the first include (the primary audience) so the send
-- log type (list_id NULL = direct 1:1), holds, alerts and older readers keep working.
-- Readers use these rows when a campaign has any, else fall back to `campaigns.list_id`.
CREATE TABLE campaign_audiences (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'include' CHECK (mode IN ('include', 'exclude')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, list_id)
);
CREATE INDEX idx_campaign_audiences_list ON campaign_audiences(list_id);

-- Backfill: every existing campaign (sent, draft, scheduled, canceled) gets its single group
-- as its one include, so it resolves exactly as before.
INSERT OR IGNORE INTO campaign_audiences (campaign_id, list_id, mode, position)
  SELECT id, list_id, 'include', 0 FROM campaigns WHERE list_id IS NOT NULL;
