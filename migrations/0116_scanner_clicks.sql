-- #518: security-scanner clicks (Safe Links, Proofpoint, Mimecast …) get their own event type.
-- Backfill of the webhook rules (`classifyScannerClicks` in src/lib/server/engagement.ts) with
-- the default constants: a window opens at each click of a recipient and runs 10 s, and a window
-- holding 3+ distinct links, or our unsubscribe link plus any other link, turns every click in
-- it into `scanner_click`. A remaining click on our unsubscribe link becomes `unsubscribe_click`
-- (a page view, not engagement). Then the cached engagement / score rows of the affected
-- contacts are marked dirty and the heartbeat recomputes them. Safe to run twice.
-- (0109 is reserved for #372, 0114 and 0115 are taken by open PRs.)

-- Per-recipient lookups below and in the webhook's reclassifyScannerClicks would otherwise walk every click via idx_events_type.
CREATE INDEX IF NOT EXISTS idx_events_recipient_type_time ON events(recipient_id, type, recorded_at);

UPDATE events SET type = 'scanner_click'
WHERE type = 'click' AND recipient_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM events a
    WHERE a.recipient_id = events.recipient_id
      AND a.type IN ('click', 'scanner_click')
      AND a.recorded_at <= events.recorded_at
      AND events.recorded_at <= datetime(a.recorded_at, '+10 seconds')
      AND (
        (SELECT COUNT(DISTINCT CASE WHEN json_valid(w.detail) THEN json_extract(w.detail, '$.OriginalLink') END)
           FROM events w
          WHERE w.recipient_id = a.recipient_id AND w.type IN ('click', 'scanner_click')
            AND w.recorded_at >= a.recorded_at AND w.recorded_at <= datetime(a.recorded_at, '+10 seconds')) >= 3
        OR (
          EXISTS (SELECT 1 FROM events w
                   WHERE w.recipient_id = a.recipient_id AND w.type IN ('click', 'scanner_click')
                     AND w.recorded_at >= a.recorded_at AND w.recorded_at <= datetime(a.recorded_at, '+10 seconds')
                     AND json_valid(w.detail)
                     AND ((CASE WHEN json_valid(w.detail) THEN json_extract(w.detail, '$.OriginalLink') END) LIKE '%/unsubscribe?%t=%'
                          OR (CASE WHEN json_valid(w.detail) THEN json_extract(w.detail, '$.OriginalLink') END) LIKE '%/unsubscribe/one-click%'))
          AND EXISTS (SELECT 1 FROM events w
                   WHERE w.recipient_id = a.recipient_id AND w.type IN ('click', 'scanner_click')
                     AND w.recorded_at >= a.recorded_at AND w.recorded_at <= datetime(a.recorded_at, '+10 seconds')
                     AND json_valid(w.detail) AND (CASE WHEN json_valid(w.detail) THEN json_extract(w.detail, '$.OriginalLink') END) IS NOT NULL
                     AND (CASE WHEN json_valid(w.detail) THEN json_extract(w.detail, '$.OriginalLink') END) NOT LIKE '%/unsubscribe?%t=%'
                     AND (CASE WHEN json_valid(w.detail) THEN json_extract(w.detail, '$.OriginalLink') END) NOT LIKE '%/unsubscribe/one-click%')
        )
      )
  );

UPDATE events SET type = 'unsubscribe_click'
WHERE type = 'click' AND json_valid(detail)
  AND ((CASE WHEN json_valid(detail) THEN json_extract(detail, '$.OriginalLink') END) LIKE '%/unsubscribe?%t=%'
       OR (CASE WHEN json_valid(detail) THEN json_extract(detail, '$.OriginalLink') END) LIKE '%/unsubscribe/one-click%');

-- Points the scoring engine (#466) gave for those rows.
DELETE FROM score_points
WHERE source_type = 'events'
  AND source_id IN (SELECT CAST(id AS TEXT) FROM events WHERE type IN ('scanner_click', 'unsubscribe_click'));

UPDATE contact_scores SET dirty = 1
WHERE contact_id IN (SELECT contact_id FROM events WHERE type IN ('scanner_click', 'unsubscribe_click') AND contact_id IS NOT NULL);

-- Engagement rollup (#111): score, tier, click counts, last click, histograms.
UPDATE contact_engagement SET dirty = 1
WHERE contact_id IN (SELECT contact_id FROM events WHERE type IN ('scanner_click', 'unsubscribe_click') AND contact_id IS NOT NULL);
