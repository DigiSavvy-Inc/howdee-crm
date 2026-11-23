import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	findActiveUserById,
	findActiveUserByLogin,
	firstActiveAdmin,
	getUserById,
	listUsers,
	resolveGitHubUser
} from '../src/lib/server/users';

const db = (env as { DB: D1Database }).DB;

function dbThatThrows(message: string): D1Database {
	const statement = {
		bind() {
			return statement;
		},
		async first() {
			throw new Error(message);
		},
		async all() {
			throw new Error(message);
		}
	};
	return {
		prepare() {
			return statement;
		}
	} as unknown as D1Database;
}

describe('users.nav_layout missing', () => {
	it('session and user lookups default to top on a database without the column', async () => {
		await db.prepare('ALTER TABLE users DROP COLUMN nav_layout').run();
		const info = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
		expect((info.results ?? []).map((column) => column.name)).not.toContain('nav_layout');

		const inserted = await db
			.prepare(`INSERT INTO users (github_login, role, name) VALUES (?, 'member', ?)`)
			.bind('nav-missing-ada', 'Ada')
			.run();
		const id = inserted.meta.last_row_id as number;

		const session = await findActiveUserById(db, id);
		expect(session?.github_login).toBe('nav-missing-ada');
		expect(session?.navLayout).toBe('top');
		expect(session?.tourSeen).toBe(false);

		expect((await findActiveUserByLogin(db, 'Nav-Missing-Ada'))?.nav_layout).toBe('top');
		expect((await getUserById(db, id))?.nav_layout).toBe('top');
		expect((await listUsers(db)).find((user) => user.id === id)?.nav_layout).toBe('top');

		const admin = await firstActiveAdmin(db);
		expect(admin?.role).toBe('admin');
		expect(admin?.nav_layout).toBe('top');

		const resolved = await resolveGitHubUser(db, {
			id: 880011,
			login: 'nav-missing-ada',
			name: 'Ada Lovelace',
			avatar_url: null
		});
		expect(resolved?.github_id).toBe(880011);
		expect(resolved?.nav_layout).toBe('top');
		expect(resolved?.name).toBe('Ada Lovelace');
	});

	it('does not swallow a missing column other than nav_layout', async () => {
		await expect(findActiveUserById(dbThatThrows('no such column: email'), 1)).rejects.toThrow(
			/no such column: email/
		);
		await expect(listUsers(dbThatThrows('D1_ERROR: no such column: github_login: SQLITE_ERROR'))).rejects.toThrow(
			/github_login/
		);
	});

	it('retries when D1 reports no such column: nav_layout and defaults to top', async () => {
		let calls = 0;
		const statement = {
			bind() {
				return statement;
			},
			async first() {
				calls += 1;
				if (calls === 1) throw new Error('D1_ERROR: no such column: nav_layout: SQLITE_ERROR');
				return {
					id: 7,
					github_login: 'ada',
					name: null,
					avatar_url: null,
					role: 'member' as const,
					tour_dismissed_at: null
				};
			}
		};
		const fake = {
			prepare(sql: string) {
				if (calls === 0) expect(sql).toContain('nav_layout');
				else expect(sql).not.toContain('nav_layout');
				return statement;
			}
		} as unknown as D1Database;

		const session = await findActiveUserById(fake, 7);
		expect(session?.navLayout).toBe('top');
		expect(calls).toBe(2);
	});
});
