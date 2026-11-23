-- #159: reply from the app, threaded.
--
-- replies.message_id_header — the inbound email's own RFC Message-ID header (angle brackets
-- stripped). Postmark's inbound `MessageID` is Postmark's id, not the sender's header, so a
-- reply we send back needs this for In-Reply-To/References to thread in their inbox.
-- Backfilled from the stored raw payload's Headers array where that JSON is still intact
-- (raw is truncated at 20 KB, so json_valid guards the rest; those stay NULL).
ALTER TABLE replies ADD COLUMN message_id_header TEXT;

UPDATE replies
SET message_id_header = (
	SELECT TRIM(REPLACE(REPLACE(json_extract(h.value, '$.Value'), '<', ''), '>', ''))
	FROM json_each(replies.raw, '$.Headers') h
	WHERE LOWER(json_extract(h.value, '$.Name')) = 'message-id'
	LIMIT 1
)
WHERE raw IS NOT NULL AND json_valid(raw);

-- campaigns.in_reply_to_message_id — set on a send made from a conversation's Reply box:
-- the Message-ID it answers. Lets conversations.ts thread that send into the right thread
-- exactly, instead of relying on the subject match (and its 30-day window).
ALTER TABLE campaigns ADD COLUMN in_reply_to_message_id TEXT;
