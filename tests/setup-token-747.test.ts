import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import pkg from '../package.json';
import { hashPassword } from '../src/lib/server/password';
import {
	MAX_USERNAME_FAILURES,
	USERNAME_KEY_PREFIX,
	lockoutMinutes,
	signInWithPassword,
	usernameAttemptKey
} from '../src/lib/server/login-attempts';
import {
	SETUP_ATTEMPT_KEY,
	SETUP_TOKEN_MIN_LENGTH,
	SETUP_TOKEN_TOO_SHORT_MESSAGE,
	SETUP_TOKEN_TOO_SHORT_PARTS,
	checkSetupToken,
	setupTokenLength,
	setupTokenTooShort
} from '../src/lib/server/setup';
import { BREAK_GLASS_ATTEMPT_KEY, checkBreakGlass } from '../src/lib/server/break-glass';
import { setupTokenCheck } from '../src/lib/server/setup-checks';
import { SETUP_TOKEN_MIN_LENGTH as DEPLOY_MIN_LENGTH } from '../scripts/deploy-plan.mjs';
import { load as setupLoad, actions as setupActions } from '../src/routes/setup/+page.server';

// #747: the first-run setup token has a minimum length, and the lockout counters for typed
// sign-in usernames are kept apart from the app's own fixed counters.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'setup-747-secret';
const LONG_TOKEN = 'setup-token-747-abcdefgh'; // gitleaks:allow
const SHORT_TOKEN = 'short-phrase-747'; // gitleaks:allow
const GOOD_PASSWORD = 'plum tractor velvet';

function cookieJar() {
	const jar: Record<string, string | undefined> = {};
	return {
		jar,
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			jar[name] = undefined;
		},
		getAll: () => [],
		serialize: () => ''
	};
}

function event(path: string, opts: { fields?: Record<string, string>; token?: string; ip?: string } = {}) {
	const url = new URL(`https://app.test${path}`);
	let request: Request;
	if (opts.fields) {
		const body = new FormData();
		for (const [k, v] of Object.entries(opts.fields)) body.set(k, v);
		request = new Request(url, { method: 'POST', body, headers: { 'cf-connecting-ip': opts.ip ?? 'setup-747-ip' } });
	} else {
		request = new Request(url, { method: 'GET' });
	}
	return {
		request,
		url,
		params: {},
		platform: { env: { DB: db, SESSION_SECRET: SECRET, SETUP_TOKEN: opts.token ?? LONG_TOKEN } },
		locals: { user: null, authed: false },
		cookies: cookieJar(),
		getClientAddress: () => '127.0.0.1'
	} as any;
}

function form(token: string) {
	return {
		token,
		name: 'Ada Admin',
		email: 'ada@ourco.example',
		github_login: '',
		password: GOOD_PASSWORD,
		confirm: GOOD_PASSWORD
	};
}

async function userCount(): Promise<number> {
	return (await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<number>('n')) ?? 0;
}

async function attemptCount(): Promise<number> {
	return (await db.prepare(`SELECT COUNT(*) AS n FROM login_attempts`).first<number>('n')) ?? 0;
}

beforeEach(async () => {
	await db.prepare(`DELETE FROM users`).run();
	await db.prepare(`DELETE FROM login_attempts`).run();
	await db.prepare(`DELETE FROM break_glass_events`).run();
});

