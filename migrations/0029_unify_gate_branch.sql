-- Unify condition gate steps (#13) into branch steps (#75/#76): a gate is exactly a
-- branch whose 'no' lane contains an 'end' step. This makes the false path visible and
-- editable in the branch tree instead of an invisible gate-fails-open-to-completed
-- outcome, and lets the engine drop its separate gate handler.
--
-- gate_kind/gate_name/gate_value already hold the condition (tag | no-tag |
-- field-exists | field-eq | field-contains | field-not-contains) — untouched; branchLabel()
-- already evaluates every one of those kinds the same way evalContactCondition (the old
-- gate evaluator) did, via the shared contact-condition fallthrough. `position` is sibling
-- order WITHIN a (parent_step_id, branch_label) group (#75/0025) — existing gates have no
-- children, so 0 is the correct first position in the new ('no') group.
--
-- Order matters: insert the 'no'-lane end child (keyed off the still-'gate' rows) BEFORE
-- flipping their type, then flip type='gate' -> 'branch'.

INSERT INTO automation_steps
  (automation_id, position, delay_before_seconds, type, subject, body_md, from_email, parent_step_id, branch_label)
SELECT automation_id, 0, 0, 'end', '', '', '', id, 'no'
FROM automation_steps
WHERE type = 'gate';

UPDATE automation_steps SET type = 'branch' WHERE type = 'gate';
