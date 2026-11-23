import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { verifySession, SESSION_COOKIE } from '../src/lib/server/auth';
import { findActiveUserById } from '../src/lib/server/users';
import { signInWithPassword, MAX_USERNAME_FAILURES } from '../src/lib/server/login-attempts';
import { hasAnyUser, SETUP_ATTEMPT_KEY, firstAdminUsername } from '../src/lib/server/setup';
import { handle } from '../src/hooks.server';
import { load as setupLoad, actions as setupActions } from '../src/routes/setup/+page.server';
import { load as loginLoad, actions as loginActions } from '../src/routes/login/+page.server';

// #606: first-run setup. This file empties `users` (each test file has its own storage), so
// the 'ourco-admin' fixture from tests/fixture-admin.ts is gone here on purpose.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'setup-606-secret';
const TOKEN = 'setup-token-0123456789abcdef';
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

function event(path: string, opts: { fields?: Record<string, string>; env?: Record<string, unknown>; ip?: string } = {}) {
	const url = new URL(`https://app.test${path}`);
	let request: Request;
	if (opts.fields) {
		const body = new FormData();
		for (const [k, v] of Object.entries(opts.fields)) body.set(k, v);
		request = new Request(url, { method: 'POST', body, headers: { 'cf-connecting-ip': opts.ip ?? 'setup-ip' } });
	} else {
		request = new Request(url, { method: 'GET' });
	}
	return {
		request,
		url,
		params: {},
		platform: { env: { DB: db, SESSION_SECRET: SECRET, SETUP_TOKEN: TOKEN, ...(opts.env ?? {}) } },
		locals: { user: null, authed: false },
		cookies: cookieJar(),
		getClientAddress: () => '127.0.0.1'
	} as any;
}

function form(overrides: Record<string, string> = {}) {
	return {
		token: TOKEN,
		name: 'Ada Admin',
		email: 'ada@example.com',
		github_login: '',
		password: GOOD_PASSWORD,
		confirm: GOOD_PASSWORD,
		...overrides
	};
}

async function expectRedirect(p: unknown, location: string) {
	await expect(p as Promise<unknown>).rejects.toSatisfy((err: unknown) => isRedirect(err) && err.location === location);
}

async function expect404(p: unknown) {
	await expect(p as Promise<unknown>).rejects.toSatisfy((err: unknown) => isHttpError(err) && err.status === 404);
}

async function userCount(): Promise<number> {
	return (await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<number>('n')) ?? 0;
}

