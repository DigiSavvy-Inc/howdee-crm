-- #589: ratings a contact gave us through a form's Rating question. One row per answered rating
-- question of a submission that resolved to a contact (anonymous submissions keep the rating on
-- the submission only). A history, not only the latest value.
--
--   contact_id     CASCADE: deleted with the contact
--   form_id        SET NULL: the rating outlives the form
--   submission_id  SET NULL: kept when the submission is pruned by the form's retention
--   field_key      the question's answer key; question = its text at submit time
--   value          the whole number given, within low..high (the scale: 1–5, 1–10 or 0–10)
--   style          stars | hearts | faces | numbers (how the card draws it)
CREATE TABLE IF NOT EXISTS contact_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  form_id INTEGER REFERENCES forms(id) ON DELETE SET NULL,
  submission_id INTEGER REFERENCES form_submissions(id) ON DELETE SET NULL,
  field_key TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  low INTEGER NOT NULL,
  high INTEGER NOT NULL,
  style TEXT NOT NULL DEFAULT 'stars' CHECK (style IN ('stars', 'hearts', 'faces', 'numbers')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_ratings_contact ON contact_ratings(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_ratings_submission ON contact_ratings(submission_id);
