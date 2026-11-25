// #729: the app Worker runs its own clock. `npm run build` wraps the adapter's _worker.js
// (scripts/wrap-worker-lib.mjs): the new _worker.js = withClock(./_app.js): fetch unchanged,
// scheduled runs one tick through the app's own fetch handler with a Symbol marker on the env.
// The CRON_KEY endpoint keeps working as before; outside requests can't use the marker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import pkg from '../package.json';
import { POST } from '../src/routes/api/automations/tick/+server';
import { CLOCK_KEY, INTERNAL_TICK, SKIP_KEY, TICK_PATH, isInternalOrigin, isInternalTick, withClock } from '../src/lib/server/internal-tick';
import { localRequiredChecks } from '../src/lib/server/setup-checks';
import { clearDomainCache } from '../src/lib/server/public-url';
import { APP_FILE, WRAPPER_MARKER, wrapWorker, wrapperSource, withAppIgnored } from '../scripts/wrap-worker-lib.mjs';

const db = (testEnv as any).DB as D1Database;

beforeEach(async () => {
	await db.prepare(`DELETE FROM app_state WHERE key LIKE 'custom_domain%' OR key IN ('last_tick', ?, ?)`).bind(CLOCK_KEY, SKIP_KEY).run();
	clearDomainCache();
});
afterEach(() => vi.restoreAllMocks());

function baseEnv(extra: Record<string | symbol, unknown> = {}): Record<string | symbol, unknown> {
	return {
		DB: db,
		SESSION_SECRET: 's',
		POSTMARK_TOKEN: 't',
		POSTMARK_FROM: 'sender@example.com',
		POSTMARK_STREAM: 'broadcast',
		POSTMARK_STREAM_TX: 'outbound',
		PUBLIC_BASE_URL: 'https://crm.example.com',
		...extra
	};
}

/** The RequestEvent SvelteKit would build for this request and env. */
function eventFor(request: Request, env: object) {
	return { url: new URL(request.url), params: {}, request, locals: { user: null }, platform: { env } } as any;
}

const post = (url: string, headers: Record<string, string>, env: object) =>
	POST(eventFor(new Request(url, { method: 'POST', headers }), env));

async function state(key: string): Promise<string | null> {
	return (await db.prepare(`SELECT value FROM app_state WHERE key = ?`).bind(key).first<{ value: string | null }>())?.value ?? null;
}

/** A fake app (what the wrapper imports as ./_app.js) whose fetch runs the real tick route. */
function routeApp() {
	const seen: { env: Record<string | symbol, unknown>; status: number; body: any }[] = [];
	const app = {
		fetch: async (req: Request, env: Record<string | symbol, unknown>) => {
			const res = await POST(eventFor(req, env));
			seen.push({ env, status: res.status, body: await res.clone().json() });
			return res;
		}
	};
	return { app, seen };
}

describe('#729 withClock', () => {
	it('passes fetch through unchanged', async () => {
		const res = new Response('page');
		const app = { fetch: vi.fn(async (_req: Request, _env: unknown, _ctx: unknown) => res) };
		const worker = withClock(app);
		const req = new Request('https://crm.example.com/contacts');
		const env = { A: 1 };
		const ctx = { waitUntil() {} };
		expect(await worker.fetch(req, env, ctx)).toBe(res);
		expect(app.fetch.mock.calls).toEqual([[req, env, ctx]]);
	});

	it('scheduled POSTs the tick path once, with the marker on a copy of the env', async () => {
		const app = { fetch: vi.fn(async (_req: Request, _env: unknown, _ctx: unknown) => new Response('{"ok":true}')) };
		const env = { DB: 'db', CRON_KEY: '' };
		await withClock(app).scheduled({}, env, { waitUntil() {} });
		expect(app.fetch.mock.calls.length).toBe(1);
		const [req, rawEnv] = app.fetch.mock.calls[0];
		const passedEnv = rawEnv as Record<string | symbol, unknown>;
		expect(req.method).toBe('POST');
		expect(new URL(req.url).pathname).toBe(TICK_PATH);
		expect(req.headers.get('authorization')).toBeNull();
		expect(isInternalTick(passedEnv)).toBe(true);
		expect(passedEnv.DB).toBe('db');
		expect(isInternalTick(env)).toBe(false); // the runtime's env is not changed
	});

	it('scheduled never throws and logs a failed tick', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await withClock({ fetch: async () => new Response('nope', { status: 500 }) }).scheduled({}, {}, { waitUntil() {} });
		await withClock({ fetch: async () => { throw new Error('boom'); } }).scheduled({}, {}, { waitUntil() {} });
		expect(spy.mock.calls.length).toBe(2);
	});
});

