import { redirect, type RequestHandler } from '@sveltejs/kit';
import { createStateToken, STATE_COOKIE } from '$lib/server/auth';
import { authorizeUrl, githubConfigured } from '$lib/server/github-oauth';

export const GET: RequestHandler = async ({ platform, url, cookies }) => {
	const env = platform?.env;
	if (!githubConfigured(env)) {
		throw redirect(303, '/login?error=not_configured');
	}

	const secret = env?.SESSION_SECRET ?? '';
	const state = await createStateToken(secret);
	cookies.set(STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	});

	const redirectUri = `${url.origin}/auth/github/callback`;
	// #741: SvelteKit 3 refuses an external redirect unless it is allowed; only GitHub's sign-in host.
	throw redirect(302, authorizeUrl(env!.GITHUB_CLIENT_ID, redirectUri, state), { external: ['https://github.com'] });
};
