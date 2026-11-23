import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import {
	hashPassword,
	verifyPassword,
	needsRehash,
	generatePassword,
	passwordPolicyError,
	credentialStamp,
	GENERATED_ALPHABET,
	PBKDF2_ITERATIONS
} from '../src/lib/server/password';
import { createSession, verifySession, SESSION_COOKIE } from '../src/lib/server/auth';
import { findActiveUserById, setUserPassword } from '../src/lib/server/users';
import { pruneLoginAttempts } from '../src/lib/server/login-attempts';
import { handle } from '../src/hooks.server';
import { actions as loginActions } from '../src/routes/login/+page.server';
import { actions as accountActions } from '../src/routes/account/+page.server';
import { actions as forcedActions } from '../src/routes/account/password/+page.server';
import { actions as usersActions } from '../src/routes/settings/users/+page.server';

// #211: per-user passwords — hashing, policy, sign-in + lockout, forced change, session
// invalidation, and the admin generate/clear actions.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'passwords-test-secret';
const PREFIX = 'pwtest-';

async function cleanup() {
	await db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`).run();
	await db.prepare(`DELETE FROM login_attempts WHERE username LIKE ? OR ip LIKE ?`).bind(`${PREFIX}%`, `${PREFIX}%`).run();
}

async function makeUser(suffix: string, role: 'admin' | 'member' = 'member'): Promise<number> {
	const res = await db
		.prepare(`INSERT INTO users (github_login, role) VALUES (?, ?)`)
		.bind(`${PREFIX}${suffix}`, role)
		.run();
	return res.meta.last_row_id as number;
}

async function giveRealPassword(id: number, password: string, mustChange = false) {
	await setUserPassword(db, id, await hashPassword(password), mustChange, credentialStamp());
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

function formEvent(path: string, fields: Record<string, string>, opts: { user?: unknown; ip?: string; cookies?: ReturnType<typeof cookieJar> } = {}) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const url = new URL(`https://app.test${path}`);
	return {
		request: new Request(url, {
			method: 'POST',
			body,
			headers: { 'cf-connecting-ip': opts.ip ?? `${PREFIX}ip-default` }
		}),
		url,
		params: {},
		platform: { env: { DB: db, SESSION_SECRET: SECRET } },
		locals: { user: opts.user ?? null, authed: !!opts.user },
		cookies: opts.cookies ?? cookieJar(),
		getClientAddress: () => '127.0.0.1'
	} as any;
}

async function runHandle(path: string, token?: string) {
	const cookies = cookieJar(token);
	const event = {
		request: new Request(`https://app.test${path}`, { method: 'GET' }),
		url: new URL(`https://app.test${path}`),
		params: {},
		route: { id: null },
		locals: {} as any,
		cookies,
		platform: { env: { DB: db, SESSION_SECRET: SECRET } },
		isDataRequest: false,
		isSubRequest: false
	};
	const response = await handle({
		event: event as never,
		resolve: async () => new Response('ok', { status: 200 })
	} as never);
	return { response, locals: event.locals, cookies };
}

