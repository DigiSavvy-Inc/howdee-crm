-- #246: which pass of a campaign a recipient row belongs to. NULL or 'original' = the
-- first send, 'resend' = a resend to non-openers (performResend). Existing rows stay
-- NULL and count as original. Additive; older code never reads it.
ALTER TABLE recipients ADD COLUMN send_pass TEXT;
