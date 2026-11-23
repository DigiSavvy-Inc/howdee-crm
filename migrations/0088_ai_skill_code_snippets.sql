-- #327: starter on-demand assistant skill for "Code & snippets" (Settings → Assistant →
-- Permissions). An ordinary ai_skills row (#302): editable, disableable and deletable in
-- Settings → Assistant → Skills. INSERT OR IGNORE, so an operator's own skill with this name
-- is kept as is. It only matters while code is enabled for the user; the prompt says so.
INSERT OR IGNORE INTO ai_skills (name, description, body, mode, enabled, sort) VALUES (
  'code-snippets',
  'Conventions for code the user asks for: email-safe HTML, Data API calls, the site tracking snippet, form hooks and webhook receivers.',
  'Use this when the user asks for code or a snippet and code is enabled for them. You write it; you never run it, and writing it never changes data.

## General
- One fenced block per file or snippet, with a language tag (`html`, `css`, `js`, `php`, `bash`, `json`, `sql`).
- A sentence or two before the block on what it does and where it goes. No long walkthroughs.
- Never put a real key, token or secret in code, even one you saw in a tool result. Use placeholders: `YOUR_API_KEY`, `YOUR_SITE_KEY`, `YOUR_INGEST_KEY`, `YOUR_WEBHOOK_SECRET`.
- Use `https://YOUR_APP_DOMAIN` for this app''s origin unless the user gave it.

## Email-safe HTML (blocks, templates)
- Layout with `<table role="presentation" cellpadding="0" cellspacing="0" border="0">`, not flex or grid. Max width 600px, centred.
- Inline CSS on every element (`style="…"`). A `<style>` block only for `@media (max-width:480px)` enhancements.
- No JavaScript, no forms, no external fonts, no background video. Images: absolute `https://` URLs, `alt`, `width` attribute, `style="display:block;border:0"`.
- Buttons: a table cell with a background colour and a padded `<a>` (bulletproof button). Colours as 6-digit hex.
- Keep merge tags verbatim: `{{first_name}}`, `{{company}}`, `{{field:<name>}}`; the unsubscribe footer is added by the app — don''t write one.

## Data API (`/api/v1`)
- Base: `https://YOUR_APP_DOMAIN/api/v1`. Auth header only: `Authorization: Bearer YOUR_API_KEY` (keys are made in Settings → API; `read` = GET, `read_write` = writes). Never a `?key=` query param.
- JSON in and out. Lists come back as `{ data, pagination: { limit, offset, total, has_more } }` (`limit` ≤ 200, `offset`); errors as `{ error }`.
- Common calls: `GET /contacts?email=…`, `POST /contacts` `{ email, first_name, tags: [] }`, `PATCH /contacts/:id`, `POST /automations/:id/enroll` `{ emails: [] }`, `POST /campaigns` `{ subject, body }` (a draft only — the API never sends).
- Show `curl` first, then `fetch` (JS) or PHP if asked.

## Form webhook (`/api/ingest`)
- `POST https://YOUR_APP_DOMAIN/api/ingest?key=YOUR_INGEST_KEY` with JSON or a normal form post: `{ email, first_name, last_name, company, list, tags, website }` (`website` is the honeypot — leave it empty).

## Site tracking snippet
- Install: `<script src="https://YOUR_APP_DOMAIN/t.js?k=YOUR_SITE_KEY" async></script>` before `</body>` (the exact tag is on Settings → Tracking).
- Custom events: `window.dsv = window.dsv || []; dsv.push([''track'', ''booked_call'', { plan: ''pro'' }]);` or `dsv.track(name, props)` once loaded.
- Identify after a form submit (e.g. WS Form success JS): post the form to `/api/ingest` with `site_key`, read `dsv_id` from the response, then `dsv.identify(dsv_id)`.
- Respect consent: `window.dsvConsent = false` turns it off.

## Webhook receivers (Slack, Zapier, Make, Node, PHP)
- Read the raw body first; verify `X-DS-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256 of `"<t>.<body>"` with `YOUR_WEBHOOK_SECRET`, constant-time compare, reject old timestamps.
- Reply 2xx fast; do slow work afterwards.',
  'on_demand', 1, 6
);
