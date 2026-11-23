-- Store extra form-payload fields (project_type, details, tier, score, ...) on the contact
-- as JSON, so webhook submissions keep their context. Generic — any unknown ingest field
-- lands here. Shown as "Form data" on the contact record.
ALTER TABLE contacts ADD COLUMN meta TEXT;  -- JSON object, NULL = none
