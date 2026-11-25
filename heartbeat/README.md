# Automation heartbeat Worker

A standalone Cloudflare Worker whose only job is to POST the app's automation tick
endpoint on a cron schedule.

**Optional since #729.** The app Worker runs its own clock: `npm run build` wraps the SvelteKit
build (whose adapter worker exports only `fetch`) with a `scheduled` handler
(`scripts/wrap-worker.mjs`, on the adapter's `.svelte-kit/cloudflare/worker/index.js`), and
`wrangler.example.jsonc` has `triggers.crons`. A new install from the template needs neither this
Worker nor `CRON_KEY` (`/api/health` still uses `CRON_KEY` as its key). Installs that already run
this Worker keep working unchanged; to use only this Worker, leave `triggers` out of the app's
`wrangler.jsonc`. Running both clocks at once is safe: sends and outside calls are claimed before
they run, and the daily and lease-based jobs claim their run (see docs/self-hosting.md step 6).
The built-in clock's Cron history in the Cloudflare dashboard shows every run as a success; a failed
tick shows in the app Worker's logs and on Settings → Setup.

All engine logic lives in the app (`src/lib/server/automations.ts`). This worker is
just the clock — `src/index.ts` is ~40 lines.

## How it works

- `scheduled()` fires on the cron in `wrangler.jsonc` (`* * * * *`, every minute) and calls the app's
  tick endpoint with `Authorization: Bearer ${CRON_KEY}`.
- **It calls the app over a service binding (`env.APP`), not a public URL.** A Worker can't
  `fetch()` another Worker on the same `workers.dev` zone over its public hostname — Cloudflare
  rejects it with **error 1042**. The service binding (`services` in `wrangler.jsonc`, pointing
  at the app Worker's name) is the supported internal channel. `TICK_URL` is only a fallback
  for local dev, where the binding isn't present and the same-zone rule doesn't apply.
- `fetch()` is a manual trigger for testing the wiring without waiting for cron;
  it's gated by the same `CRON_KEY`.
- The engine is idempotent, so cadence only affects latency, never correctness.

## Deploy (operator runs this — environment-specific)

This is the operator's own Cloudflare account. Run from **inside this `heartbeat/` folder**:

```sh
# 1. Authenticate (interactive — your own terminal)
npx wrangler login

# 2. Confirm the service binding in wrangler.jsonc → services[0].service matches your
#    deployed app Worker's "name" in the root wrangler.jsonc. No TICK_URL needed
#    in prod — the binding handles it.

# 3. Set the shared secret — MUST be byte-for-byte identical to the app's CRON_KEY.
npx wrangler secret put CRON_KEY --config wrangler.jsonc

# 4. Deploy
npx wrangler deploy --config wrangler.jsonc
```

Always pass `--config wrangler.jsonc` here (#741). wrangler looks for `.wrangler/deploy/config.json`
in this folder **and every parent**; an app build leaves one in the repo root, and without an
explicit `--config` a heartbeat command stops with "Found both a user configuration file ... do not
share the same base path".

The same `CRON_KEY` must also be set on the **app** worker (`wrangler secret put CRON_KEY`
from the repo root). If they differ, every tick returns 401 and no automations run.

After deploy, confirm the cron trigger shows in the Cloudflare dashboard under this
worker's *Triggers*, and that `npx wrangler tail --config wrangler.jsonc` logs `automation tick ok: {...}` on the
next fire.

## Local testing

`.dev.vars` (gitignored) holds local `CRON_KEY` + a local `TICK_URL`
(`http://localhost:5173/api/automations/tick`). With the app running (`npm run dev`
in the repo root):

```sh
npx wrangler dev --config wrangler.jsonc --port 8787 --local
# real cron path:
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
# manual fetch trigger:
curl -H "Authorization: Bearer <local CRON_KEY>" http://localhost:8787/
```
