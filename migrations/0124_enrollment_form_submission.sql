-- #516 (Forms 4/7): the form submission that started an automation pass. Set by the
-- "Form submitted" trigger (`form_submitted`); NULL for every other trigger and for passes
-- from before this migration. A Condition step's `form_answer` rule reads this submission's
-- answers first, then the contact's latest submission to that form.
--
-- No FK: a submission pruned by the form's retention leaves a dangling id, and the rule then
-- falls back to the contact's latest submission (none = the rule is false).
ALTER TABLE automation_enrollments ADD COLUMN form_submission_id INTEGER;