describe('setup token length', () => {
	it('is 20 characters after trimming, the same number the deploy script states', () => {
		expect(SETUP_TOKEN_MIN_LENGTH).toBe(20);
		expect(DEPLOY_MIN_LENGTH).toBe(SETUP_TOKEN_MIN_LENGTH);
		expect(setupTokenTooShort('')).toBe(false); // unset is its own case
		expect(setupTokenTooShort('a'.repeat(19))).toBe(true);
		expect(setupTokenTooShort(`   ${'a'.repeat(19)}   `)).toBe(true);
		expect(setupTokenTooShort('a'.repeat(20))).toBe(false);
		expect(SHORT_TOKEN.length).toBeLessThan(20);
		expect(LONG_TOKEN.length).toBeGreaterThanOrEqual(20);
	});

	it('counts by code point and leaves zero-width characters out', () => {
		const zw = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'];
		for (const z of zw) {
			// 19 visible characters padded with invisible ones is still too short.
			expect(setupTokenLength('a'.repeat(19) + z.repeat(5))).toBe(19);
			expect(setupTokenTooShort('a'.repeat(19) + z.repeat(5))).toBe(true);
			expect(setupTokenTooShort(z + 'a'.repeat(10) + z + 'a'.repeat(9) + z)).toBe(true);
			expect(setupTokenTooShort('a'.repeat(20) + z)).toBe(false);
		}
		// Ten emoji are 20 UTF-16 units but 10 characters.
		const emoji = String.fromCodePoint(0x1f600);
		expect(emoji.repeat(10).length).toBe(20);
		expect(setupTokenLength(emoji.repeat(10))).toBe(10);
		expect(setupTokenTooShort(emoji.repeat(10))).toBe(true);
		expect(setupTokenTooShort(emoji.repeat(20))).toBe(false);
		// Only invisible characters: set, and too short (never treated as unset).
		expect(setupTokenTooShort('\u200B'.repeat(30))).toBe(true);
	});

	it('the message names the minimum and both ways to set a longer one', () => {
		expect(SETUP_TOKEN_TOO_SHORT_MESSAGE).toContain('at least 20 characters');
		expect(SETUP_TOKEN_TOO_SHORT_MESSAGE).toContain('npm run deploy -- --new-setup-token');
		expect(SETUP_TOKEN_TOO_SHORT_MESSAGE).toContain('Cloudflare dashboard');
		// Shown as plain text, with the command in its own code element: no Markdown backticks.
		expect(SETUP_TOKEN_TOO_SHORT_MESSAGE).not.toContain('`');
		expect(SETUP_TOKEN_TOO_SHORT_PARTS.command).toBe('npm run deploy -- --new-setup-token');
	});

	it('the Deploy to Cloudflare field description states the minimum', () => {
		const bindings = (pkg as { cloudflare: { bindings: Record<string, { description: string }> } }).cloudflare.bindings;
		expect(bindings.SETUP_TOKEN.description).toContain('at least 20 characters');
	});

	it('/setup load with a short token shows the message instead of the form', async () => {
		const data = (await setupLoad(event('/setup', { token: SHORT_TOKEN }))) as any;
		expect(data.tokenSet).toBe(true);
		expect(data.tokenTooShort).toBe(true);
		expect(data.tooShort).toEqual(SETUP_TOKEN_TOO_SHORT_PARTS);
		const ok = (await setupLoad(event('/setup'))) as any;
		expect(ok.tokenTooShort).toBe(false);
	});

	it('/setup action with a short token creates nothing, even when the typed token matches', async () => {
		const res = (await setupActions.default(event('/setup', { token: SHORT_TOKEN, fields: form(SHORT_TOKEN) }))) as any;
		expect(res.status).toBe(400);
		expect(res.data.error).toBe(SETUP_TOKEN_TOO_SHORT_MESSAGE);
		expect(JSON.stringify(res.data)).not.toContain(SHORT_TOKEN);
		expect(await userCount()).toBe(0);
		expect(await attemptCount()).toBe(0);
	});

	it('a token of exactly 20 characters is accepted', async () => {
		const token = 'twenty-characters-ok'; // gitleaks:allow
		expect(token.length).toBe(20);
		await expect(setupActions.default(event('/setup', { token, fields: form(token) }))).rejects.toSatisfy(
			(err: unknown) => isRedirect(err) && err.location === '/settings/setup?first=1'
		);
		expect(await userCount()).toBe(1);
	});

	it('an install that already has an admin is unaffected: /setup stays a 404 whatever the token', async () => {
		await db.prepare(`INSERT INTO users (github_login, role) VALUES ('existing-admin', 'admin')`).run();
		for (const token of [SHORT_TOKEN, LONG_TOKEN]) {
			await expect(setupLoad(event('/setup', { token }))).rejects.toSatisfy((err: unknown) => isHttpError(err) && err.status === 404);
			await expect(setupActions.default(event('/setup', { token, fields: form(token) }))).rejects.toSatisfy(
				(err: unknown) => isHttpError(err) && err.status === 404
			);
		}
	});
});

