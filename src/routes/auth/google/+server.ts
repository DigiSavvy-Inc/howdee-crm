import { redirect, type RequestHandler } from '@sveltejs/kit';
import { createStateToken } from '$lib/server/auth';
import { GOOGLE_STATE_COOKIE, googleAuthorizeUrl } from '$lib/server/gmail';
import { mailReady } from '$lib/server/mail-sync';

// Connect Gmail (#158): start of the Google OAuth web flow. `/auth` is a public prefix
// (GitHub sign-in), so the sign-in check happens here; the callback re-checks it.
// #585: any signed-in user connects their own mailbox (it was admin-only).
export const GET: RequestHandler = async ({ platform, url, cookies, locals }) => {
	if (!locals?.user) throw redirect(303, '/login');
	const env = platform?.env;
	if (!env || !mailReady(env)) throw redirect(303, '/settings/mail?error=not_configured');

	const state = await createStateToken(env.SESSION_SECRET ?? '');
	cookies.set(GOOGLE_STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	});
	// #741: SvelteKit 3 refuses an external redirect unless it is allowed; only Google's sign-in host.
	throw redirect(302, googleAuthorizeUrl(env.GOOGLE_CLIENT_ID, `${url.origin}/auth/google/callback`, state), {
		external: ['https://accounts.google.com']
	});
};
