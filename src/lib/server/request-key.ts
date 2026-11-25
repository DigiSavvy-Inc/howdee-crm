// #750: the shared key a machine caller presents. It may come in an Authorization header
// (`Bearer <key>`, or HTTP Basic with the key as the password, which is what a webhook URL of the
// form https://user:<key>@host/… sends) or as `?key=` in the URL. The request is accepted when
// either one matches, so a provider that adds its own unrelated Authorization header to a URL
// carrying `?key=` keeps working. A key in a URL is written to Workers Logs with the request, so
// use the header where the caller supports it.

import { safeEqual } from './auth';

/** The key from the Authorization header, or null when the header has none. */
export function headerKey(request: Request): string | null {
	const auth = request.headers.get('authorization')?.trim() ?? '';
	if (!auth) return null;
	const bearer = /^Bearer\s+(.+)$/i.exec(auth);
	if (bearer) return bearer[1].trim() || null;
	const basic = /^Basic\s+(.+)$/i.exec(auth);
	if (basic) {
		let decoded = '';
		try {
			decoded = atob(basic[1].trim());
		} catch {
			return null;
		}
		const colon = decoded.indexOf(':');
		const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
		return password || null;
	}
	return null;
}

/**
 * True when the header key or the `?key=` value equals `expected`. Both are compared, each in
 * constant time, before the answers are combined. An empty `expected` never matches.
 */
export function requestKeyMatches(request: Request, url: URL, expected: string): boolean {
	if (!expected) return false;
	const header = headerKey(request);
	const query = url.searchParams.get('key');
	const headerOk = safeEqual(header ?? '', expected) && header !== null;
	const queryOk = safeEqual(query ?? '', expected) && query !== null;
	return headerOk || queryOk;
}
