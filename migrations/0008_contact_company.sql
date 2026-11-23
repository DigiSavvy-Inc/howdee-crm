-- #44: add a Company / Org Name field to contacts. Editable in the contact record UI
-- and settable via the contact upsert API (#45). NULL = unset.
ALTER TABLE contacts ADD COLUMN company TEXT;
