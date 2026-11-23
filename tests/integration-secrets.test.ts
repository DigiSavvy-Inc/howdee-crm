import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isValidKey, open, seal } from '../src/lib/server/crypto-box';
import {
	cleanToken,
	getProviderToken,
	removeProviderToken,
	resolveIntegrationEnv,
	setProviderToken,
	tokenInfo
} from '../src/lib/server/integrations/secrets';
import { githubProvider, integrationsStatus, recentSyncs, runProviderSync } from '../src/lib/server/integrations';
import { actions, load } from '../src/routes/settings/integrations/+page.server';

const db = (env as any).DB as D1Database;

function newKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const KEY = newKey();
const TOKEN = 'ghp_inAppFakeValue1a2b';
let admin = { id: 0, role: 'admin' };
let member = { id: 0, role: 'member' };

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM integration_secrets'),
		db.prepare('DELETE FROM integration_syncs'),
		db.prepare(`DELETE FROM app_state WHERE key LIKE 'integration_%'`),
		db.prepare(`INSERT OR IGNORE INTO users (github_login, role) VALUES ('token-admin', 'admin')`)
	]);
	const id = (await db.prepare(`SELECT id FROM users WHERE github_login = 'token-admin'`).first<number>('id'))!;
	admin = { id, role: 'admin' };
	member = { id, role: 'member' };
});

/** Fake GitHub `/user`: accepts only `good`, records the bearer tokens it saw. */
function fakeGithub(good: string) {
	const seen: string[] = [];
	const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		const auth = new Headers(init?.headers).get('Authorization') ?? '';
		seen.push(auth.replace(/^Bearer /, ''));
		return auth === `Bearer ${good}`
			? new Response(JSON.stringify({ login: 'ourco-admin' }), { status: 200 })
			: new Response('{}', { status: 401 });
	}) as typeof fetch;
	return { f, seen };
}

function ev(fields: Record<string, string> | null, opts: { user?: unknown; extraEnv?: Record<string, string>; fetch?: typeof fetch } = {}) {
	const url = 'https://crm.test/settings/integrations';
	let request: Request;
	if (fields) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		request = new Request(url, { method: 'POST', body: fd });
	} else {
		request = new Request(url);
	}
	return {
		request,
		url: new URL(url),
		platform: { env: { ...(env as any), ...(opts.extraEnv ?? {}) } },
		locals: { user: opts.user === undefined ? admin : opts.user },
		fetch: opts.fetch ?? fakeGithub('nothing').f
	} as any;
}

describe('crypto-box', () => {
	it('round-trips with a v1. prefix', async () => {
		const blob = await seal(KEY, 'hello token');
		expect(blob.startsWith('v1.')).toBe(true);
		expect(blob).not.toContain('hello');
		expect(await open(KEY, blob)).toBe('hello token');
		// Fresh IV each time.
		expect(await seal(KEY, 'hello token')).not.toBe(blob);
	});

	it('throws on a tampered blob', async () => {
		const blob = await seal(KEY, 'hello token');
		const i = blob.length - 5;
		const tampered = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
		await expect(open(KEY, tampered)).rejects.toThrow();
		await expect(open(KEY, 'v2.' + blob.slice(3))).rejects.toThrow();
	});

	it('throws with the wrong key', async () => {
		const blob = await seal(KEY, 'hello token');
		await expect(open(newKey(), blob)).rejects.toThrow();
	});

	it('validates the key', () => {
		expect(isValidKey(KEY)).toBe(true);
		expect(isValidKey(undefined)).toBe(false);
		expect(isValidKey('')).toBe(false);
		expect(isValidKey('c2hvcnQ')).toBe(false); // "short"
	});
});

