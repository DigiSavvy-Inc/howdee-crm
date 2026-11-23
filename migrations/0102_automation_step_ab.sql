-- #398: subject / content A/B on an automation email step. Additive only.
--
-- Variant A is the step's own subject / preheader / body. Variant B is stored next to it:
-- ab_subject (required while the test runs), ab_preheader and ab_body_md (NULL = same as A).
-- ab_enabled = 1 while the test runs: each pass gets A or B by a stable hash of
-- (enrollment id, step id), 50/50. Picking a winner copies B into the step when B wins, turns
-- the test off and records ab_winner ('a' | 'b') + ab_decided_at; B's copy is kept for history.
ALTER TABLE automation_steps ADD COLUMN ab_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_steps ADD COLUMN ab_subject TEXT;
ALTER TABLE automation_steps ADD COLUMN ab_preheader TEXT;
ALTER TABLE automation_steps ADD COLUMN ab_body_md TEXT;
ALTER TABLE automation_steps ADD COLUMN ab_winner TEXT;
ALTER TABLE automation_steps ADD COLUMN ab_decided_at TEXT;

-- Which variant a step send used ('a' | 'b'); NULL = no test was running.
ALTER TABLE recipients ADD COLUMN ab_variant TEXT;
