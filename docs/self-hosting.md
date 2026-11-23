# Self-hosting guide

This guide takes a new install from an empty Cloudflare account to a working app with the first
admin signed in. Allow about an hour, most of it in the Cloudflare and Postmark dashboards. Every
command runs from the repository root unless it says otherwise.

Names in this guide are placeholders: replace `crm.example.com`, `your-crm-worker`,
`your-database-name` and `your-media-bucket` with your own.

## 1. Before you start

- A Cloudflare account with Workers, D1 and R2 enabled.
- A Postmark account and a sending domain you control. Verify the domain in Postmark (DKIM and
  Return-Path) before the first real send.
- Node.js 20 or newer and git on the machine you deploy from.

Clone the repository and install dependencies:

```sh
git clone <repository url> howdee-crm
cd howdee-crm
npm install
npx wrangler login
```

`wrangler login` opens a browser window and signs this machine into your Cloudflare account.

## 2. Create the Cloudflare resources

```sh
npx wrangler d1 create your-database-name
npx wrangler r2 bucket create your-media-bucket
```

The first command prints the database id. Keep it for the next step.

## 3. Configure the app Worker

Copy the template and fill in the placeholders:

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

In `wrangler.jsonc`:

| Key | Value |
| --- | --- |
| `name` | The Worker's name, for example `your-crm-worker`. The heartbeat Worker refers to it. |
| `d1_databases[0].database_name` and `database_id` | What `wrangler d1 create` printed |
| `r2_buckets[0].bucket_name` | The bucket you created |
| `vars.POSTMARK_FROM` | The default From address, on your verified Postmark domain |
| `vars.POSTMARK_STREAM` | Your broadcast message stream id, usually `broadcast` |
| `vars.POSTMARK_STREAM_TX` | Your transactional stream id, usually `outbound` |
| `vars.PUBLIC_BASE_URL` | The public origin of the app, no trailing slash. Start with the `workers.dev` URL (`https://your-crm-worker.<your subdomain>.workers.dev`) and change it when you add a custom domain. |
| `vars.WORKER_NAME` | The same value as `name` |

The other vars are optional and documented in the template:

- `DEFAULT_LIST_NAME`: the list a contact joins when `/api/ingest` or the Luma webhook names none.
- `REVIEW_FROM` and `REVIEW_TO`: sender and extra recipient for the assistant's scheduled job
  emails. Unset, both fall back to the default From address.
- `POSTMARK_INBOUND_ADDRESS` and `INBOUND_FORWARD_TO`: reply capture, step 9.
- `CF_ACCOUNT_ID`: your Cloudflare account id, for attaching a custom domain from inside the app.
- `ARCHIVE_ROUTE_HOSTS`: hosts that serve the newsletter archive, step 11.

Keep `wrangler.jsonc` out of any public repository: it holds your ids.

## 4. Set the secrets

Each secret is set once with `wrangler secret put`, which prompts for the value. Generate random
values with `openssl rand -base64 32`.

Required:

| Secret | What it does |
| --- | --- |
| `SESSION_SECRET` | Signs sessions and every unsubscribe, tracking and approval token. Long random string. |
| `POSTMARK_TOKEN` | The Postmark **Server** API token (Postmark → Servers → your server → API Tokens). Not the account token. |
| `WEBHOOK_KEY` | Gates the Postmark event webhook. Random string; you put it in the webhook URL in step 8. |
| `CRON_KEY` | Gates the automation tick. Random string; the heartbeat Worker gets the same value in step 6. |
| `INGEST_KEY` | Bearer key for `/api/ingest` and `/api/contacts/upsert`. Random string. |
| `SETUP_TOKEN` | Lets you create the first admin at `/setup`. Any long random string; delete it after step 7. |

```sh
npx wrangler secret put SESSION_SECRET
npx wrangler secret put POSTMARK_TOKEN
npx wrangler secret put WEBHOOK_KEY
npx wrangler secret put CRON_KEY
npx wrangler secret put INGEST_KEY
npx wrangler secret put SETUP_TOKEN
```

Optional, set later when you turn the feature on:

| Secret | Turns on |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | "Sign in with GitHub" (a GitHub OAuth App whose callback is `<PUBLIC_BASE_URL>/auth/github/callback`). Without them users sign in with a password. |
| `APP_PASSWORD` | A break-glass password that signs in as the first active admin. Leave unset unless you need it. |
| `POSTMARK_ACCOUNT_TOKEN` | DKIM and Return-Path status on the Deliverability page, read from Postmark's Domains API. |
| `INBOUND_KEY` | Reply capture through Postmark Inbound (step 9). |
| `MAIL_TOKEN_KEY` | Encrypts tokens entered in Settings (integrations, Gmail, an in-app Anthropic key). 32 random bytes, base64url. Without it those fields are disabled. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail sync in Settings → Mail. |
| `ANTHROPIC_API_KEY` | The AI assistant and subject suggestions. |
| `OPENAI_API_KEY` | Optional second AI provider: an OpenAI-compatible endpoint set up in Settings → Assistant (see [ai-providers.md](ai-providers.md)). |
| `TIMING_API_TOKEN`, `GITHUB_TOKEN` | Timing and GitHub data on company records. |
| `LUMA_WEBHOOK_SECRET` | Fallback signing secret for the Luma webhook; the value in Settings wins. |
| `CF_API_TOKEN` | "Attach to this Worker" in Settings → Domain (needs `CF_ACCOUNT_ID` and `WORKER_NAME` in `wrangler.jsonc`). |

The complete list with a comment per name is `.dev.vars.example`.

## 5. Deploy the app

```sh
npm run deploy
```

This applies every migration to the production database, builds the app and uploads the Worker, in
that order. If the migration step fails nothing is uploaded. The first run takes a few minutes. At
the end wrangler prints the Worker's `workers.dev` URL.

Always deploy this way. `wrangler deploy` on its own can ship code ahead of the schema, and a
migration file's SQL must never be run by hand.

## 6. Deploy the heartbeat Worker

The app cannot own a cron trigger, so a second, tiny Worker calls its tick endpoint once a minute.
The tick runs automations, scheduled sends, scoring, backups and housekeeping.

```sh
cd heartbeat
cp wrangler.example.jsonc wrangler.jsonc
```

In `heartbeat/wrangler.jsonc` set `name` (for example `your-crm-heartbeat`) and make
`services[0].service` equal to the app Worker's `name` from step 3. The heartbeat reaches the app
through that service binding, never over the public URL.

```sh
npx wrangler secret put CRON_KEY     # the same value as the app's CRON_KEY, byte for byte
npx wrangler deploy
cd ..
```

If the two `CRON_KEY` values differ, every tick answers 401 and no automation runs. The Setup page
in step 7 shows the time of the last successful tick.

## 7. Create the first admin

Open the app's URL. With no users yet, `/login` redirects to `/setup`. Enter the `SETUP_TOKEN`,
your name, email and a password (12 characters or more), and an optional GitHub login if you plan to
use GitHub sign-in. You are signed in as an admin and land on **Settings → Setup**.

`/setup` answers 404 from now on. Delete the token:

```sh
npx wrangler secret delete SETUP_TOKEN
```

**Settings → Setup** lists every check for the install: migrations, the media bucket, the secrets,
the Postmark token and both streams, the default From address, the heartbeat, the webhook, the
unsubscribe setting and each optional integration. Each row that needs attention says what to do.
Come back to it after the next two steps.

## 8. Connect Postmark

**Sending domain.** In Postmark → Sender Signatures, add your domain and complete DKIM and
Return-Path verification. The Deliverability page in the app reports both once
`POSTMARK_ACCOUNT_TOKEN` is set.

**Message streams.** The server needs a broadcast stream (campaigns and automations) and a
transactional stream (replies, confirmations and operator mail). Their ids go in `POSTMARK_STREAM`
and `POSTMARK_STREAM_TX`; a new Postmark server already has `outbound` for transactional mail, and
you create the broadcast one under Message Streams.

**Event webhook.** On the broadcast stream, open Webhooks and add:

```
https://crm.example.com/api/webhook?key=<WEBHOOK_KEY>
```

Enable Open, Click, Bounce, Spam Complaint and Subscription Change. These feed the campaign stats,
engagement, scoring and the suppression state.

**Unsubscribe handling.** The app adds its own unsubscribe link and List-Unsubscribe headers to
every broadcast, and records the reason when someone leaves. For that to be the only unsubscribe
path, the broadcast stream's unsubscribe handling must be **Custom**: Postmark → Servers → your
server → the broadcast stream → Settings → Unsubscribe handling. Postmark may ask you to confirm
that you handle unsubscribes yourself. Until it is Custom, Postmark adds a second link of its own,
which still works but records no reason. The Setup page shows the current setting.

