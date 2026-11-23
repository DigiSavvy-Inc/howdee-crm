-- #221: compound Condition steps. A branch step's condition can be a rule set —
-- JSON `{ "match": "all" | "any", "rules": [ { field, op, value?, value2? }, … ] }` — the
-- segment RuleBuilder's shape plus the automation-only kinds (list, email, field_contains,
-- step_opened / step_clicked). NULL = the legacy single gate_* columns, evaluated exactly
-- as before (no data migration). Saving a condition from the editor writes gate_rules and
-- clears gate_kind / gate_name / gate_value / gate_ref_id (an A/B split keeps them).
ALTER TABLE automation_steps ADD COLUMN gate_rules TEXT;
