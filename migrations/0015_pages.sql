-- #59: hosted pages built with the block builder (#56). Served publicly at /p/[slug]
-- when published — e.g. a consent/origin explainer linked from the email footer.
CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,                       -- /p/<slug>; kebab-case
  title TEXT NOT NULL,
  blocks TEXT NOT NULL DEFAULT '[]',               -- JSON Block[] (src/lib/blocks.ts)
  published INTEGER NOT NULL DEFAULT 0,            -- 0 = draft (404s publicly)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
