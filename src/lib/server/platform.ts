// #741: @sveltejs/adapter-cloudflare 8+ no longer fills `event.platform` (its changelog: "remove
// cloudflare `platform`, emulate the `cloudflare:workers` module instead"; the generated Worker calls
// `server.respond(req, { getClientAddress })` with no platform). The app reads `event.platform.env`
// / `.ctx` in well over a hundred places, and the tests build events with their own `platform`, so
// rather than rewrite every reader, `hooks.server.ts` calls `ensurePlatform` first thing and gives
// the event the same shape it had under adapter 7, built from `cloudflare:workers`:
//   env    = the module's `env` (the Worker's bindings; in `vite dev` the adapter's stub backed by
//            the platform proxy). Inside `withEnv(...)` (the internal tick, internal-tick.ts) it is
//            that env, so the tick's Symbol marker still reaches `platform.env`.
//   ctx    = `waitUntil` from the module (`passThroughOnException` is a no-op; nothing calls it)
//   caches = the global `caches` (the adapter no longer passes it either)
//   cf     = `request.cf`, where the runtime puts it
// An event that already has a platform (a test, or a future adapter that sets one) is left alone.
import { env, waitUntil } from 'cloudflare:workers';

type WithPlatform = { platform?: App.Platform; request: Request };

export function ensurePlatform(event: WithPlatform): void {
	if (event.platform) return;
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => waitUntil(promise),
		passThroughOnException: () => {},
		props: {}
	} as unknown as ExecutionContext;
	// RequestEvent.platform is typed readonly; SvelteKit itself assigns it lazily on the same
	// plain object (runtime/server/respond.js), so writing it here is safe.
	(event as { platform?: App.Platform }).platform = {
		env: env as unknown as Env,
		ctx,
		caches: globalThis.caches as unknown as CacheStorage,
		cf: (event.request as unknown as { cf?: IncomingRequestCfProperties }).cf
	};
}
