// Small symmetric "box" for secrets stored in D1 (#175): AES-256-GCM via Web Crypto.
//
// Blob format: `v1.` + base64url(iv(12) ‖ ciphertext ‖ tag(16)). The `v1.` prefix is a key id
// so a future key rotation can tell old blobs from new ones. The key is MAIL_TOKEN_KEY —
// 32 random bytes, base64url (standard base64 is accepted too) — imported once per isolate.
// `open` throws on a tampered blob, a wrong key, or an unknown prefix; never log its input.

const KID = 'v1.';
const IV_BYTES = 12;

const keyCache = new Map<string, Promise<CryptoKey>>();

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.trim().replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function b64urlEncode(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function rawKey(key: string): Uint8Array<ArrayBuffer> {
	let raw: Uint8Array<ArrayBuffer>;
	try {
		raw = b64urlDecode(key);
	} catch {
		throw new Error('MAIL_TOKEN_KEY is not valid base64url');
	}
	if (raw.length !== 32) throw new Error('MAIL_TOKEN_KEY must decode to 32 bytes');
	return raw;
}

/** True when `key` is set and decodes to a 32-byte AES key. */
export function isValidKey(key: string | undefined | null): key is string {
	if (!key || !key.trim()) return false;
	try {
		rawKey(key);
		return true;
	} catch {
		return false;
	}
}

function importKey(key: string): Promise<CryptoKey> {
	let k = keyCache.get(key);
	if (!k) {
		k = crypto.subtle.importKey('raw', rawKey(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
		// A failed import must not stay cached.
		k.catch(() => keyCache.delete(key));
		keyCache.set(key, k);
	}
	return k;
}

export async function seal(key: string, plaintext: string): Promise<string> {
	const k = await importKey(key);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plaintext)));
	const out = new Uint8Array(IV_BYTES + ct.length);
	out.set(iv, 0);
	out.set(ct, IV_BYTES);
	return KID + b64urlEncode(out);
}

export async function open(key: string, blob: string): Promise<string> {
	if (!blob.startsWith(KID)) throw new Error('Unknown sealed-blob version');
	const bytes = b64urlDecode(blob.slice(KID.length));
	if (bytes.length < IV_BYTES + 16) throw new Error('Sealed blob is too short');
	const k = await importKey(key);
	const pt = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
		k,
		bytes.slice(IV_BYTES)
	);
	return new TextDecoder().decode(pt);
}