async function expectRedirect(p: unknown, location: string) {
	await expect(p as Promise<unknown>).rejects.toSatisfy((err: unknown) => isRedirect(err) && err.location === location);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('hashing', () => {
	it('round-trips and rejects a wrong password', async () => {
		const hash = await hashPassword('correct horse battery');
		expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
		expect(await verifyPassword('correct horse battery', hash)).toBe(true);
		expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
		expect(needsRehash(hash)).toBe(false);
	});

	it('salts every hash', async () => {
		expect(await hashPassword('same input here')).not.toBe(await hashPassword('same input here'));
	});

	it('still runs the KDF and returns false when there is no hash', async () => {
		const spy = vi.spyOn(crypto.subtle, 'deriveBits');
		try {
			expect(await verifyPassword('anything at all', null)).toBe(false);
			expect(await verifyPassword('anything at all', 'garbage')).toBe(false);
			// Same work as a real check: one full-strength PBKDF2 per call.
			expect(spy).toHaveBeenCalledTimes(2);
			for (const call of spy.mock.calls) {
				expect((call[0] as Pbkdf2Params).iterations).toBe(PBKDF2_ITERATIONS);
			}
		} finally {
			spy.mockRestore();
		}
	});

	it('flags old iteration counts for rehash', async () => {
		const weak = await hashPassword('another password', 1000);
		expect(await verifyPassword('another password', weak)).toBe(true);
		expect(needsRehash(weak)).toBe(true);
		expect(needsRehash(null)).toBe(true);
		expect(PBKDF2_ITERATIONS).toBe(100_000);
	});
});

describe('policy', () => {
	it('enforces length, username and common passwords', () => {
		expect(passwordPolicyError('short', 'jdoe')).toMatch(/at least 12/);
		expect(passwordPolicyError('x'.repeat(129), 'jdoe')).toMatch(/at most 128/);
		expect(passwordPolicyError('LongUsername1', 'longusername1')).toMatch(/username/);
		expect(passwordPolicyError('Password1234', 'jdoe')).toMatch(/too common/);
		expect(passwordPolicyError('qwertyuiop123', 'jdoe')).toMatch(/too common/);
		expect(passwordPolicyError('plum tractor velvet', 'jdoe')).toBeNull();
	});
});

describe('generatePassword', () => {
	it('is 20 unambiguous characters grouped in fives', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const pw = generatePassword();
			expect(pw).toMatch(/^[^-]{5}-[^-]{5}-[^-]{5}-[^-]{5}$/);
			for (const ch of pw.replace(/-/g, '')) expect(GENERATED_ALPHABET).toContain(ch);
			expect(pw).not.toMatch(/[0O1lI]/);
			seen.add(pw);
		}
		expect(seen.size).toBe(50);
	});
});

