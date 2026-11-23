-- #423: contacts overview + filter-aware activity feed. Additive only.
-- The overview groups contacts by created_at / source and the scoped feed reads replies and
-- unsubscribes newest first (or within a period); none of those columns were indexed.
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts(source);
CREATE INDEX IF NOT EXISTS idx_replies_received_at ON replies(received_at);
CREATE INDEX IF NOT EXISTS idx_unsubscribes_created_at ON unsubscribes(created_at);