describe('token resolution', () => {
	it('prefers the in-app token over the Worker secret over nothing', async () => {
		expect(await getProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'github')).toBeNull();
		expect(await getProviderToken(db, { MAIL_TOKEN_KEY: KEY, GITHUB_TOKEN: 'from-env' }, 'github')).toBe('from-env');
		await setProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'github', TOKEN, admin.id);
		expect(await getProviderToken(db, { MAIL_TOKEN_KEY: KEY, GITHUB_TOKEN: 'from-env' }, 'github')).toBe(TOKEN);
		// Without the key the stored token can't be opened → Worker secret.
		expect(await getProviderToken(db, { GITHUB_TOKEN: 'from-env' }, 'github')).toBe('from-env');
		const resolved = await resolveIntegrationEnv(db, { MAIL_TOKEN_KEY: KEY, TIMING_API_TOKEN: 't-env' });
		expect(resolved).toMatchObject({ GITHUB_TOKEN: TOKEN, TIMING_API_TOKEN: 't-env' });
	});

	it('stores only the sealed blob + last4, and audits set/remove without the token', async () => {
		await setProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'github', TOKEN, admin.id);
		const row = await db.prepare(`SELECT * FROM integration_secrets`).first<Record<string, unknown>>();
		expect(row).toMatchObject({ provider: 'github', last4: '1a2b', set_by: admin.id });
		expect(String(row!.blob)).not.toContain(TOKEN);
		expect(await removeProviderToken(db, 'github')).toBe(true);
		expect(await removeProviderToken(db, 'github')).toBe(false);
		const audit = await recentSyncs(db);
		expect(audit.map((s) => [s.trigger, JSON.parse(s.detail!)])).toEqual([
			['token', { action: 'removed', last4: '1a2b' }],
			['token', { action: 'set', last4: '1a2b' }]
		]);
		expect(JSON.stringify(audit)).not.toContain(TOKEN);
	});

	it('runProviderSync uses the in-app token', async () => {
		await setProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'github', TOKEN, admin.id);
		let used: string | undefined;
		const p = { ...githubProvider, sync: async (_db: D1Database, e: { GITHUB_TOKEN?: string }) => ((used = e.GITHUB_TOKEN), { counts: {}, errors: [] }) };
		const r = await runProviderSync(db, { MAIL_TOKEN_KEY: KEY }, p, 'manual');
		expect(r).toMatchObject({ ok: true });
		expect(used).toBe(TOKEN);
	});

	it('token rows do not count as the last sync', async () => {
		await setProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'github', TOKEN, admin.id);
		const s = await integrationsStatus(db, { MAIL_TOKEN_KEY: KEY });
		const gh = s.find((x) => x.provider === 'github')!;
		expect(gh.lastSync).toBeNull();
		expect(gh.configured).toBe(true);
		expect(gh.token).toMatchObject({ source: 'app', last4: '1a2b', setBy: 'token-admin', stored: true });
	});
});

describe('cleanToken (#350)', () => {
	const LONG = 'eyJ' + 'a'.repeat(1194) + 'Zz9';

	it('accepts a ~1,200-character token that seals, stores and round-trips', async () => {
		expect(LONG.length).toBe(1200);
		const r = cleanToken(LONG);
		expect(r).toEqual({ ok: true, token: LONG });
		await setProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'timing', LONG, admin.id);
		const row = await db.prepare(`SELECT last4 FROM integration_secrets WHERE provider = 'timing'`).first<{ last4: string }>();
		expect(row?.last4).toBe('aZz9');
		expect(await getProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'timing')).toBe(LONG);
	});

	it('refuses a token over 4,096 characters', () => {
		expect(cleanToken('x'.repeat(4096))).toMatchObject({ ok: true });
		expect(cleanToken('x'.repeat(4097))).toEqual({ ok: false, error: 'That token is too long.' });
	});

	it('strips a pasted Bearer prefix and keeps the other checks', () => {
		expect(cleanToken('  Bearer xyz123456789  ')).toEqual({ ok: true, token: 'xyz123456789' });
		expect(cleanToken('bearer xyz123456789')).toEqual({ ok: true, token: 'xyz123456789' });
		expect(cleanToken('Bearer short')).toMatchObject({ ok: false, error: 'That token is too short.' });
		expect(cleanToken('abc def ghi jkl')).toMatchObject({ ok: false });
		expect(cleanToken('   ')).toMatchObject({ ok: false, error: 'Paste a token first.' });
	});
});

