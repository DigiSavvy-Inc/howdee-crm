-- #157: Conversations. The inbound payload's In-Reply-To header (angle brackets stripped),
-- when present — matched against recipients.message_id for exact reply threading.
-- NULL for replies captured before this migration or sent without the header.
ALTER TABLE replies ADD COLUMN in_reply_to_message_id TEXT;
