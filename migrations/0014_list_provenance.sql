-- #53: sender-compliance provenance on lists. `origin` answers "how did these contacts get
-- into the database / what did they consent to" (CAN-SPAM/GDPR records, Postmark list
-- quality); `description` is the operator's note on what the group is for.
ALTER TABLE lists ADD COLUMN description TEXT;
ALTER TABLE lists ADD COLUMN origin TEXT;
