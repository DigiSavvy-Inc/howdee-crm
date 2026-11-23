-- Reports (#354). Saved report specs. Additive only: new table and one index.
--
-- events(contact_id, type, recorded_at) already exists as idx_events_contact_type_time
-- (migration 0042). Not created again.
-- events(recorded_at) already exists as idx_events_recorded (migration 0062). Not created again.
-- site_events had no index led by occurred_at (0048 leads with contact_id or site_id),
-- so time-window scans of page views add one here.

CREATE TABLE IF NOT EXISTS reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	description TEXT,
	spec TEXT NOT NULL,
	created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	pinned INTEGER NOT NULL DEFAULT 0,
	folder TEXT,
	built_in_key TEXT UNIQUE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_folder ON reports(folder, updated_at);
CREATE INDEX IF NOT EXISTS idx_reports_pinned ON reports(pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_site_events_occurred ON site_events(occurred_at);
