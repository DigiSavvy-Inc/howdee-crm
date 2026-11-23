-- #207 (part 2 of #205): pipeline in automations.
-- Action steps: action_kind 'pipeline_move' (target_stage_id, optional only_from_stage_id)
-- and 'pipeline_remove'. Trigger: trigger_type 'pipeline_stage_entered' + trigger_stage_id.
-- Deliberately no FKs (like trigger_site_id, #154): a deleted stage leaves a dangling id
-- that never matches — the step records "skipped: deleted stage", the trigger never fires —
-- instead of SET NULL silently widening "only from <stage>" to "from anywhere".
ALTER TABLE automation_steps ADD COLUMN target_stage_id INTEGER;
ALTER TABLE automation_steps ADD COLUMN only_from_stage_id INTEGER;
ALTER TABLE automations ADD COLUMN trigger_stage_id INTEGER;
