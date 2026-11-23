-- #514 (Forms 2/7, conditional logic): which outcomes a submission fired.
-- form_submissions.outcomes  JSON array of outcome ids (`["default","low"]`), NULL on rows from
--                            before this migration (and on spam / rejected rows). The thanks page
--                            of a native post reads it to pick the message / redirect without
--                            evaluating the rules again (contact-aware rules can't be re-run there).
ALTER TABLE form_submissions ADD COLUMN outcomes TEXT;
