import { describe, it, expect } from 'vitest';
import {
	createSession,
	verifySession,
	createStateToken,
	verifyStateToken,
	safeEqual
} from '../src/lib/server/auth';

const SECRET = 'test-secret-abc123';

describe('createSession / verifySession', () => {
	it('round-trips and returns the bound userId', async () => {
		const token = await createSession(SECRET, 42);
		const before = Date.now();
		const result = await verifySession(SECRET, token);
		expect(result?.userId).toBe(42);
		expect(result!.issuedAt).toBeLessThanOrEqual(before);
		expect(before - result!.issuedAt).toBeLessThan(5000);
	});

	it('rejects a tampered signature', async () => {
		const token = await createSession(SECRET, 42);
		const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
		const result = await verifySession(SECRET, tampered);
		expect(result).toBeNull();
	});

	it('rejects a legacy auth.<ts>.<sig> token (no bound user)', async () => {
		// Reproduce the old single-password session shape without importing removed code.
		const enc = new TextEncoder();
		const payload = `auth.${Date.now()}`;
		const key = await crypto.subtle.importKey(
			'raw',
			enc.encode(SECRET),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
		const sigBytes = new Uint8Array(sigBuf);
		let str = '';
		for (const b of sigBytes) str += String.fromCharCode(b);
		const sig = btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const legacyToken = `${payload}.${sig}`;

		const result = await verifySession(SECRET, legacyToken);
		expect(result).toBeNull();
	});

	it('rejects missing token or secret', async () => {
		expect(await verifySession(SECRET, undefined)).toBeNull();
		expect(await verifySession('', 'u.1.123.sig')).toBeNull();
	});

	it('rejects a wrong secret', async () => {
		const token = await createSession(SECRET, 7);
		const result = await verifySession('different-secret', token);
		expect(result).toBeNull();
	});
});

describe('createStateToken / verifyStateToken', () => {
	it('round-trips true', async () => {
		const token = await createStateToken(SECRET);
		expect(token.startsWith('st.')).toBe(true);
		expect(await verifyStateToken(SECRET, token)).toBe(true);
	});

	it('rejects a wrong secret', async () => {
		const token = await createStateToken(SECRET);
		expect(await verifyStateToken('different-secret', token)).toBe(false);
	});

	it('rejects a tampered token', async () => {
		const token = await createStateToken(SECRET);
		const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
		expect(await verifyStateToken(SECRET, tampered)).toBe(false);
	});

	it('rejects an expired-shaped token (forged old timestamp fails signature)', async () => {
		// Can't fast-forward the clock cheaply here; a forged old-timestamp payload at
		// least confirms a mismatched signature (different payload) is rejected too.
		const forged = `st.${'0'.repeat(32)}.1.deadbeef`;
		expect(await verifyStateToken(SECRET, forged)).toBe(false);
	});

	it('rejects missing token or secret', async () => {
		expect(await verifyStateToken(SECRET, undefined)).toBe(false);
		expect(await verifyStateToken('', 'st.abc.123.sig')).toBe(false);
	});
});

describe('safeEqual', () => {
	it('is true for equal strings, false otherwise', () => {
		expect(safeEqual('abc', 'abc')).toBe(true);
		expect(safeEqual('abc', 'abd')).toBe(false);
		expect(safeEqual('abc', 'ab')).toBe(false);
	});
});
