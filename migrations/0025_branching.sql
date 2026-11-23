-- #75: branching automations. Steps become a tree: trunk steps have parent_step_id NULL;
-- a step of type 'branch' evaluates a condition and routes each enrollment down its
-- labeled child path ('yes' / 'no'), which re-joins the parent flow when it runs out of
-- steps. `position` orders siblings WITHIN a (parent_step_id, branch_label) group.
ALTER TABLE automation_steps ADD COLUMN parent_step_id INTEGER REFERENCES automation_steps(id);
ALTER TABLE automation_steps ADD COLUMN branch_label TEXT;   -- 'yes' | 'no' under a branch parent; NULL on the trunk
ALTER TABLE automation_steps ADD COLUMN gate_ref_id INTEGER; -- list id (gate_kind='list-member') or email step id ('opened'/'clicked')
ALTER TABLE automation_steps ADD COLUMN split_pct INTEGER;   -- % routed to YES for gate_kind='split' (A/B)

-- Which way each enrollment went at each branch — feeds per-branch analytics (#76).
CREATE TABLE automation_branch_hits (
  step_id INTEGER NOT NULL REFERENCES automation_steps(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                               -- 'yes' | 'no'
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (step_id, enrollment_id)
);
