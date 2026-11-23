import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { safeEqual, verifySession, SESSION_COOKIE } from '../src/lib/server/auth';
import { MAX_IP_FAILURES, MAX_USERNAME_FAILURES } from '../src/lib/server/login-attempts';
import { BREAK_GLASS_ATTEMPT_KEY, listBreakGlassEvents, pruneBreakGlassEvents } from '../src/lib/server/break-glass';
import { actions as loginActions } from '../src/routes/login/+page.server';
import { load as usersLoad } from '../src/routes/settings/users/+page.server';

// #533: the break-glass sign-in (APP_PASSWORD) is under the login lockout and audited.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'break-glass-533-secret';
const APP_PASSWORD = 'correct horse battery staple';

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

function serverEvent(password: string, ip = '203.0.113.7', cookies = cookieJar()) {
	const body = new FormData();
	body.set('password', password);
	const url = new URL('https://app.test/login?/server');
	return {
		request: new Request(url, { method: 'POST', body, headers: { 'cf-connecting-ip': ip } }),
		url,
		params: {},
		platform: { env: { DB: db, SESSION_SECRET: SECRET, APP_PASSWORD } },
		locals: { user: null, authed: false },
		cookies,
		getClientAddress: () => '127.0.0.1'
	} as any;
}

async function attempt(password: string, ip?: string, cookies?: ReturnType<typeof cookieJar>) {
	try {
		return (await loginActions.server(serverEvent(password, ip, cookies))) as any;
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location };
		throw e;
	}
}

beforeEach(async () => {
	await db.prepare(`DELETE FROM break_glass_events`).run();
	await db.prepare(`DELETE FROM login_attempts`).run();
});

describe('safeEqual', () => {
	it('compares without returning early on a length mismatch', () => {
		expect(safeEqual('abc', 'abc')).toBe(true);
		expect(safeEqual('abc', 'abcd')).toBe(false);
		expect(safeEqual('abcd', 'abc')).toBe(false);
		expect(safeEqual('', 'a')).toBe(false);
		expect(safeEqual('', '')).toBe(true);
		// A trailing NUL must not pass for a missing character.
		expect(safeEqual('abc\u0000', 'abc')).toBe(false);
	});
});

describe('break-glass sign-in', () => {
	it('signs in as the first active admin and records the success', async () => {
		const cookies = cookieJar();
		const res = await attempt(APP_PASSWORD, '203.0.113.7', cookies);
		expect(res).toEqual({ redirect: '/' });
		const session = await verifySession(SECRET, cookies.jar[SESSION_COOKIE] ?? '');
		expect(session?.userId).toBe(1);

		const events = await listBreakGlassEvents(db);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ outcome: 'ok', user_id: 1, login: 'ourco-admin' });
		expect(events[0].ip_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(events[0].ip_hash).not.toContain('203.0.113.7');
	});

	it('records a wrong password without storing it', async () => {
		const res = await attempt('guess-one');
		expect(res.status).toBe(401);
		const events = await listBreakGlassEvents(db);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ outcome: 'failed', user_id: null });
		const dump = JSON.stringify(
			(await db.prepare(`SELECT * FROM break_glass_events`).all()).results.concat(
				(await db.prepare(`SELECT * FROM login_attempts`).all()).results
			)
		);
		expect(dump).not.toContain('guess-one');
	});

	it('locks globally after repeated failures, even for the right password from another IP', async () => {
		for (let i = 0; i < MAX_USERNAME_FAILURES; i++) {
			expect((await attempt(`wrong-${i}`, `198.51.100.${i}`)).status).toBe(401);
		}
		const locked = await attempt(APP_PASSWORD, '192.0.2.99');
		expect(locked.status).toBe(429);
		expect(locked.data.error).toMatch(/Too many attempts, try again in \d+ minutes?\./);

		const events = await listBreakGlassEvents(db);
		expect(events[0].outcome).toBe('locked');
		expect(events.filter((e) => e.outcome === 'failed')).toHaveLength(MAX_USERNAME_FAILURES);
		// A refused attempt isn't counted toward the lockout, so it can't extend it.
		const counted = await db
			.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = ?`)
			.bind(BREAK_GLASS_ATTEMPT_KEY)
			.first<number>('n');
		expect(counted).toBe(MAX_USERNAME_FAILURES);
	});

	it('locks one IP after its failures across sign-in methods', async () => {
		const ip = '198.51.100.200';
		// Fill the per-IP counter with other usernames' failures (as username + password sign-in would).
		for (let i = 0; i < MAX_IP_FAILURES; i++) {
			await db.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES (?, ?, 0)`).bind(`user-${i}`, ip).run();
		}
		expect((await attempt(APP_PASSWORD, ip)).status).toBe(429);
		// Another IP still gets in: the global break-glass counter is clean.
		expect(await attempt(APP_PASSWORD, '198.51.100.201')).toEqual({ redirect: '/' });
	});

	it('a success resets the global counter', async () => {
		for (let i = 0; i < MAX_USERNAME_FAILURES - 1; i++) await attempt(`wrong-${i}`, `198.51.100.${i}`);
		expect(await attempt(APP_PASSWORD)).toEqual({ redirect: '/' });
		expect((await attempt('wrong-again', '198.51.100.50')).status).toBe(401);
	});
});

describe('audit on Settings → Users', () => {
	it('admins see the events and whether break-glass is on', async () => {
		await attempt('nope');
		await attempt(APP_PASSWORD);
		const data = (await usersLoad({
			locals: { user: { id: 1, role: 'admin' } },
			platform: { env: { DB: db, APP_PASSWORD } }
		} as any)) as any;
		expect(data.breakGlass.enabled).toBe(true);
		expect(data.breakGlass.events.map((e: { outcome: string }) => e.outcome)).toEqual(['ok', 'failed']);
	});

	it('members are refused', async () => {
		await expect(
			usersLoad({ locals: { user: { id: 2, role: 'member' } }, platform: { env: { DB: db } } } as any)
		).rejects.toBeTruthy();
	});

	it('prunes rows older than a year', async () => {
		await db.prepare(`INSERT INTO break_glass_events (at, outcome) VALUES (datetime('now', '-400 days'), 'failed')`).run();
		await db.prepare(`INSERT INTO break_glass_events (outcome) VALUES ('failed')`).run();
		expect(await pruneBreakGlassEvents(db)).toBe(1);
		expect(await listBreakGlassEvents(db)).toHaveLength(1);
	});
});