describe('sign-in with username + password', () => {
	it('signs in (case-insensitive username) and records the attempt', async () => {
		const id = await makeUser('ann');
		await giveRealPassword(id, 'plum tractor velvet');
		const cookies = cookieJar();
		await expectRedirect(
			loginActions.password(formEvent('/login?/password', { username: `  ${PREFIX}ANN `, password: 'plum tractor velvet' }, { cookies })),
			'/'
		);
		const session = await verifySession(SECRET, cookies.jar[SESSION_COOKIE]);
		expect(session?.userId).toBe(id);
		const row = await db.prepare(`SELECT last_login_at FROM users WHERE id = ?`).bind(id).first<{ last_login_at: string | null }>();
		expect(row?.last_login_at).not.toBeNull();
		const ok = await db.prepare(`SELECT ok FROM login_attempts WHERE username = ?`).bind(`${PREFIX}ann`).first<{ ok: number }>();
		expect(ok?.ok).toBe(1);
	});

	it('gives one generic error for wrong password, unknown user, no password and disabled', async () => {
		const id = await makeUser('bo');
		await giveRealPassword(id, 'plum tractor velvet');
		await makeUser('nopw');
		const disabled = await makeUser('off');
		await giveRealPassword(disabled, 'plum tractor velvet');
		await db.prepare(`UPDATE users SET disabled_at = datetime('now') WHERE id = ?`).bind(disabled).run();

		const cases = [
			{ username: `${PREFIX}bo`, password: 'wrong wrong wrong', ip: `${PREFIX}ip1` },
			{ username: `${PREFIX}nobody`, password: 'plum tractor velvet', ip: `${PREFIX}ip2` },
			{ username: `${PREFIX}nopw`, password: 'plum tractor velvet', ip: `${PREFIX}ip3` },
			{ username: `${PREFIX}off`, password: 'plum tractor velvet', ip: `${PREFIX}ip4` }
		];
		for (const c of cases) {
			const res = (await loginActions.password(formEvent('/login?/password', c, { ip: c.ip }))) as any;
			expect(res.status).toBe(401);
			expect(res.data.error).toBe('Incorrect username or password.');
		}
	});

	it('locks a username after 5 failures, and a success resets the counter', async () => {
		const id = await makeUser('cy');
		await giveRealPassword(id, 'plum tractor velvet');
		const attempt = (password: string, ip: string) =>
			loginActions.password(formEvent('/login?/password', { username: `${PREFIX}cy`, password }, { ip }));

		for (let i = 0; i < 4; i++) expect(((await attempt('nope nope nope', `${PREFIX}a${i}`)) as any).status).toBe(401);
		// A success after 4 failures clears the username counter.
		await expectRedirect(attempt('plum tractor velvet', `${PREFIX}a9`), '/');
		for (let i = 0; i < 4; i++) expect(((await attempt('nope nope nope', `${PREFIX}b${i}`)) as any).status).toBe(401);
		expect(((await attempt('nope nope nope', `${PREFIX}b4`)) as any).status).toBe(401);

		// Five failures since the last success → locked, even with the right password, from any IP.
		const locked = (await attempt('plum tractor velvet', `${PREFIX}c0`)) as any;
		expect(locked.status).toBe(429);
		expect(locked.data.error).toMatch(/^Too many attempts, try again in (1[0-5]|[1-9]) minutes?\.$/);
	});

	it('lets the lock lapse once failures are older than 15 minutes', async () => {
		const id = await makeUser('di');
		await giveRealPassword(id, 'plum tractor velvet');
		for (let i = 0; i < 5; i++) {
			await db
				.prepare(`INSERT INTO login_attempts (username, ip, ok, at) VALUES (?, ?, 0, datetime('now', '-16 minutes'))`)
				.bind(`${PREFIX}di`, `${PREFIX}old`)
				.run();
		}
		await expectRedirect(
			loginActions.password(formEvent('/login?/password', { username: `${PREFIX}di`, password: 'plum tractor velvet' })),
			'/'
		);
	});

	it('locks an IP after 20 failures across usernames', async () => {
		const id = await makeUser('ed');
		await giveRealPassword(id, 'plum tractor velvet');
		const ip = `${PREFIX}spray`;
		for (let i = 0; i < 20; i++) {
			await db
				.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES (?, ?, 0)`)
				.bind(`${PREFIX}guess${i}`, ip)
				.run();
		}
		const res = (await loginActions.password(
			formEvent('/login?/password', { username: `${PREFIX}ed`, password: 'plum tractor velvet' }, { ip })
		)) as any;
		expect(res.status).toBe(429);
		// Another IP is fine.
		await expectRedirect(
			loginActions.password(formEvent('/login?/password', { username: `${PREFIX}ed`, password: 'plum tractor velvet' }, { ip: `${PREFIX}home` })),
			'/'
		);
	});

	it('prunes attempts older than 30 days', async () => {
		await db
			.prepare(`INSERT INTO login_attempts (username, ip, ok, at) VALUES (?, ?, 0, datetime('now', '-31 days'))`)
			.bind(`${PREFIX}old`, `${PREFIX}ip`)
			.run();
		await db.prepare(`INSERT INTO login_attempts (username, ip, ok) VALUES (?, ?, 0)`).bind(`${PREFIX}new`, `${PREFIX}ip`).run();
		const res = await pruneLoginAttempts(db);
		expect(res.deleted).toBeGreaterThanOrEqual(1);
		const left = await db
			.prepare(`SELECT username FROM login_attempts WHERE ip = ?`)
			.bind(`${PREFIX}ip`)
			.all<{ username: string }>();
		expect(left.results.map((r) => r.username)).toEqual([`${PREFIX}new`]);
	});
});

describe('must change password', () => {
	it('sends a forced user to /account/password and blocks other routes', async () => {
		const id = await makeUser('fay');
		await giveRealPassword(id, 'temp-temp-temp-temp', true);
		await expectRedirect(
			loginActions.password(formEvent('/login?/password', { username: `${PREFIX}fay`, password: 'temp-temp-temp-temp' })),
			'/account/password?first=1'
		);

		const token = await createSession(SECRET, id);
		await expectRedirect(runHandle('/', token), '/account/password?first=1');
		await expectRedirect(runHandle('/contacts', token), '/account/password?first=1');
		expect((await runHandle('/account/password', token)).response.status).toBe(200);
		expect((await runHandle('/account/password/__data.json', token)).response.status).toBe(200);
		expect((await runHandle('/unsubscribe', token)).response.status).toBe(200);
	});

	it('the forced change needs no current password, clears the flag and lands in the app', async () => {
		const id = await makeUser('gus');
		await giveRealPassword(id, 'temp-temp-temp-temp', true);
		const user = await findActiveUserById(db, id);
		expect(user?.mustChangePassword).toBe(true);
		const cookies = cookieJar();
		await expectRedirect(
			forcedActions.password(
				formEvent('/account/password?/password', { new_password: 'plum tractor velvet', confirm_password: 'plum tractor velvet' }, { user, cookies })
			),
			'/'
		);
		expect((await findActiveUserById(db, id))?.mustChangePassword).toBe(false);
		const { locals } = await runHandle('/', cookies.jar[SESSION_COOKIE]);
		expect(locals.user?.id).toBe(id);
	});
});

describe('changing your password', () => {
	it('requires the current password, enforces policy, and signs out older sessions only', async () => {
		const id = await makeUser('hal');
		await giveRealPassword(id, 'plum tractor velvet');
		// Sessions issued *after* the first password stamp.
		await new Promise((r) => setTimeout(r, 5));
		const otherDevice = await createSession(SECRET, id);
		const thisDevice = await createSession(SECRET, id);
		expect((await runHandle('/', otherDevice)).locals.user?.id).toBe(id);

		const user = await findActiveUserById(db, id);
		const cookies = cookieJar(thisDevice);
		const wrong = (await accountActions.password(
			formEvent('/account?/password', { current_password: 'nope', new_password: 'granite orchard lamp', confirm_password: 'granite orchard lamp' }, { user, cookies })
		)) as any;
		expect(wrong.status).toBe(400);
		expect(wrong.data.pwError).toMatch(/current password/);

		const weak = (await accountActions.password(
			formEvent('/account?/password', { current_password: 'plum tractor velvet', new_password: 'password1234', confirm_password: 'password1234' }, { user, cookies })
		)) as any;
		expect(weak.data.pwError).toMatch(/too common/);

		const mismatch = (await accountActions.password(
			formEvent('/account?/password', { current_password: 'plum tractor velvet', new_password: 'granite orchard lamp', confirm_password: 'granite orchard lump' }, { user, cookies })
		)) as any;
		expect(mismatch.data.pwError).toMatch(/match/);

		await new Promise((r) => setTimeout(r, 5));
		const ok = (await accountActions.password(
			formEvent('/account?/password', { current_password: 'plum tractor velvet', new_password: 'granite orchard lamp', confirm_password: 'granite orchard lamp' }, { user, cookies })
		)) as any;
		expect(ok.pwOk).toMatch(/changed/);

		// The other device's session predates the change → signed out and its cookie dropped.
		const other = await runHandle('/unsubscribe', otherDevice);
		expect(other.locals.user).toBeNull();
		await expectRedirect(runHandle('/', otherDevice), '/login');
		// The old cookie on this device too; the reissued one keeps working.
		expect((await runHandle('/unsubscribe', thisDevice)).locals.user).toBeNull();
		expect(cookies.jar[SESSION_COOKIE]).not.toBe(thisDevice);
		expect((await runHandle('/', cookies.jar[SESSION_COOKIE])).locals.user?.id).toBe(id);

		const row = await db.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(id).first<{ password_hash: string }>();
		expect(await verifyPassword('granite orchard lamp', row!.password_hash)).toBe(true);
	});

	it('sets a first password without a current one', async () => {
		const id = await makeUser('ivy');
		const user = await findActiveUserById(db, id);
		const ok = (await accountActions.password(
			formEvent('/account?/password', { new_password: 'granite orchard lamp', confirm_password: 'granite orchard lamp' }, { user })
		)) as any;
		expect(ok.pwOk).toMatch(/set/);
	});
});

describe('admin: generate / clear', () => {
	it('generates a password shown once with must-change set, and the member can sign in with it', async () => {
		const adminId = await makeUser('boss', 'admin');
		const memberId = await makeUser('mia');
		const admin = await findActiveUserById(db, adminId);
		const memberSession = await createSession(SECRET, memberId);
		await new Promise((r) => setTimeout(r, 5));

		const res = (await usersActions.generatePassword(formEvent('/settings/users?/generatePassword', { id: String(memberId) }, { user: admin }))) as any;
		expect(res.generated.login).toBe(`${PREFIX}mia`);
		const pw = res.generated.password as string;
		expect(pw).toMatch(/^[^-]{5}-[^-]{5}-[^-]{5}-[^-]{5}$/);

		const row = await db
			.prepare(`SELECT password_hash, must_change_password FROM users WHERE id = ?`)
			.bind(memberId)
			.first<{ password_hash: string; must_change_password: number }>();
		expect(row!.must_change_password).toBe(1);
		expect(row!.password_hash).not.toContain(pw);
		// The plaintext is not readable anywhere afterwards — the page load only has status fields.
		const { load } = await import('../src/routes/settings/users/+page.server');
		const data = (await load({ locals: { user: admin }, platform: { env: { DB: db } } } as any)) as any;
		expect(JSON.stringify(data)).not.toContain(pw);
		expect(JSON.stringify(data)).not.toContain('pbkdf2');
		expect(data.users.find((u: any) => u.id === memberId).must_change_password).toBe(1);

		// The member's existing session was signed out.
		expect((await runHandle('/unsubscribe', memberSession)).locals.user).toBeNull();

		await expectRedirect(
			loginActions.password(formEvent('/login?/password', { username: `${PREFIX}mia`, password: pw })),
			'/account/password?first=1'
		);
	});

	it('add user can generate a password at once', async () => {
		const admin = await findActiveUserById(db, await makeUser('boss2', 'admin'));
		const res = (await usersActions.add(
			formEvent('/settings/users?/add', { github_login: `${PREFIX}newbie`, role: 'member', generate_password: '1' }, { user: admin })
		)) as any;
		expect(res.generated.login).toBe(`${PREFIX}newbie`);
		const row = await db
			.prepare(`SELECT must_change_password, password_hash IS NOT NULL AS has FROM users WHERE github_login = ?`)
			.bind(`${PREFIX}newbie`)
			.first<{ must_change_password: number; has: number }>();
		expect(row).toEqual({ must_change_password: 1, has: 1 });
	});

	it('clears a password', async () => {
		const admin = await findActiveUserById(db, await makeUser('boss3', 'admin'));
		const memberId = await makeUser('ned');
		await giveRealPassword(memberId, 'plum tractor velvet', true);
		const res = (await usersActions.clearPassword(formEvent('/settings/users?/clearPassword', { id: String(memberId) }, { user: admin }))) as any;
		expect(res.ok).toMatch(/Cleared/);
		const row = await db
			.prepare(`SELECT password_hash, must_change_password FROM users WHERE id = ?`)
			.bind(memberId)
			.first<{ password_hash: string | null; must_change_password: number }>();
		expect(row).toEqual({ password_hash: null, must_change_password: 0 });
		const login = (await loginActions.password(
			formEvent('/login?/password', { username: `${PREFIX}ned`, password: 'plum tractor velvet' })
		)) as any;
		expect(login.status).toBe(401);
	});

	it('403s a member on the admin password actions', async () => {
		const member = await findActiveUserById(db, await makeUser('pat'));
		const targetId = await makeUser('quin');
		for (const action of ['generatePassword', 'clearPassword'] as const) {
			await expect(
				usersActions[action](formEvent(`/settings/users?/${action}`, { id: String(targetId) }, { user: member }))
			).rejects.toSatisfy((err: any) => err?.status === 403);
		}
		const row = await db.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(targetId).first<{ password_hash: string | null }>();
		expect(row?.password_hash).toBeNull();
	});
});
