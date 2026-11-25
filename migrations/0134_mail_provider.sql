-- #700 (1/5 of #699): sending providers. Every stored provider message id now records which
-- provider holds it, so events for mail sent before a switch still map back after it
-- (docs/sending-providers.md → Switching providers). Additive only.
--
-- recipients.message_id (the webhook join key) → recipients.provider. Every row sent before
-- this migration went through Postmark, hence the default.
ALTER TABLE recipients ADD COLUMN provider TEXT NOT NULL DEFAULT 'postmark';

-- replies.forward_message_id (#585, the forwarded copy's id) → replies.forward_provider.
ALTER TABLE replies ADD COLUMN forward_provider TEXT;
UPDATE replies SET forward_provider = 'postmark' WHERE forward_message_id IS NOT NULL AND forward_provider IS NULL;
