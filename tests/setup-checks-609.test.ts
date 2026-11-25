import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import {
	expectedMigration,
	localRequiredAttention,
	migrationsCheck,
	optionalChecks,
	postmarkChecks,
	runSetupChecks,
	usableFrom,
	webhookMatches,
	type SetupCheck
} from '../src/lib/server/setup-checks';
import { load as setupPageLoad } from '../src/routes/settings/setup/+page.server';
import { load as dashboardLoad } from '../src/routes/+page.server';

// #609: Settings → Setup. Each check in its ready and not-ready state, no secret values in the
// page data, admin only.

const db = (env as { DB: D1Database }).DB;

const SECRETS = {
	SESSION_SECRET: 'sess-secret-value-609',
	POSTMARK_TOKEN: 'pm-token-value-609',
	CRON_KEY: 'cron-key-value-609',
	WEBHOOK_KEY: 'webhook-key-value-609',
	GITHUB_CLIENT_ID: 'gh-client-id-609',
	GITHUB_CLIENT_SECRET: 'gh-client-secret-609',
	ANTHROPIC_API_KEY: 'sk-ant-value-609-xxxxxxxxxxxxxxxx',
	MAIL_TOKEN_KEY: 'mail-token-key-609',
	INGEST_KEY: 'ingest-key-value-609'
};

function goodEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		DB: db,
		MEDIA: {},
		POSTMARK_FROM: 'sender@ourco.test',
		POSTMARK_STREAM: 'broadcast',
		POSTMARK_STREAM_TX: 'outbound',
		...SECRETS,
		...extra
	};
}

type Answer = { status: number; body?: unknown };

/** Postmark stand-in: path (without query) → answer. Records the token it was sent. */
function fakePostmark(answers: Record<string, Answer>) {
	const seen: string[] = [];
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		seen.push(url.pathname + url.search);
		const hdr = new Headers(init?.headers).get('X-Postmark-Server-Token');
		if (hdr !== SECRETS.POSTMARK_TOKEN) return new Response('{}', { status: 401 });
		const a = answers[url.pathname];
		if (!a) return new Response('{}', { status: 404 });
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
	}) as typeof fetch;
	return { fn, seen };
}

const GOOD_PM: Record<string, Answer> = {
	'/message-streams/broadcast': { status: 200, body: { ID: 'broadcast', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } } },
	'/message-streams/outbound': { status: 200, body: { ID: 'outbound' } },
	'/webhooks': { status: 200, body: { Webhooks: [{ ID: 1, Url: `https://crm.ourco.test/api/webhook?key=${SECRETS.WEBHOOK_KEY}` }] } }
};

const byId = (rows: SetupCheck[], id: string) => {
	const r = rows.find((c) => c.id === id);
	if (!r) throw new Error(`no row ${id}`);
	return r;
};

async function tickAgo(minutes: number | null) {
	await db.prepare(`DELETE FROM app_state WHERE key IN ('last_tick', 'default_from')`).run();
	if (minutes === null) return;
	await db
		.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('last_tick', 'x', datetime('now', ?))`)
		.bind(`-${minutes} minutes`)
		.run();
}

function pageEvent(role: 'admin' | 'member', envOverride: Record<string, unknown> = goodEnv(), path = '/settings/setup') {
	return {
		url: new URL(`https://app.test${path}`),
		params: {},
		platform: { env: envOverride },
		locals: { user: { id: 1, role, github_login: 'x' } },
		request: new Request(`https://app.test${path}`)
	} as any;
}

beforeEach(async () => {
	await tickAgo(1);
	vi.unstubAllGlobals();
});

