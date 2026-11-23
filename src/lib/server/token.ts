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

export async function signUnsub(secret: string, payload: UnsubPayload): Promise<string> {
	const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
	const sig = b64urlEncode(await hmac(secret, body));
	return `${body}.${sig}`;
}

export async function verifyUnsub(
	secret: string,
	token: string | undefined
): Promise<UnsubPayload | null> {
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
	const expected = await hmac(secret, body);
	if (!timingSafeEqual(sigBytes, expected)) return null;
	try {
		return JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as UnsubPayload;
	} catch {
		return null;
	}
}

/** Trimmed SESSION_SECRET. Every signer and verifier of a token must agree on it. */
export function sessionSecret(source: { SESSION_SECRET?: string | null } | null | undefined): string {
	return (source?.SESSION_SECRET ?? '').trim();
}
