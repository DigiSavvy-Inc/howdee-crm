-- #310 (Phase 4 of #71): thumbs up / down on assistant answers, so admins can see which
-- answers miss. Set on the last assistant row of a turn (the answer the panel shows).
-- feedback: 1 = 👍, -1 = 👎, NULL = none. Additive only.
ALTER TABLE ai_messages ADD COLUMN feedback INTEGER CHECK (feedback IN (1, -1));
ALTER TABLE ai_messages ADD COLUMN feedback_at TEXT;
CREATE INDEX idx_ai_messages_feedback ON ai_messages(feedback_at) WHERE feedback IS NOT NULL;
