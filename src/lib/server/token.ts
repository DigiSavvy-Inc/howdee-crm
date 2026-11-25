// Signed, stateless tokens for unsubscribe links (HMAC-SHA256, Workers-native).

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
	const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function hmac(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export type UnsubPayload = {
	c: number | null; // campaign id
	k: number | null; // contact id
	e: string; // email
};

/**
 * #750: what a new unsubscribe token signs starts with this purpose prefix, so a value signed
 * with the same secret for another purpose can't stand in for one. Tokens made before #750
 * were signed without it; they keep verifying (they must keep unsubscribing, forever).
 */
export const UNSUB_PURPOSE = 'dsv-unsub:';

/**
 * #750: self-resubscribe (the unsubscribe page's Resubscribe button and "Resubscribe me") needs
 * a token issued in the last this-many days. Unsubscribing never expires.
 */
export const RESUB_TOKEN_MAX_AGE_DAYS = 90;

/** Shown when a resubscribe is refused because the link is too old. */
export const RESUB_LINK_EXPIRED =
	'This link is too old to resubscribe with. Use the link in a newer email from us.';

export async function signUnsub(secret: string, payload: UnsubPayload, nowMs = Date.now()): Promise<string> {
	const signed = { c: payload.c, k: payload.k, e: payload.e, i: Math.floor(nowMs / 1000) };
	const body = b64urlEncode(enc.encode(JSON.stringify(signed)));
	const sig = b64urlEncode(await hmac(secret, UNSUB_PURPOSE + body));
	return `${body}.${sig}`;
}

export type VerifiedUnsub = {
	payload: UnsubPayload;
	/** Unix seconds the token was signed; null for a token made before #750. */
	issuedAt: number | null;
};

/** Verify an unsubscribe token: the payload plus when it was issued (null = an older token). */
export async function verifyUnsubToken(
	secret: string,
	token: string | undefined
): Promise<VerifiedUnsub | null> {
	if (!secret || !token) return null;
	const dot = token.lastIndexOf('.');
	if (dot < 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	let sigBytes: Uint8Array;
	try {
		sigBytes = b64urlDecode(sig);
	} catch {
		return null;
	}
	const purposed = timingSafeEqual(sigBytes, await hmac(secret, UNSUB_PURPOSE + body));
	const legacy = !purposed && timingSafeEqual(sigBytes, await hmac(secret, body));
	if (!purposed && !legacy) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object' || typeof raw.e !== 'string') return null;
	const payload: UnsubPayload = {
		c: typeof raw.c === 'number' ? raw.c : null,
		k: typeof raw.k === 'number' ? raw.k : null,
		e: raw.e
	};
	// Only a token signed with the purpose prefix carries an issue time we trust.
	const issuedAt = purposed && typeof raw.i === 'number' && Number.isFinite(raw.i) ? raw.i : null;
	return { payload, issuedAt };
}

export async function verifyUnsub(
	secret: string,
	token: string | undefined
): Promise<UnsubPayload | null> {
	return (await verifyUnsubToken(secret, token))?.payload ?? null;
}

/** #750: may this token resubscribe? Only one issued within RESUB_TOKEN_MAX_AGE_DAYS. */
export function resubscribeAllowed(v: VerifiedUnsub, nowMs = Date.now()): boolean {
	if (v.issuedAt == null) return false;
	const age = nowMs / 1000 - v.issuedAt;
	return age >= -300 && age <= RESUB_TOKEN_MAX_AGE_DAYS * 86400;
}

/** Trimmed SESSION_SECRET. Every signer and verifier of a token must agree on it. */
export function sessionSecret(source: { SESSION_SECRET?: string | null } | null | undefined): string {
	return (source?.SESSION_SECRET ?? '').trim();
}
