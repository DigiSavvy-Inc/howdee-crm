-- Reports 5/5 (#358): daily history for values we otherwise only keep as current
-- snapshots. Written once per UTC day by the heartbeat (`runReportHistoryDaily` in
-- src/lib/server/reports/history.ts), kept 3 years. Derived data: safe to drop.

CREATE TABLE IF NOT EXISTS company_metrics_daily (
	day TEXT NOT NULL,
	company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
	hours_7d REAL,
	hours_30d REAL,
	open_issues INTEGER,
	issues_opened_30d INTEGER,
	issues_closed_30d INTEGER,
	PRIMARY KEY (day, company_id)
);

CREATE INDEX IF NOT EXISTS idx_company_metrics_daily_company ON company_metrics_daily(company_id, day);

CREATE TABLE IF NOT EXISTS list_size_daily (
	day TEXT NOT NULL,
	list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
	members INTEGER NOT NULL,
	subscribed INTEGER NOT NULL,
	PRIMARY KEY (day, list_id)
);

CREATE INDEX IF NOT EXISTS idx_list_size_daily_list ON list_size_daily(list_id, day);
