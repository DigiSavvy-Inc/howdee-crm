import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as general from '../src/routes/settings/+page.server';
import * as api from '../src/routes/settings/api/+page.server';
import * as webhooks from '../src/routes/settings/webhooks/+page.server';
import { setSettings } from '../src/lib/server/settings';

// #532: API keys, webhook keys and General settings are admin-only (load + every action);
// a member keeps only their own navigation layout.

const db = (env as any).DB as D1Database;
const LUMA_SECRET = 'whsec_test532secretvalue';
const member = { id: 990532, github_login: 'member-532', role: 'member', navLayout: 'top' };
const admin = { id: 990533, github_login: 'admin-532', role: 'admin', navLayout: 'top' };

function ev(path: string, user: unknown, fields: Record<string, string> = {}) {
	const url = new URL(`https://app.test${path}`);
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		request: new Request(url, { method: 'POST', body }),
		platform: { env },
		url,
		params: {},
		depends: () => {},
		locals: { user, authed: !!user }
	} as any;
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
	try {
		const r = (await p) as { status?: number } | undefined;
		return r?.status;
	} catch (e) {
		return (e as { status?: number }).status;
	}
}

async function cleanup() {
	await db.prepare(`DELETE FROM api_keys WHERE label LIKE 'k532-%'`).run();
	await db.prepare(`DELETE FROM webhook_keys WHERE label LIKE 'k532-%'`).run();
}

describe('#532 settings admin gating', () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it('/settings/api: member gets 403 on load and every action, nothing written', async () => {
		expect(await status((api.load as any)(ev('/settings/api', member)))).toBe(403);
		for (const name of ['create', 'rotate', 'revoke', 'remove']) {
			const st = await status((api.actions as any)[name](ev(`/settings/api?/${name}`, member, { label: 'k532-m', scope: 'read_write', id: '1' })));
			expect(st, name).toBe(403);
		}
		const n = await db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE label LIKE 'k532-%'`).first<{ n: number }>();
		expect(n?.n).toBe(0);
	});

	it('/settings/api: an admin can still load and create', async () => {
		const data = (await (api.load as any)(ev('/settings/api', admin))) as { keys: unknown[] };
		expect(Array.isArray(data.keys)).toBe(true);
		const res = (await (api.actions as any).create(ev('/settings/api?/create', admin, { label: 'k532-a', scope: 'read' }))) as { token?: string };
		expect(res.token).toMatch(/^dk_live_/);
	});

	it('/settings/webhooks: member gets 403 on load and every action', async () => {
		expect(await status((webhooks.load as any)(ev('/settings/webhooks', member)))).toBe(403);
		for (const name of ['create', 'update', 'revoke', 'remove']) {
			const st = await status((webhooks.actions as any)[name](ev(`/settings/webhooks?/${name}`, member, { label: 'k532-m', id: '1' })));
			expect(st, name).toBe(403);
		}
		const n = await db.prepare(`SELECT COUNT(*) AS n FROM webhook_keys WHERE label LIKE 'k532-%'`).first<{ n: number }>();
		expect(n?.n).toBe(0);
	});

	it('/settings/webhooks: an admin can still load and create', async () => {
		const res = (await (webhooks.actions as any).create(ev('/settings/webhooks?/create', admin, { label: 'k532-a' }))) as { ok?: boolean };
		expect(res.ok).toBe(true);
		const data = (await (webhooks.load as any)(ev('/settings/webhooks', admin))) as { keys: { label: string }[] };
		expect(data.keys.some((k) => k.label === 'k532-a')).toBe(true);
	});

	it('General: member page data carries no secrets or settings', async () => {
		await setSettings(db, { luma_webhook_secret: LUMA_SECRET, inbound_forward_to: 'ops532@example.com', approved_senders: 'example.com' });
		const data = (await (general.load as any)(ev('/settings', member))) as Record<string, unknown>;
		expect(data.isAdmin).toBe(false);
		expect(Object.keys(data).sort()).toEqual(['isAdmin', 'me']);
		const json = JSON.stringify(data);
		expect(json).not.toContain(LUMA_SECRET);
		expect(json).not.toContain('ops532@example.com');

		const adminData = (await (general.load as any)(ev('/settings', admin))) as { isAdmin: boolean; settings: { luma_webhook_secret?: string } };
		expect(adminData.isAdmin).toBe(true);
		expect(adminData.settings.luma_webhook_secret).toBe(LUMA_SECRET);
		await setSettings(db, { luma_webhook_secret: '', inbound_forward_to: '', approved_senders: '' });
	});

	it('General: member gets 403 on the admin actions, setNavLayout stays open', async () => {
		for (const name of ['save', 'recomputeEngagement', 'saveEngagementConfig', 'resetEngagementConfig']) {
			const st = await status((general.actions as any)[name](ev(`/settings?/${name}`, member, { luma_webhook_secret: 'whsec_evil' })));
			expect(st, name).toBe(403);
		}
		const row = await db.prepare(`SELECT value FROM app_state WHERE key = 'luma_webhook_secret'`).first<{ value: string }>();
		expect(row?.value ?? '').not.toBe('whsec_evil');
		// setNavLayout writes to users; the fake member has no row, so only check it isn't refused as 403.
		const st = await status((general.actions as any).setNavLayout(ev('/settings?/setNavLayout', member, { nav_layout: 'left' })));
		expect(st).not.toBe(403);
	});
});
