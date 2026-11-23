-- #119: opt-in "weekdays only" — a due time landing on Sat/Sun (operator tz) moves to Monday,
-- same local time. Applied by applyWeekdayOnly() at enrollment, step advance, schedule, resend.
ALTER TABLE automation_steps ADD COLUMN weekday_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN weekday_only INTEGER NOT NULL DEFAULT 0;
