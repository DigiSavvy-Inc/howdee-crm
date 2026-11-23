-- #414: curated subscription topics with public wording, and topic opt-outs that hold.
-- Additive only.
--
-- lists.topic_label / topic_blurb / topic_order — what the preference page shows for a topic
-- list (kind = 'list' AND public_topic = 1). The page never shows lists.name / description;
-- a topic with no label falls back to the name only when the name has no internal markers
-- (zz-…, [merged], Seg · …). topic_order sorts the topics (NULL last, then label).
ALTER TABLE lists ADD COLUMN topic_label TEXT;
ALTER TABLE lists ADD COLUMN topic_blurb TEXT;
ALTER TABLE lists ADD COLUMN topic_order INTEGER;

-- campaigns.topic_list_id — the topic an email belongs to. NULL = automatic (the first
-- included group when it is a topic list), 0 = no topic, else a lists.id. No FK on purpose
-- (a deleted list just stops matching any opt-out).
ALTER TABLE campaigns ADD COLUMN topic_list_id INTEGER;

-- automations.topic_list_id — the topic every email step of the automation belongs to
-- (NULL = none). No FK, same reason.
ALTER TABLE automations ADD COLUMN topic_list_id INTEGER;

-- topic_optouts — a contact unticked a topic on the preference page. Sends whose topic is
-- that list skip them, whichever list or segment they were picked from. Re-ticking deletes it.
CREATE TABLE topic_optouts (
	contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
	list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (contact_id, list_id)
);
CREATE INDEX idx_topic_optouts_list ON topic_optouts(list_id);
