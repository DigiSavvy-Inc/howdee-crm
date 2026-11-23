import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';

// #537: one job that throws must not stop the jobs after it, and the tick still records itself.
vi.mock('$lib/server/automations', async (orig) => ({
	...(await orig<typeof import('$lib/server/automations')>()),
	tick: async () => {
		throw new Error('tick boom');
	}
}));
vi.mock('$lib/server/scheduled', async (orig) => ({
	...(await orig<typeof import('$lib/server/scheduled')>()),
	processScheduledCampaigns: async () => {
		throw new Error('scheduled boom');
	}
}));
vi.mock('$lib/server/hygiene', async (orig) => ({
	...(await orig<typeof import('$lib/server/hygiene')>()),
	runHygieneBackfill: async () => {
		throw new Error('hygiene boom');
	}
}));

import { POST } from '../src/routes/api/automations/tick/+server';
import { load } from '../src/routes/+page.server';

const db = (env as any).DB as D1Database;

afterEach(() => vi.restoreAllMocks());

function event() {
	const url = new URL('https://crm.example.com/api/automations/tick');
	return {
		url,
		params: {},
		request: new Request(url, { method: 'POST', headers: { authorization: 'Bearer cron-537' } }),
		locals: { user: null },
		platform: {
			env: {
				DB: db,
				SESSION_SECRET: 's',
				POSTMARK_TOKEN: 't',
				CRON_KEY: 'cron-537',
				POSTMARK_FROM: 'sender@example.com',
				POSTMARK_STREAM: 'broadcast',
				POSTMARK_STREAM_TX: 'outbound',
				PUBLIC_BASE_URL: 'https://crm.example.com'
			}
		}
	} as any;
}

describe('#537 heartbeat isolation', () => {
	it('keeps running later jobs, records errors, stamps attempt and last tick', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await POST(event());
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, any>;
		expect(Object.keys(body.errors).sort()).toEqual(['automation tick', 'hygiene backfill', 'scheduled campaigns']);
		// Jobs after the failures still ran.
		expect(body.deliverability).toBeDefined();
		expect(body.reportHistory).toBeDefined();
		expect(body.backup).toBeDefined();
		const rows = await db
			.prepare(`SELECT key FROM app_state WHERE key IN ('last_tick', 'last_tick_attempt')`)
			.all<{ key: string }>();
		expect(rows.results.map((r) => r.key).sort()).toEqual(['last_tick', 'last_tick_attempt']);
	});

	it('dashboard warns about a late heartbeat with no active automation', async () => {
		await db.prepare(`UPDATE automations SET status = 'paused' WHERE status = 'active'`).run();
		await db
			.prepare(`UPDATE app_state SET updated_at = datetime('now', '-30 minutes') WHERE key = 'last_tick'`)
			.run();
		const data = (await load({
			url: new URL('https://crm.example.com/'),
			locals: { user: null },
			platform: { env: { DB: db } },
			cookies: { get: () => undefined }
		} as any)) as any;
		expect(data.health.active_automations).toBe(0);
		expect(data.health.heartbeatStale).toBe(true);
	});
});
