import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	generateApiKey,
	sha256Hex,
	authenticateApiKey,
	type ApiScope
} from '../src/lib/server/api-keys';

const db = (env as any).DB as D1Database;

/** Insert a key with the given scope and return its plaintext token. */
async function makeKey(label: string, scope: ApiScope): Promise<string> {
	const k = await generateApiKey();
	await db
		.prepare(
			`INSERT INTO api_keys (label, token_hash, token_prefix, token_last4, scope) VALUES (?, ?, ?, ?, ?)`
		)
		.bind(label, k.tokenHash, k.prefix, k.last4, scope)
		.run();
	return k.token;
}

function makeEvent(authHeader?: string) {
	const headers: Record<string, string> = {};
	if (authHeader !== undefined) headers.authorization = authHeader;
	return {
		request: new Request('https://app.test/api/v1/contacts', { headers }),
		platform: { env },
		url: new URL('https://app.test/api/v1/contacts')
	} as any;
}

beforeEach(async () => {
	await db.prepare('DELETE FROM api_keys').run();
});

describe('generateApiKey', () => {
	it('mints a dk_live_ token whose hash and display fields line up', async () => {
		const k = await generateApiKey();
		expect(k.token).toMatch(/^dk_live_[0-9a-f]{48}$/);
		expect(k.tokenHash).toBe(await sha256Hex(k.token));
		expect(k.prefix).toBe(k.token.slice(0, 'dk_live_'.length + 6));
		expect(k.last4).toBe(k.token.slice(-4));
	});

	it('does not collide across calls', async () => {
		const a = await generateApiKey();
		const b = await generateApiKey();
		expect(a.token).not.toBe(b.token);
		expect(a.tokenHash).not.toBe(b.tokenHash);
	});
});

describe('authenticateApiKey', () => {
	it('accepts a valid read key for read scope and bumps usage', async () => {
		const token = await makeKey('reader', 'read');
		const res = await authenticateApiKey(makeEvent(`Bearer ${token}`), 'read');
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.key.scope).toBe('read');
			expect(res.key.label).toBe('reader');
		}
		const row = await db.prepare('SELECT request_count, last_used_at FROM api_keys LIMIT 1').first<any>();
		expect(row.request_count).toBe(1);
		expect(row.last_used_at).not.toBeNull();
	});

	it('rejects a read key when read_write is required (403)', async () => {
		const token = await makeKey('reader', 'read');
		const res = await authenticateApiKey(makeEvent(`Bearer ${token}`), 'read_write');
		expect(res).toMatchObject({ ok: false, status: 403 });
	});

	it('accepts a read_write key for both scopes', async () => {
		const token = await makeKey('writer', 'read_write');
		expect((await authenticateApiKey(makeEvent(`Bearer ${token}`), 'read')).ok).toBe(true);
		expect((await authenticateApiKey(makeEvent(`Bearer ${token}`), 'read_write')).ok).toBe(true);
	});

	it('rejects a missing or malformed header (401)', async () => {
		expect(await authenticateApiKey(makeEvent(undefined), 'read')).toMatchObject({ ok: false, status: 401 });
		expect(await authenticateApiKey(makeEvent('Token abc'), 'read')).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects an unknown token (401)', async () => {
		await makeKey('reader', 'read');
		const res = await authenticateApiKey(makeEvent('Bearer dk_live_deadbeef'), 'read');
		expect(res).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a revoked key (401)', async () => {
		const token = await makeKey('reader', 'read');
		await db.prepare("UPDATE api_keys SET revoked_at = datetime('now')").run();
		const res = await authenticateApiKey(makeEvent(`Bearer ${token}`), 'read');
		expect(res).toMatchObject({ ok: false, status: 401 });
	});
});
