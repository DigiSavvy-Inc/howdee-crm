// #701 (2/5 of #699): open and click tracking done by the CRM. Spec: docs/sending-providers.md →
// "Open and click tracking by the CRM".
//
// A tracked message gets a random `track_id` (stored on its `recipients` row) and:
//   open pixel   `<base>/t/o/<trackId>.<sig>`               sig = HMAC("dsv-open:"  + trackId)
//   click link   `<base>/t/c/<trackId>.<dest64>.<sig>`      sig = HMAC("dsv-click:" + trackId.dest64)
// keyed by SESSION_SECRET (the first 16 bytes of HMAC-SHA256, base64url, like track-token.ts).
// `dest64` = the destination URL, UTF-8, base64url. The click route only ever redirects to the
// URL inside a valid signature; anything else is a 400, never a redirect.
//
// No send / provider imports: the routes and the send path both use this module.

import { b64urlDecode, b64urlEncode, hmac, timingSafeEqual } from './token';
import { isUnsubscribeLink } from './engagement';

const OPEN_PREFIX = 'dsv-open:';
const CLICK_PREFIX = 'dsv-click:';
const SIG_BYTES = 16;
const SIG_CHARS = 22;
const TRACK_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** Longer destinations are left as they are (not rewritten). */
export const MAX_TRACKED_URL = 2000;
const MAX_TOKEN = 4000;

export const OPEN_PATH = '/t/o/';
export const CLICK_PATH = '/t/c/';

/** 16 random bytes, base64url (22 characters). */
export function newTrackId(): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

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
	if (b64urlEncode(bytes) !== sig) return false;
	const expected = (await hmac(secret, prefix + body)).slice(0, SIG_BYTES);
	return timingSafeEqual(bytes, expected);
}

/** Printable ASCII only, no spaces: safe as a header value. */
const ASCII_URL_RE = /^[\x21-\x7e]+$/;

/** An http(s) URL we are willing to redirect to, normalised (`new URL(raw).href`: inner tabs /
 *  newlines dropped, non-ASCII percent-encoded or punycoded), else null. The normalised form is
 *  what gets signed and what the click route puts in `Location`, so the header is always ASCII. */
export function trackableUrl(raw: string): string | null {
	if (!raw || raw.length > MAX_TRACKED_URL) return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
	if (u.username || u.password) return null;
	const href = u.href;
	if (href.length > MAX_TRACKED_URL || !ASCII_URL_RE.test(href)) return null;
	return href;
}

/** True when `url` may go in the click route's `Location`: http(s), no credentials, printable
 *  ASCII, and already in its normalised form (parsing it again gives the same string). */
export function isSafeRedirect(url: string): boolean {
	return trackableUrl(url) === url;
}

export async function signOpenToken(secret: string, trackId: string): Promise<string> {
	return `${trackId}.${await sign(secret, OPEN_PREFIX, trackId)}`;
}

export async function verifyOpenToken(secret: string, token: string | null | undefined): Promise<{ trackId: string } | null> {
	if (!secret || !token || token.length > 100) return null;
	const parts = token.split('.');
	if (parts.length !== 2 || !TRACK_ID_RE.test(parts[0])) return null;
	if (!(await checkSig(secret, OPEN_PREFIX, parts[0], parts[1]))) return null;
	return { trackId: parts[0] };
}

/** Signs the normalised destination (`trackableUrl`); a URL that isn't trackable is signed as
 *  given and refused by `verifyClickToken`. */
export async function signClickToken(secret: string, trackId: string, url: string): Promise<string> {
	const dest = b64urlEncode(new TextEncoder().encode(trackableUrl(url) ?? url));
	const body = `${trackId}.${dest}`;
	return `${body}.${await sign(secret, CLICK_PREFIX, body)}`;
}

export async function verifyClickToken(secret: string, token: string | null | undefined): Promise<{ trackId: string; url: string } | null> {
	if (!secret || !token || token.length > MAX_TOKEN) return null;
	const parts = token.split('.');
	if (parts.length !== 3 || !TRACK_ID_RE.test(parts[0]) || !parts[1]) return null;
	if (!(await checkSig(secret, CLICK_PREFIX, `${parts[0]}.${parts[1]}`, parts[2]))) return null;
	let url: string;
	try {
		const bytes = b64urlDecode(parts[1]);
		if (b64urlEncode(bytes) !== parts[1]) return null;
		url = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	// Only a destination that was signed in its normalised form (round-trips) is accepted.
	return isSafeRedirect(url) ? { trackId: parts[0], url } : null;
}

function decodeHrefEntities(v: string): string {
	return v.replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
}

/** True when this href must stay as it is: not http(s), the unsubscribe / preference page, an
 *  already-tracked link, or a merge tag left over. */
export function skipTracking(href: string, base: string): boolean {
	if (!/^https?:\/\//i.test(href)) return true;
	if (href.includes('{{') || href.includes('%%')) return true;
	if (isUnsubscribeLink(href)) return true;
	let u: URL;
	try {
		u = new URL(href);
	} catch {
		return true;
	}
	let appHost = '';
	try {
		appHost = new URL(base).host.toLowerCase();
	} catch {
		appHost = '';
	}
	if (u.host.toLowerCase() === appHost) {
		const path = u.pathname;
		if (path.startsWith('/unsubscribe') || path.startsWith(OPEN_PATH) || path.startsWith(CLICK_PATH)) return true;
	}
	return !trackableUrl(href);
}

// A real `href` attribute only: not preceded by a word character or `-` (so `data-href=` and
// similar are left alone).
const HREF_RE = /(<a\b[^>]*?(?<![\w-])href\s*=\s*)(["'])([^"']*)\2/gi;

/**
 * The HTML with every trackable `<a href>` rewritten to a signed click link and (when `opens`)
 * the open pixel added before `</body>`. Text parts are never rewritten.
 */
export async function addCrmTracking(
	html: string,
	opts: { base: string; secret: string; trackId: string; links: boolean; opens: boolean }
): Promise<string> {
	const base = opts.base.replace(/\/+$/, '');
	let out = html;
	if (opts.links) {
		const found: { start: number; end: number; text: string }[] = [];
		for (const m of html.matchAll(HREF_RE)) {
			const href = decodeHrefEntities(m[3].trim());
			if (skipTracking(href, base)) continue;
			const dest = trackableUrl(href);
			if (!dest) continue;
			const token = await signClickToken(opts.secret, opts.trackId, dest);
			found.push({ start: m.index!, end: m.index! + m[0].length, text: `${m[1]}${m[2]}${base}${CLICK_PATH}${token}${m[2]}` });
		}
		if (found.length) {
			let acc = '';
			let at = 0;
			for (const f of found) {
				acc += html.slice(at, f.start) + f.text;
				at = f.end;
			}
			out = acc + html.slice(at);
		}
	}
	if (opts.opens) {
		const pixel = `<img src="${base}${OPEN_PATH}${await signOpenToken(opts.secret, opts.trackId)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;" />`;
		const idx = out.toLowerCase().lastIndexOf('</body>');
		out = idx >= 0 ? out.slice(0, idx) + pixel + out.slice(idx) : out + pixel;
	}
	return out;
}

/** The transparent 1x1 GIF the open route answers with. */
export const PIXEL_GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
