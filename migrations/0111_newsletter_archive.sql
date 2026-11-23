-- #481: public newsletter archive (/newsletter).
-- archive_slug          YYYY-MM-DD-<subject-slug>, set the first time an issue is published and
--                       never changed after (re-publishing restores the same URL). NULL = never.
-- archive_published_at  NULL = not in the archive (removed issues keep their slug).
-- archive_after_send    Compose's "Publish to newsletter archive after sending" (1 = publish
--                       when the campaign becomes 'sent', incl. scheduled sends).
-- templates.kind gains 'web' (the newsletter archive's web template); kind is free text, so no
-- schema change. Settings live in app_state (archive_enabled, archive_title, archive_intro,
-- archive_subscribe_url, archive_template_id, archive_indexable, archive_auto_groups).
ALTER TABLE campaigns ADD COLUMN archive_slug TEXT;
ALTER TABLE campaigns ADD COLUMN archive_published_at TEXT;
ALTER TABLE campaigns ADD COLUMN archive_after_send INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_archive_slug ON campaigns(archive_slug);
CREATE INDEX IF NOT EXISTS idx_campaigns_archive_published ON campaigns(archive_published_at);
