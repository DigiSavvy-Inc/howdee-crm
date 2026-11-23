-- Forms: share & embed (#515). The page an embedded form was submitted from: embed.js passes the
-- host page's URL as `?page_url=` and the iframe posts it with the answers. NULL for the hosted
-- page (/f/<slug>) and for submissions from before this migration. Phase 1 stored only `referrer`.
ALTER TABLE form_submissions ADD COLUMN page_url TEXT;
