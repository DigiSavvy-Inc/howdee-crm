// #741: adapter-cloudflare 8+ no longer sets `event.platform`; hooks.server.ts rebuilds it from
// `cloudflare:workers` (src/lib/server/platform.ts) so every `event.platform.env` reader keeps working.
import { describe, expect, it } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import { withEnv } from 'cloudflare:workers';
import { ensurePlatform } from '../src/lib/server/platform';
import { INTERNAL_TICK, isInternalTick } from '../src/lib/server/internal-tick';

const request = () => new Request('https://crm.example.com/');

describe('#741 ensurePlatform', () => {
	it('fills platform from cloudflare:workers when the adapter left it unset', async () => {
		const event: { platform?: App.Platform; request: Request } = { request: request() };
		ensurePlatform(event);
		expect(event.platform).toBeDefined();
		// The test Worker's own bindings (the same D1 binding the suites use).
		expect(typeof (event.platform!.env as unknown as { DB?: D1Database }).DB?.prepare).toBe('function');
		expect(typeof (testEnv as unknown as { DB?: D1Database }).DB?.prepare).toBe('function');
		// Code spreads platform.env (e.g. `{ ...env, [INTERNAL_TICK]: true }`): the copy's bindings
		// must still work, so the proxy has to expose them as own enumerable keys.
		const copy = { ...(event.platform!.env as unknown as Record<string, unknown>) } as { DB?: D1Database };
		expect(typeof copy.DB?.prepare).toBe('function');
		expect(await copy.DB!.prepare('SELECT 1 AS n').first<{ n: number }>()).toEqual({ n: 1 });
		expect(typeof event.platform!.ctx.waitUntil).toBe('function');
		expect(event.platform!.caches).toBe(globalThis.caches);
	});

	it('leaves an existing platform alone (tests build their own)', () => {
		const own = { env: { DB: 'mine' } } as unknown as App.Platform;
		const event = { platform: own, request: request() };
		ensurePlatform(event);
		expect(event.platform).toBe(own);
	});

	it('inside withEnv (the internal tick) platform.env carries the marker; outside it does not', async () => {
		const marked = { ...(testEnv as unknown as object), [INTERNAL_TICK]: true };
		const inside = await (withEnv(marked, async () => {
			const event: { platform?: App.Platform; request: Request } = { request: request() };
			ensurePlatform(event);
			return isInternalTick(event.platform!.env);
		}) as Promise<boolean>);
		expect(inside).toBe(true);
		const event: { platform?: App.Platform; request: Request } = { request: request() };
		ensurePlatform(event);
		expect(isInternalTick(event.platform!.env)).toBe(false);
	});
});
