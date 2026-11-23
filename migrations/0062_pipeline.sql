-- #206 (part of #205): a sales pipeline. One card per contact (UNIQUE contact_id), sitting
-- in one stage. `pipeline_id` is fixed at 1 for now (room for more boards later).
-- `color` is a palette key (see src/lib/pipeline.ts STAGE_COLORS), never a raw colour.
CREATE TABLE pipeline_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO pipeline_stages (name, color, position, kind) VALUES
  ('Lead', 'muted', 0, 'open'),
  ('Qualified', 'viz-3', 1, 'open'),
  ('Proposal', 'viz-2', 2, 'open'),
  ('Negotiation', 'viz-1', 3, 'open'),
  ('Won', 'success', 4, 'won'),
  ('Lost', 'danger', 5, 'lost');

CREATE TABLE pipeline_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id),
  value INTEGER,                 -- whole currency units, NULL = not set
  note TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,  -- order within the stage column
  entered_stage_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pipeline_cards_stage ON pipeline_cards(stage_id, position);

-- Every add / move / remove. to_stage_id NULL = removed from the pipeline.
-- No FKs on purpose: history outlives the card (and survives a deleted contact's id).
CREATE TABLE pipeline_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  from_stage_id INTEGER,
  to_stage_id INTEGER,
  actor_kind TEXT NOT NULL,      -- user | automation | api | system
  actor_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pipeline_history_contact ON pipeline_history(contact_id, id);
