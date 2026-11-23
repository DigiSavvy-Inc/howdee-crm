-- Resend-to-non-openers (#81/#82). A resend sends on the SAME campaign row (events
-- attribute to it via new recipients rows), these columns just record that it happened
-- and, later (#82), schedule an automatic one.
ALTER TABLE campaigns ADD COLUMN resend_at TEXT;          -- when an auto-resend is scheduled to fire (#82, unused by manual resend)
ALTER TABLE campaigns ADD COLUMN resend_status TEXT;      -- NULL | 'pending' | 'sent' | 'canceled' (#82)
ALTER TABLE campaigns ADD COLUMN resend_subject TEXT;     -- subject used for the (last) resend, if different
ALTER TABLE campaigns ADD COLUMN resent_at TEXT;          -- when the last resend actually went out
ALTER TABLE campaigns ADD COLUMN resend_recipients INTEGER; -- how many the last resend reached
