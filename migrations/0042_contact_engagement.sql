-- #111/#113: per-contact engagement rollup. Recomputed daily by the heartbeat and
-- incrementally for contacts marked dirty by the webhook. Everything here is derivable
-- from events/recipients/replies — safe to drop and rebuild.
CREATE TABLE contact_engagement (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,          -- all opens incl. proxy
  proxy_open_count INTEGER NOT NULL DEFAULT 0,    -- opens classified as Apple MPP / prefetch
  unique_open_campaigns INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  unique_click_campaigns INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  first_sent_at TEXT, last_sent_at TEXT, last_open_at TEXT, last_click_at TEXT, last_reply_at TEXT,
  open_rate REAL, click_rate REAL,                -- unique campaigns opened/clicked ÷ campaigns sent (NULL when sent_count = 0)
  hour_hist TEXT NOT NULL DEFAULT '[]',           -- JSON 24 ints, UTC hour of non-proxy opens+clicks
  dow_hist TEXT NOT NULL DEFAULT '[]',            -- JSON 7 ints (0 = Sunday), UTC
  best_hour_utc INTEGER, best_dow INTEGER,        -- NULL until ≥ 3 real engagement events
  tz_offset_guess INTEGER,                        -- hours, from Geo country/region when available
  tz_confidence REAL,                             -- 0–1
  top_client TEXT, top_platform TEXT, top_country TEXT,
  score REAL NOT NULL DEFAULT 0,                  -- 0–100, recency-weighted
  tier TEXT NOT NULL DEFAULT 'new',               -- hot | warm | cool | cold | never | new
  dirty INTEGER NOT NULL DEFAULT 1,               -- 1 = needs recompute
  computed_at TEXT
);
CREATE INDEX idx_contact_engagement_dirty ON contact_engagement(dirty);
CREATE INDEX idx_contact_engagement_tier ON contact_engagement(tier);
CREATE INDEX idx_events_contact_type_time ON events(contact_id, type, recorded_at);
