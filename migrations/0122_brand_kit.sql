-- #595: brand kit. The editors' colour swatches and logos used to be hardcoded in
-- src/lib/brand.ts (BRAND_SWATCHES, BRAND_LOGOS); they now live in app_state `brand_kit`
-- (JSON, $lib/brand-kit, Settings → Brand kit). The default app name moved to a neutral
-- value ("Email CRM" / "CRM").
--
-- The public newsletter archive's colours moved too: its built-in palette (WEB_DEFAULTS) is now
-- neutral, overridden key by key by app_state `newsletter_archive_theme` (JSON of hex colours).
--
-- An install that already holds data (any contact or campaign) keeps what it had with no
-- manual step: the old palette and logos are seeded into the kit, the archive's old Ourco
-- colours into `newsletter_archive_theme`, and app_name / app_short_name are set to the old
-- defaults when they are unset or blank. A fresh database (no contacts, no campaigns) gets
-- nothing here: a neutral palette and no logos.
-- Every statement is a no-op when its key already holds a value, so a re-run changes nothing.

INSERT INTO app_state (key, value, updated_at)
SELECT 'brand_kit',
  '{"swatches":[{"key":"warmInk","label":"Warm ink","hex":"#15130e"},{"key":"deepTeal","label":"Deep teal","hex":"#066971"},{"key":"teal","label":"Teal","hex":"#0ab5c2"},{"key":"cyan","label":"Brand cyan","hex":"#1a9ec4"},{"key":"ivory","label":"Ivory","hex":"#f5f3ed"},{"key":"warmSurface","label":"Warm surface","hex":"#ece8de"},{"key":"cream","label":"Cream","hex":"#f3efe6"},{"key":"warmGray","label":"Warm gray","hex":"#544e44"},{"key":"warmBrown","label":"Warm brown","hex":"#6a5e4e"},{"key":"coral","label":"CTA coral","hex":"#ce423b"},{"key":"gold","label":"Gold","hex":"#fcb900"},{"key":"white","label":"White","hex":"#ffffff"}],"logos":[{"key":"primary-white","label":"Primary logo (white)","src":"https://crm.myapp.example/img/logo-white.png","alt":"Ourco","background":"dark"},{"key":"primary","label":"Primary logo","src":"https://crm.myapp.example/img/logo.png","alt":"Ourco","background":"light"},{"key":"logomark","label":"Logomark","src":"https://crm.myapp.example/img/logomark.png","alt":"Ourco","background":"light"}]}',
  datetime('now')
WHERE (EXISTS (SELECT 1 FROM contacts) OR EXISTS (SELECT 1 FROM campaigns))
  AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'brand_kit');

INSERT INTO app_state (key, value, updated_at)
SELECT 'newsletter_archive_theme',
  '{"bg":"#f5f3ed","surface":"#ffffff","text":"#15130e","muted":"#544e44","hairline":"#ece8de","link":"#066971","brand":"#066971","onBrand":"#ffffff","cta":"#ce423b","darkBg":"#15130e","darkSurface":"#1f1c16","darkText":"#f5f3ed","darkMuted":"#b8b0a2","darkHairline":"#3a352c","darkLink":"#0ab5c2","darkOnBrand":"#15130e"}',
  datetime('now')
WHERE (EXISTS (SELECT 1 FROM contacts) OR EXISTS (SELECT 1 FROM campaigns))
  AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'newsletter_archive_theme');

INSERT INTO app_state (key, value, updated_at)
SELECT 'app_name', 'DS Email Marketing', datetime('now')
WHERE (EXISTS (SELECT 1 FROM contacts) OR EXISTS (SELECT 1 FROM campaigns))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE TRIM(COALESCE(app_state.value, '')) = '';

INSERT INTO app_state (key, value, updated_at)
SELECT 'app_short_name', 'DS Email', datetime('now')
WHERE (EXISTS (SELECT 1 FROM contacts) OR EXISTS (SELECT 1 FROM campaigns))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE TRIM(COALESCE(app_state.value, '')) = '';