describe('Settings → Integrations token actions', () => {
	it('load never includes the token or the blob', async () => {
		await setProviderToken(db, { MAIL_TOKEN_KEY: KEY }, 'github', TOKEN, admin.id);
		const blob = (await db.prepare(`SELECT blob FROM integration_secrets`).first<{ blob: string }>())!.blob;
		const data = await load(ev(null, { extraEnv: { MAIL_TOKEN_KEY: KEY } }));
		const s = JSON.stringify(data);
		expect(s).not.toContain(TOKEN);
		expect(s).not.toContain(blob);
		expect(s).not.toContain(KEY);
		expect(s).toContain('1a2b');
		expect((data as any).tokenKeyReady).toBe(true);
	});

	it('save → stores, probes, and shows Connected', async () => {
		const gh = fakeGithub(TOKEN);
		const res = (await actions.setToken(
			ev({ provider: 'github', token: `  ${TOKEN}  ` }, { extraEnv: { MAIL_TOKEN_KEY: KEY }, fetch: gh.f })
		)) as any;
		expect(res).toMatchObject({ provider: 'github', tokenSaved: '1a2b', probe: { state: 'connected' } });
		expect(gh.seen).toEqual([TOKEN]);
		const data = (await load(ev(null, { extraEnv: { MAIL_TOKEN_KEY: KEY } }))) as any;
		const card = data.providers.find((p: any) => p.provider === 'github');
		expect(card.state).toBe('connected');
		expect(card.token).toMatchObject({ source: 'app', last4: '1a2b' });
	});

	it('save without MAIL_TOKEN_KEY is refused and does not echo the token', async () => {
		const res = (await actions.setToken(ev({ provider: 'github', token: TOKEN }, { extraEnv: { MAIL_TOKEN_KEY: '' } }))) as any;
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/MAIL_TOKEN_KEY/);
		expect(JSON.stringify(res)).not.toContain(TOKEN);
		expect(await db.prepare(`SELECT COUNT(*) AS n FROM integration_secrets`).first('n')).toBe(0);
		const data = (await load(ev(null, { extraEnv: { MAIL_TOKEN_KEY: '' } }))) as any;
		expect(data.tokenKeyReady).toBe(false);
	});

	it('an invalid token is refused without echoing it', async () => {
		const res = (await actions.setToken(
			ev({ provider: 'github', token: 'has space inside' }, { extraEnv: { MAIL_TOKEN_KEY: KEY } })
		)) as any;
		expect(res.status).toBe(400);
		expect(JSON.stringify(res)).not.toContain('has space inside');
	});

	it('remove → falls back to the Worker secret, or Not connected', async () => {
		const extra = { MAIL_TOKEN_KEY: KEY, GITHUB_TOKEN: 'ghp_workerSecretzz99' };
		await actions.setToken(ev({ provider: 'github', token: TOKEN }, { extraEnv: extra, fetch: fakeGithub(TOKEN).f }));

		const gh = fakeGithub('ghp_workerSecretzz99');
		const res = (await actions.removeToken(ev({ provider: 'github' }, { extraEnv: extra, fetch: gh.f }))) as any;
		expect(res).toMatchObject({ tokenRemoved: true, fallback: true });
		expect(gh.seen).toEqual(['ghp_workerSecretzz99']);
		let card = ((await load(ev(null, { extraEnv: extra }))) as any).providers.find((p: any) => p.provider === 'github');
		expect(card.token).toMatchObject({ source: 'worker', last4: 'zz99', stored: false });
		expect(card.state).toBe('connected');

		// No Worker secret: removing leaves it not connected.
		const noEnv = { MAIL_TOKEN_KEY: KEY, GITHUB_TOKEN: '' };
		await actions.setToken(ev({ provider: 'github', token: TOKEN }, { extraEnv: noEnv, fetch: fakeGithub(TOKEN).f }));
		const res2 = (await actions.removeToken(ev({ provider: 'github' }, { extraEnv: noEnv }))) as any;
		expect(res2).toMatchObject({ tokenRemoved: true, fallback: false });
		card = ((await load(ev(null, { extraEnv: noEnv }))) as any).providers.find((p: any) => p.provider === 'github');
		expect(card.state).toBe('not_configured');
		expect(card.token.source).toBeNull();
	});

	it('non-admins get 403', async () => {
		await expect(load(ev(null, { user: member }))).rejects.toMatchObject({ status: 403 });
		await expect(
			actions.setToken(ev({ provider: 'github', token: TOKEN }, { user: member, extraEnv: { MAIL_TOKEN_KEY: KEY } }))
		).rejects.toMatchObject({ status: 403 });
		await expect(actions.removeToken(ev({ provider: 'github' }, { user: member }))).rejects.toMatchObject({ status: 403 });
		expect(await db.prepare(`SELECT COUNT(*) AS n FROM integration_secrets`).first('n')).toBe(0);
	});
});
