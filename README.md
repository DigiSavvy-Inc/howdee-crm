# Howdee CRM

Howdee CRM is a small self-hosted CRM and email marketing app for one team. Import contacts, group
them into lists, segments and tags, write emails in Markdown or a block editor, send them through
Postmark, run drip automations, capture replies, and keep a pipeline of deals, all on your own
Cloudflare account.

It runs on Cloudflare Workers with D1 (database) and R2 (media and backups). Postmark does the
sending. At small volume both fit in the free tiers.

## What you need

- A Cloudflare account with Workers, D1 and R2 enabled (the free plan is enough to start).
- A Postmark account with one server, a verified sending domain, a broadcast message stream and a
  transactional message stream.
- Node.js 20 or newer on the machine you deploy from.

Everything else is optional and off until you configure it: GitHub sign-in, Gmail sync, the AI
assistant (an Anthropic API key), Luma event registrants, Timing and GitHub on company records, a
custom domain, and a newsletter archive served from your own site.

## Install

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DigiSavvy-Inc/howdee-crm)

**With the button:** click **Deploy to Cloudflare**, sign in, type a setup phrase in the one field
(`SETUP_TOKEN`), and wait for the build. Then open the app and create the first admin at `/setup`
with that phrase. The build is designed to create the database and bucket, apply the migrations and
generate every other secret. The button is new and still being tested on a fresh account; the
terminal path below (`npm run deploy`) is the tested one. Cloudflare can take up to 15 minutes to start the app's once-a-minute clock on a
new install; Settings → Setup shows when it has.

**From a terminal:**

```sh
git clone <repository url> howdee-crm && cd howdee-crm
npm install
npx wrangler login
npm run deploy
```

The deploy creates the database and bucket, applies the migrations, uploads the app, generates its
secrets and prints a one-time setup link. Open it and create the first admin. The app's
**Settings → Setup** page walks you through connecting Postmark and checks the install afterwards.

Every install runs its own once-a-minute clock (`triggers.crons` in `wrangler.jsonc`), so there is no
second Worker to deploy. The separate heartbeat Worker is optional.

To choose every name and secret yourself, use the manual steps in
[Install by hand](docs/self-hosting.md#9-install-by-hand). The
[self-hosting guide](docs/self-hosting.md) covers all three, plus the optional parts and how to
remove an install.

## Features

- **Contacts**: CSV import with column mapping and dedupe, editable records with custom fields,
  companies grouped from the company name, avatars resolved server-side and cached in R2, archive
  and restore, bulk actions on any selection or on everything matching a filter.
- **Lists, segments and tags**: hand-picked lists and segments, rule-based segments that update
  themselves (subscription, engagement, tags, lists, fields, company, pipeline, scores), a
  filterable member table on every group, and a bulk bar that adds, removes, tags, enrolls and
  excludes from a segment.
- **Companies and pipeline**: company records with domains, notes, linked people and activity; a
  kanban board of deals with stages, values, owners and history.
- **Campaigns**: a Markdown composer with live preview, a block editor with templates, a global
  header and footer, conditional content, merge tags, test sends, scheduling, resend to
  non-openers, and pre-send checks for links and placeholders.
- **Sending and tracking**: batch sends through Postmark, a personalised unsubscribe link and
  RFC 8058 List-Unsubscribe headers on every broadcast, an unsubscribe page that records the
  reason, optional double opt-in, open, click, bounce, spam complaint and subscription events from
  the Postmark webhook, suppression sync, and a deliverability page with DKIM and Return-Path
  checks.
- **Automations**: drip flows on a visual canvas with email, tag, wait, condition and branch steps,
  triggers for list membership, opens, clicks, site visits, pipeline stages and subscription
  changes, entry conditions, re-entry policy and per-contact history. A separate one-file cron
  Worker drives the engine.
- **Engagement and scoring**: hot, warm, cool and cold tiers from opens and clicks, named scores
  with point rules, expiry and bands, usable in segments and automation conditions.
- **Replies and conversations**: replies to your emails arrive through Postmark Inbound, attach
  to the contact and campaign, show up in Conversations, and can be forwarded to your inbox.
  Optional Gmail sync shows your own mail with contacts.
- **Forms**: a form builder with conditional logic, hosted at `/f/<slug>` or embedded, that creates
  or updates contacts, tags them, adds them to lists and can start automations.
- **Newsletter archive**: a public page and RSS feed of the broadcasts you choose, rendered from a
  web template, optionally served from a path on your own site.
- **Site tracking**: a snippet for your own sites that records page views and events for known
  contacts (honours Do Not Track and Global Privacy Control), with a "visits a page" automation
  trigger.
- **Reports**: a report builder over email, contacts, site, pipeline and integration data, with
  saved reports and results that can become a segment or list.
- **AI assistant** (optional): answers questions about your data, edits records with undo, and
  drafts campaigns and automations. It never sends, schedules, activates or enrolls.
- **Data API, MCP server and CLI**: `/api/v1/*` with scoped keys, a remote MCP server at `/mcp` for
  Claude Code and Claude Desktop, and `scripts/dscrm.mjs` for shell use. See
  [Connect an AI assistant](docs/connect-an-assistant.md) and **Settings → API** inside the app.
- **Backups**: a nightly export of every table to R2, plus D1's 30-day point-in-time restore.

## Local development

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc        # local D1 only needs the database_name
cp .dev.vars.reference .dev.vars                # fill in SESSION_SECRET and SETUP_TOKEN at least
npx wrangler d1 migrations apply <database_name> --local
npm run dev
```

Open http://localhost:5173, which redirects to `/setup` while there are no users. Create the first
admin there with the `SETUP_TOKEN` from `.dev.vars`. The Postmark test token `POSTMARK_API_TEST`
validates sends without delivering anything. Automations need a tick; locally you can trigger one
with:

```sh
curl -X POST -H "Authorization: Bearer <CRON_KEY>" http://localhost:5173/api/automations/tick
```

After `npm run build`, `npx wrangler dev --test-scheduled` runs the built Worker and
`curl http://localhost:8787/__scheduled` fires its built-in clock once (no `CRON_KEY` needed; it
needs `PUBLIC_BASE_URL` or a Settings → Domain value, or it skips the tick).

`npm run check` type-checks the project and `npm test` runs the test suite inside a local
Workers runtime with a real D1.

## Updating

```sh
git pull
npm ci
npm run deploy
```

`npm run deploy` applies any new migrations to the production database first, then builds and
uploads the Worker, so the schema is never behind the code. An install made with the button updates by
bringing the new release into its own repository copy; Workers Builds then runs the same deploy
([Upgrading](docs/self-hosting.md#upgrading); those steps are not tested yet). Redeploy the heartbeat Worker only when
`heartbeat/` changed. Never run a migration file's SQL by hand; `wrangler d1 migrations apply` is
the only supported path.

## Contributing

Pull requests run `npm run check` and `npm test` in CI. Schema changes are new numbered files in
`migrations/`; applied files are never edited.

- [AGENTS.md](AGENTS.md): how the code is laid out, how to run and test it, and the rules for
  coding agents (and people) working in it.
- [Design notes](docs/design-notes.md): the design tokens in `src/app.css` and the house rules
  for new UI.
- [Connect an AI assistant](docs/connect-an-assistant.md): MCP and Data API access with scoped
  keys.
- [Third-party notices](THIRD_PARTY_NOTICES.md): the bundled font and the icon set, with their
  licences.

## License

Copyright (c) 2026 DigiSavvy

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License, version 3, as published by the Free Software Foundation. It is
distributed without any warranty. See [LICENSE](LICENSE) for the full text.
