-- #64: per-template control over the global email header/footer (stored in app_state
-- as keys global_email_header / global_email_footer, blocks JSON). Default = included.
ALTER TABLE templates ADD COLUMN use_global_header INTEGER NOT NULL DEFAULT 1;
ALTER TABLE templates ADD COLUMN use_global_footer INTEGER NOT NULL DEFAULT 1;
