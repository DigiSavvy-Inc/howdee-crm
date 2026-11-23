// GitHub OAuth auth (#88): HMAC-signed session cookie using Web Crypto (Workers-native).
// Sessions are bound to a users row (`u.<userId>.<ts>.<sig>`); a short-lived HMAC state
// token (`st.<random>.<ts>.<sig>`) guards the OAuth redirect round-trip against CSRF.

const enc = new TextEncoder();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64url(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
	return base64url(sig);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
	// #533: no early return on a length mismatch — always walk the longer string, and fold the
	// length difference into the result (a missing char reads as 0 via `NaN | 0`).
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
	return diff === 0;
}

/** Random hex string (CSPRNG), used as the state token's nonce. */
function randomHex(bytes: number): string {
	const b = new Uint8Array(bytes);
	crypto.getRandomValues(b);
	return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function createSession(secret: string, userId: number): Promise<string> {
	const payload = `u.${userId}.${Date.now()}`;
	const sig = await hmac(secret, payload);
	return `${payload}.${sig}`;
}

/**
 * Verifies a session token and returns the bound user id + when it was issued (epoch ms), or
 * null (also for legacy tokens). hooks.server.ts also rejects a session issued before the
 * user's `password_set_at` (#211) — see `sessionPredates`.
 */
export async function verifySession(
	secret: string,
	token: string | undefined
): Promise<{ userId: number; issuedAt: number } | null> {
	if (!secret || !token) return null;
	const idx = token.lastIndexOf('.');
	if (idx < 0) return null;
	const payload = token.slice(0, idx);
	const sig = token.slice(idx + 1);
	const parts = payload.split('.');
	// Current format: u.<userId>.<ts>. Legacy `auth.<ts>` tokens (no bound user) are rejected.
	if (parts.length !== 3 || parts[0] !== 'u') return null;
	const expected = await hmac(secret, payload);
	if (!safeEqual(sig, expected)) return null;
	const userId = Number(parts[1]);
	const ts = Number(parts[2]);
	if (!Number.isInteger(userId) || userId <= 0) return null;
	if (!ts || Date.now() - ts > SESSION_TTL_MS) return null;
	return { userId, issuedAt: ts };
}

/**
 * #211: true when a session issued at `issuedAt` (ms) predates the user's last credential
 * change (`credentialChangedAt`, ms; NaN = never) — such a session is signed out.
 */
export function sessionPredates(issuedAt: number, credentialChangedAt: number): boolean {
	return Number.isFinite(credentialChangedAt) && issuedAt < credentialChangedAt;
}

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE = SESSION_TTL_MS / 1000;

export const STATE_COOKIE = 'oauth_state';

/** Short-lived signed state token for the OAuth redirect round-trip (`st.<nonce>.<ts>.<sig>`). */
export async function createStateToken(secret: string): Promise<string> {
	const payload = `st.${randomHex(16)}.${Date.now()}`;
	const sig = await hmac(secret, payload);
	return `${payload}.${sig}`;
}

export async function verifyStateToken(secret: string, token: string | undefined): Promise<boolean> {
	if (!secret || !token) return false;
	const idx = token.lastIndexOf('.');
	if (idx < 0) return false;
	const payload = token.slice(0, idx);
	const sig = token.slice(idx + 1);
	const parts = payload.split('.');
	if (parts.length !== 3 || parts[0] !== 'st') return false;
	const expected = await hmac(secret, payload);
	if (!safeEqual(sig, expected)) return false;
	const ts = Number(parts[2]);
	if (!ts || Date.now() - ts > STATE_TTL_MS) return false;
	return true;
}
