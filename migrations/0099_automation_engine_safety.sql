-- #395: automation engine safety. Additive only.
--
-- recipients.enrollment_id — the automation pass (automation_enrollments.id) a step send
-- belongs to, so the engine's "already sent" guard is per pass, not per contact: a
-- re-entered contact ('multiple') gets the email again. No FK on purpose (recipients keep
-- their history when an enrollment row goes). NULL on every broadcast / 1:1 row and on
-- automation rows written before this migration — the engine treats such a NULL row as
-- "already sent" for the contact's FIRST pass only (today's behaviour), never later ones.
--
-- recipients.enrollment_visit — the pass's jump_count at send time. Revisiting a step in the
-- same pass needs a go-to jump (jump_count + 1), so a go-to loop sends the email again
-- while a crash-retry of the same visit (same jump_count) still de-dupes.
ALTER TABLE recipients ADD COLUMN enrollment_id INTEGER;
ALTER TABLE recipients ADD COLUMN enrollment_visit INTEGER;
CREATE INDEX idx_recipients_campaign_enrollment ON recipients(campaign_id, enrollment_id);

-- automation_steps.ready — 0 = added in the builder but never saved with a valid
-- configuration. The engine holds contacts at a not-ready step (no send, no advance,
-- last_error 'Step not finished') until it is saved or deleted. Existing steps are ready.
ALTER TABLE automation_steps ADD COLUMN ready INTEGER NOT NULL DEFAULT 1;
