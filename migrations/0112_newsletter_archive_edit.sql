-- #483: a web-only version of a newsletter archive issue. The sent email (subject, body_blocks,
-- body_md, body_html) is never changed; the archive pages prefer these when archive_edited_at is set.
-- archive_title      the page title (NULL = the subject).
-- archive_teaser     meta description, index card and feed text (NULL = preheader, else the opening text).
-- archive_blocks     the body as editor blocks JSON (sanitised on save and on render); NULL = the email body.
-- archive_edited_at  when the web version was last saved; NULL = no web version (Reset clears all four).
-- (0109 is reserved for #372.)
ALTER TABLE campaigns ADD COLUMN archive_title TEXT;
ALTER TABLE campaigns ADD COLUMN archive_teaser TEXT;
ALTER TABLE campaigns ADD COLUMN archive_blocks TEXT;
ALTER TABLE campaigns ADD COLUMN archive_edited_at TEXT;
