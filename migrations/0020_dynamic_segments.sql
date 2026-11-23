-- #66: dynamic segments. A segment (kind='segment') with rules is computed from the
-- live contact set instead of hand-picked list_members. NULL rules = classic segment.
ALTER TABLE lists ADD COLUMN rules TEXT;
