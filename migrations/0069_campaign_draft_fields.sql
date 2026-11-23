-- #240: drafts keep everything compose collects, so a saved draft (or a scheduled
-- campaign flipped back to draft for editing) reopens in compose exactly as entered.
-- Additive; older code never reads these columns.
ALTER TABLE campaigns ADD COLUMN preheader TEXT;        -- inbox preview text
ALTER TABLE campaigns ADD COLUMN template_id INTEGER;   -- compose "Start from" template; no FK (a deleted template just won't preselect)
ALTER TABLE campaigns ADD COLUMN resend_delay TEXT;     -- compose auto-resend choice: NULL/'' off | '24h' | '3d' | 'custom' (custom time = resend_at)
