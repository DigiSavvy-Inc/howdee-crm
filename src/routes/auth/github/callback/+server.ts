import { redirect, type RequestHandler } from '@sveltejs/kit';
import { createSession, verifyStateToken, SESSION_COOKIE, SESSION_MAX_AGE, STATE_COOKIE } from '$lib/server/auth';
import { exchangeCode, fetchGitHubUser } from '$lib/server/github-oauth';
import { resolveGitHubUser } from '$lib/server/users';
import { getDB } from '$lib/server/db';

export const GET: RequestHandler = async (event) => {
	const { url, cookies, platform } = event;
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const stateCookie = cookies.get(STATE_COOKIE);
	cookies.delete(STATE_COOKIE, { path: '/' });

	const secret = platform?.env?.SESSION_SECRET ?? '';
	if (
		!state ||
		!stateCookie ||
		state !== stateCookie ||
		!(await verifyStateToken(secret, stateCookie))
	) {
		throw redirect(303, '/login?error=state');
	}

	if (!code) {
		throw redirect(303, '/login?error=github');
	}

	let ghUser;
	try {
		const token = await exchangeCode(
			{
				clientId: platform!.env.GITHUB_CLIENT_ID,
				clientSecret: platform!.env.GITHUB_CLIENT_SECRET,
				code,
				redirectUri: `${url.origin}/auth/github/callback`
			},
			fetch
		);
		ghUser = await fetchGitHubUser(token, fetch);
	} catch {
		throw redirect(303, '/login?error=github');
	}

	const db = getDB(event);
	const user = await resolveGitHubUser(db, ghUser);
	if (!user) {
		throw redirect(303, '/login?error=not_allowed');
	}

	const sessionToken = await createSession(secret, user.id);
	cookies.set(SESSION_COOKIE, sessionToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: SESSION_MAX_AGE
	});
	throw redirect(303, '/');
};
