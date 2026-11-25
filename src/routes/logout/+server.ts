import { redirect, type RequestHandler } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth';
import { endUserSessions } from '$lib/server/users';

/**
 * Is this sign-out from the app's own pages? The app origin is `url.origin`, the same value the
 * hook's form-post origin check compares against (the host the request reached, so the custom
 * domain when that is how the app was opened). A matching `Origin` header passes. With no
 * `Origin` header, `Sec-Fetch-Site: same-origin` (a same-origin post from a browser that leaves
 * Origin out) or `none` (typed or bookmarked by the user) passes. Anything else does not,
 * including `Origin: null` and a request that sends neither header.
 */
function isSameOriginRequest(request: Request, url: URL): boolean {
	const origin = request.headers.get('origin');
	if (origin !== null) return origin === url.origin;
	const site = (request.headers.get('sec-fetch-site') ?? '').trim().toLowerCase();
	return site === 'same-origin' || site === 'none';
}

/**
 * Sign out. #746: from the app's own pages this signs the user out on every device — it moves
 * the user's "sessions valid after" stamp forward, so every session issued before now is
 * refused, not only the cookie in this browser. A sign-out posted from another site (the hook
 * only checks the origin of form posts, so a body-less POST from a sibling host gets here with
 * the cookie) only clears this browser's cookie and leaves the other devices signed in.
 * A break-glass session belongs to the first active admin, so signing out of it ends that
 * admin's other sessions too; break-glass and normal sign-in still work straight after (a new
 * session is issued after the stamp).
 */
export const POST: RequestHandler = async ({ request, url, cookies, locals, platform }) => {
	const db = platform?.env?.DB;
	if (locals.user && db && isSameOriginRequest(request, url)) {
		try {
			await endUserSessions(db, locals.user.id);
		} catch (err) {
			// The cookie below is still deleted; log without any session detail.
			console.error('sign-out: could not end other sessions', err instanceof Error ? err.message : err);
		}
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
	throw redirect(303, '/login');
};