describe('required checks', () => {
	it('migrations: up to date with the build, behind, none applied', async () => {
		expect(expectedMigration()).toMatch(/^\d{4}_.*\.sql$/);
		expect((await migrationsCheck(db)).state).toBe('ready');
		expect((await migrationsCheck(db, '9999_future.sql')).state).toBe('attention');
		expect((await migrationsCheck(db, '9999_future.sql')).detail).toContain('Behind');
	});

	it('everything set and a fresh tick → nothing needs attention', async () => {
		expect(await localRequiredAttention(db, goodEnv())).toBe(0);
	});

	it.each([
		['media', { MEDIA: undefined }],
		['session_secret', { SESSION_SECRET: '' }],
		['postmark_token', { POSTMARK_TOKEN: undefined }],
		['cron_key', { CRON_KEY: '  ' }],
		['default_from', { POSTMARK_FROM: 'you@example.com' }]
	])('%s not set → needs attention', async (id, over) => {
		const rows = (await runSetupChecks(db, goodEnv(over), fakePostmark(GOOD_PM).fn)).checks;
		expect(byId(rows, id).state).toBe('attention');
		expect(byId(rows, id).fix).toBeTruthy();
	});

	it('#731: token and From fixes lead with the in-app path, the command line second', async () => {
		const rows = (await runSetupChecks(db, goodEnv({ POSTMARK_TOKEN: undefined, POSTMARK_FROM: 'you@example.com' }), fakePostmark(GOOD_PM).fn)).checks;
		// The brand-new install: no env token, no stored token, MAIL_TOKEN_KEY set. The row shown is
		// the provider's (postmarkCheckRows), which replaces the local one in runSetupChecks.
		expect(byId(rows, 'postmark_token').state).toBe('attention');
		const token = byId(rows, 'postmark_token').fix!;
		expect(token.startsWith('Paste it in the setup wizard (step 2) or Settings → Sending.')).toBe(true);
		expect(token.indexOf('wrangler secret put')).toBeGreaterThan(token.indexOf('Settings → Sending'));
		const from = byId(rows, 'default_from').fix!;
		expect(from.startsWith('Set it in the setup wizard (step 1) or Settings → General.')).toBe(true);
	});

	it('default From from Settings wins over a placeholder POSTMARK_FROM', async () => {
		await db.prepare(`INSERT INTO app_state (key, value) VALUES ('default_from', 'hello@ourco.test')`).run();
		const rows = (await runSetupChecks(db, goodEnv({ POSTMARK_FROM: 'you@example.com' }), fakePostmark(GOOD_PM).fn)).checks;
		expect(byId(rows, 'default_from').state).toBe('ready');
		expect(usableFrom('a@example.org')).toBe(false);
		expect(usableFrom('not an email')).toBe(false);
	});

	it('heartbeat: fresh, stale, never', async () => {
		const run = async () => byId((await runSetupChecks(db, goodEnv(), fakePostmark(GOOD_PM).fn)).checks, 'heartbeat').state;
		expect(await run()).toBe('ready');
		await tickAgo(30);
		expect(await run()).toBe('attention');
		await tickAgo(null);
		expect(await run()).toBe('attention');
	});
});

