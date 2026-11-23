-- #42: auto-tag a contact when they open/click an automation email step.
-- Stored on the email step; applied at Postmark webhook time (open/click), not at tick.
-- NULL / '' = disabled. Reuses lists(kind='tag') + list_members (no new tables).
ALTER TABLE automation_steps ADD COLUMN tag_on_open TEXT;   -- tag name to add when this step's email is opened
ALTER TABLE automation_steps ADD COLUMN tag_on_click TEXT;  -- tag name to add when a link in it is clicked
