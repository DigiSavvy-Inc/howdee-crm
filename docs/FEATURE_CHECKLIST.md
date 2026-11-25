# Feature checklist

Run this for **every** feature before you call it done. It exists because subsystems
in this app are easy to miss until production bites — e.g. shipping automations was
"finished" locally three times before the Cloudflare **1042** same-zone rule surfaced
on the live workers.dev domain. Walk all ten sections; check what applies, note what
doesn't.

Most features here are some flavor of "a thing that groups or messages contacts," so
the same handful of seams come up again and again.

---

## 1. Data & migrations
- [ ] Schema change → a new **numbered** file in `migrations/` (never edit an applied one, and never run the SQL by hand — only `wrangler d1 migrations apply`).
- [ ] Apply to **local** (`wrangler d1 migrations apply postmark-marketing --local`) **and**, at deploy, **remote** (`--remote`). Local and remote D1 are separate databases.
- [ ] Run `npx wrangler types` after any schema or `wrangler.jsonc`/`.dev.vars` change.
- [ ] **Reuse before adding.** `lists(kind=…)` + `list_members` already model every group (lists, segments, tags). Don't add a parallel grouping table without a real reason.
- [ ] Partial-unique index? The `ON CONFLICT(col)` upsert must repeat the index's `WHERE` predicate, or SQLite errors.

## 2. The shared send path
- [ ] All sending goes through `$lib/server/send.ts` (`sendCampaignEmail`). Don't fork it.
- [ ] `recipients.message_id` (Postmark MessageID) is the join key for webhook events — don't break how it's recorded.

