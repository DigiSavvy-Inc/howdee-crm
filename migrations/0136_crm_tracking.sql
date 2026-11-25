-- #701 (2/5 of #699): open and click tracking done by the CRM (docs/sending-providers.md →
-- Open and click tracking by the CRM). Additive only.
--
-- recipients.track_id = the random id inside a message's signed pixel / click links
-- (/t/o/<token>, /t/c/<token>). Set only on messages the CRM tracked; NULL = the provider
-- tracked it (or nobody did). A tracked row's provider open / click events are ignored, so
-- nothing is counted twice.
ALTER TABLE recipients ADD COLUMN track_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_recipients_track_id ON recipients(track_id) WHERE track_id IS NOT NULL;
