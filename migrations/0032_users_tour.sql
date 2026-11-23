-- #104: first-run product tour. NULL = never dismissed → auto-open once.
ALTER TABLE users ADD COLUMN tour_dismissed_at TEXT;
