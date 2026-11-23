-- #105: cached avatar resolution per contact. avatar_source: gravatar | github | domain | none.
-- avatar_key = R2 object key under avatars/ (NULL when none). Re-checked after 30 days or
-- when the email changes (avatar_email records which email the check was for).
ALTER TABLE contacts ADD COLUMN avatar_source TEXT;
ALTER TABLE contacts ADD COLUMN avatar_key TEXT;
ALTER TABLE contacts ADD COLUMN avatar_checked_at TEXT;
ALTER TABLE contacts ADD COLUMN avatar_email TEXT;
