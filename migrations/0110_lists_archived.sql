-- #472: archive / restore lists and segments. NULL = active; a timestamp ('YYYY-MM-DD HH:MM:SS'
-- UTC) = archived at that time. An archived group is hidden from day-to-day pickers and the
-- Groups pages (an Archived view lists it), but keeps its members, rules, campaign history and
-- reports; restoring brings it back exactly as it was. Only kind 'list' / 'segment' are archived.
ALTER TABLE lists ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_lists_archived_at ON lists(archived_at);
