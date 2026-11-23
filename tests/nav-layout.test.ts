import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { actions } from '../src/routes/settings/+page.server';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { findActiveUserById } from '../src/lib/server/users';
import { parseNavLayout, withNavLayoutAttr } from '../src/lib/nav-layout';

// #134: per-user nav layout preference (top | left).

const db = (env as any).DB as D1Database;
const PREFIX = 'navlayout-test-';

async function cleanup() {
	await db.prepare(`DELETE FROM users WHERE github_login LIKE ?`).bind(`${PREFIX}%`).run();
}

async function makeUser(): Promise<number> {
	const res = await db
		.prepare(`INSERT INTO users (github_login, role) VALUES (?, 'member')`)
		.bind(`${PREFIX}jdoe`)
		.run();
	return res.meta.last_row_id as number;
}

function actionEvent(user: { id: number } | null, navLayout: string) {
	const body = new FormData();
	body.set('nav_layout', navLayout);
	const url = new URL('https://app.test/settings?/setNavLayout');
	return {
		request: new Request(url, { method: 'POST', body }),
		platform: { env },
		url,
		params: {},
		locals: { user, authed: !!user }
	} as any;
}

describe('nav layout preference', () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it('defaults to top for a new user', async () => {
		const id = await makeUser();
		expect((await findActiveUserById(db, id))?.navLayout).toBe('top');
	});

	it('round-trips through the setNavLayout action and the layout load', async () => {
		const id = await makeUser();

		const res = await actions.setNavLayout(actionEvent({ id }, 'left'));
		expect(res).toEqual({ navLayout: 'left' });

		// hooks.server.ts resolves locals.user via findActiveUserById; the layout load passes it on.
		const user = await findActiveUserById(db, id);
		expect(user?.navLayout).toBe('left');
		const data = (await layoutLoad({ locals: { authed: true, user }, depends: () => {} } as any)) as any;
		expect(data.user.navLayout).toBe('left');

		await actions.setNavLayout(actionEvent({ id }, 'top'));
		expect((await findActiveUserById(db, id))?.navLayout).toBe('top');
	});

	it('rejects an invalid value without changing the saved one', async () => {
		const id = await makeUser();
		await actions.setNavLayout(actionEvent({ id }, 'left'));

		const res = (await actions.setNavLayout(actionEvent({ id }, 'sideways'))) as any;
		expect(res.status).toBe(400);
		expect((await findActiveUserById(db, id))?.navLayout).toBe('left');
	});

	it('401s without a session user', async () => {
		const res = (await actions.setNavLayout(actionEvent(null, 'left'))) as any;
		expect(res.status).toBe(401);
	});
});

describe('layout attribute', () => {
	const doc = '<!doctype html>\n<html lang="en">\n\t<head></head><body></body></html>';

	it('stamps data-nav on the <html> tag', () => {
		expect(withNavLayoutAttr(doc, 'left')).toContain('<html data-nav="left" lang="en">');
		expect(withNavLayoutAttr(doc, 'top')).toContain('<html data-nav="top" lang="en">');
	});

	it('handles a bare <html> and leaves chunks without one untouched', () => {
		expect(withNavLayoutAttr('<html><body></body></html>', 'left')).toBe(
			'<html data-nav="left"><body></body></html>'
		);
		expect(withNavLayoutAttr('<main>later chunk</main>', 'left')).toBe('<main>later chunk</main>');
	});

	it('only touches the first <html> tag', () => {
		const out = withNavLayoutAttr(`${doc}<code>&lt;html&gt;</code><html lang="x">`, 'left');
		expect(out.match(/data-nav=/g)?.length).toBe(1);
	});

	it('parseNavLayout falls back to top', () => {
		expect(parseNavLayout('left')).toBe('left');
		expect(parseNavLayout('nope')).toBe('top');
		expect(parseNavLayout(null)).toBe('top');
	});
});
