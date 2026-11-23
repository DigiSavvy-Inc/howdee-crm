import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { handle } from '../src/hooks.server';
import { createSession, SESSION_COOKIE } from '../src/lib/server/auth';

// #195: hooks.server.ts stamps data-nav from the signed-in user's nav_layout.
// Public pages with no session are rendered as-is. The rewrite runs only when a
// user resolves, including on a public path.

const db = (env as { DB: D1Database }).DB;
const SECRET = 'nav-hook-test-secret';
const PREFIX = 'navhook-';
const DOC = '<!doctype html>\n<html lang="en">\n<head></head><body>ok</body></html>';
const LATER = '<p>later chunk</p>';

async function cleanup() {
	await db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`).run();
}

async function makeUser(layout: 'top' | 'left'): Promise<number> {
	const res = await db
		.prepare(`INSERT INTO users (github_login, role, nav_layout) VALUES (?, 'member', ?)`)
		.bind(`${PREFIX}${layout}`, layout)
		.run();
	return res.meta.last_row_id as number;
}

function eventFor(path: string, token?: string) {
	return {
		request: new Request(`https://app.test${path}`, { method: 'GET' }),
		url: new URL(`https://app.test${path}`),
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
	};
}

/** Drive `handle` the way SvelteKit does: call transformPageChunk on each HTML chunk. */
async function render(path: string, token?: string) {
	let transformed = false;
	const response = await handle({
		event: eventFor(path, token) as never,
		resolve: async (
			_event: unknown,
			opts?: {
				transformPageChunk?: (input: { html: string; done: boolean }) => string | Promise<string | undefined>;
			}
		) => {
			const transform = opts?.transformPageChunk;
			transformed = !!transform;
			if (!transform) {
				return new Response(DOC, { status: 200, headers: { 'content-type': 'text/html' } });
			}
			const first = (await transform({ html: DOC, done: false })) ?? '';
			const second = (await transform({ html: LATER, done: true })) ?? '';
			return new Response(first + second, { status: 200, headers: { 'content-type': 'text/html' } });
		}
	} as never);
	return { status: response.status, html: await response.text(), transformed };
}

describe('hooks.server.ts data-nav (#195)', () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it('stamps a signed-in page with the saved layout and leaves later chunks alone', async () => {
		for (const layout of ['top', 'left'] as const) {
			const id = await makeUser(layout);
			const token = await createSession(SECRET, id);
			const { status, html, transformed } = await render('/', token);
			expect(status).toBe(200);
			expect(transformed).toBe(true);
			expect(html).toContain(`<html data-nav="${layout}" lang="en">`);
			expect(html.match(/data-nav=/g)?.length).toBe(1);
			expect(html).toContain(LATER);
			expect(html.endsWith(LATER)).toBe(true);
		}
	});

	it('does not rewrite a public page when nobody is signed in', async () => {
		for (const path of ['/login', '/unsubscribe', '/p/welcome']) {
			const { status, html, transformed } = await render(path);
			expect(status).toBe(200);
			expect(transformed).toBe(false);
			expect(html).toBe(DOC);
			expect(html).not.toContain('data-nav');
		}
	});

	it('still stamps a public page when the visitor is signed in', async () => {
		const id = await makeUser('left');
		const token = await createSession(SECRET, id);
		const { html, transformed } = await render('/login', token);
		expect(transformed).toBe(true);
		expect(html).toContain('<html data-nav="left" lang="en">');
	});

	it('redirects a signed-out private page instead of rewriting it', async () => {
		await expect(render('/')).rejects.toSatisfy(
			(err: unknown) => isRedirect(err) && err.status === 303 && err.location === '/login'
		);
	});
});
