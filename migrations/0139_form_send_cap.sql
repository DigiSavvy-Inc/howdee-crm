-- #744: a per-form daily cap on the emails submissions cause (confirmation emails, and first
-- writes of new addresses). A submission over the cap is stored but nothing runs for it until an
-- admin releases it from the form's Submissions tab.
--   held_at       set while held (NULL = not held)
--   released_at   when an admin released it; released_by = that user (no FK, like other audit ids)
-- The cap itself lives in the form's spec (`settings.daily_send_cap`, default 500, 0 = none).
ALTER TABLE form_submissions ADD COLUMN held_at TEXT;
ALTER TABLE form_submissions ADD COLUMN released_at TEXT;
ALTER TABLE form_submissions ADD COLUMN released_by INTEGER;
CREATE INDEX IF NOT EXISTS idx_form_submissions_held ON form_submissions(form_id, held_at) WHERE held_at IS NOT NULL;
