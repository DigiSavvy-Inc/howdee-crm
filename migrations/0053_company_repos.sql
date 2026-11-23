-- #169: GitHub repos attached to a company (Integrations 4/5). A repo belongs to at most one
-- company (UNIQUE owner/repo, case-insensitive like GitHub, stored in GitHub's canonical case). The per-repo counts and
-- recent issues are the last sync's values; the company-level totals are aggregated into
-- company_metrics (#168, migration 0052) — github columns only.
-- `etag` is the If-None-Match value for the recent-issues listing (a 304 keeps the old values).
CREATE TABLE company_repos (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
	owner TEXT NOT NULL COLLATE NOCASE,
	repo TEXT NOT NULL COLLATE NOCASE,
	added_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_synced_at TEXT,
	last_error TEXT,
	etag TEXT,
	issues_open INTEGER,
	issues_closed INTEGER,
	issues_opened_30d INTEGER,
	issues_closed_30d INTEGER,
	last_issue_at TEXT,
	recent_issues TEXT, -- JSON [{ number, title, state, html_url, updated_at }]
	UNIQUE (owner, repo)
);

CREATE INDEX idx_company_repos_company ON company_repos(company_id);
