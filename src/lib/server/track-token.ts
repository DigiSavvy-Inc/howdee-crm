// Site-tracking identity tokens (#151). Two compact HMAC-signed strings, both keyed by
// SESSION_SECRET with their own domain-separation prefix:
//
//   visitor token  `<contact36>.<exp36>.<sig>`        — appended to links as `dsv=` (30 days)
//   visitor id     `<contact36>.<site36>.<iat36>.<sig>` — returned by /api/track/identify,
//                                                     kept in the site's localStorage (180 days)
//
// Numbers are base36 and the signature is the first 16 bytes of HMAC-SHA256 in base64url
// (22 chars), so a link token stays well under 60 characters.
import { b64urlDecode, b64urlEncode, hmac, timingSafeEqual } from './token';

const LINK_PREFIX = 'dsv-link:';
const ID_PREFIX = 'dsv-id:';
const SIG_BYTES = 16;
const SIG_CHARS = 22;

export const VISITOR_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const VISITOR_ID_TTL_SECONDS = 180 * 24 * 60 * 60;

export type VisitorToken = { c: number; exp: number };
export type VisitorId = { c: number; s: number; iat: number };

async function sign(secret: string, prefix: string, body: string): Promise<string> {
	return b64urlEncode((await hmac(secret, prefix + body)).slice(0, SIG_BYTES));
}

async function checkSig(secret: string, prefix: string, body: string, sig: string): Promise<boolean> {
	if (sig.length !== SIG_CHARS) return false;
	let bytes: Uint8Array;
	try {
		bytes = b64urlDecode(sig);
	} catch {
		return false;
	}
	// Only the canonical encoding (the last char has spare bits).
	if (b64urlEncode(bytes) !== sig) return false;
	const expected = (await hmac(secret, prefix + body)).slice(0, SIG_BYTES);
	return timingSafeEqual(bytes, expected);
}

function parsePositive36(s: string): number | null {
	if (!/^[0-9a-z]{1,11}$/.test(s)) return null;
	const n = parseInt(s, 36);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function signVisitorToken(
	secret: string,
	payload: { c: number; exp?: number }
): Promise<string> {
	const exp = payload.exp ?? nowSec() + VISITOR_TOKEN_TTL_SECONDS;
	const body = `${payload.c.toString(36)}.${exp.toString(36)}`;
	return `${body}.${await sign(secret, LINK_PREFIX, body)}`;
}

/** Valid signature AND not expired, else null. */
export async function verifyVisitorToken(
	secret: string,
	token: string | null | undefined,
	now = nowSec()
): Promise<VisitorToken | null> {
	if (!secret || !token || token.length > 80) return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const c = parsePositive36(parts[0]);
	const exp = parsePositive36(parts[1]);
	if (!c || !exp) return null;
	if (!(await checkSig(secret, LINK_PREFIX, `${parts[0]}.${parts[1]}`, parts[2]))) return null;
	if (exp <= now) return null;
	return { c, exp };
}

export async function signVisitorId(secret: string, payload: { c: number; s: number; iat?: number }): Promise<string> {
	const iat = payload.iat ?? nowSec();
	const body = `${payload.c.toString(36)}.${payload.s.toString(36)}.${iat.toString(36)}`;
	return `${body}.${await sign(secret, ID_PREFIX, body)}`;
}

/** Valid signature, issued no more than 180 days ago (and not in the future), else null. */
export async function verifyVisitorId(
	secret: string,
	id: string | null | undefined,
	now = nowSec()
): Promise<VisitorId | null> {
	if (!secret || !id || id.length > 100) return null;
	const parts = id.split('.');
	if (parts.length !== 4) return null;
	const c = parsePositive36(parts[0]);
	const s = parsePositive36(parts[1]);
	const iat = parsePositive36(parts[2]);
	if (!c || !s || !iat) return null;
	if (!(await checkSig(secret, ID_PREFIX, `${parts[0]}.${parts[1]}.${parts[2]}`, parts[3]))) return null;
	if (iat > now + 300 || now - iat > VISITOR_ID_TTL_SECONDS) return null;
	return { c, s, iat };
}
