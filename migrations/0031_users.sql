-- #88: app users (the sign-in allowlist). Sign-in is GitHub OAuth; a login only succeeds
-- if github_login matches an ACTIVE row here. github_id is pinned on first login so a
-- renamed GitHub account keeps its row. role: 'admin' manages users; 'member' = everything else.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login TEXT NOT NULL COLLATE NOCASE UNIQUE,
  github_id INTEGER UNIQUE,
  name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  disabled_at TEXT
);
-- #606: no seeded admin. A fresh database has zero users; /setup creates the first admin.
-- (D1 records applied migrations by name, so installs that already ran this keep their row.)
