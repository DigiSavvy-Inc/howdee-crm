import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { GET } from '../src/routes/api/health/+server';
import hooksSource from '../src/hooks.server.ts?raw';
import { REDIRECT_EXEMPT } from '../src/lib/server/public-url';

// #637: GET /api/health — the instance health check. Bearer CRON_KEY only; counts and names, no personal data.

const DB = (env as any).DB as D1Database;
const KEY = 'health-test-key';

async function call(headers: Record<string, string> = {}, platformEnv: Record<string, unknown> = { DB, CRON_KEY: KEY }) {
	const url = new URL('https://app.test/api/health');
	const res = await GET({
		url,
		params: {},
		request: new Request(url, { headers }),
		platform: { env: platformEnv }
	} as any);
	return { status: res.status, body: (await res.json()) as any };
}

describe('GET /api/health', () => {
	it('401 without the key, with a wrong key, a ?key= param, or no CRON_KEY configured', async () => {
		expect((await call()).status).toBe(401);
		expect((await call({ authorization: 'Bearer nope' })).status).toBe(401);
		expect((await call({ authorization: `Bearer ${KEY}x` })).status).toBe(401);
		const url = new URL(`https://app.test/api/health?key=${KEY}`);
		const viaQuery = await GET({ url, params: {}, request: new Request(url), platform: { env: { DB, CRON_KEY: KEY } } } as any);
		expect(viaQuery.status).toBe(401);
		expect((await call({ authorization: 'Bearer ' }, { DB, CRON_KEY: '' })).status).toBe(401);
		expect((await call({ authorization: `Bearer ${KEY}` }, { DB })).status).toBe(401);
		const denied = await call({ authorization: 'Bearer nope' });
		expect(denied.body).toEqual({ error: 'unauthorized' });
	});

	it('returns ok, the newest applied migration, the last tick and a user count — nothing else', async () => {
		await DB.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES ('last_tick', '{}', '2026-11-18 10:00:00')
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		).run();
		const users = (await DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;
		const newestFile = typeof __LATEST_MIGRATION__ === 'string' ? __LATEST_MIGRATION__ : '';

		const { status, body } = await call({ authorization: `Bearer ${KEY}` });
		expect(status).toBe(200);
		expect(Object.keys(body).sort()).toEqual(['last_tick_at', 'latest_migration', 'ok', 'users']);
		expect(body.ok).toBe(true);
		expect(body.last_tick_at).toBe('2026-11-18 10:00:00');
		expect(body.users).toBe(users);
		expect(typeof body.latest_migration).toBe('string');
		if (newestFile) expect(body.latest_migration).toBe(newestFile);
		expect(JSON.stringify(body)).not.toMatch(/@/);
	});

	it('last_tick_at is null before the first tick', async () => {
		await DB.prepare(`DELETE FROM app_state WHERE key = 'last_tick'`).run();
		const { status, body } = await call({ authorization: `bearer ${KEY}` });
		expect(status).toBe(200);
		expect(body.last_tick_at).toBeNull();
	});

	it('is public, CSRF-exempt and never redirected (machine endpoint)', () => {
		const lists = hooksSource.match(/const (PUBLIC_PREFIXES|CSRF_EXEMPT) = \[[\s\S]*?\];/g) ?? [];
		expect(lists).toHaveLength(2);
		for (const list of lists) expect(list).toContain("'/api/health'");
		expect(REDIRECT_EXEMPT).toContain('/api/health');
	});
});
