-- #151: site tracking (part A) — ingest + identity + storage.
-- A tracking site is a website that runs our snippet. `site_key` is PUBLIC (it ships in
-- the snippet); `origins` is a JSON list of allowed Origin values (e.g.
-- ["https://ourco.example","https://www.ourco.example"]) checked on every beacon.
CREATE TABLE tracking_sites (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	domain TEXT NOT NULL,
	origins TEXT NOT NULL DEFAULT '[]',
	site_key TEXT NOT NULL UNIQUE,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_event_at TEXT
);

-- Known contacts only (v1): every row has a contact. Pageviews and custom events share
-- the table (`kind`); `name` is 'pageview' for views. `utm` holds only the five UTM keys;
-- `props` (event kind only) is capped at 2 KB. Paths are stored without query strings.
CREATE TABLE site_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	site_id INTEGER NOT NULL REFERENCES tracking_sites(id) ON DELETE CASCADE,
	contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	path TEXT,
	title TEXT,
	referrer_host TEXT,
	utm TEXT,
	props TEXT,
	country TEXT,
	occurred_at TEXT NOT NULL,
	received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_site_events_contact ON site_events (contact_id, occurred_at);
CREATE INDEX idx_site_events_site ON site_events (site_id, occurred_at);
CREATE INDEX idx_site_events_path ON site_events (path);
-- Rate-limit fallback counts a site's rows by arrival time.
CREATE INDEX idx_site_events_site_received ON site_events (site_id, received_at);

-- Per-contact opt-out: beacons for an opted-out contact are dropped.
ALTER TABLE contacts ADD COLUMN tracking_optout INTEGER NOT NULL DEFAULT 0;
