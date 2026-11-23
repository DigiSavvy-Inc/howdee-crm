-- #74: the enrollment pointer becomes a step ID (was a step position).
-- Position pointers forced the builder to lock ALL structural edits while any enrollment
-- was active (reordering shifted positions under in-flight contacts). Id pointers survive
-- add/move/reorder, and are the foundation for branching (#75) where "next" is no longer
-- position+1. Completed/cancelled enrollments keep a NULL pointer (their old audit value
-- was one-past-the-last position — meaningless as an id; status carries the state).
ALTER TABLE automation_enrollments ADD COLUMN current_step_id INTEGER REFERENCES automation_steps(id);

UPDATE automation_enrollments SET current_step_id = (
  SELECT s.id FROM automation_steps s
  WHERE s.automation_id = automation_enrollments.automation_id
    AND s.position = automation_enrollments.current_step
);

ALTER TABLE automation_enrollments DROP COLUMN current_step;
