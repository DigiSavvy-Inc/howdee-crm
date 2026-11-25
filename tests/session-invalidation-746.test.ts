import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE } from '../src/lib/server/auth';
import { credentialStamp } from '../src/lib/server/password';
import {
	endUserSessions,
	findActiveUserById,
	firstActiveAdmin,
	getUserById,
	setUserDisabled,
	setUserRole
} from '../src/lib/server/users';
import { handle } from '../src/hooks.server';
import { POST as logout } from '../src/routes/logout/+server';
import { actions as usersActions } from '../src/routes/settings/users/+page.server';
import { actions as loginActions } from '../src/routes/login/+page.server';

// #746: a per-user "sessions valid after" stamp. Sign-out (every device), disable, enable and a
// role change refuse every session issued before them; a fresh sign-in afterwards works.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'sessions-746-test-secret';
const APP_PASSWORD = 'sessions 746 break glass words';
const PREFIX = 'sess746-';

async function cleanup() {
	await db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`).run();
	await db.prepare(`DELETE FROM login_attempts`).run();
	await db.prepare(`DELETE FROM break_glass_events`).run();
}

async function makeUser(suffix: string, role: 'admin' | 'member' = 'member'): Promise<number> {
	const res = await db
		.prepare(`INSERT INTO users (github_login, role) VALUES (?, ?)`)
		.bind(`${PREFIX}${suffix}`, role)
		.run();
	return res.meta.last_row_id as number;
}

function cookieJar(initial?: string) {
	const jar: Record<string, string | undefined> = { [SESSION_COOKIE]: initial };
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

/** A session cookie issued `msAgo` milliseconds before now. */
async function sessionFrom(userId: number, msAgo: number): Promise<string> {
	const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - msAgo);
	try {
		return await createSession(SECRET, userId);
	} finally {
		spy.mockRestore();
	}
}

async function signedInAs(token: string, database: D1Database = db): Promise<number | null> {
	const cookies = cookieJar(token);
	const event = {
		request: new Request('https://app.test/settings', { method: 'GET' }),
		url: new URL('https://app.test/settings'),
		params: {},
		route: { id: null },
		locals: {} as any,
		cookies,
		platform: { env: { DB: database, SESSION_SECRET: SECRET } },
		isDataRequest: false,
		isSubRequest: false
	};
	try {
		await handle({ event: event as never, resolve: async () => new Response('ok') } as never);
	} catch (e) {
		if (isRedirect(e)) return null;
		throw e;
	}
	return event.locals.user?.id ?? null;
}

function adminEvent(actorId: number, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const url = new URL('https://app.test/settings/users');
	return {
		request: new Request(url, { method: 'POST', body }),
		url,
		params: {},
		platform: { env: { DB: db, SESSION_SECRET: SECRET } },
		locals: {
			user: { id: actorId, github_login: `${PREFIX}admin`, name: null, avatar_url: null, role: 'admin' },
			authed: true
		},
		cookies: cookieJar(),
		getClientAddress: () => '127.0.0.1'
	} as any;
}

/** The app's own origin in these tests (what `url.origin` is for a request to it). */
const APP_ORIGIN = 'https://app.test';

/**
 * Post a sign-out the way the hook would hand it over. `headers` defaults to a same-origin form
 * post; `userId` null = a request with no signed-in user.
 */
async function runLogout(
	userId: number | null,
	token: string | undefined,
	opts: { headers?: Record<string, string>; database?: D1Database } = {}
) {
	const database = opts.database ?? db;
	const cookies = cookieJar(token);
	const user = userId === null ? null : await findActiveUserById(database, userId);
	const url = new URL(`${APP_ORIGIN}/logout`);
	const request = new Request(url, { method: 'POST', headers: opts.headers ?? { origin: APP_ORIGIN } });
	let location: string | null = null;
	try {
		await logout({ request, url, cookies, locals: { user, authed: !!user }, platform: { env: { DB: database } } } as any);
	} catch (e) {
		if (!isRedirect(e)) throw e;
		location = e.location;
	}
	expect(location).toBe('/login');
	return cookies;
}

async function stampOf(id: number): Promise<string | null> {
	const row = await db
		.prepare(`SELECT sessions_valid_after AS s FROM users WHERE id = ?`)
		.bind(id)
		.first<{ s: string | null }>();
	return row?.s ?? null;
}

beforeEach(cleanup);
afterEach(cleanup);

describe('sign-out', () => {
	it('refuses a cookie issued before sign-out, on any device, and a new sign-in works', async () => {
		const id = await makeUser('signout');
		const here = await sessionFrom(id, 5000);
		const otherDevice = await sessionFrom(id, 10_000);
		expect(await signedInAs(otherDevice)).toBe(id);

		const cookies = await runLogout(id, here);
		expect(cookies.jar[SESSION_COOKIE]).toBeUndefined();

		expect(await signedInAs(here)).toBeNull();
		expect(await signedInAs(otherDevice)).toBeNull();
		// Signing in again straight away works.
		expect(await signedInAs(await createSession(SECRET, id))).toBe(id);
	});

	it('a same-origin post without an Origin header (Sec-Fetch-Site same-origin) ends other devices', async () => {
		const id = await makeUser('fetchsite');
		const here = await sessionFrom(id, 5000);
		const otherDevice = await sessionFrom(id, 10_000);
		const cookies = await runLogout(id, here, { headers: { 'sec-fetch-site': 'same-origin' } });
		expect(cookies.jar[SESSION_COOKIE]).toBeUndefined();
		expect(await signedInAs(otherDevice)).toBeNull();
	});

	it('a post from another origin clears this cookie only; other devices stay signed in', async () => {
		const id = await makeUser('crossorigin');
		const here = await sessionFrom(id, 5000);
		const otherDevice = await sessionFrom(id, 10_000);
		const cookies = await runLogout(id, here, {
			headers: { origin: 'https://sibling.app.test', 'sec-fetch-site': 'same-site' }
		});
		expect(cookies.jar[SESSION_COOKIE]).toBeUndefined();
		expect(await stampOf(id)).toBeNull();
		expect(await signedInAs(otherDevice)).toBe(id);
	});

	it('does not end other devices for Origin null, or with neither Origin nor Sec-Fetch-Site', async () => {
		const id = await makeUser('noorigin');
		const otherDevice = await sessionFrom(id, 10_000);
		await runLogout(id, await sessionFrom(id, 5000), { headers: { origin: 'null' } });
		await runLogout(id, await sessionFrom(id, 5000), { headers: {} });
		await runLogout(id, await sessionFrom(id, 5000), { headers: { 'sec-fetch-site': 'cross-site' } });
		expect(await stampOf(id)).toBeNull();
		expect(await signedInAs(otherDevice)).toBe(id);
	});

	it('with no session cookie redirects to the login page and writes nothing', async () => {
		const id = await makeUser('nocookie');
		const before = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
		const cookies = await runLogout(null, undefined);
		expect(cookies.jar[SESSION_COOKIE]).toBeUndefined();
		expect(await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()).toEqual(before);
	});

	it('leaves other users signed in', async () => {
		const a = await makeUser('a');
		const b = await makeUser('b');
		const tokenA = await sessionFrom(a, 5000);
		const tokenB = await sessionFrom(b, 5000);
		await runLogout(a, tokenA);
		expect(await signedInAs(tokenA)).toBeNull();
		expect(await signedInAs(tokenB)).toBe(b);
	});
});

describe('admin changes', () => {
	it('a cookie from before a disable stays refused after the user is enabled again', async () => {
		const admin = await makeUser('admin', 'admin');
		const id = await makeUser('disabled');
		const old = await sessionFrom(id, 5000);
		const bystander = await makeUser('bystander');
		const bystanderToken = await sessionFrom(bystander, 5000);

		await usersActions.disable(adminEvent(admin, { id: String(id) }));
		expect(await signedInAs(old)).toBeNull();
		await usersActions.enable(adminEvent(admin, { id: String(id) }));
		expect(await signedInAs(old)).toBeNull();

		expect(await signedInAs(await createSession(SECRET, id))).toBe(id);
		expect(await signedInAs(bystanderToken)).toBe(bystander);
	});

	it('a role change ends the sessions issued before it', async () => {
		const admin = await makeUser('admin', 'admin');
		const id = await makeUser('promoted');
		const old = await sessionFrom(id, 5000);

		await usersActions.setRole(adminEvent(admin, { id: String(id), role: 'admin' }));
		expect(await signedInAs(old)).toBeNull();
		const fresh = await createSession(SECRET, id);
		expect(await signedInAs(fresh)).toBe(id);
		expect((await findActiveUserById(db, id))?.role).toBe('admin');
	});
});

describe('same millisecond', () => {
	it('a session issued in the same millisecond as the stamp is kept; one a millisecond earlier is refused', async () => {
		const id = await makeUser('same-ms');
		const now = Date.now();
		const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
		let same: string;
		try {
			same = await createSession(SECRET, id);
		} finally {
			spy.mockRestore();
		}
		// Issue the earlier session at exactly now - 1 with a fixed clock, so a clock tick between
		// two reads can never move it into the same millisecond as the stamp.
		const earlierSpy = vi.spyOn(Date, 'now').mockReturnValue(now - 1);
		let earlier: string;
		try {
			earlier = await createSession(SECRET, id);
		} finally {
			earlierSpy.mockRestore();
		}
		expect(await endUserSessions(db, id, credentialStamp(now))).toBe(true);
		expect(await signedInAs(same)).toBe(id);
		expect(await signedInAs(earlier)).toBeNull();
	});
});

describe('break-glass', () => {
	it('still signs in right after the admin signed out everywhere, and its sign-out ends it', async () => {
		const admin = await firstActiveAdmin(db);
		expect(admin).not.toBeNull();
		const old = await sessionFrom(admin!.id, 5000);
		await runLogout(admin!.id, old);
		expect(await signedInAs(old)).toBeNull();

		const body = new FormData();
		body.set('password', APP_PASSWORD);
		const url = new URL('https://app.test/login?/server');
		const cookies = cookieJar();
		try {
			await loginActions.server({
				request: new Request(url, { method: 'POST', body, headers: { 'cf-connecting-ip': '192.0.2.46' } }),
				url,
				params: {},
				platform: { env: { DB: db, SESSION_SECRET: SECRET, APP_PASSWORD } },
				locals: { user: null, authed: false },
				cookies,
				getClientAddress: () => '127.0.0.1'
			} as any);
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		const token = cookies.jar[SESSION_COOKIE]!;
		expect(token).toBeTruthy();
		expect(await signedInAs(token)).toBe(admin!.id);

		// Sign out of the break-glass session a moment later: it is refused from then on.
		const later = Date.now() + 5;
		const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
		try {
			await runLogout(admin!.id, token);
		} finally {
			spy.mockRestore();
		}
		expect(await signedInAs(token)).toBeNull();
	});
});

describe('before migration 0140', () => {
	/** A D1 stand-in whose `users` table has no `sessions_valid_after` column. */
	function withoutColumn(real: D1Database): D1Database {
		const missing = () => Promise.reject(new Error('D1_ERROR: no such column: sessions_valid_after: SQLITE_ERROR'));
		return new Proxy(real, {
			get(target, prop) {
				if (prop === 'prepare') {
					return (sql: string) => {
						if (!sql.includes('sessions_valid_after')) return target.prepare(sql);
						const stmt = { bind: () => stmt, first: missing, run: missing, all: missing };
						return stmt;
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	}

	it('signs in as usual and treats the missing column as no extra limit', async () => {
		const id = await makeUser('premigration');
		const fake = withoutColumn(db);
		const token = await sessionFrom(id, 5000);
		const user = await findActiveUserById(fake, id);
		expect(user?.id).toBe(id);
		expect(user?.sessionsValidAfter).toBeNull();
		expect(await signedInAs(token, fake)).toBe(id);
		// Ending sessions is a no-op, never an error.
		expect(await endUserSessions(fake, id)).toBe(false);
		expect(await signedInAs(token, fake)).toBe(id);
	});

	it('sign-out still clears the cookie and does not error', async () => {
		const id = await makeUser('premigration-signout');
		const fake = withoutColumn(db);
		const token = await sessionFrom(id, 5000);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const cookies = await runLogout(id, token, { database: fake });
			expect(cookies.jar[SESSION_COOKIE]).toBeUndefined();
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});

	it('a role change, disable and enable still apply without the stamp column', async () => {
		const id = await makeUser('premigration-admin');
		const fake = withoutColumn(db);
		await setUserRole(fake, id, 'admin');
		expect((await getUserById(db, id))?.role).toBe('admin');
		await setUserDisabled(fake, id, true);
		expect((await getUserById(db, id))?.disabled_at).not.toBeNull();
		await setUserDisabled(fake, id, false);
		expect((await getUserById(db, id))?.disabled_at).toBeNull();
		expect(await stampOf(id)).toBeNull();
	});
});
