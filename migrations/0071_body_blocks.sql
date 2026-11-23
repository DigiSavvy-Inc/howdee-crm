-- #250: the visual editor's block document (JSON Block[], see src/lib/blocks.ts).
-- NULL = the row is markdown-only and sends from body_md exactly as before. When set,
-- sends render from these blocks and body_md holds a markdown export (search, API,
-- fallback). Additive; older code never reads it.
ALTER TABLE campaigns ADD COLUMN body_blocks TEXT;
ALTER TABLE automation_steps ADD COLUMN body_blocks TEXT;
