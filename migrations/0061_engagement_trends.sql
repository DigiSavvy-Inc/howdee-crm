-- #116: dashboard engagement intelligence.
-- Daily tier counts for the 90-day trend, taken by the heartbeat once the engagement
-- backlog is drained (one snapshot per UTC day). Derived — safe to drop.
CREATE TABLE engagement_tier_daily (
  day TEXT NOT NULL,          -- YYYY-MM-DD, UTC
  tier TEXT NOT NULL,         -- hot | warm | cool | cold | never | new
  n INTEGER NOT NULL,
  PRIMARY KEY (day, tier)
);

-- The tier a contact had before its last tier change, and when that change happened —
-- "going cold this month" = moved down into cool/cold in the last 30 days.
ALTER TABLE contact_engagement ADD COLUMN prev_tier TEXT;
ALTER TABLE contact_engagement ADD COLUMN tier_changed_at TEXT;
CREATE INDEX idx_contact_engagement_tier_changed ON contact_engagement(tier_changed_at);
