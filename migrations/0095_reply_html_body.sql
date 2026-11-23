-- #380: the HTML a captured reply's text was converted from, for the Conversations
-- "View original" toggle (rendered in a sandboxed iframe). NULL = the text was already plain
-- (StrippedTextReply / a real TextBody). Additive only; existing rows stay NULL and fall back
-- to their stored text when that text is itself HTML.
ALTER TABLE replies ADD COLUMN html_body TEXT;
