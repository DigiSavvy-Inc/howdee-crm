-- #128: "Action" steps — act on the contact's membership in OTHER automations.
-- type='action'; action_kind: enroll_automation | end_automation; target nulls on delete.
ALTER TABLE automation_steps ADD COLUMN action_kind TEXT;
ALTER TABLE automation_steps ADD COLUMN target_automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL;
