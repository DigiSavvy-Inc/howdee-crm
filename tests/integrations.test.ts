import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	CRON_INTERVAL_MS,
	githubProvider,
	timingProvider,
	integrationsStatus,
	recentSyncs,
	runIntegrationsTick,
	runProviderSync,
	testConnection,
	type IntegrationProvider,
	type IntegrationEnv
} from '../src/lib/server/integrations';

const db = (env as any).DB as D1Database;

beforeEach(async () => {
	await db.prepare(`DELETE FROM integration_syncs`).run();
	await db.prepare(`DELETE FROM app_state WHERE key LIKE 'integration_%'`).run();
});

/** A fake provider whose sync records calls and can be made to throw. */
function fake(id: 'timing' | 'github', secret: keyof IntegrationEnv, opts: { fail?: string } = {}) {
	const calls: string[] = [];
	const p: IntegrationProvider = {
		provider: id,
		label: id,
		secretName: secret,
		tokenHelp: '',
		isConfigured: (e) => !!e[secret],
		probe: async () => ({ state: 'connected', detail: 'ok', checkedAt: new Date().toISOString() }),
		sync: async (_db, _env, o) => {
			calls.push(o.trigger);
			if (opts.fail) throw new Error(opts.fail);
			return { counts: { items: 3 }, errors: [] };
		}
	};
	return { p, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('runIntegrationsTick', () => {
	it('runs only configured providers', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN');
		const g = fake('github', 'GITHUB_TOKEN');
		const res = await runIntegrationsTick(db, { TIMING_API_TOKEN: 'tok' }, { providers: [t.p, g.p] });
		expect(t.calls).toEqual(['cron']);
		expect(g.calls).toEqual([]);
		expect(res.map((r) => r.provider)).toEqual(['timing']);
		const rows = await recentSyncs(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ provider: 'timing', trigger: 'cron', ok: 1 });
	});

	it('throttles cron runs to once per interval per provider', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN');
		const e = { TIMING_API_TOKEN: 'tok' };
		const t0 = new Date('2026-10-01T00:00:00Z');
		await runIntegrationsTick(db, e, { providers: [t.p], now: t0 });
		await runIntegrationsTick(db, e, { providers: [t.p], now: new Date(t0.getTime() + 60_000) });
		await runIntegrationsTick(db, e, { providers: [t.p], now: new Date(t0.getTime() + CRON_INTERVAL_MS - 1) });
		expect(t.calls).toHaveLength(1);
		await runIntegrationsTick(db, e, { providers: [t.p], now: new Date(t0.getTime() + CRON_INTERVAL_MS) });
		expect(t.calls).toHaveLength(2);
	});

	it('a manual sync does not reset the cron schedule', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN');
		const e = { TIMING_API_TOKEN: 'tok' };
		await runProviderSync(db, e, t.p, 'manual');
		await runIntegrationsTick(db, e, { providers: [t.p] });
		expect(t.calls).toEqual(['manual', 'cron']);
	});
});

