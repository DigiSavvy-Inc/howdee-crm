-- Phase 2 automations (#12/#13):
-- Campaigns (broadcasts) can tag engagers like automation steps already do — the tag
-- then fires list_added automation triggers = enroll-on-open/click (#12).
ALTER TABLE campaigns ADD COLUMN tag_on_open TEXT;
ALTER TABLE campaigns ADD COLUMN tag_on_click TEXT;
-- Condition gate step (#13): type='gate' continues the flow only when the contact
-- matches the rule (same kinds as block visibility: tag | no-tag | field-exists | field-eq).
ALTER TABLE automation_steps ADD COLUMN gate_kind TEXT;
ALTER TABLE automation_steps ADD COLUMN gate_name TEXT;
ALTER TABLE automation_steps ADD COLUMN gate_value TEXT;
