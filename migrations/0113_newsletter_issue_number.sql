-- #499: newsletter archive issue numbers. Set on first publish (MAX + 1), kept when the issue is
-- removed from the archive, editable on the archive edit page (blank = no number).
-- (0109 is reserved for #372.)
ALTER TABLE campaigns ADD COLUMN archive_number INTEGER;
CREATE UNIQUE INDEX idx_campaigns_archive_number ON campaigns(archive_number) WHERE archive_number IS NOT NULL;
