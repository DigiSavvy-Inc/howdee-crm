-- Inbound reply capture (epic #36 / issue #37). One row per reply we receive via the
-- Postmark Inbound webhook. contact_id / campaign_id are nullable (a reply from an
-- unknown sender, or one we couldn't pin to a campaign, still gets stored).
CREATE TABLE replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  from_email TEXT NOT NULL,
  subject TEXT,
  text TEXT,                                    -- stripped reply text (no quoted history)
  raw TEXT,                                      -- optional raw payload (truncated)
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_replies_contact ON replies(contact_id);
CREATE INDEX idx_replies_campaign ON replies(campaign_id);