async function addAdmin(login = 'existing-admin'): Promise<number> {
	const res = await db.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'admin')`).bind(login).run();
	return res.meta.last_row_id as number;
}

beforeEach(async () => {
	await db.prepare(`DELETE FROM users`).run();
	await db.prepare(`DELETE FROM login_attempts`).run();
});

describe('fresh database', () => {
	it('no migration seeds a user', () => {
		const migrations = (env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[];
		expect(migrations.length).toBeGreaterThan(0);
		const seeding = migrations.filter((m) => m.queries.some((q) => /INSERT\s+(OR\s+\w+\s+)?INTO\s+users\b/i.test(q)));
		expect(seeding.map((m) => m.name)).toEqual([]);
	});

	it('hasAnyUser is false with zero users and true with one', async () => {
		expect(await hasAnyUser(db)).toBe(false);
		await addAdmin();
		expect(await hasAnyUser(db)).toBe(true);
	});
});

describe('/setup load', () => {
	it('without SETUP_TOKEN shows how to set it (no form)', async () => {
		const data = (await setupLoad(event('/setup', { env: { SETUP_TOKEN: '' } }))) as any;
		expect(data.tokenSet).toBe(false);
	});

	it('with SETUP_TOKEN offers the form', async () => {
		const data = (await setupLoad(event('/setup'))) as any;
		expect(data.tokenSet).toBe(true);
	});

	it('is a 404 once any user exists', async () => {
		await addAdmin();
		await expect404(setupLoad(event('/setup')));
	});

	it('is public (no redirect to /login without a session)', async () => {
		const ev = event('/setup');
		ev.route = { id: null };
		ev.isDataRequest = false;
		ev.isSubRequest = false;
		ev.locals = {};
		const res = await handle({ event: ev, resolve: async () => new Response('ok', { status: 200 }) } as never);
		expect(res.status).toBe(200);
	});
});

describe('/setup action', () => {
	it('refuses when SETUP_TOKEN is unset', async () => {
		const res = (await setupActions.default(event('/setup', { fields: form(), env: { SETUP_TOKEN: '' } }))) as any;
		expect(res.status).toBe(400);
		expect(await userCount()).toBe(0);
	});

	it('a wrong token is refused and counted; the value is never echoed', async () => {
		const res = (await setupActions.default(event('/setup', { fields: form({ token: 'nope' }) }))) as any;
		expect(res.status).toBe(401);
		expect(JSON.stringify(res.data)).not.toContain('nope');
		expect(JSON.stringify(res.data)).not.toContain(GOOD_PASSWORD);
		expect(await userCount()).toBe(0);
		const n = await db
			.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ok = 0`)
			.bind(SETUP_ATTEMPT_KEY)
			.first<number>('n');
		expect(n).toBe(1);
	});

	it('a missing token is refused', async () => {
		const fields = form();
		delete (fields as Record<string, string>).token;
		const res = (await setupActions.default(event('/setup', { fields }))) as any;
		expect(res.status).toBe(401);
		expect(await userCount()).toBe(0);
	});

	it('locks out after repeated wrong tokens, even for the right one', async () => {
		for (let i = 0; i < MAX_USERNAME_FAILURES; i++) {
			await setupActions.default(event('/setup', { fields: form({ token: `wrong-${i}` }), ip: `ip-${i}` }));
		}
		const res = (await setupActions.default(event('/setup', { fields: form(), ip: 'ip-other' }))) as any;
		expect(res.status).toBe(429);
		expect(await userCount()).toBe(0);
	});

	it('applies the password rules and field checks', async () => {
		const weak = (await setupActions.default(event('/setup', { fields: form({ password: 'password1234', confirm: 'password1234' }) }))) as any;
		expect(weak.status).toBe(400);
		expect(weak.data.errors.password).toMatch(/too common/);

		const mismatch = (await setupActions.default(event('/setup', { fields: form({ confirm: 'something else entirely' }) }))) as any;
		expect(mismatch.data.errors.confirm).toMatch(/match/);

		const bad = (await setupActions.default(event('/setup', { fields: form({ email: 'not-an-email', name: '', github_login: '-bad-' }) }))) as any;
		expect(bad.data.errors.email).toBeTruthy();
		expect(bad.data.errors.name).toBeTruthy();
		expect(bad.data.errors.githubLogin).toBeTruthy();
		expect(await userCount()).toBe(0);
	});

	it('the right token creates the first admin, signs them in and goes to Settings → Setup (#609)', async () => {
		const ev = event('/setup', { fields: form({ github_login: 'Ada-Gh' }) });
		await expectRedirect(setupActions.default(ev), '/settings/setup?first=1');

		const row = await db
			.prepare(`SELECT id, github_login, name, email, role, must_change_password, password_hash IS NOT NULL AS has FROM users`)
			.first<{ id: number; github_login: string; name: string; email: string; role: string; must_change_password: number; has: number }>();
		expect(row).toMatchObject({ github_login: 'ada-gh', name: 'Ada Admin', email: 'ada@example.com', role: 'admin', must_change_password: 0, has: 1 });

		const session = await verifySession(SECRET, ev.cookies.jar[SESSION_COOKIE]);
		expect(session?.userId).toBe(row!.id);
		expect((await findActiveUserById(db, row!.id))?.role).toBe('admin');

		// The password works for a normal sign-in.
		const signIn = await signInWithPassword(db, { username: 'ada-gh', password: GOOD_PASSWORD, ip: 'x' });
		expect(signIn.ok).toBe(true);

		// And setup is gone.
		await expect404(setupLoad(event('/setup')));
		await expect404(setupActions.default(event('/setup', { fields: form({ email: 'eve@example.com' }) })));
		expect(await userCount()).toBe(1);
	});

	it('without a GitHub login the username is the email address', async () => {
		await expectRedirect(setupActions.default(event('/setup', { fields: form({ email: 'Ada@Example.com' }) })), '/settings/setup?first=1');
		expect(firstAdminUsername({ email: 'Ada@Example.com', githubLogin: '' })).toBe('ada@example.com');
		const signIn = await signInWithPassword(db, { username: 'ada@example.com', password: GOOD_PASSWORD, ip: 'x' });
		expect(signIn.ok).toBe(true);
	});
});

describe('/login with zero users', () => {
	it('sends people to /setup', async () => {
		await expectRedirect(loginLoad(event('/login')), '/setup');
	});

	it('renders normally once a user exists', async () => {
		await addAdmin();
		const data = (await loginLoad(event('/login'))) as any;
		expect(data).toHaveProperty('github');
	});

	it('break-glass points at /setup instead of erroring', async () => {
		const res = (await loginActions.server(
			event('/login?/server', { fields: { password: 'break-glass' }, env: { APP_PASSWORD: 'break-glass' } })
		)) as any;
		expect(res.status).toBe(409);
		expect(res.data.error).toContain('/setup');
	});

	it('break-glass on an install with users still signs in as the first admin', async () => {
		const id = await addAdmin();
		const ev = event('/login?/server', { fields: { password: 'break-glass' }, env: { APP_PASSWORD: 'break-glass' } });
		await expectRedirect(loginActions.server(ev), '/');
		expect((await verifySession(SECRET, ev.cookies.jar[SESSION_COOKIE]))?.userId).toBe(id);
	});
});
