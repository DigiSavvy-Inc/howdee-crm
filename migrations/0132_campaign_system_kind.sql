-- #668: mark account emails (invite / password reset / email verification, #639) so they stay
-- out of Conversations, the send log, the dashboard, reports, search and the API.
-- NULL = a normal send; 'account' = account mail (see src/lib/server/system-mail.ts).
ALTER TABLE campaigns ADD COLUMN system_kind TEXT;

-- Backfill: account emails sent before this migration. Their stored copy has the link redacted
-- to `<base>/invite/…`, `<base>/reset/…` or `<base>/verify/…` (sendAccountEmail), and they are
-- direct rows (no list, no automation).
UPDATE campaigns SET system_kind = 'account'
 WHERE system_kind IS NULL AND list_id IS NULL AND automation_id IS NULL AND automation_step_id IS NULL
   AND (body_text LIKE '%/invite/…%' OR body_text LIKE '%/reset/…%' OR body_text LIKE '%/verify/…%');
