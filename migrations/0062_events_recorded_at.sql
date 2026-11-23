-- #194: the dashboard activity feed orders open/click/bounce events by recorded_at.
-- Without this index SQLite filters on idx_events_type and sorts every match in a temp B-tree.
CREATE INDEX IF NOT EXISTS idx_events_recorded ON events(recorded_at);
