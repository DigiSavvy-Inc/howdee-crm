-- Email marketing app schema (Cloudflare D1 / SQLite)

CREATE TABLE lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  first_name TEXT,
  last_name TEXT,
  subscribed INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE list_members (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  body_md TEXT NOT NULL,
  body_html TEXT NOT NULL,
  list_id INTEGER REFERENCES lists(id),
  from_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | sending | sent | failed
  recipient_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

-- One row per recipient of a campaign; message_id maps Postmark webhook events back.
CREATE TABLE recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id),
  email TEXT NOT NULL,
  message_id TEXT,                               -- Postmark MessageID
  status TEXT,                                   -- accepted | error
  error TEXT
);
CREATE INDEX idx_recipients_message ON recipients(message_id);
CREATE INDEX idx_recipients_campaign ON recipients(campaign_id);

-- Tracking events ingested from Postmark webhooks.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES recipients(id),
  contact_id INTEGER REFERENCES contacts(id),
  type TEXT NOT NULL,                            -- delivery | open | click | bounce | spam | unsubscribe
  message_id TEXT,
  detail TEXT,                                   -- JSON payload extras
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_campaign ON events(campaign_id);
CREATE INDEX idx_events_type ON events(type);

CREATE TABLE unsubscribes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  email TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_unsubscribes_email ON unsubscribes(email);
