import { fail, redirect, type Actions, type Cookies, type RequestEvent, type ServerLoad } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE } from '$lib/server/auth';
import { breakGlassSucceeded, checkBreakGlass, recordBreakGlassEvent } from '$lib/server/break-glass';
import { githubConfigured } from '$lib/server/github-oauth';
import { firstActiveAdmin, findActiveUserById } from '$lib/server/users';
import { getDB } from '$lib/server/db';
import { signInWithPassword } from '$lib/server/login-attempts';
import { hasAnyUser } from '$lib/server/setup';

/** Client IP for the lockout counter: Cloudflare's header, else the adapter's address. */
function clientIp(event: RequestEvent): string {
	const cf = event.request.headers.get('cf-connecting-ip');
	if (cf) return cf.slice(0, 64);
	try {
		return event.getClientAddress().slice(0, 64);
	} catch {
		return 'unknown';
	}
}

function setSessionCookie(cookies: Cookies, url: URL, token: string) {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: SESSION_MAX_AGE
	});
}

const ERROR_MESSAGES: Record<string, string> = {
	not_allowed: "That GitHub account isn't on the user list. Ask an admin to add you.",
	state: 'Sign-in expired or was tampered with. Try again.',
	github: 'GitHub sign-in failed. Try again.',
	not_configured: "GitHub sign-in isn't configured on this server."
};

// #606: a fresh install has no users yet — sign-in can't work until /setup creates the first admin.
const NO_USERS_ERROR = 'No users exist yet. Create the first admin at /setup.';

export const load: ServerLoad = async (event) => {
	const { locals, platform, url } = event;
	if (locals.authed) throw redirect(303, '/');
	if (!(await hasAnyUser(getDB(event)))) throw redirect(303, '/setup');
	const code = url.searchParams.get('error');
	return {
		github: githubConfigured(platform?.env),
		password: !!platform?.env?.APP_PASSWORD,
		error: (code && ERROR_MESSAGES[code]) ?? null
	};
};

export const actions: Actions = {
	// #211: username (= GitHub login) + per-user password.
	password: async (event) => {
		const { request, cookies, platform, url } = event;
		const secret = platform?.env?.SESSION_SECRET ?? '';
		if (!secret) return fail(500, { error: 'Server is missing SESSION_SECRET.' });

		const data = await request.formData();
		const username = String(data.get('username') ?? '');
		const password = String(data.get('password') ?? '');
		const db = getDB(event);
		const result = await signInWithPassword(db, { username, password, ip: clientIp(event) });
		if (!result.ok) {
			if (result.status === 429) {
				const n = result.minutes;
				return fail(429, {
					error: `Too many attempts, try again in ${n} minute${n === 1 ? '' : 's'}.`,
					username
				});
			}
			return fail(401, { error: 'Incorrect username or password.', username });
		}

		setSessionCookie(cookies, url, await createSession(secret, result.userId));
		const user = await findActiveUserById(db, result.userId);
		throw redirect(303, user?.mustChangePassword ? '/account/password?first=1' : '/');
	},

	// Break-glass: the shared APP_PASSWORD signs in as the first active admin. #533: under the
	// login_attempts lockout (global + per IP) and audited in break_glass_events.
	server: async (event) => {
		const { request, cookies, platform, url } = event;
		const expected = platform?.env?.APP_PASSWORD ?? '';
		if (!expected) {
			return fail(404, { error: 'Not found.' });
		}

		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const secret = platform?.env?.SESSION_SECRET ?? '';

		if (!secret) {
			return fail(500, { error: 'Server is missing SESSION_SECRET.' });
		}
		const db = getDB(event);
		const ip = clientIp(event);
		const check = await checkBreakGlass(db, { expected, typed: password, ip, secret });
		if (!check.ok) {
			if (check.status === 429) {
				const n = check.minutes;
				return fail(429, { error: `Too many attempts, try again in ${n} minute${n === 1 ? '' : 's'}.` });
			}
			return fail(401, { error: 'Incorrect password.' });
		}

		const admin = await firstActiveAdmin(db);
		if (!admin) {
			await recordBreakGlassEvent(db, { ip, secret, outcome: 'no_admin' });
			// #606: on a fresh install point at first-run setup instead of a server error.
			if (!(await hasAnyUser(db))) return fail(409, { error: NO_USERS_ERROR, setup: true });
			return fail(500, { error: 'No active admin user exists.' });
		}

		await breakGlassSucceeded(db, { ip, secret, userId: admin.id });
		setSessionCookie(cookies, url, await createSession(secret, admin.id));
		throw redirect(303, '/');
	}
};
