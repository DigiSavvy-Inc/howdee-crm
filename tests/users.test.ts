import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	findActiveUserById,
	findActiveUserByLogin,
	resolveGitHubUser,
	firstActiveAdmin,
	isValidGitHubLogin,
	listUsers
} from '../src/lib/server/users';

const db = (env as any).DB as D1Database;

// Unique logins for rows this file inserts — never touch the 'ourco-admin' admin fixture row
// (tests/fixture-admin.ts; migrations seed no users since #606).
const TEST_LOGINS = ['users-test-alice', 'users-test-bob', 'users-test-carol'];

beforeEach(async () => {
	for (const login of TEST_LOGINS) {
		await db.prepare('DELETE FROM users WHERE github_login = ?').bind(login).run();
	}
});

afterEach(async () => {
	for (const login of TEST_LOGINS) {
		await db.prepare('DELETE FROM users WHERE github_login = ?').bind(login).run();
	}
});

describe('fixture admin', () => {
	it('the ourco-admin admin fixture exists and is found', async () => {
		const row = await db
			.prepare("SELECT id FROM users WHERE github_login = 'ourco-admin'")
			.first<{ id: number }>();
		expect(row).not.toBeNull();
		const found = await findActiveUserById(db, row!.id);
		expect(found).not.toBeNull();
		expect(found!.github_login).toBe('ourco-admin');
		expect(found!.role).toBe('admin');
	});

	it('firstActiveAdmin finds the fixture admin (lowest id)', async () => {
		const admin = await firstActiveAdmin(db);
		expect(admin).not.toBeNull();
		expect(admin!.role).toBe('admin');
	});
});

describe('findActiveUserByLogin', () => {
	it('is case-insensitive', async () => {
		await db
			.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member')`)
			.bind('users-test-alice')
			.run();
		const found = await findActiveUserByLogin(db, 'Users-Test-Alice');
		expect(found).not.toBeNull();
		expect(found!.github_login.toLowerCase()).toBe('users-test-alice');
	});

	it('does not return a disabled user', async () => {
		await db
			.prepare(
				`INSERT INTO users (github_login, role, disabled_at) VALUES (?, 'member', datetime('now'))`
			)
			.bind('users-test-bob')
			.run();
		const found = await findActiveUserByLogin(db, 'users-test-bob');
		expect(found).toBeNull();
	});
});

describe('findActiveUserById', () => {
	it('does not return a disabled user', async () => {
		const res = await db
			.prepare(
				`INSERT INTO users (github_login, role, disabled_at) VALUES (?, 'member', datetime('now'))`
			)
			.bind('users-test-carol')
			.run();
		const id = res.meta.last_row_id as number;
		const found = await findActiveUserById(db, id);
		expect(found).toBeNull();
	});
});

describe('resolveGitHubUser', () => {
	it('pins github_id on first login and updates last_login_at', async () => {
		await db
			.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member')`)
			.bind('users-test-alice')
			.run();

		const resolved = await resolveGitHubUser(db, {
			id: 990001,
			login: 'users-test-alice',
			name: 'Alice',
			avatar_url: 'https://example.test/alice.png'
		});
		expect(resolved).not.toBeNull();
		expect(resolved!.github_id).toBe(990001);
		expect(resolved!.name).toBe('Alice');
		expect(resolved!.last_login_at).not.toBeNull();
	});

	it('a login match on a row already pinned to a different github_id returns null', async () => {
		await db
			.prepare(`INSERT INTO users (github_login, github_id, role) VALUES (?, 990002, 'member')`)
			.bind('users-test-bob')
			.run();

		const resolved = await resolveGitHubUser(db, {
			id: 990003, // different id than the row is pinned to
			login: 'users-test-bob',
			name: null,
			avatar_url: null
		});
		expect(resolved).toBeNull();

		// Row must be untouched — no hijack.
		const row = await db
			.prepare('SELECT github_id FROM users WHERE github_login = ?')
			.bind('users-test-bob')
			.first<{ github_id: number }>();
		expect(row!.github_id).toBe(990002);
	});

	it('a github_id match survives a login rename and updates the stored login', async () => {
		await db
			.prepare(`INSERT INTO users (github_login, github_id, role) VALUES (?, 990004, 'member')`)
			.bind('users-test-carol')
			.run();

		// Upstream rename: same id, new login.
		const resolved = await resolveGitHubUser(db, {
			id: 990004,
			login: 'users-test-carol-renamed',
			name: 'Carol',
			avatar_url: null
		});
		expect(resolved).not.toBeNull();
		expect(resolved!.github_login).toBe('users-test-carol-renamed');
		expect(resolved!.github_id).toBe(990004);

		// Clean up the renamed row (outside TEST_LOGINS spelling).
		await db.prepare('DELETE FROM users WHERE github_id = 990004').run();
	});

	it('returns null for a disabled user even with a matching github_id', async () => {
		await db
			.prepare(
				`INSERT INTO users (github_login, github_id, role, disabled_at) VALUES (?, 990005, 'member', datetime('now'))`
			)
			.bind('users-test-alice')
			.run();
		const resolved = await resolveGitHubUser(db, {
			id: 990005,
			login: 'users-test-alice',
			name: null,
			avatar_url: null
		});
		expect(resolved).toBeNull();
	});
});

describe('isValidGitHubLogin', () => {
	it('accepts valid logins', () => {
		expect(isValidGitHubLogin('octocat')).toBe(true);
		expect(isValidGitHubLogin('a')).toBe(true);
		expect(isValidGitHubLogin('a-b')).toBe(true);
		expect(isValidGitHubLogin('a'.repeat(39))).toBe(true);
	});

	it('rejects invalid logins', () => {
		expect(isValidGitHubLogin('-abc')).toBe(false);
		expect(isValidGitHubLogin('abc-')).toBe(false);
		expect(isValidGitHubLogin('a'.repeat(40))).toBe(false);
		expect(isValidGitHubLogin('a--b')).toBe(false);
		expect(isValidGitHubLogin('')).toBe(false);
	});
});

describe('listUsers', () => {
	it('includes the fixture admin and inserted rows', async () => {
		await db
			.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member')`)
			.bind('users-test-alice')
			.run();
		const rows = await listUsers(db);
		expect(rows.some((r) => r.github_login === 'ourco-admin')).toBe(true);
		expect(rows.some((r) => r.github_login === 'users-test-alice')).toBe(true);
	});
});