describe('#729 the tick route', () => {
	it('the scheduled handler runs a tick without CRON_KEY (clock = cron)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { app, seen } = routeApp();
		const env = baseEnv();
		await withClock(app).scheduled({}, env, { waitUntil() {} });
		expect(seen.length).toBe(1);
		expect(seen[0].status).toBe(200);
		expect(seen[0].body.ok).toBe(true);
		// The env the app saw is a copy carrying the marker; the runtime's env never gets it.
		expect(seen[0].env).not.toBe(env);
		expect(seen[0].env[INTERNAL_TICK]).toBe(true);
		expect(seen[0].env.DB).toBe(db);
		expect(INTERNAL_TICK in env).toBe(false);
		expect(await state(CLOCK_KEY)).toBe('cron');
		expect(await state('last_tick')).not.toContain('"clock"');
	});

	it('an outside request cannot use the internal path', async () => {
		const env = baseEnv({ CRON_KEY: 'cron-729', 'howdee-crm.internal-tick': true, INTERNAL_TICK: true });
		const url = `https://crm.example.com${TICK_PATH}`;
		const headerSets: Record<string, string>[] = [{}, { 'x-internal-tick': '1' }, { authorization: 'Bearer wrong' }, { authorization: 'Bearer true' }];
		for (const headers of headerSets) {
			const res = await post(`${url}?internal=1`, headers, env);
			expect(res.status).toBe(401);
		}
		// The marker is a Symbol: string keys (a wrangler var, a JSON body) never match it.
		expect(isInternalTick({ 'howdee-crm.internal-tick': true })).toBe(false);
		expect(isInternalTick(JSON.parse(JSON.stringify({ [INTERNAL_TICK]: true })))).toBe(false);
		expect(isInternalTick({ [INTERNAL_TICK]: 'true' })).toBe(false);
		expect(isInternalTick(undefined)).toBe(false);
	});

	it('without CRON_KEY an outside request is still refused (500, as before)', async () => {
		let err: unknown;
		try {
			await post(`https://crm.example.com${TICK_PATH}`, {}, baseEnv());
		} catch (e) {
			err = e;
		}
		expect(isHttpError(err) && err.status).toBe(500);
	});

	it('the key-gated endpoint is unchanged (clock = http)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const env = baseEnv({ CRON_KEY: 'cron-729' });
		const url = `https://crm.example.com${TICK_PATH}`;
		expect((await post(url, { authorization: 'Bearer cron-729' }, env)).status).toBe(200);
		expect(await state(CLOCK_KEY)).toBe('http');
		expect((await post(`${url}?key=cron-729`, {}, env)).status).toBe(200);
		expect((await post(url, { authorization: 'Bearer nope' }, env)).status).toBe(401);
	});
});

describe('#729 no public address: the built-in clock sends nothing', () => {
	it('an internal tick without Settings → Domain or PUBLIC_BASE_URL runs no job', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { app, seen } = routeApp();
		await withClock(app).scheduled({}, baseEnv({ PUBLIC_BASE_URL: '' }), { waitUntil() {} });
		expect(seen[0].status).toBe(200);
		expect(seen[0].body).toEqual({ ok: false, skipped: 'no_public_url' });
		expect(spy.mock.calls.map((c) => String(c[0]))).toEqual(['automation tick (cron) skipped: no public URL (open Settings → Setup, or set Settings → Domain or PUBLIC_BASE_URL)']);
		// Nothing ran: no last tick, no clock; only the skip marker.
		expect(await state('last_tick')).toBeNull();
		expect(await state(CLOCK_KEY)).toBeNull();
		expect(await state(SKIP_KEY)).toBe('no_public_url');

		const row = (await localRequiredChecks(db, baseEnv({ PUBLIC_BASE_URL: '' }) as Record<string, unknown>)).find((c) => c.id === 'public_url')!;
		expect(row.state).toBe('attention');
		expect(row.fix).toContain('Settings → Domain');
		expect(row.fix).toContain('PUBLIC_BASE_URL');
	});

	it('a Settings → Domain value is enough, and the next full tick clears the row', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { app, seen } = routeApp();
		await withClock(app).scheduled({}, baseEnv({ PUBLIC_BASE_URL: '' }), { waitUntil() {} });
		expect(await state(SKIP_KEY)).toBe('no_public_url');
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('custom_domain', 'crm.example.com')`).run();
		clearDomainCache();
		await withClock(app).scheduled({}, baseEnv({ PUBLIC_BASE_URL: '' }), { waitUntil() {} });
		expect(seen[1].body.ok).toBe(true);
		expect(await state(SKIP_KEY)).toBeNull();
		expect((await localRequiredChecks(db, baseEnv() as Record<string, unknown>)).some((c) => c.id === 'public_url')).toBe(false);
	});

	it('the key-gated path keeps today’s behaviour without a public address', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await post(`https://crm.example.com${TICK_PATH}`, { authorization: 'Bearer k' }, baseEnv({ CRON_KEY: 'k', PUBLIC_BASE_URL: '' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
		expect(await state(SKIP_KEY)).toBeNull();
	});

	it('isInternalOrigin', () => {
		expect(isInternalOrigin('https://scheduled.invalid')).toBe(true);
		expect(isInternalOrigin('https://crm.example.com')).toBe(false);
		expect(isInternalOrigin('')).toBe(false);
	});
});

