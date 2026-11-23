-- #412: engagement triggers (opens / clicks) + entry conditions for every trigger. Additive only.

-- JSON config of the newer trigger kinds (`email_opened`, `email_clicked`), e.g.
-- {"email":"any"|{"campaign_id":12}|{"step_id":34},"list_id":null,"link":"any"|{"op":"contains","value":"/pricing"},
--  "exclude":[{"campaign_id":12},{"link":{"op":"contains","value":"unsubscribe"}}],
--  "ignore_proxy_opens":true,"once_per_email":true}.
-- NULL for the older kinds, which keep their own trigger_* columns for now.
ALTER TABLE automations ADD COLUMN trigger_config TEXT;

-- Entry conditions for every trigger kind: a ConditionRuleSet ({"match":"all","rules":[…]}).
-- A contact who doesn't match is not enrolled. NULL = none.
ALTER TABLE automations ADD COLUMN entry_rules TEXT;

-- "Fire at most once per email per contact": one row per (automation, contact, email, kind)
-- that created a pass.
CREATE TABLE engagement_trigger_fires (
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automation_id, contact_id, campaign_id, kind)
);

-- Clicked links (the link picker, link-matched triggers). Guarded by json_valid: older rows
-- were cut at 4,000 characters and may not be valid JSON, and a bare json_extract on those
-- would fail the CREATE INDEX (and every later insert of such a row). Queries use the same
-- expression (CLICK_LINK_SQL in src/lib/server/event-detail.ts) so the index applies.
CREATE INDEX idx_events_link ON events(CASE WHEN json_valid(detail) THEN json_extract(detail, '$.OriginalLink') END) WHERE type = 'click';
