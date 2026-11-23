-- #585: replies sent from our own mail client join the thread they answer.
--
-- mail_messages.references_header: the raw References header of a synced Gmail message
-- (ids in angle brackets, oldest first). NULL = not fetched yet (stored before #585): the
-- Gmail tick backfills those, newest first, inside its per-tick budget, and writes '' when
-- the message has no References header, so each message is fetched once.
ALTER TABLE mail_messages ADD COLUMN references_header TEXT;

CREATE INDEX IF NOT EXISTS idx_mail_messages_refs_pending
  ON mail_messages (account_id, sent_at)
  WHERE references_header IS NULL;

-- replies.forward_message_id: Postmark's MessageID of the copy of this reply forwarded to the
-- operator's inbox (#381). Answering that forward from Gmail names it in In-Reply-To /
-- References, which is how the answer finds this reply's thread.
ALTER TABLE replies ADD COLUMN forward_message_id TEXT;