describe('#729 setup checks', () => {
	const stamp = async (clock: string, minutesAgo: number, summary = JSON.stringify({ sent: 1 })) => {
		await db.prepare(`DELETE FROM app_state WHERE key IN ('last_tick', ?)`).bind(CLOCK_KEY).run();
		await db.batch([
			db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('last_tick', ?, datetime('now', ?))`).bind(summary, `-${minutesAgo} minutes`),
			db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now', ?))`).bind(CLOCK_KEY, clock, `-${minutesAgo} minutes`)
		]);
	};
	const row = async (id: string, env: Record<string, unknown>) =>
		(await localRequiredChecks(db, env)).find((c) => c.id === id)!;

	it('CRON_KEY is not needed once the built-in clock ticked recently', async () => {
		await stamp('cron', 1);
		expect((await row('cron_key', baseEnv() as Record<string, unknown>)).state).toBe('ready');
		const hb = await row('heartbeat', baseEnv() as Record<string, unknown>);
		expect(hb.state).toBe('ready');
		expect(hb.detail).toContain('built-in clock');
	});

	it('CRON_KEY still needs attention when the heartbeat endpoint ticked, or the built-in clock went stale', async () => {
		await stamp('http', 1);
		expect((await row('cron_key', baseEnv() as Record<string, unknown>)).state).toBe('attention');
		expect((await row('heartbeat', baseEnv() as Record<string, unknown>)).detail).toContain('heartbeat endpoint');
		await stamp('cron', 30);
		expect((await row('cron_key', baseEnv() as Record<string, unknown>)).state).toBe('attention');
		expect((await row('heartbeat', baseEnv() as Record<string, unknown>)).state).toBe('attention');
	});

	it('#731: no tick yet → both rows need attention and say first that the built-in clock runs once a minute', async () => {
		const cron = await row('cron_key', baseEnv() as Record<string, unknown>);
		const hb = await row('heartbeat', baseEnv() as Record<string, unknown>);
		expect(cron.state).toBe('attention');
		expect(hb.state).toBe('attention');
		for (const fix of [cron.fix!, hb.fix!]) {
			expect(fix.startsWith('The built-in clock runs once a minute.')).toBe(true);
			expect(fix).toContain('can take up to 15 minutes to start after the first deploy');
		}
		expect(hb.fix!.indexOf('triggers.crons')).toBeGreaterThan(hb.fix!.indexOf('up to 15 minutes'));
		expect(cron.fix!.indexOf('CRON_KEY')).toBeGreaterThan(cron.fix!.indexOf('up to 15 minutes'));
	});

	it('a long summary (cut at 500 chars, not valid JSON) never hides the clock', async () => {
		const long = JSON.stringify({ errors: { a: 'x'.repeat(300), b: 'y'.repeat(300) }, sent: 3 }).slice(0, 500);
		expect(() => JSON.parse(long)).toThrow();
		await stamp('cron', 1, long);
		expect((await row('cron_key', baseEnv() as Record<string, unknown>)).state).toBe('ready');
		expect((await row('heartbeat', baseEnv() as Record<string, unknown>)).detail).toContain('built-in clock');
	});

	it('a tick from before #729 (no clock row) reads as an unknown clock', async () => {
		await db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('last_tick', 'x', datetime('now'))`).run();
		const hb = await row('heartbeat', baseEnv() as Record<string, unknown>);
		expect(hb.state).toBe('ready');
		expect(hb.detail).not.toContain(' by the ');
		expect((await row('cron_key', baseEnv() as Record<string, unknown>)).state).toBe('attention');
	});
});

describe('#729 wrap-worker (the build step)', () => {
	const DIR = '/repo/.svelte-kit/cloudflare';
	const TICK = '../../src/lib/server/internal-tick.ts';
	const ADAPTER = "import { Server } from './../output/server/index.js';\nexport { worker_default as default };\n";
	const IGNORE = '\n_worker.js\n_routes.json\n_headers\n_redirects';

	function fakeFs(files: Record<string, string>) {
		const map = new Map(Object.entries(files));
		const ops: string[] = [];
		return {
			map,
			ops,
			fs: {
				exists: (p: string) => map.has(p),
				read: (p: string) => {
					if (!map.has(p)) throw new Error(`ENOENT ${p}`);
					return map.get(p)!;
				},
				write: (p: string, text: string) => {
					ops.push(`write ${p}`);
					map.set(p, text);
				},
				rename: (from: string, to: string) => {
					ops.push(`rename ${from} ${to}`);
					map.set(to, map.get(from)!);
					map.delete(from);
				}
			}
		};
	}

	it('moves the adapter worker to _app.js and writes the wrapper', () => {
		const f = fakeFs({ [`${DIR}/_worker.js`]: ADAPTER, [`${DIR}/.assetsignore`]: IGNORE });
		expect(wrapWorker(DIR, f.fs, { tickModule: TICK })).toEqual({ wrapped: true, ignoreUpdated: true });
		expect(f.map.get(`${DIR}/_app.js`)).toBe(ADAPTER);
		const wrapper = f.map.get(`${DIR}/_worker.js`)!;
		expect(wrapper).toBe(wrapperSource(TICK));
		expect(wrapper.startsWith(WRAPPER_MARKER)).toBe(true);
		expect(wrapper).toContain("import app from './_app.js';");
		expect(wrapper).toContain(`import { withClock } from '${TICK}';`);
		expect(wrapper).toContain('export default withClock(app);');
	});

	it('keeps server code out of the static assets (.assetsignore)', () => {
		const f = fakeFs({ [`${DIR}/_worker.js`]: ADAPTER, [`${DIR}/.assetsignore`]: IGNORE });
		wrapWorker(DIR, f.fs, { tickModule: TICK });
		const lines = f.map.get(`${DIR}/.assetsignore`)!.split('\n');
		expect(lines).toContain('_worker.js');
		expect(lines).toContain(APP_FILE);
		expect(lines.filter((l) => l === APP_FILE).length).toBe(1);
		// No .assetsignore at all: one is written.
		const g = fakeFs({ [`${DIR}/_worker.js`]: ADAPTER });
		wrapWorker(DIR, g.fs, { tickModule: TICK });
		expect(g.map.get(`${DIR}/.assetsignore`)).toBe('_app.js\n');
		expect(withAppIgnored('a\n_app.js\n')).toBe('a\n_app.js\n');
		expect(withAppIgnored('a')).toBe('a\n_app.js\n');
	});

	it('is idempotent: a second run changes nothing', () => {
		const f = fakeFs({ [`${DIR}/_worker.js`]: ADAPTER, [`${DIR}/.assetsignore`]: IGNORE });
		wrapWorker(DIR, f.fs, { tickModule: TICK });
		const snapshot = new Map(f.map);
		f.ops.length = 0;
		expect(wrapWorker(DIR, f.fs, { tickModule: TICK })).toEqual({ wrapped: false, ignoreUpdated: false });
		expect(f.ops).toEqual([]);
		expect(f.map).toEqual(snapshot);
		expect(f.map.get(`${DIR}/_app.js`)).toBe(ADAPTER); // never wraps the wrapper
	});

	it('a fresh adapter build over a stale _app.js wraps the new build', () => {
		const f = fakeFs({ [`${DIR}/_worker.js`]: ADAPTER, [`${DIR}/_app.js`]: 'old build' });
		expect(wrapWorker(DIR, f.fs, { tickModule: TICK }).wrapped).toBe(true);
		expect(f.map.get(`${DIR}/_app.js`)).toBe(ADAPTER);
	});

	it('fails loudly when the adapter output is missing or half-wrapped', () => {
		expect(() => wrapWorker(DIR, fakeFs({}).fs, { tickModule: TICK })).toThrow(/_worker\.js not found/);
		const half = fakeFs({ [`${DIR}/_worker.js`]: wrapperSource(TICK) });
		expect(() => wrapWorker(DIR, half.fs, { tickModule: TICK })).toThrow(/_app\.js is missing/);
	});

	it('runs as part of `npm run build` (deploy runs `npm run build`, so it cannot be skipped)', () => {
		expect(pkg.scripts.build).toMatch(/&& vite build && node scripts\/wrap-worker\.mjs$/);
		expect(pkg.scripts.preview).toContain('.svelte-kit/cloudflare/_worker.js');
	});
});