describe('runProviderSync', () => {
	it('logs a success row with counts', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN');
		const r = await runProviderSync(db, { TIMING_API_TOKEN: 'tok' }, t.p, 'manual');
		expect(r).toMatchObject({ provider: 'timing', ok: true });
		const [row] = await recentSyncs(db);
		expect(row.ok).toBe(1);
		expect(row.trigger).toBe('manual');
		expect(row.finished_at).not.toBeNull();
		expect(JSON.parse(row.detail!)).toEqual({ counts: { items: 3 }, errors: [] });
	});

	it('logs a failure row and scrubs the secret from the error', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN', { fail: 'boom with sekret-123 inside' });
		const r = await runProviderSync(db, { TIMING_API_TOKEN: 'sekret-123' }, t.p, 'cron');
		expect(r).toMatchObject({ ok: false });
		const [row] = await recentSyncs(db);
		expect(row.ok).toBe(0);
		expect(row.detail).toContain('[redacted]');
		expect(row.detail).not.toContain('sekret-123');
	});

	it('skips unconfigured providers without a row', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN');
		const r = await runProviderSync(db, {}, t.p, 'manual');
		expect(r).toEqual({ provider: 'timing', skipped: 'not_configured' });
		expect(await recentSyncs(db)).toHaveLength(0);
	});

	it('never overlaps: a held lease blocks, an expired one is reclaimed', async () => {
		const t = fake('timing', 'TIMING_API_TOKEN');
		const e = { TIMING_API_TOKEN: 'tok' };
		const future = new Date(Date.now() + 5 * 60_000).toISOString();
		await db
			.prepare(`INSERT INTO app_state (key, value) VALUES ('integration_lock:timing', ?)`)
			.bind(future)
			.run();
		expect(await runProviderSync(db, e, t.p, 'manual')).toEqual({ provider: 'timing', skipped: 'locked' });
		expect(t.calls).toHaveLength(0);

		await db
			.prepare(`UPDATE app_state SET value = ? WHERE key = 'integration_lock:timing'`)
			.bind(new Date(Date.now() - 60_000).toISOString())
			.run();
		expect(await runProviderSync(db, e, t.p, 'manual')).toMatchObject({ ok: true });
		// …and the lease is released afterwards.
		expect(await runProviderSync(db, e, t.p, 'manual')).toMatchObject({ ok: true });
	});
});

describe('probes + card state', () => {
	it('no secrets → every card not configured', async () => {
		const s = await integrationsStatus(db, {});
		expect(s.map((p) => [p.provider, p.state])).toEqual([
			['timing', 'not_configured'],
			['github', 'not_configured'],
			['zoho_books', 'not_configured']
		]);
	});

	it('secret set but untested → untested', async () => {
		const s = await integrationsStatus(db, { GITHUB_TOKEN: 'x' });
		expect(s.find((p) => p.provider === 'github')!.state).toBe('untested');
	});

	it('GitHub probe success → connected with login + rate limit', async () => {
		const f = (async () => json({ login: 'ourco-admin' }, 200, { 'x-ratelimit-remaining': '4999' })) as typeof fetch;
		const probe = await testConnection(db, { GITHUB_TOKEN: 'x' }, githubProvider, f);
		expect(probe).toMatchObject({ state: 'connected' });
		expect(probe!.detail).toContain('ourco-admin');
		expect(probe!.detail).toContain('4999');
		const s = await integrationsStatus(db, { GITHUB_TOKEN: 'x' });
		expect(s.find((p) => p.provider === 'github')!.state).toBe('connected');
	});

	it('probe 401 → "secret set but rejected" state', async () => {
		const f = (async () => json({ message: 'Bad credentials' }, 401)) as typeof fetch;
		const probe = await testConnection(db, { TIMING_API_TOKEN: 'bad' }, timingProvider, f);
		expect(probe!.state).toBe('rejected');
		const s = await integrationsStatus(db, { TIMING_API_TOKEN: 'bad' });
		expect(s.find((p) => p.provider === 'timing')!.state).toBe('rejected');
	});

	it('network error → error state, not a throw', async () => {
		const f = (async () => {
			throw new Error('connect failed');
		}) as typeof fetch;
		const probe = await timingProvider.probe({ TIMING_API_TOKEN: 'x' }, f);
		expect(probe.state).toBe('error');
	});

	it('a stale probe is ignored once the secret is removed', async () => {
		const f = (async () => json({ login: 'a' })) as typeof fetch;
		await testConnection(db, { GITHUB_TOKEN: 'x' }, githubProvider, f);
		const s = await integrationsStatus(db, {});
		expect(s.find((p) => p.provider === 'github')).toMatchObject({ state: 'not_configured', probe: null });
	});

	it('real provider sync failure (HTTP 401) is logged as ok=0', async () => {
		const f = (async () => json({}, 401)) as typeof fetch;
		const r = await runProviderSync(db, { TIMING_API_TOKEN: 'bad' }, timingProvider, 'manual', { fetch: f });
		expect(r).toMatchObject({ ok: false });
		const [row] = await recentSyncs(db);
		expect(JSON.parse(row.detail!).error).toContain('401');
	});
});
