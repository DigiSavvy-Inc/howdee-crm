-- #280: archive / restore contacts. NULL = active; a timestamp ('YYYY-MM-DD HH:MM:SS' UTC)
-- = archived at that time. An archived contact is hidden from day-to-day views and never
-- sent to (recipient resolution, scheduled sends, resends, best-time claims, enroll, tick),
-- but keeps all history. Independent of `subscribed`.
ALTER TABLE contacts ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_archived_at ON contacts(archived_at);
