-- #621 (Forms epic #508, scoring #466): points for submitting a CRM form.
--
-- New scoring event `crm_form_submit` reads `form_submissions` (src/lib/server/scoring/engine.ts).
-- score_rules.created_at   when the rule was added (ISO, UTC). A `crm_form_submit` rule never
--                          awards points for submissions made before it. NULL (rules from before
--                          this migration) = no such limit.
--
-- Where the seeded "Lead score" still has its external-form (`form_submit`) rule and has no CRM
-- form rule yet, add "Submitted a CRM form": 20 points, expires after 180 days, last position.

ALTER TABLE score_rules ADD COLUMN created_at TEXT;

INSERT INTO score_rules (score_id, kind, label, event_type, filter, rules, points, expires_days, max_per_day, once, active, position, created_at)
SELECT d.id, 'event', 'Submitted a CRM form', 'crm_form_submit', NULL, NULL, 20, 180, NULL, 0, 1,
  (SELECT COALESCE(MAX(r.position), -1) + 1 FROM score_rules r WHERE r.score_id = d.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM score_defs d
WHERE d.slug = 'lead-score'
  AND EXISTS (SELECT 1 FROM score_rules r WHERE r.score_id = d.id AND r.event_type = 'form_submit')
  AND NOT EXISTS (SELECT 1 FROM score_rules r WHERE r.score_id = d.id AND r.event_type = 'crm_form_submit');
