-- #68: mark lists as subscriber-visible topics for the preference center. Only
-- kind='list' topics appear on the preference page; recipients opt in/out per topic.
ALTER TABLE lists ADD COLUMN public_topic INTEGER NOT NULL DEFAULT 0;
