import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handle } from '../src/hooks.server';
import { createSession, SESSION_COOKIE } from '../src/lib/server/auth';
import { findActiveUserById } from '../src/lib/server/users';

// #195: migration 0046 not applied yet. findActiveUserById (#192) falls back to top,
// and the signed-in rewrite must still return a page instead of 500.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'nav-hook-missing-secret';
const DOC = '<!doctype html>\n<html lang="en">\n<head></head><body>ok</body></html>';

describe('hooks.server.ts when nav_layout is missing (#195)', () => {
	it('falls back to top and still stamps the signed-in page', async () => {
		await db.prepare('ALTER TABLE users DROP COLUMN nav_layout').run();
		const info = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
		expect((info.results ?? []).map((column) => column.name)).not.toContain('nav_layout');

		const inserted = await db
			.prepare(`INSERT INTO users (github_login, role, name) VALUES (?, 'member', ?)`)
			.bind('navhook-missing', 'Ada')
			.run();
		const id = inserted.meta.last_row_id as number;

		const session = await findActiveUserById(db, id);
		expect(session?.navLayout).toBe('top');

		const token = await createSession(SECRET, id);
		const response = await handle({
			event: {
				request: new Request('https://app.test/', { method: 'GET' }),
				url: new URL('https://app.test/'),
				params: {},
				route: { id: null },
				locals: {},
				cookies: {
					get(name: string) {
						return name === SESSION_COOKIE ? token : undefined;
					},
					set() {},
					delete() {},
					getAll() {
						return [];
					},
					serialize() {
						return '';
					}
				},
				platform: { env: { DB: db, SESSION_SECRET: SECRET } },
				isDataRequest: false,
				isSubRequest: false
			} as never,
			resolve: async (
				_event: unknown,
				opts?: {
					transformPageChunk?: (input: { html: string; done: boolean }) => string | Promise<string | undefined>;
				}
			) => {
				const transform = opts?.transformPageChunk;
				const html = transform ? ((await transform({ html: DOC, done: true })) ?? DOC) : DOC;
				return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
			}
		} as never);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('<html data-nav="top" lang="en">');
	});
});
