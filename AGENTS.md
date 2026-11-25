# AGENTS.md

A guide for coding agents (and people) working in this repository. Read it before you change
anything. For installing a production copy, see [docs/self-hosting.md](docs/self-hosting.md).

## What this is

Howdee CRM is a small self-hosted CRM and email marketing app for one team:
contacts, lists, segments and tags, campaigns written in Markdown or a block editor, drip
automations, reply capture, a deals pipeline, forms, reports and an optional AI assistant. Email is
sent through Postmark. Everything runs on one Cloudflare account.

## Stack

- **SvelteKit** with **Svelte 5 runes**, built with `@sveltejs/adapter-cloudflare` for **Workers**.
  Server routes (`+page.server.ts`, `+server.ts`) are the Worker; there is no separate API server.
- **Cloudflare D1** (SQLite) for all data, binding `DB`. **R2** for media and backups, binding `MEDIA`.
- **Postmark** for sending (a broadcast stream and a transactional stream) and for tracking webhooks.
- The tick runs once a minute. A new install uses the app Worker's own clock: `npm run build` wraps
  the SvelteKit build (`scripts/wrap-worker.mjs`) so the Worker has a `scheduled` handler that runs
  the tick in-process, and `triggers.crons` fires it (#729). The older setup, a second tiny Worker in
  `heartbeat/` that POSTs the tick endpoint with `CRON_KEY`, still works.
- **Vanilla scoped CSS** in components plus global tokens in `src/app.css`. No Tailwind, no CSS
  framework. See [docs/design-notes.md](docs/design-notes.md).
- The block editor is the npm package `@digisavvy/block-editor`. Editor changes belong in that
  package, not in a local copy here.
- TypeScript everywhere, Vitest for tests.

## Install and run locally

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc        # local D1 only needs the database_name
cp .dev.vars.reference .dev.vars                # fill in SESSION_SECRET and SETUP_TOKEN at least
npx wrangler d1 migrations apply <database_name> --local
npm run dev                                     # http://localhost:5173
```

With no users yet, the app sends you to `/setup` to create the first admin with the `SETUP_TOKEN`
from `.dev.vars`. Use Postmark's test token locally: it validates sends without delivering them.
Automations need a tick; locally, trigger one by hand:

```sh
curl -X POST -H "Authorization: Bearer <CRON_KEY>" http://localhost:5173/api/automations/tick
```

## Check and test

```sh
npm run check     # wrangler types + svelte-kit sync + svelte-check
npm test          # Vitest inside workerd with a real D1
npm run build     # production build
```

All three must pass before a change is done. CI runs `npm run check` and `npm test` on every pull
request. After editing `wrangler.jsonc` or `.dev.vars`, run `npx wrangler types` (part of
`npm run check`) so the generated `Env` type is current.

`svelte-check` may report hundreds of errors under `.svelte-kit/output` after a build. Those are
bundled files, not source; ignore anything under `.svelte-kit/` or delete those folders first.

## Tests run in workerd

Tests run inside the Workers runtime (`@cloudflare/vitest-pool-workers`, see `vitest.config.ts`),
against a real local D1 with every migration applied (`tests/apply-migrations.ts`). That means:

- **No Node APIs.** No `node:fs`, `node:path`, `child_process` and so on inside a test. To read a
  file's text, import it with Vite's `?raw` suffix (`import doc from '../README.md?raw'`) or use
  `import.meta.glob(..., { query: '?raw', eager: true })`.
- Scripts under `scripts/` that need the file system keep their pure logic in a `*-lib.mjs` module
  with no I/O, and the tests import that module. Follow the same split for new scripts.
- Tests don't get a fresh database each. Create the rows a test needs and don't depend on row
  counts another test may change.
- Fixture data uses invented values: domains under `.example` or `.test`, `example.com`, made-up
  names. Never paste real addresses, hosts, ids or keys into a test, comment or help text.
- Form POSTs in tests need a matching `Origin` header (the app checks it on form actions).

Add or update tests whenever you touch the automation engine, sending, ingest, membership helpers,
permissions or anything a scheduled tick runs.

## Adding a migration

- Schema changes are a **new numbered file** in `migrations/` (`NNNN_short_name.sql`, the next
  number). Never edit a migration that has been applied anywhere.
- Apply it with `npx wrangler d1 migrations apply <database_name> --local`. That command is the
  only way a migration is run: it records the file in `d1_migrations` and skips it next time.
  Never paste a migration's SQL into `wrangler d1 execute`.
- Production gets migrations through `npm run deploy`, which applies them remotely before it
  builds and uploads the Worker. Don't deploy with a bare `wrangler deploy`.
- Code that reads a new column should survive a Worker that briefly runs before its migration
  where that matters (a signed-in page that 500s is worse than a missing feature).
- A new table or column that holds a secret must be added to the backup exclusions in
  `src/lib/server/backups.ts`.

## Where things live

```
migrations/              D1 schema, numbered
heartbeat/               the optional cron Worker that POSTs /api/automations/tick
scripts/                 deploy, restore, CLI (dscrm.mjs), wrap-worker (the build's scheduled
                         handler, #729); pure logic in *-lib.mjs
src/app.css              design tokens + base element styles
src/hooks.server.ts      session auth, public-route list, CSRF/origin checks, security headers
src/lib/                 code shared by server and browser (pure helpers, vocabulary)
src/lib/components/      Svelte components (StatGroup, BulkBar, Modal, Icon, ...)
src/lib/icons/glyphs.ts  the app's icon set
src/lib/server/          server-only modules (database queries, sending, engine, integrations)
src/lib/server/ai/       the AI assistant: provider, loop, tools
src/lib/server/mcp/      the MCP server
src/routes/              pages and endpoints; src/routes/api/v1/ is the Data API
tests/                   Vitest suites (*.test.ts)
docs/                    self-hosting, backups, the feature checklist and these notes
```

Useful landmarks:

- `src/lib/server/send.ts`: the shared send path (`sendCampaignEmail`). Campaigns, automation
  emails, 1:1 replies, double opt-in and account emails go through it; test sends, reply forwards
  and form notifications call `sendBatch` in `src/lib/server/postmark.ts` directly.
- `src/lib/server/automations.ts`: the automation engine (`enroll`, `tick`).
- `src/lib/server/automation-write.ts`: the one place automations are edited.
- `src/lib/server/contact-bulk.ts`, `contact-write.ts`: contact writes shared by the UI and API.
- `src/routes/api/automations/tick/+server.ts`: everything the heartbeat runs.

Before adding a feature, walk [docs/FEATURE_CHECKLIST.md](docs/FEATURE_CHECKLIST.md): it lists the
subsystems a change tends to touch (migrations, the send path, automation enrollment, group kinds,
public routes and secrets, frontend conventions).

## Conventions

- Type D1 queries: `.all<Row>()` / `.first<Row>()`. Untyped rows fail the Svelte type check.
- Bind every value in SQL. Never build SQL from user input by string concatenation.
- Lists, segments, tags and companies share the `lists` table with a `kind` column. Any new query
  on `lists` must filter by `kind` on purpose.
- An archived contact is never sent to. Any new contact or recipient query decides about
  `contacts.archived_at`.
- A new admin-only page checks the role in `load` **and** in every form action.
- A new public, machine-called route goes in `PUBLIC_PREFIXES` in `src/hooks.server.ts` and is
  gated by its own key.
- Use `publicBaseUrl` (`src/lib/server/public-url.ts`) for any absolute link to the app; don't
  read `PUBLIC_BASE_URL` directly.
- A new optional integration stays quiet when it isn't configured: no throw, no outbound request,
  no log line per tick, and its settings page says it isn't set up.
- Pair drag-and-drop with buttons (touch and keyboard).
- No emoji or dingbats in UI text; use `Icon.svelte` (a test enforces this).

## Safety rules

These are hard rules. Tests guard most of them; don't weaken a test to get past one.

- **The AI assistant never sends, test-sends, schedules, activates an automation or enrolls a
  contact.** Nothing under `src/lib/server/ai/` may import the send path, Postmark, the scheduler,
  resends or the automation engine; `tests/ai-no-send.test.ts` checks every import in that folder.
  Assistant writes pass the opt-outs that stop them from firing automation triggers. The same holds
  for the MCP server (`tests/mcp.test.ts`) and the Data API's draft endpoints: they create and edit
  drafts, a person sends.
- **Never commit secrets.** `.dev.vars`, `wrangler.jsonc` values you were given privately, API
  keys, tokens, passwords and contact exports (`*.csv`) stay out of git. New secrets are named in
  `.dev.vars.reference` with a required / optional comment and set in production with
  `wrangler secret put`. Never print, log or echo a secret's value.
- **Never send real email from development or tests.** Use Postmark's test token locally.
- Only send to contacts who opted in; keep the unsubscribe link and `List-Unsubscribe` headers on
  every broadcast.
- Don't run migrations by hand, don't deploy without `npm run deploy`, and don't touch a
  production database unless a person asked you to.
- Keep changes scoped to the task. Don't reformat or rewrite unrelated files.

## Related docs

- [README.md](README.md): what the app does and how to update it.
- [docs/self-hosting.md](docs/self-hosting.md): installing a production copy.
- [docs/design-notes.md](docs/design-notes.md): tokens and house rules for new UI.
- [docs/connect-an-assistant.md](docs/connect-an-assistant.md): connecting an AI assistant over MCP
  or the Data API.
- [docs/backups.md](docs/backups.md): backups and restore.
