-- One campaigns row per automation step. Guarantees that concurrent ticks (or an
-- overlapping heartbeat) can't create two campaign rows for the same step and split
-- its stats. Partial index: only automation step-campaigns are constrained; ordinary
-- broadcast/1:1 campaigns leave automation_step_id NULL and are unaffected.
CREATE UNIQUE INDEX idx_campaigns_step
  ON campaigns(automation_step_id)
  WHERE automation_step_id IS NOT NULL;
