-- #552: assistant-caused score changes never enroll anyone through a `score_changed` trigger.
--
-- contact_scores.trigger_quiet   1 = the next recompute of this contact × score was caused by
--                                the assistant (add_score_points, its Undo, or points earned
--                                from a quiet source row below). Set by markPairsDirty({ quiet }),
--                                cleared by the recompute. Sticky until then: a change computed
--                                together with an assistant one is never attributed elsewhere.
-- score_change_events.quiet      copied from the flag; the heartbeat drains these rows without
--                                enrolling (src/lib/server/score-trigger.ts). The score and its
--                                history (ledger, prev_value / changed_at) change as usual.
-- score_quiet_sources            scoring source rows the assistant wrote (list_members rowids,
--                                pipeline_history ids). Points the engine awards for them mark
--                                the pair quiet. Pruned after 370 days (a rebuild replays 365).
ALTER TABLE contact_scores ADD COLUMN trigger_quiet INTEGER NOT NULL DEFAULT 0;
ALTER TABLE score_change_events ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
CREATE TABLE score_quiet_sources (
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id)
);
CREATE INDEX idx_score_quiet_sources_created ON score_quiet_sources (created_at);
