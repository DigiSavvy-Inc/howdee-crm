-- #287 (Phase 1 of #71): the in-app AI assistant. One thread = one conversation of one
-- signed-in user; messages hold Anthropic content blocks as JSON. `ai_actions` is the
-- audit log + undo store for the write tools of Phase 2 — created now so Phase 2 needs no
-- migration; Phase 1 tools are read-only and never write to it.
-- Spend: cost_micros = millionths of a US dollar, priced from src/lib/ai-models.ts.
CREATE TABLE ai_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  effort TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_threads_user ON ai_threads(user_id, updated_at);

-- role: user (typed by the person) | assistant (model output) | tool (tool_result blocks,
-- sent to the API as a user turn). Usage columns are set on assistant rows only.
CREATE TABLE ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  page_context TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_messages_thread ON ai_messages(thread_id, id);
CREATE INDEX idx_ai_messages_created ON ai_messages(created_at);

CREATE TABLE ai_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  input TEXT,
  status TEXT NOT NULL CHECK (status IN ('applied', 'pending', 'approved', 'cancelled', 'undone', 'failed')),
  before TEXT,
  after TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_ai_actions_thread ON ai_actions(thread_id);