describe('lockout key spaces', () => {
	it('every typed username is stored under its own prefix, never as a fixed key', () => {
		for (const typed of [SETUP_ATTEMPT_KEY, BREAK_GLASS_ATTEMPT_KEY, 'token:open', 'reset:abc', ' SETUP:TOKEN ', '']) {
			const key = usernameAttemptKey(typed);
			expect(key.startsWith(USERNAME_KEY_PREFIX)).toBe(true);
			expect([SETUP_ATTEMPT_KEY, BREAK_GLASS_ATTEMPT_KEY, 'token:open']).not.toContain(key);
		}
		for (const fixed of [SETUP_ATTEMPT_KEY, BREAK_GLASS_ATTEMPT_KEY, 'token:open']) {
			expect(fixed.startsWith(USERNAME_KEY_PREFIX)).toBe(false);
		}
	});

	it('failed sign-ins with a reserved name as the username leave the setup counter alone', async () => {
		for (let i = 0; i <= MAX_USERNAME_FAILURES; i++) {
			const res = await signInWithPassword(db, { username: SETUP_ATTEMPT_KEY, password: 'wrong wrong wrong', ip: `login-747-${i}` });
			expect(res.ok).toBe(false);
		}
		const setupRows = await db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = ?`).bind(SETUP_ATTEMPT_KEY).first<number>('n');
		expect(setupRows).toBe(0);
		expect(await lockoutMinutes(db, SETUP_ATTEMPT_KEY, 'setup-747-ip')).toBe(0);
		// The real first admin can still be created from another address.
		expect(await checkSetupToken(db, LONG_TOKEN, LONG_TOKEN, 'setup-747-ip')).toEqual({ ok: true });
	});

	it('failed sign-ins with the break-glass key as the username leave break-glass unlocked', async () => {
		for (let i = 0; i <= MAX_USERNAME_FAILURES; i++) {
			await signInWithPassword(db, { username: BREAK_GLASS_ATTEMPT_KEY, password: 'wrong wrong wrong', ip: `login-747-bg-${i}` });
		}
		const res = await checkBreakGlass(db, { expected: 'break-glass-747-pass', typed: 'break-glass-747-pass', ip: 'bg-747-ip', secret: SECRET });
		expect(res).toEqual({ ok: true });
	});

	it('the username lockout still works under the new keys, for that username only', async () => {
		const hash = await hashPassword(GOOD_PASSWORD);
		await db
			.prepare(`INSERT INTO users (github_login, role, password_hash, password_set_at) VALUES ('jdoe-747', 'member', ?, datetime('now'))`)
			.bind(hash)
			.run();
		for (let i = 0; i < MAX_USERNAME_FAILURES; i++) {
			await signInWithPassword(db, { username: 'jdoe-747', password: 'wrong wrong wrong', ip: `lk-747-${i}` });
		}
		const locked = await signInWithPassword(db, { username: 'jdoe-747', password: GOOD_PASSWORD, ip: 'lk-747-other' });
		expect(locked).toMatchObject({ ok: false, status: 429 });
		const rows = await db.prepare(`SELECT DISTINCT username FROM login_attempts`).all<{ username: string }>();
		expect(rows.results.map((r) => r.username)).toEqual([usernameAttemptKey('jdoe-747')]);
	});

	it('rows written before the change (bare usernames) no longer lock that username', async () => {
		const hash = await hashPassword(GOOD_PASSWORD);
		const res = await db
			.prepare(`INSERT INTO users (github_login, role, password_hash, password_set_at) VALUES ('kroe-747', 'member', ?, datetime('now'))`)
			.bind(hash)
			.run();
		for (let i = 0; i < MAX_USERNAME_FAILURES; i++) {
			await db.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES ('kroe-747', ?, 0)`).bind(`old-747-${i}`).run();
		}
		const signed = await signInWithPassword(db, { username: 'kroe-747', password: GOOD_PASSWORD, ip: 'new-747-ip' });
		expect(signed).toEqual({ ok: true, userId: res.meta.last_row_id });
	});
});

describe('Settings → Setup row for SETUP_TOKEN', () => {
	it('says the secret can be deleted while it is still set', () => {
		const row = setupTokenCheck({ SETUP_TOKEN: LONG_TOKEN });
		expect(row.id).toBe('setup_token');
		expect(row.state).toBe('attention');
		expect(row.group).toBe('optional');
		expect(row.detail).toMatch(/first admin exists.*can be deleted/);
		expect(row.fix).toContain('npx wrangler secret delete SETUP_TOKEN');
		expect(JSON.stringify(row)).not.toContain(LONG_TOKEN);
	});

	it('is ready once the secret is gone', () => {
		const row = setupTokenCheck({});
		expect(row.state).toBe('ready');
		expect(row.detail).toMatch(/Not set.*isn’t needed/);
		expect(row.fix).toBeUndefined();
	});
});
