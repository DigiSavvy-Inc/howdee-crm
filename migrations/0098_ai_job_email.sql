-- #390: scheduled assistant jobs can also email their report to admins. Additive only.
-- `email_admins` = JSON array of who gets the report: active admin user ids (numbers) and
-- optionally the string "review_to" (the REVIEW_TO address). NULL = email delivery off.
-- Addresses are never stored here; they're resolved from `users` at send time, so a free-text
-- address, a contact or a list can't be a recipient (src/lib/server/ai/jobs-email.ts).
-- A job with email only stores webhook_url = ''.
ALTER TABLE ai_jobs ADD COLUMN email_admins TEXT;

-- Per run: 'sent' | 'partial' | 'failed' (NULL = no email for this run).
ALTER TABLE ai_job_runs ADD COLUMN email_status TEXT;
