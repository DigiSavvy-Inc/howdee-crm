-- #413: "Added to segment" for rule-based segments. Those have no list_members rows, so the
-- heartbeat polls their membership and diffs it against this snapshot. Additive only.

-- The members last seen, per automation whose trigger is a rule-based segment. A contact who
-- matches and has no row is a new entrant; a row whose contact no longer matches is dropped
-- (so leaving and coming back is a new entry).
CREATE TABLE segment_trigger_members (
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (automation_id, contact_id)
);

-- Which segment the snapshot above was taken for. No row (or another list id) = take a fresh
-- baseline without enrolling anyone: the people already in the segment are not "new".
CREATE TABLE segment_trigger_state (
  automation_id INTEGER PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL,
  baselined_at TEXT NOT NULL DEFAULT (datetime('now'))
);
