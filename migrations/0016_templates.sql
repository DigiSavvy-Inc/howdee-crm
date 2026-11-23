-- #60: reusable email templates. kind='builder' stores blocks JSON (rendered to
-- email-safe HTML at send time); kind='html' stores raw pasted HTML (sent as-is —
-- the unsubscribe footer is appended at send if %%UNSUB_URL%% is missing).
CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'builder',            -- 'builder' | 'html'
  blocks TEXT,                                     -- JSON Block[] (builder)
  html TEXT,                                       -- raw HTML (html)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