describe('Postmark checks', () => {
	it('all good: token, streams, webhook, unsubscribe handling', async () => {
		const rows = await postmarkChecks(goodEnv(), fakePostmark(GOOD_PM).fn);
		for (const r of rows) expect(r.state, r.id).toBe('ready');
	});

	it('token rejected', async () => {
		const rows = await postmarkChecks(goodEnv({ POSTMARK_TOKEN: 'wrong' }), fakePostmark(GOOD_PM).fn);
		expect(byId(rows, 'postmark_token').state).toBe('attention');
		expect(byId(rows, 'postmark_token').detail).toContain('rejected');
		expect(byId(rows, 'postmark_streams').state).toBe('attention');
	});

	it('no token → no request at all', async () => {
		const pm = fakePostmark(GOOD_PM);
		const rows = await postmarkChecks(goodEnv({ POSTMARK_TOKEN: '' }), pm.fn);
		expect(pm.seen).toEqual([]);
		expect(rows.every((r) => r.state === 'attention')).toBe(true);
	});

	it('a missing stream', async () => {
		const { ['/message-streams/outbound']: _gone, ...rest } = GOOD_PM;
		const rows = await postmarkChecks(goodEnv(), fakePostmark(rest).fn);
		expect(byId(rows, 'postmark_token').state).toBe('ready');
		expect(byId(rows, 'postmark_streams').state).toBe('attention');
		expect(byId(rows, 'postmark_streams').detail).toContain('outbound');
	});

	it('webhook: missing, another key, WEBHOOK_KEY unset', async () => {
		const none = await postmarkChecks(goodEnv(), fakePostmark({ ...GOOD_PM, '/webhooks': { status: 200, body: { Webhooks: [] } } }).fn);
		expect(byId(none, 'postmark_webhook').state).toBe('attention');
		const other = await postmarkChecks(
			goodEnv(),
			fakePostmark({ ...GOOD_PM, '/webhooks': { status: 200, body: { Webhooks: [{ Url: 'https://elsewhere.test/api/webhook?key=nope' }] } } }).fn
		);
		expect(byId(other, 'postmark_webhook').state).toBe('attention');
		const unset = await postmarkChecks(goodEnv({ WEBHOOK_KEY: '' }), fakePostmark(GOOD_PM).fn);
		expect(byId(unset, 'postmark_webhook').state).toBe('attention');
		expect(webhookMatches('https://a.test/api/webhook/?key=k', 'k')).toBe(true);
		expect(webhookMatches('https://a.test/api/other?key=k', 'k')).toBe(false);
	});

	it('unsubscribe handling still Postmark → needs attention, links to Deliverability', async () => {
		const rows = await postmarkChecks(
			goodEnv(),
			fakePostmark({
				...GOOD_PM,
				'/message-streams/broadcast': { status: 200, body: { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Postmark' } } }
			}).fn
		);
		const r = byId(rows, 'postmark_unsubscribe');
		expect(r.state).toBe('attention');
		expect(r.href).toContain('/deliverability');
	});
});

describe('optional checks', () => {
	it('set → ready, unset → optional', async () => {
		const set = await optionalChecks(db, goodEnv());
		expect(byId(set, 'github_oauth').state).toBe('ready');
		expect(byId(set, 'anthropic').state).toBe('ready');
		expect(byId(set, 'google').state).toBe('optional');
		const bare = await optionalChecks(db, { DB: db });
		// #747: the setup token row is the exception: unset needs nothing, so it's ready.
		expect(bare.filter((r) => r.id !== 'setup_token').every((r) => r.state === 'optional')).toBe(true);
		expect(bare.every((r) => r.group === 'optional')).toBe(true);
	});

	it('#747: the setup token row is ready when unset and needs attention while still set', async () => {
		expect(byId(await optionalChecks(db, { DB: db }), 'setup_token').state).toBe('ready');
		const left = byId(await optionalChecks(db, goodEnv({ SETUP_TOKEN: 'leftover-setup-token-609' })), 'setup_token'); // gitleaks:allow
		expect(left.state).toBe('attention');
		expect(left.detail).toMatch(/can be deleted/);
	});
});

describe('the page', () => {
	it('is admin only', async () => {
		vi.stubGlobal('fetch', fakePostmark(GOOD_PM).fn);
		try {
			await setupPageLoad(pageEvent('member'));
			throw new Error('expected 403');
		} catch (e) {
			expect(isHttpError(e) && e.status).toBe(403);
		}
	});

	it('never puts a secret value in the page data', async () => {
		vi.stubGlobal('fetch', fakePostmark(GOOD_PM).fn);
		const data = (await setupPageLoad(pageEvent('admin'))) as { attention: number; checks: SetupCheck[] };
		expect(data.attention).toBe(0);
		const json = JSON.stringify(data);
		for (const [name, value] of Object.entries(SECRETS)) expect(json, name).not.toContain(value);
		expect(json).not.toContain(SECRETS.WEBHOOK_KEY.slice(-4));
	});

	it('dashboard: notice count for admins only', async () => {
		vi.stubGlobal('fetch', fakePostmark(GOOD_PM).fn);
		const badEnv = goodEnv({ CRON_KEY: '' });
		const admin = (await dashboardLoad(pageEvent('admin', badEnv, '/'))) as { setupAttention: number };
		expect(admin.setupAttention).toBe(1);
		const member = (await dashboardLoad(pageEvent('member', badEnv, '/'))) as { setupAttention: number };
		expect(member.setupAttention).toBe(0);
		const ok = (await dashboardLoad(pageEvent('admin', goodEnv(), '/'))) as { setupAttention: number };
		expect(ok.setupAttention).toBe(0);
	});
});
