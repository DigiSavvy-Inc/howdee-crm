import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	canActOn,
	createUser,
	setUserDisabled,
	findActiveUserById,
	resolveGitHubUser,
	type UserRow,
	type SessionUser
} from '../src/lib/server/users';

const db = (env as any).DB as D1Database;

// Every row this file inserts uses this prefix — cleaned up before and after every test.
// Never touch the 'ourco-admin' admin fixture row (tests/fixture-admin.ts).
const PREFIX = 'users-admin-test-';

async function cleanup() {
	await db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`).run();
}

beforeEach(cleanup);
afterEach(cleanup);

function makeAdmin(id: number): SessionUser {
	return { id, github_login: `admin-${id}`, name: null, avatar_url: null, role: 'admin', tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false };
}
function makeMember(id: number): SessionUser {
	return { id, github_login: `member-${id}`, name: null, avatar_url: null, role: 'member', tourSeen: true, navLayout: 'top', passwordSetAt: null, mustChangePassword: false };
}
function makeRow(overrides: Partial<UserRow> & { id: number }): UserRow {
	return {
		github_login: `user-${overrides.id}`,
		github_id: null,
		name: null,
		avatar_url: null,
		role: 'member',
		created_at: '2024-01-01 00:00:00',
		last_login_at: null,
		disabled_at: null,
		tour_dismissed_at: null,
		nav_layout: 'top',
		has_password: 0,
		password_set_at: null,
		must_change_password: 0,
		email: null,
		email_verified_at: null,
		...overrides
	};
}

describe('canActOn', () => {
	it('refuses a non-admin actor', () => {
		const actor = makeMember(1);
		const target = makeRow({ id: 2, role: 'member' });
		const result = canActOn(actor, target, 'disable', undefined, 2);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/admin/i);
	});

	it('refuses acting on your own account, for every action', () => {
		const actor = makeAdmin(1);
		const self = makeRow({ id: 1, role: 'admin' });
		for (const action of ['setRole', 'disable', 'enable', 'remove'] as const) {
			const result = canActOn(actor, self, action, 'member', 5);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("You can't change your own account.");
		}
	});

	it('refuses disabling the last active admin', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'admin' });
		const result = canActOn(actor, target, 'disable', undefined, 1);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("You can't remove the last admin.");
	});

	it('refuses removing the last active admin', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'admin' });
		const result = canActOn(actor, target, 'remove', undefined, 1);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("You can't remove the last admin.");
	});

	it('refuses demoting the last active admin to member', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'admin' });
		const result = canActOn(actor, target, 'setRole', 'member', 1);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("You can't remove the last admin.");
	});

	it('allows disabling/removing/demoting an admin when another active admin exists', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'admin' });
		expect(canActOn(actor, target, 'disable', undefined, 2).ok).toBe(true);
		expect(canActOn(actor, target, 'remove', undefined, 2).ok).toBe(true);
		expect(canActOn(actor, target, 'setRole', 'member', 2).ok).toBe(true);
	});

	it('refuses enabling an already-active user', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'member', disabled_at: null });
		const result = canActOn(actor, target, 'enable', undefined, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/already/i);
	});

	it('refuses disabling an already-disabled user', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'member', disabled_at: '2024-01-01 00:00:00' });
		const result = canActOn(actor, target, 'disable', undefined, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/already/i);
	});

	it('allows promoting a member to admin', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'member' });
		expect(canActOn(actor, target, 'setRole', 'admin', 3).ok).toBe(true);
	});

	it('allows removing a disabled member even with only one active admin', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'member', disabled_at: '2024-01-01 00:00:00' });
		expect(canActOn(actor, target, 'remove', undefined, 1).ok).toBe(true);
	});

	it('allows enabling a disabled admin', () => {
		const actor = makeAdmin(1);
		const target = makeRow({ id: 2, role: 'admin', disabled_at: '2024-01-01 00:00:00' });
		expect(canActOn(actor, target, 'enable', undefined, 1).ok).toBe(true);
	});
});

describe('createUser', () => {
	it('normalizes the login (trim + lowercase)', async () => {
		const user = await createUser(db, `  ${PREFIX}Alice  `, 'member');
		expect(user.github_login).toBe(`${PREFIX}alice`);
		expect(user.role).toBe('member');
		expect(user.github_id).toBeNull();
	});

	it('rejects an invalid GitHub login', async () => {
		await expect(createUser(db, '-not-valid', 'member')).rejects.toThrow();
	});

	it('rejects a case-insensitive duplicate', async () => {
		await createUser(db, `${PREFIX}bob`, 'member');
		await expect(createUser(db, `${PREFIX}BOB`, 'admin')).rejects.toThrow(
			'That GitHub login is already on the list.'
		);
	});
});

describe('setUserDisabled + findActiveUserById', () => {
	it('disabling hides the user from findActiveUserById; enabling restores it', async () => {
		const user = await createUser(db, `${PREFIX}carol`, 'member');
		expect(await findActiveUserById(db, user.id)).not.toBeNull();

		await setUserDisabled(db, user.id, true);
		expect(await findActiveUserById(db, user.id)).toBeNull();

		await setUserDisabled(db, user.id, false);
		const restored = await findActiveUserById(db, user.id);
		expect(restored).not.toBeNull();
		expect(restored!.github_login).toBe(`${PREFIX}carol`);
	});
});

describe('resolveGitHubUser login collision', () => {
	it('keeps its own login when the incoming login already belongs to a different row', async () => {
		await db
			.prepare(`INSERT INTO users (github_login, github_id, role) VALUES (?, 990101, 'member')`)
			.bind(`${PREFIX}dave`)
			.run();
		await db
			.prepare(`INSERT INTO users (github_login, github_id, role) VALUES (?, 990102, 'member')`)
			.bind(`${PREFIX}erin`)
			.run();

		// erin (990102) renames on GitHub to dave's existing login — must not hijack dave's row
		// nor fail the UPDATE with a UNIQUE error.
		const resolved = await resolveGitHubUser(db, {
			id: 990102,
			login: `${PREFIX}dave`,
			name: 'Erin Renamed',
			avatar_url: null
		});

		expect(resolved).not.toBeNull();
		expect(resolved!.github_id).toBe(990102);
		expect(resolved!.github_login).toBe(`${PREFIX}erin`);
		expect(resolved!.name).toBe('Erin Renamed');

		const dave = await db
			.prepare('SELECT github_login FROM users WHERE github_id = 990101')
			.first<{ github_login: string }>();
		expect(dave!.github_login).toBe(`${PREFIX}dave`);
	});
});
