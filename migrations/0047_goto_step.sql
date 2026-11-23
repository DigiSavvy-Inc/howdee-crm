-- #146: "Go to a step" action — action_kind='goto_step' moves the contact to another step
-- in the SAME automation. target_step_id nulls on delete (shown as "(deleted step)").
ALTER TABLE automation_steps ADD COLUMN target_step_id INTEGER REFERENCES automation_steps(id) ON DELETE SET NULL;
-- Per-pass jump counter for the goto loop guard (max 25 jumps per pass). A counter, not a
-- count of decision rows: automation_branch_hits keeps one row per (step, enrollment), so
-- repeated jumps through the same step overwrite rather than accumulate.
ALTER TABLE automation_enrollments ADD COLUMN jump_count INTEGER NOT NULL DEFAULT 0;
