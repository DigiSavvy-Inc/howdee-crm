-- #134: per-user nav layout preference — 'top' (default, the classic header) or 'left' (sidebar).
ALTER TABLE users ADD COLUMN nav_layout TEXT NOT NULL DEFAULT 'top';
