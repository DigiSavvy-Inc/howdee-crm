# Automation heartbeat Worker

A standalone Cloudflare Worker whose only job is to POST the app's automation tick
endpoint on a cron schedule. It exists because the SvelteKit app's adapter worker
exports only a `fetch` handler (no `scheduled`), so it can't own a cron trigger itself.

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
npx wrangler secret put CRON_KEY

# 4. Deploy
npx wrangler deploy
```

The same `CRON_KEY` must also be set on the **app** worker (`wrangler secret put CRON_KEY`
from the repo root). If they differ, every tick returns 401 and no automations run.

After deploy, confirm the cron trigger shows in the Cloudflare dashboard under this
worker's *Triggers*, and that `wrangler tail` logs `automation tick ok: {...}` on the
next fire.

## Local testing

`.dev.vars` (gitignored) holds local `CRON_KEY` + a local `TICK_URL`
(`http://localhost:5173/api/automations/tick`). With the app running (`npm run dev`
in the repo root):

```sh
npx wrangler dev --port 8787 --local
# real cron path:
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
# manual fetch trigger:
curl -H "Authorization: Bearer <local CRON_KEY>" http://localhost:8787/
```
