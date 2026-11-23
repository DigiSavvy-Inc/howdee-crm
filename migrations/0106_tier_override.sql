-- #460: engagement tier override. `contact_engagement.tier` stays the EFFECTIVE tier every
-- reader uses; `tier_auto` is the computed (score / unsubscribed-cold) tier underneath.
-- An override wins while `tier_override_until` is NULL (until cleared) or in the future
-- (ISO 8601 UTC); the engagement recompute drops it once that time has passed.
ALTER TABLE contact_engagement ADD COLUMN tier_override TEXT;
ALTER TABLE contact_engagement ADD COLUMN tier_auto TEXT;
ALTER TABLE contact_engagement ADD COLUMN tier_override_until TEXT;
ALTER TABLE contact_engagement ADD COLUMN tier_override_source TEXT; -- automation:<id> | user:<login> | bulk:<login> | assistant:<login> | api:<key id>
ALTER TABLE contact_engagement ADD COLUMN tier_override_at TEXT;
CREATE INDEX IF NOT EXISTS idx_contact_engagement_override_until ON contact_engagement(tier_override_until)
  WHERE tier_override IS NOT NULL;

-- The "Set engagement tier" action step (action_kind = 'set_tier'): the tier to set, or
-- 'clear' (back to automatic), and how many days the override lasts (NULL = until cleared).
ALTER TABLE automation_steps ADD COLUMN target_tier TEXT;
ALTER TABLE automation_steps ADD COLUMN tier_days INTEGER;