## 3. Automations
- [ ] Triggers: `manual`, `list_added`, `company_metric`, `site_visit`, `pipeline_stage_entered`, `email_opened`, `email_clicked` (#412), `site_activity` (#434), `subscription_changed` (#444 — the one kind whose passes run for unsubscribed contacts: `enroll(…, { allowUnsubscribed })`, and the engine ends the pass at an email step instead of sending). Anything that lives in `list_members` (list, hand-picked segment, tag) works as a `list_added` trigger for free. A **rule-based segment** has no `list_members` rows, so its `list_added` trigger is polled instead (#413, `processSegmentTriggers` in `segment-trigger.ts`): each heartbeat diffs the segment against `segment_trigger_members` and enrolls new entrants (≤ 2,000 per tick) — a new dynamic-segment rule kind gets this for free. The older kinds use flat `automations.trigger_*` columns; **new kinds keep their config as JSON in `automations.trigger_config`** (validated in `automation-write.ts` `triggerColumns`). Every trigger path enrolls through `enroll()`, which applies the automation's **entry conditions** (`automations.entry_rules`) — a new trigger gets them for free if it calls `enroll()`. A paused automation records the contact with `recordPendingTriggers` instead (#397).
- [ ] **Every path that adds a contact to a list/tag must call `autoEnroll`/`autoEnrollByEmails`** (best-effort `try/catch`). Current paths: `/api/ingest`, CSV import, manual add, bulk add-to-list. A new add path (e.g. tagging) is easy to forget here.
- [ ] The engine pointer is a step **position** → structural step edits stay **locked while any enrollment is active**. Don't break that invariant; content/delay edits are fine.
- [ ] One `campaigns` row per step (reuses stats/attribution).

## 4. The `kind` leak check (critical for any grouping feature)
The `lists` table is shared across `kind in ('list','segment','tag')`. Adding a new kind
silently changes every query that reads `lists` **without** a kind filter. Audit each:
- [ ] Contacts page load (`lists` / `segments` groups) — kind-filtered? confirm no leak.
- [ ] Compose audience picker — should it offer the new kind? include + label, or exclude.
- [ ] Automation **trigger** picker (`/automations/[id]`) — labels the kind correctly?
- [ ] `addToSegment` target dropdown (contacts) — include/exclude/label.
- [ ] Any new picker you add.
- [ ] Unsubscribe / topics (#414): anything subscriber-facing (preference page, footer) shows a
  topic's `topic_label` / `topic_blurb` only — never a list, segment or tag `name`. A new send
  path must pass the email's topic (`campaignTopicId` / `resolveTopicId`) so `topic_optouts` hold.
Decide include / exclude / label for each — don't let it leak by default.
- [ ] Active audience (#705): any new query that lists or counts contacts (a group page, a count,
  a picker, a report, search, an API or assistant read) uses `activeContactSql` /
  `segmentAudienceSql` from `src/lib/server/active-audience.ts` — unsubscribed and archived
  contacts appear only on `/contacts` through its Status / Archived filters. Send and enrol
  paths keep their own (stricter) `subscribed = 1` rule; campaign history is never filtered.

## 5. Compose / targeting
- [ ] `campaigns.list_id` can point at any list/segment/tag. "Don't special-case sending."

## 6. Auth, routes & secrets
- [ ] New **public** route (machine-called) → add its prefix to `PUBLIC_PREFIXES` in `hooks.server.ts` **and** gate it with its own key/bearer (mirror `WEBHOOK_KEY`/`INGEST_KEY`/`CRON_KEY`).
- [ ] New secret → `.dev.vars` (local) + `wrangler secret put` (prod, **on every worker that uses it**) + README + CLAUDE.md secrets list.
- [ ] JSON endpoints skip SvelteKit's CSRF check; form POSTs need a matching `Origin` (matters for curl/tests).
- [ ] Admin-only route? Check `locals.user?.role === 'admin'` in `load` **and** every action (mirror `/settings/users`).
- [ ] Need the current user? `locals.user` (`SessionUser`), not a password check.
- [ ] Changing a user's credentials (#211)? Stamp `users.password_set_at` (`credentialStamp()`) — `hooks.server.ts` signs out every session issued before it.

## 7. Frontend conventions
- [ ] Svelte 5 runes; vanilla scoped CSS; reuse `badge` / `card` / `muted` and match `/lists/[id]`, `/contacts/[id]`, `/campaign/[id]`.
- [ ] **Type every D1 query** — `.all<RowType>()` / `.first<RowType>()`.
- [ ] New `/contacts` filter key? Parse + `isFiltered` + `contactsFilterParams` + `contactsWhere` in `contacts-query.ts`, a chip and `urlClearFilters` on the page, and `filterToRules` (contacts Overview save-as-segment / report, #423). Needs JS to resolve (like `awaiting`)? Do it in `resolveContactsFilter`.
- [ ] HTML5 drag-and-drop has no touch support → always pair it with buttons.

## 8. Docs
- [ ] CLAUDE.md — data model, the new subsystem, gotchas, and Out-of-scope.
- [ ] README — features, config table, deploy steps.

## 9. Verify (local-first)
- [ ] `npm run check` → **0 source errors** (ignore everything under `.svelte-kit/`; `rm -rf .svelte-kit/output .svelte-kit/cloudflare*` first).
- [ ] SvelteKit 3 (#741): config lives in `vite.config.ts` (`sveltekit({...})`), never `svelte.config.js`; `event.platform` is rebuilt from `cloudflare:workers` in `hooks.server.ts` (`ensurePlatform`); `goto` takes `replace` / `reset: false` (not `replaceState` / `noScroll` / `keepFocus`), links take `data-sveltekit-reset="false"`; an external `redirect()` needs `{ external: [...] }`.
- [ ] Drive the **real flow** on local dev + local D1 (the `POSTMARK_API_TEST` token validates + returns MessageIDs without sending). For time-based features, seed rows with `next_run_at` in the **past** to force-due instead of waiting.
- [ ] State machine / idempotency? Run an adversarial review before closing.
- [ ] Test data, comments and help text use invented people and reserved domains (`example.com`/`.org`/`.net`, `.test`, `.example`), never a real person, customer or company address.
- [ ] Clean up all seeded test data afterward.

## 10. Deploy — the prod-only gotchas (operator runs these)
Local/miniflare does **not** reproduce these:
- [ ] Deploy with `npm run deploy` (remote `wrangler d1 migrations apply`, then build, then the Worker). Don't `wrangler deploy` alone, and don't run migration SQL by hand.
- [ ] Set secrets on the **deployed** worker — and identically on any companion worker.
- [ ] **Worker → Worker on the same `workers.dev` zone fails with Cloudflare error 1042.** Use a **service binding** (`services` in `wrangler.jsonc`, called via `env.<BINDING>.fetch()`), not a public-URL `fetch()`.
- [ ] Verify against the **live URL**, not just local.

---

### How to use
Before opening a PR or closing a feature issue, paste sections 1–10 into the issue (or
your notes) and check off what applies. The goal isn't ceremony — it's that "what did
I forget" has a fixed answer instead of being discovered in production.
