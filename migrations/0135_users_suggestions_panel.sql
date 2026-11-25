-- #715: per-user "Show the suggestions panel" (Account). 1 = on (default), 0 = hidden for that user.
-- Reads tolerate the column being absent (a Worker that ships before this migration treats
-- everyone as on), like users.nav_layout (0046).
ALTER TABLE users ADD COLUMN suggestions_panel INTEGER NOT NULL DEFAULT 1;