## 9. Optional: reply capture

Replies to your emails can land in the app and be forwarded to your inbox.

1. In Postmark, set up an inbound domain (MX record pointing at `inbound.postmarkapp.com`) or use
   the server's inbound hash address.
2. Set the `INBOUND_KEY` secret, then in `wrangler.jsonc` set `POSTMARK_INBOUND_ADDRESS` to the
   inbound address and `INBOUND_FORWARD_TO` to the mailbox that should get a copy.
3. On the server's Inbound stream, set the webhook to
   `https://crm.example.com/api/inbound?key=<INBOUND_KEY>` and tick "Include raw email content".
4. `npm run deploy`.

Sends now carry a per-recipient Reply-To at the inbound address.

## 10. Optional: custom domain

In Cloudflare, add the hostname to the Worker (Workers & Pages → your Worker → Settings → Domains
& Routes), or set `CF_API_TOKEN` and use **Attach to this Worker** in the app's Settings → Domain.
Then enter the hostname in Settings → Domain, check its status, and turn on the redirect from the
`workers.dev` URL once the check passes. Update `PUBLIC_BASE_URL` and the GitHub OAuth callback to
match.

## 11. Optional: everything else

Each of these is off until configured and has its own page in Settings with the steps:

- **GitHub sign-in**: Settings → Users. Create a GitHub OAuth App, set the two secrets, add users by
  GitHub login.
- **Gmail sync**: Settings → Mail. A Google OAuth client plus `MAIL_TOKEN_KEY`.
- **AI assistant**: Settings → Assistant. An Anthropic API key, who may use it, and spend caps.
- **Luma**: the Luma card on Settings → General. A guest webhook from Luma (Plus plan) and its
  signing secret.
- **Timing and GitHub on companies**: Settings → Integrations.
- **Newsletter archive on your own site**: Settings → Newsletter archive. Add Worker routes for the
  path on your site to `wrangler.jsonc` and list the host in `ARCHIVE_ROUTE_HOSTS`.
- **Site tracking**: Settings → Tracking. A snippet for your own sites.
- **Webhook keys** for website forms: Settings → Webhooks.
- **Data API keys and the MCP server**: Settings → API.

## 12. Upgrading

```sh
git pull
npm ci
npm run deploy
```

Migrations run first, then the Worker ships. Redeploy the heartbeat Worker (`cd heartbeat &&
npx wrangler deploy`) only when files under `heartbeat/` changed. Read the release notes for any
new secret or var; the Setup page flags a missing one after the deploy.

## 13. Backups and restore

- The heartbeat writes a nightly export of every table to the media bucket under `backups/`, with
  secrets left out, and keeps a rolling set. Settings → Backups shows the last run.
- D1 keeps 30 days of history. To rewind the whole database to a moment:

  ```sh
  npx wrangler d1 time-travel info your-database-name
  npx wrangler d1 time-travel restore your-database-name --timestamp "2026-06-09T12:00:00Z"
  ```

- The Contacts page has **Export CSV** for an off-platform copy.

## 14. If something is wrong

| Symptom | Cause and fix |
| --- | --- |
| Every signed-in page is a 500 right after a deploy | The Worker shipped ahead of the schema. Run `npm run deploy` again; it applies the missing migrations first. |
| `/setup` is a 404 | A user already exists. Sign in instead, or reset the database if this is a fresh install. |
| Setup page says the heartbeat has not ticked | The heartbeat Worker is not deployed, its service binding names the wrong Worker, or its `CRON_KEY` differs from the app's. `npx wrangler tail your-crm-heartbeat` shows each tick's result. |
| Heartbeat logs Cloudflare error 1042 | It is calling the app over its public URL. Use the service binding in `heartbeat/wrangler.jsonc`. |
| Postmark webhook events never arrive | The webhook URL is missing `?key=<WEBHOOK_KEY>`, or it is on the wrong stream. The Setup page checks both. |
| Sends are refused with an unsubscribe error | `PUBLIC_BASE_URL` is wrong, so the unsubscribe link cannot be built. Set it to the app's real origin. |
| "Not configured" on an optional page | That integration's secret or var is unset. The page names it. |
