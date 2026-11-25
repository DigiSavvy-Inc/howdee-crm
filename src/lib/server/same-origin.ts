// #749: the hook's cross-site request rule (SvelteKit's own origin check is off, see
// `csrf.trustedOrigins` in vite.config.ts). Pure, so the tests can call it directly; `hooks.server.ts` applies it
// to every request that is not on its CSRF-exempt list.

export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Content types a plain HTML form can send (the pre-#749 rule for requests without a session). */
export const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

/** `Sec-Fetch-Site` values that mean the request did not come from another site. */
const SAME_SITE_FETCH = ['same-origin', 'none'];

export const CROSS_SITE_MESSAGE = 'Cross-site requests are forbidden';

/**
 * Whether a state-changing request must be refused.
 *
 * With a session cookie, the request must come from the app's own origin whatever its
 * content type, body or lack of one: `Origin` equal to `appOrigin`; with no `Origin`,
 * `Sec-Fetch-Site` of `same-origin` or `none`; with neither header, refused.
 * Without a session cookie, only form-type bodies are checked (`Origin` must equal
 * `appOrigin`), as before: such a request acts as nobody.
 */
export function crossSiteRefused(
	method: string,
	headers: Headers,
	appOrigin: string,
	hasSessionCookie: boolean
): boolean {
	if (!MUTATING_METHODS.includes(method.toUpperCase())) return false;
	const origin = headers.get('origin');
	if (hasSessionCookie) {
		if (origin !== null) return origin !== appOrigin;
		const site = (headers.get('sec-fetch-site') ?? '').trim().toLowerCase();
		return !SAME_SITE_FETCH.includes(site);
	}
	const ct = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	return FORM_CONTENT_TYPES.includes(ct) && origin !== appOrigin;
}
