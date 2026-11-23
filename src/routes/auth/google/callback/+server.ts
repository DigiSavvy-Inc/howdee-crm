import { redirect, type RequestHandler } from '@sveltejs/kit';
import { verifyStateToken } from '$lib/server/auth';
import { getDB } from '$lib/server/db';
import { GOOGLE_STATE_COOKIE, exchangeGoogleCode, getProfile } from '$lib/server/gmail';
import { mailReady, saveMailAccount } from '$lib/server/mail-sync';

// Google OAuth callback (#158): validate state, exchange the code, read the mailbox address
// from the Gmail profile, and store the sealed refresh token bound to the signed-in user
// (#585: any user connects their own mailbox; a mailbox another user connected can be
// reconnected only by them or an admin). Errors land on Settings → Mail as ?error=<code>;
// tokens never reach a URL or a log.
export const GET: RequestHandler = async (event) => {
	const { url, cookies, platform, locals } = event;
	const state = url.searchParams.get('state');
	const stateCookie = cookies.get(GOOGLE_STATE_COOKIE);
	cookies.delete(GOOGLE_STATE_COOKIE, { path: '/' });

	const user = locals?.user;
	if (!user) throw redirect(303, '/login');
	const env = platform?.env;
	if (!env || !mailReady(env)) throw redirect(303, '/settings/mail?error=not_configured');

	if (!state || !stateCookie || state !== stateCookie || !(await verifyStateToken(env.SESSION_SECRET ?? '', stateCookie))) {
		throw redirect(303, '/settings/mail?error=state');
	}
	if (url.searchParams.get('error')) throw redirect(303, '/settings/mail?error=denied');
	const code = url.searchParams.get('code');
	if (!code) throw redirect(303, '/settings/mail?error=google');

	let email: string;
	let refreshToken: string;
	try {
		const t = await exchangeGoogleCode(
			{
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				code,
				redirectUri: `${url.origin}/auth/google/callback`
			},
			event.fetch
		);
		refreshToken = t.refreshToken;
		email = (await getProfile(t.accessToken, event.fetch)).emailAddress;
	} catch {
		throw redirect(303, '/settings/mail?error=google');
	}

	const db = getDB(event);
	if (user.role !== 'admin') {
		const owner = await db
			.prepare('SELECT user_id FROM mail_accounts WHERE email = ?')
			.bind(email.trim().toLowerCase())
			.first<{ user_id: number | null }>();
		if (owner && owner.user_id != null && owner.user_id !== user.id) {
			throw redirect(303, '/settings/mail?error=taken');
		}
	}
	await saveMailAccount(db, env, { email, refreshToken, userId: user.id });
	throw redirect(303, '/settings/mail?connected=1');
};
