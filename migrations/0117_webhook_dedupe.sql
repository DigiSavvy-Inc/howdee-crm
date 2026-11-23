-- #542: Postmark webhook hardening.
-- events.dedupe_key = SHA-256 of the fields that identify one Postmark record (RecordType, ID,
-- MessageID, the event time, link, address). A Postmark retry carries the same key, so the
-- webhook's INSERT OR IGNORE stores nothing and the retry is a no-op. NULL = no dedupe (rows from
-- before this migration, payloads without an ID or timestamp).
ALTER TABLE events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_dedupe ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Many queries filter recipients by contact (contact history, conversations, engagement, enroll guards).
CREATE INDEX IF NOT EXISTS idx_recipients_contact ON recipients(contact_id);
