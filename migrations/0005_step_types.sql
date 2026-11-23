-- Automation step types (epic #25 / issue #27).
-- Steps can now be an email (the original behavior) OR a tag action that adds/removes a
-- tag on the enrolled contact. Existing rows default to 'email'. subject/body_md/from_email
-- stay NOT NULL — tag steps just store '' for them and the engine never sends from them.
ALTER TABLE automation_steps ADD COLUMN type TEXT NOT NULL DEFAULT 'email';  -- 'email' | 'tag'
ALTER TABLE automation_steps ADD COLUMN tag_action TEXT;                     -- 'add' | 'remove' (tag steps)
ALTER TABLE automation_steps ADD COLUMN tag_name TEXT;                       -- the tag for the action
