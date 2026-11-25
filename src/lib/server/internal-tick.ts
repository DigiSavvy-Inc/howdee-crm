// #729: the app Worker runs its own clock. After `vite build`, `scripts/wrap-worker.mjs` moves the
// adapter's Worker entry (`.svelte-kit/cloudflare/worker/index.js` since #741) to `_app.js` and
// writes a new `index.js` that imports it and this file and exports `withClock(app)`. Its `scheduled` handler (a Cron Trigger on
// the app Worker, from `triggers.crons`) runs one tick by calling the app's own fetch handler with
// an internal request. Every build is wrapped; whether the handler ever fires is decided only by
// `triggers.crons` in the wrangler config.
//
// The request is marked on the **env** object, not on the request: the scheduled handler passes
// `{ ...env, [INTERNAL_TICK]: true }` as the env, and the tick route reads that Symbol off
// `platform.env`. A Symbol key can't come from a header, a query string, a body, a cookie or a
// wrangler var, and every outside request reaches the app through the runtime's own `fetch(req,
// env)` with the plain env. So an outside caller can't take this path, and the internal call needs
// neither CRON_KEY nor a network hop. `Symbol.for` (the global registry) keeps the marker the same
// value in the wrapper's copy of this module and in the SvelteKit bundle's copy.
//
// #741: with adapter-cloudflare 9 the app no longer reads the `env` argument of `fetch(req, env)`;
// it reads `env` from `cloudflare:workers` (src/lib/server/platform.ts builds `platform.env` from
// it). So the tick runs the app's fetch inside `withEnv(markedEnv, …)`, which makes the module's
// `env` the marked one for that call; the marked env is still passed as the argument too.
//
// One import only (`cloudflare:workers`, a runtime built-in): `npm run build` transpiles this file
// on its own next to the unbundled adapter output (scripts/wrap-worker.mjs), so it must not import
// anything that needs bundling.
import { withEnv } from 'cloudflare:workers';

/** The env marker of a tick started by the app's own Cron Trigger. */
export const INTERNAL_TICK: unique symbol = Symbol.for('howdee-crm.internal-tick');

/** Path the scheduled handler calls (the same route the heartbeat Worker POSTs with CRON_KEY). */
export const TICK_PATH = '/api/automations/tick';

/** Host of the internal request. Reserved (.invalid), so it is never an archive or custom host. */
export const INTERNAL_TICK_ORIGIN = 'https://scheduled.invalid';

/** app_state key: which clock ran the last full tick, `cron` (the built-in clock) or `http` (the
 *  CRON_KEY endpoint). Written next to `last_tick`, whose summary is cut at 500 chars. */
export const CLOCK_KEY = 'last_tick_clock';

/** app_state key: set (value = the reason) when an internal tick ran nothing; cleared by the next
 *  full tick. Settings → Setup reads it. */
export const SKIP_KEY = 'last_tick_skipped';

/** Why an internal tick ran nothing: no public address to build links with. Since #731 the origin
 *  of the first admin's /setup request is that address, so this is left only as the safety net of
 *  an install with no admin yet, or one set up before #731 (or on a loopback host) whose admin
 *  hasn't chosen an address in the setup wizard. */
export const TICK_SKIPPED_NO_PUBLIC_URL = 'no_public_url';

/** #731: why a tick skipped every job that sends email: the provider resolution found no sending
 *  credentials (a fresh install before the wizard's Connect step). Housekeeping still ran. It is
 *  the tick summary's `skipped_sends` and the value of `SENDS_SKIPPED_KEY`. */
export const TICK_SKIPPED_NO_SENDING = 'no_sending_token';

/** #731: app_state key, set by a tick that skipped its sends (value = the reason), cleared by a tick
 *  that had credentials. Settings → Setup reads it for its "Scheduled work" row. */
export const SENDS_SKIPPED_KEY = 'last_tick_sends_skipped';

/** True only for a tick started by the `scheduled` handler of the wrapped Worker. */
export function isInternalTick(env: unknown): boolean {
	return !!env && typeof env === 'object' && (env as Record<symbol, unknown>)[INTERNAL_TICK] === true;
}

/**
 * #729: an internal tick's request origin is `INTERNAL_TICK_ORIGIN`, so with no Settings → Domain
 * value and no PUBLIC_BASE_URL every unsubscribe and tracking link would point there. True when
 * `baseUrl` (from `publicBaseUrlFor`) is that origin: the tick must then send nothing.
 */
export function isInternalOrigin(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).origin === INTERNAL_TICK_ORIGIN;
	} catch {
		return false;
	}
}

type FetchHandler = (req: Request, env: any, ctx: any) => Response | Promise<Response>;

/** Run one tick through the app's own fetch handler. Never throws; logs the outcome. */
export async function runInternalTick(appFetch: FetchHandler, env: object, ctx: unknown): Promise<{ status: number; body: string }> {
	try {
		const req = new Request(`${INTERNAL_TICK_ORIGIN}${TICK_PATH}`, { method: 'POST' });
		const marked = { ...env, [INTERNAL_TICK]: true };
		const res = await (withEnv(marked, () => appFetch(req, marked, ctx)) as Promise<Response>);
		const body = await res.text();
		if (!res.ok) console.error(`automation tick (cron) failed: ${res.status} ${body.slice(0, 300)}`);
		return { status: res.status, body };
	} catch (e) {
		console.error('automation tick (cron) threw:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		return { status: 500, body: '' };
	}
}

type AppWorker = { fetch: FetchHandler } & Record<string, unknown>;

/** The SvelteKit worker with a `scheduled` handler added; `fetch` (and anything else) unchanged. */
export function withClock<T extends AppWorker>(app: T): T & { scheduled: (controller: unknown, env: object, ctx: { waitUntil(p: Promise<unknown>): void }) => Promise<void> } {
	return {
		...app,
		fetch: app.fetch,
		async scheduled(_controller: unknown, env: object, ctx: { waitUntil(p: Promise<unknown>): void }) {
			await runInternalTick(app.fetch.bind(app), env, ctx);
		}
	};
}
