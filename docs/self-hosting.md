# Self-hosting guide

This guide takes a new install from an empty Cloudflare account to a working app with the first
admin signed in. The design behind the install is in [easy-install.md](easy-install.md).

There are three ways in: the Deploy to Cloudflare button, one command in a terminal, or
[Install by hand](#9-install-by-hand) at the end of this guide. Installs made by hand keep working
with the other two.

Names in this guide are placeholders. Replace `crm.example.com`, `howdee-crm`, `your-crm-worker`,
`your-database-name` and `your-media-bucket` with your own.

## 1. Before you start

- A Cloudflare account (the free plan is enough to start).
- A Postmark account and a sending domain you control. Verify the domain in Postmark (DKIM and
  Return-Path) before the first real send. Postmark is the default sending provider. Resend,
  Amazon SES or your own SMTP server work instead: see [sending-providers.md](sending-providers.md).
  This guide uses Postmark throughout. With another provider, skip the Postmark-only steps and
  follow that provider's section there.
- For the terminal path and the install by hand: Node.js 20 or newer and git on the machine you
  deploy from.

## 2. Install

Choose one path. Both are designed to create the database and media bucket, apply the migrations,
upload the app and generate its secrets. Neither asks you to copy an id or a secret. The terminal
path is the tested one.

### The Deploy to Cloudflare button (#732)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DigiSavvy-Inc/howdee-crm)

The button is new and still being tested on a fresh account. The terminal path (`npm run deploy`,
next section) is the tested one.

1. Click **Deploy to Cloudflare** (above, or in the README).
2. Sign in to Cloudflare. If no GitHub or GitLab account is connected yet, connect one: Cloudflare
   puts a copy of the repository there and builds from it.
3. Keep the suggested names for the Worker, the D1 database (`DB`) and the R2 bucket (`MEDIA`), or
   change them.
4. In the one field, `SETUP_TOKEN`, type a phrase only you know. You need it once, in the next
   section. It's the only value the page asks for: the build generates every other secret.
5. Click **Deploy** and wait for the build to finish (a few minutes). Workers Builds runs
   `npm run deploy`, which is designed to apply the migrations and set the generated secrets.

If the build stops with a D1 permission error, the build token lacks D1 access. Add "D1: Edit" to
the build's API token in the Cloudflare dashboard (Workers & Pages, the Worker, Settings, Builds)
and retry, or use the terminal path.

The page reads two files from the repository: `package.json` (`cloudflare.bindings`, the text shown
next to each field) and `.dev.vars.example` (the secret fields: only `SETUP_TOKEN`). The full list of
secrets the app reads is `.dev.vars.reference`.

Cloudflare can take **up to 15 minutes** to start the app's once-a-minute clock after the first
deploy (8 minutes when we measured). Until then Settings → Setup says the tick hasn't run yet; that's
expected, and nothing is lost.

### The terminal (built, #730)

```sh
git clone <repository url> howdee-crm
cd howdee-crm
npm install
npx wrangler login
npm run deploy
```

`wrangler login` opens a browser window and signs this machine into your Cloudflare account.
If your login can reach more than one Cloudflare account, set the one to install into first:
`export CLOUDFLARE_ACCOUNT_ID=<account id>` (shown by `npx wrangler whoami`). The deploy can't ask
which account to use, and `account_id` in `wrangler.jsonc` alone isn't enough, because
`wrangler r2 bucket list` doesn't read it.

`npm run deploy` first prints which mode it runs in and why:

- **Install mode** on a new install: `wrangler.jsonc` was missing (it's written from the template),
  it has no D1 `database_id` (the repository ships one with default names and no ids), an earlier
  install run didn't finish, or you passed `--setup`.
- **Classic mode** on an install that already has its `database_id`: migrations, build and upload,
  exactly as before the easy install. Nothing on your account is listed, created or changed, no
  secret is generated and no file is written.

In install mode it asks no questions and does the following, in order:

1. Creates the D1 database and R2 bucket, if they don't exist, and writes the database id into
   `wrangler.jsonc`. It never overwrites your `wrangler.jsonc` with the template, and never
   replaces a database id that's already there.
2. Applies the migrations. If they fail, nothing is uploaded.
3. Builds the Worker and uploads it together with the secrets that aren't set yet.
4. Prints the one-time setup link right away.
5. Writes the Worker's `workers.dev` address into `PUBLIC_BASE_URL` (when it's empty) and uploads
   once more, so the built-in clock has an address. If this step fails, the app is still live and
   the link above still works; run `npm run deploy` again to finish.

Each step prints one line saying what it did. If Cloudflare refuses a command (you're not logged in,
or an API token lacks a permission), it stops with one line naming the command and the permission.
It asks no questions, so it also runs in CI (`CI=1`).

The setup link looks like this:

```
Open https://howdee-crm.<subdomain>.workers.dev/setup#token=… to create the first admin.
```

The token in that link is the only secret you ever see. Don't share the link. It stops working once
the first admin exists. Lost it before creating the admin? Run `npm run deploy -- --new-setup-token`
for a fresh one (it only works while no admin exists).

While a first install is running, the script keeps a small note in `.wrangler/howdee-install.json`
(names of the database, the bucket and the finished steps; no secrets). If the run stops half way,
the next `npm run deploy` sees it and carries on in install mode. It's deleted when a run finishes.

| Flag | What it does |
| --- | --- |
| `npm run deploy -- --setup` | Run install mode on an install that already has its database id: check the database and bucket, set any missing secrets. Nothing that exists is changed. |
| `npm run deploy -- --adopt-database` | Use an existing D1 database with the configured name that this install didn't create. Without it the script stops and names the database. (Inside Workers Builds the database Cloudflare made from the config is used without the flag.) |
| `npm run deploy -- --new-setup-token` | While no admin exists: make a fresh `SETUP_TOKEN` and print a new setup link. Refused once an admin exists, and in CI. |

### Which secrets the deploy creates (built, #730)

`SESSION_SECRET`, `WEBHOOK_KEY`, `CRON_KEY`, `INGEST_KEY`, `MAIL_TOKEN_KEY` and, on the terminal path,
`SETUP_TOKEN` (only while no admin exists, and never in CI). A secret that's already set is never
replaced (the one exception is `--new-setup-token`, for `SETUP_TOKEN` only), so running
`npm run deploy` again is always safe. Secrets that come from another service (the Postmark token, OAuth clients, API keys)
are entered in the app later. The full list is in [easy-install.md](easy-install.md#generated-secrets).

### The cron

Automations, scheduled sends, scoring, backups and housekeeping run on a tick once a minute. The app
Worker runs that tick itself, on every install: `npm run build` (part of `npm run deploy`) wraps the
SvelteKit build so the Worker also has a `scheduled` handler (`scripts/wrap-worker.mjs`), and the
template's `triggers.crons` fires it every minute. There's no second Worker to deploy, and the clock
needs no `CRON_KEY`. On a new install Cloudflare can take up to 15 minutes to start the schedule
(8 minutes when we measured); after that, Settings → Setup shows the last tick "by the built-in
clock". The separate heartbeat Worker is optional and stays supported
([Optional: the heartbeat Worker](#optional-the-heartbeat-worker);
[easy-install.md](easy-install.md#one-worker-runs-the-cron) for moving an install over).

The built-in clock needs the app's public address to build unsubscribe and tracking links. It uses
Settings → Domain, else `PUBLIC_BASE_URL`, else the address you created the first admin on at
`/setup` (stored by the app, or chosen later in the setup wizard), so on a new install it has one
from the first tick. Only with none of the three does it send nothing, log
`automation tick (cron) skipped: no public URL` and show an "App's public address" row on Settings →
Setup. Until a sending token is saved, each tick (either clock) skips everything that sends email:
scheduled campaigns stay scheduled, automation emails wait at their step with "Finish setup" (for up
to 24 hours, then the pass fails with "No sender configured for 24 hours" or "No sending provider
configured for 24 hours"), and scheduled assistant jobs that email their report wait too, without
running or spending. Housekeeping (engagement, scoring, backups, pruning) still runs, and Settings →
Setup shows a "Scheduled work" row saying so, plus an "Automation emails" row while emails wait.

Cloudflare's cron history (the Worker's Triggers / Cron events in the dashboard) shows every run of
the built-in clock as a success, even when the tick itself failed: the handler never throws. A
failed or skipped tick shows up in the Worker's logs (`npx wrangler tail your-crm-worker`:
`automation tick (cron) failed` / `skipped`) and on Settings → Setup.

## 3. First-run pages

**Create the first admin.** Open the app's URL. With no users yet, `/login` sends you to `/setup`.
The setup link from the terminal (`/setup#token=…`) fills in the token for you: the page reads it
from the part after `#`, which the browser never sends to the server, and then removes it from the
address bar. With the button, type your phrase. The address you open `/setup` on becomes the app's
address until you set one in Settings → Domain (a `localhost` address is never stored; the wizard's
first step can change or clear it later). Lost the link? Run `npm run deploy -- --new-setup-token`
for a fresh one. Then enter your name, email and a password (12 characters or more). Add a GitHub
login if you plan to use GitHub sign-in. You're signed in as an admin.

`/setup` answers 404 from then on. You can delete the token:

```sh
npx wrangler secret delete SETUP_TOKEN
```

**Settings → Setup** lists every check for the install: migrations, the media bucket, the secrets,
the sending provider's credentials and streams, the default From address, the tick, the webhook,
the unsubscribe setting and each optional integration. Each row that needs attention says what to
do.

Right after `/setup`, this page opens as a step-by-step wizard:

1. **Your address:** shows which address links use and where it comes from (Settings → Domain,
   `PUBLIC_BASE_URL`, recorded at setup, or this request). Without a custom domain or
   `PUBLIC_BASE_URL`, **Use this address for links** records the address you have the page open on,
   and **Clear the recorded address** forgets it (neither is offered once a custom domain or
   `PUBLIC_BASE_URL` is set). Check the host it shows: a Cloudflare
   version-preview address (`<8 hex>-<name>.<subdomain>.workers.dev`) gets a note, so open the app at
   its main address before recording it. Then set the Default From address.
2. **Connect sending:** pick the provider and paste its token (stored the same way as in Settings →
   Sending). Saving tests the connection and sends nothing.
3. **Postmark webhook:** one button creates the event webhook on the broadcast stream with this
   install's key (or finds the one that's there), and reports the stream and its unsubscribe
   handling, with **Switch to custom**. A webhook with this install's key that still points at an
   old address is reported as pointing at another address, with **Update** to move it here. **Show the URL to copy** gives the full URL if you'd rather
   add it in Postmark yourself.
4. **Send yourself a test** to your own address, on the transactional stream. It's the only email
   the wizard sends, and only when you click.

Every step can be skipped, and only admins can use it. **Open the setup wizard** on Settings → Setup
brings it back later. Until a token and a From address are set, sends are refused with a "Finish
setup" message under the form you sent from (for example "Finish setup: sending isn’t set up yet.
Paste the sending provider’s token in Settings → Sending (or follow Settings → Setup).").

## 4. Connect Postmark

Using Resend, Amazon SES or SMTP instead? Skip this section. Choose the provider in **Settings →
Sending** and follow its section in [sending-providers.md](sending-providers.md).

**Server token.** Copy the **Server** API token (Postmark → Servers → your server → API Tokens; not
the account token). Paste it in **Settings → Sending**, or set it as the `POSTMARK_TOKEN` secret.

**Sending domain.** In Postmark → Sender Signatures, add your domain and complete DKIM and
Return-Path verification. The Deliverability page in the app reports both once
`POSTMARK_ACCOUNT_TOKEN` is set.

**Message streams.** The server needs a broadcast stream (campaigns and automations) and a
transactional stream (replies, confirmations and operator mail). A new Postmark server already has
`outbound` for transactional mail. You create the broadcast one under Message Streams. The app uses
`broadcast` and `outbound` unless you name others in Settings → Sending (or in `POSTMARK_STREAM` and
`POSTMARK_STREAM_TX`).

**Event webhook.** On the broadcast stream, open Webhooks and add:

```
https://crm.example.com/api/webhook?key=<WEBHOOK_KEY>
```

Enable Open, Click, Delivery, Bounce, Spam Complaint and Subscription Change. These feed the
campaign stats, engagement, scoring and the suppression state. On an easy install the deploy generated
`WEBHOOK_KEY` (planned, #727). The wizard's **Create the webhook** button adds it for you, with every
trigger on, and **Show the URL to copy** shows the full URL. On an install by hand, use the value you
set.

**Unsubscribe handling.** The app adds its own unsubscribe link and List-Unsubscribe headers to
every broadcast, and records the reason when someone leaves. For that to be the only way to
unsubscribe, the broadcast stream's unsubscribe handling must be **Custom**: Postmark → Servers →
your server → the broadcast stream → Settings → Unsubscribe handling. Postmark may ask you to
confirm that you handle unsubscribes yourself. Until it's Custom, Postmark adds a second link of
its own, which still works but records no reason. The Setup page shows the current setting.

## 5. Optional: reply capture

Replies to your emails can land in the app and be forwarded to your inbox.

1. In Postmark, set up an inbound domain (MX record pointing at `inbound.postmarkapp.com`) or use
   the server's inbound hash address.
2. Set the `INBOUND_KEY` secret (a random string). Then in `wrangler.jsonc`, set
   `POSTMARK_INBOUND_ADDRESS` to the inbound address and `INBOUND_FORWARD_TO` to the mailbox that
   should get a copy.
3. On the server's Inbound stream, set the webhook to
   `https://crm.example.com/api/inbound?key=<INBOUND_KEY>` and tick "Include raw email content".
4. `npm run deploy`.

Sends now carry a per-recipient Reply-To at the inbound address. Reply capture works with every
sending provider, so you can use Postmark Inbound while sending through another one.

## 6. Optional: custom domain

In Cloudflare, add the hostname to the Worker (Workers & Pages → your Worker → Settings → Domains
& Routes), or set `CF_API_TOKEN` and use **Attach to this Worker** in the app's Settings → Domain.
Then enter the hostname in Settings → Domain and check its status. Once the check passes, turn on
the redirect from the `workers.dev` URL. Update `PUBLIC_BASE_URL` (if you set it) and the GitHub
OAuth callback to match.

## 7. Optional: everything else

Each of these is off until you configure it, and each has its own page in Settings with the steps:

- **GitHub sign-in:** Settings → Users. Create a GitHub OAuth App whose callback is
  `<your app URL>/auth/github/callback`, set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and add
  users by GitHub login.
- **Gmail sync:** Settings → Mail. A Google OAuth client (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`) plus `MAIL_TOKEN_KEY`.
- **AI assistant:** Settings → Assistant. An Anthropic API key (pasted there, or
  `ANTHROPIC_API_KEY`), who may use it, and spend caps. An OpenAI-compatible provider can be added
  too (see [ai-providers.md](ai-providers.md)).
- **Suggestions** (planned, see [suggestions.md](suggestions.md)): Settings → Suggestions. Runs on
  the tick and needs no new secrets or vars. Works without an AI key (rules only).
- **Luma:** the Luma card on Settings → General. A guest webhook from Luma (Plus plan) and its
  signing secret.
- **Timing and GitHub on companies:** Settings → Integrations.
- **Newsletter archive on your own site:** Settings → Newsletter archive. Add Worker routes for the
  path on your site to `wrangler.jsonc` and list the host in `ARCHIVE_ROUTE_HOSTS`.
- **Site tracking:** Settings → Tracking. A snippet for your own sites.
- **Webhook keys** for website forms: Settings → Webhooks.
- **Data API keys and the MCP server:** Settings → API.

## 8. Running the install

### Upgrading

```sh
git pull
npm ci
npm run deploy
```

Migrations run first, then the Worker ships. An install that has its database id deploys in
classic mode: nothing else is checked or changed. To have missing secrets set as well, run
`npm run deploy -- --setup` (#730); it never changes anything that exists. If
you still run the heartbeat Worker, redeploy it (`cd heartbeat && npx wrangler deploy`) only when
files under `heartbeat/` changed. Read the release notes for any new secret or var. The Setup page
flags a missing one after the deploy.

**An install made with the button** has its own copy of the repository on GitHub (or GitLab), and
Workers Builds deploys every push to its main branch. To upgrade, bring the new release into that
copy. These steps are not tested yet.

- If your copy shows **Sync fork**, use it (click it, then **Update branch**).
- Otherwise add the public repository as a remote and pull. Once, from any machine with git:

  ```sh
  git clone <your copy's url> howdee-crm && cd howdee-crm
  git remote add upstream https://github.com/DigiSavvy-Inc/howdee-crm.git
  git pull upstream main
  git push origin main
  ```

  Later upgrades are `git pull upstream main && git push origin main` in that folder. If git refuses
  with "refusing to merge unrelated histories", see the terminal path in [Install](#2-install).

The push starts a build in Workers Builds (Workers & Pages → your Worker → Deployments), which runs
`npm run deploy`: migrations first, then the upload, so the schema is never behind the code. Secrets
already set are never replaced. If you changed `wrangler.jsonc` in the copy (a custom route, say),
git keeps your change and merges the release around it; a conflict stops the pull and names the file.

### Backups and restore

- The tick writes a nightly export of every table to the media bucket under `backups/`, leaves the
  secrets out, and keeps a rolling set. Settings → Backups shows the last run.
- D1 keeps 30 days of history. To rewind the whole database to a moment:

  ```sh
  npx wrangler d1 time-travel info your-database-name
  npx wrangler d1 time-travel restore your-database-name --timestamp "2026-06-09T12:00:00Z"
  ```

- The Contacts page has **Export CSV** for an off-platform copy.

### If something is wrong

| Symptom | Cause and fix |
| --- | --- |
| Every signed-in page is a 500 right after a deploy | The Worker shipped ahead of the schema. Run `npm run deploy` again. It applies the missing migrations first. |
| `npm run deploy` stops at "A database named … already exists" | A D1 database with that name exists on the account and this install didn't create it. Change `database_name` in `wrangler.jsonc`, or run `npm run deploy -- --adopt-database` if it is yours to use. |
| `npm run deploy` stops at "A bucket named … already exists" or "Couldn't create bucket …" | An R2 bucket with that name exists on the account, or the name is taken. The bucket check reads a single page of `wrangler r2 bucket list`, so on an account with very many buckets an existing one may not be listed. Change `bucket_name` in `wrangler.jsonc` and run it again. |
| `npm run deploy` stops at "this database id is not on the logged-in Cloudflare account" | `wrangler.jsonc` has a database id from another account, or wrangler is logged in to the wrong one. Check `npx wrangler whoami` and `CLOUDFLARE_ACCOUNT_ID`. The script never creates a replacement. |
| `npm run deploy` stops at "more than one account" | Set `CLOUDFLARE_ACCOUNT_ID` to the account to install into and run it again. |
| `npm run deploy` stops at "Cloudflare refused …" | You're not logged in, or the API token lacks the permission the line names. Run `npx wrangler login`, or add that permission to the token, and run it again. |
| `/setup` is a 404 | A user already exists. Sign in instead, or reset the database if this is a fresh install. |
| `/setup` says the token is wrong | The setup link was cut off, or you typed a different phrase than on the button page. Run `npm run deploy -- --new-setup-token` for a fresh link, or set a new one with `npx wrangler secret put SETUP_TOKEN`, and try again. |
| Setup page says the tick hasn't run | Built-in clock: `triggers.crons` is missing from `wrangler.jsonc` (check its `triggers` block and run `npm run deploy`), the Worker was deployed without `npm run build` (the wrap step adds the `scheduled` handler), or no public address is set (the Setup page then has an "App's public address" row). Cloudflare's cron history shows every run as a success; `npx wrangler tail your-crm-worker` logs a failed tick as `automation tick (cron) failed`. Heartbeat Worker: it isn't deployed, its service binding names the wrong Worker, or its `CRON_KEY` differs from the app's. `npx wrangler tail your-crm-heartbeat` shows each tick's result. |
| Heartbeat logs Cloudflare error 1042 | It's calling the app over its public URL. Use the service binding in `heartbeat/wrangler.jsonc`. |
| Postmark webhook events never arrive | The webhook URL is missing `?key=<WEBHOOK_KEY>`, it's on the wrong stream, or it still points at an old address. The Setup page checks the first two; the wizard's webhook step reports an old address and **Update** moves it. |
| Sends are refused with an unsubscribe error | The app doesn't know its public address, so it can't build the unsubscribe link. Set it in Settings → Domain, or set `PUBLIC_BASE_URL` to the app's real origin. |
| A send says "Finish setup" | No sending token or no From address is set yet. Follow the wizard on Settings → Setup, or set them in Settings → Sending and Settings → General. An automation email held with this message sends on its own within 10 minutes once they're set. |
| Tokens in Settings stopped working after a deploy | `MAIL_TOKEN_KEY` was changed by hand. Put the old value back, or enter the tokens again. |
| "Not configured" on an optional page | That integration's secret or var isn't set. The page names it. |

### Removing an install

Delete the Worker, the database and the bucket from the Cloudflare dashboard (Workers & Pages, D1,
R2) or with wrangler:

```sh
npx wrangler delete --name your-crm-worker
npx wrangler d1 delete your-database-name
npx wrangler r2 bucket delete your-media-bucket
```

**The bucket isn't empty.** From the first tick on it holds a nightly backup under `backups/` (and
any uploaded images), and R2 refuses to delete a bucket that still has objects. Empty it first: in
the dashboard, open the bucket and delete its objects (select all, Delete), or set an object
lifecycle rule that deletes everything and wait for it to run; then delete the bucket. Download a
backup first (Settings → Backups) if you might want the data. A heartbeat Worker, if you ran one, is
deleted the same way as the app Worker. A button install also leaves its repository copy and its
Workers Builds connection; delete those on GitHub (or GitLab) and in the dashboard.

## 9. Install by hand

This is the install that works today, step by step. It's also the way to go if you want to choose
every name and set every secret yourself. Install the dependencies first:

```sh
git clone <repository url> howdee-crm
cd howdee-crm
npm install
npx wrangler login
```

### Create the Cloudflare resources

```sh
npx wrangler d1 create your-database-name
npx wrangler r2 bucket create your-media-bucket
```

The first command prints the database id. Keep it for the next step.

### Configure the app Worker

The repository ships a `wrangler.jsonc` written from the template (no ids). If yours is missing,
copy the template:

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
| `triggers.crons` | Keep the template's `["* * * * *"]`. It runs the app's built-in clock ([the cron](#the-cron)). |

All four `vars` above (and `WORKER_NAME`) are optional. Each has a stand-in in the app
([easy-install.md](easy-install.md#vars-become-optional-built-731)): the From address and the token
from the wizard or Settings, the streams `broadcast` and `outbound`, and the address you set up on. A
var that's set always wins. Reply forwarding (section 5) sends from an address on `POSTMARK_FROM`'s
domain, or the Default From's when the var is empty; a value like `Brand <a@example.com>` counts as
`a@example.com` there and in the self-loop guard (it never matched before #731). One change for existing installs: a new
automation email step starts with the Default From, then `POSTMARK_FROM` (it used to be
`POSTMARK_FROM` only), as the builder does; a step saved with no From sends from those too.

The other vars are optional and documented in the template:

- `DEFAULT_LIST_NAME`: the list a contact joins when `/api/ingest` or the Luma webhook names none.
- `REVIEW_FROM` and `REVIEW_TO`: sender and extra recipient for the assistant's scheduled job
  emails. Unset, both fall back to the default From address.
- `POSTMARK_INBOUND_ADDRESS` and `INBOUND_FORWARD_TO`: reply capture (section 5).
- `CF_ACCOUNT_ID`: your Cloudflare account id, for attaching a custom domain from inside the app.
- `ARCHIVE_ROUTE_HOSTS`: hosts that serve the newsletter archive (section 7).

Keep `wrangler.jsonc` out of any public repository, because it holds your ids.

### Set the secrets

You set each secret once with `wrangler secret put`, which prompts for the value. Generate random
values with `openssl rand -base64 32`.

Required:

| Secret | What it does |
| --- | --- |
| `SESSION_SECRET` | Signs sessions and every unsubscribe, tracking and approval token. Long random string. |
| `POSTMARK_TOKEN` | The Postmark **Server** API token. You can enter it in Settings → Sending instead. Needed while Postmark is the sending provider. Another provider has its own credentials ([sending-providers.md](sending-providers.md#environment-variables)). |
| `WEBHOOK_KEY` | Gates the Postmark event webhook. Random string. It goes in the webhook URL (section 4). Required while Postmark is the sending provider. |
| `INGEST_KEY` | Bearer key for `/api/ingest` and `/api/contacts/upsert`. Random string. |
| `SETUP_TOKEN` | Lets you create the first admin at `/setup`. Any long random string. Delete it once the admin exists. |

```sh
npx wrangler secret put SESSION_SECRET
npx wrangler secret put POSTMARK_TOKEN
npx wrangler secret put WEBHOOK_KEY
npx wrangler secret put INGEST_KEY
npx wrangler secret put SETUP_TOKEN
```

Optional, set later when you turn the feature on:

| Secret | Turns on |
| --- | --- |
| `CRON_KEY` | The HTTP tick endpoint `/api/automations/tick`: needed only with the separate heartbeat Worker ([below](#optional-the-heartbeat-worker)) or to run a tick by hand. The app's built-in clock doesn't use it. `/api/health` (uptime monitors) still requires it: it is that endpoint's only key. Random string. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | "Sign in with GitHub" (a GitHub OAuth App whose callback is `<PUBLIC_BASE_URL>/auth/github/callback`). Without them, users sign in with a password. |
| `APP_PASSWORD` | A break-glass password that signs in as the first active admin. Leave it unset unless you need it. |
| `POSTMARK_ACCOUNT_TOKEN` | DKIM and Return-Path status on the Deliverability page, read from Postmark's Domains API. |
| `INBOUND_KEY` | Reply capture through Postmark Inbound (section 5). |
| `MAIL_TOKEN_KEY` | Encrypts tokens entered in Settings (integrations, Gmail, an in-app Anthropic key, the Postmark token). 32 random bytes, base64url. Without it, those fields are disabled. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail sync in Settings → Mail. |
| `ANTHROPIC_API_KEY` | The AI assistant and subject suggestions. |
| `OPENAI_API_KEY` | A second, optional AI provider: an OpenAI-compatible endpoint set up in Settings → Assistant (see [ai-providers.md](ai-providers.md)). |
| `TIMING_API_TOKEN`, `GITHUB_TOKEN` | Timing and GitHub data on company records. |
| `LUMA_WEBHOOK_SECRET` | Fallback signing secret for the Luma webhook. The value in Settings wins. |
| `CF_API_TOKEN` | "Attach to this Worker" in Settings → Domain (needs `CF_ACCOUNT_ID` and `WORKER_NAME` in `wrangler.jsonc`). |

The complete list, with a comment for each name, is in `.dev.vars.reference`.

### Deploy the app

```sh
npm run deploy
```

This applies every migration to the production database, builds the app and uploads the Worker, in
that order. If the migration step fails, nothing is uploaded. The first run takes a few minutes. At
the end, wrangler prints the Worker's `workers.dev` URL.

Always deploy this way. `wrangler deploy` on its own can ship code ahead of the schema. Never run a
migration file's SQL by hand.

### Optional: the heartbeat Worker

The app Worker runs the tick itself ([the cron](#the-cron)), so you can skip this step and go on to
create the first admin at `/setup` (section 3).

Older installs, and installs that prefer it, run the tick from a second, tiny Worker instead, which
calls the app's tick endpoint with a shared `CRON_KEY`. To use only that, remove `triggers` from the
app's `wrangler.jsonc` (every build still has the `scheduled` handler; without a cron it never
runs). Running both at once is also safe: everything that sends or calls out claims its work before
it runs (scheduled campaigns, resends, best-time rows, automation steps, AI jobs, deliverability
checks), the backup, integration and Gmail syncs hold leases, and the daily suppression sync, the
daily domain check and the account briefs claim their run. The rest of the housekeeping
(engagement, scoring, pruning, report snapshots) may repeat in the same minute and ends in the same
state.

```sh
cd heartbeat
cp wrangler.example.jsonc wrangler.jsonc
```

In `heartbeat/wrangler.jsonc`, set `name` (for example `your-crm-heartbeat`) and make
`services[0].service` equal to the app Worker's `name`. The heartbeat reaches the app through that
service binding, never over the public URL.

```sh
npx wrangler secret put CRON_KEY     # the same value as the app's CRON_KEY, byte for byte
npx wrangler deploy
cd ..
npx wrangler secret put CRON_KEY     # on the app Worker too, the same value
```

If the two `CRON_KEY` values differ, every tick from the heartbeat answers 401 and it runs no
automation. Then open the app and create the first admin at `/setup` (section 3). The Setup page
shows the time of the last successful tick and which clock ran it.
