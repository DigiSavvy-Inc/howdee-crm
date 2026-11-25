import { error, fail, redirect, type Actions, type RequestEvent, type ServerLoad } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE } from '$lib/server/auth';
import { getDB } from '$lib/server/db';
import { recordSeenOrigin } from '$lib/server/public-url';
import {
	checkSetupToken,
	createFirstAdmin,
	hasAnyUser,
	setupToken,
	validateFirstAdmin,
	type FirstAdminInput
} from '$lib/server/setup';

// #606: first-run setup — creates the first admin while the users table is empty.
// Once any user exists this route is a 404 (load and action alike).
//
// #731: the setup link the deploy prints carries the token in the URL fragment (`/setup#token=…`).
// The page's script reads it, fills the token field and strips it from the address bar; a
// fragment is never sent to the server, so the token reaches us only in the form body, like a
// typed one, and goes through the same constant-time check and lockout.

function clientIp(event: RequestEvent): string {
	const cf = event.request.headers.get('cf-connecting-ip');
	if (cf) return cf.slice(0, 64);
	try {
		return event.getClientAddress().slice(0, 64);
	} catch {
		return 'unknown';
	}
}

export const load: ServerLoad = async (event) => {
	const db = getDB(event);
	if (await hasAnyUser(db)) throw error(404, 'Not found');
	return { tokenSet: !!setupToken(event.platform?.env) };
};

export const actions: Actions = {
	default: async (event) => {
		const { request, platform, cookies, url } = event;
		const db = getDB(event);
		if (await hasAnyUser(db)) throw error(404, 'Not found');
		const expected = setupToken(platform?.env);
		if (!expected) return fail(400, { error: 'Set the SETUP_TOKEN secret first.' });
		const secret = platform?.env?.SESSION_SECRET ?? '';
		if (!secret) return fail(500, { error: 'Server is missing SESSION_SECRET.' });

		const data = await request.formData();
		const input: FirstAdminInput = {
			name: String(data.get('name') ?? ''),
			email: String(data.get('email') ?? ''),
			password: String(data.get('password') ?? ''),
			confirm: String(data.get('confirm') ?? ''),
			githubLogin: String(data.get('github_login') ?? '')
		};
		// Echoed back on a failure; the token and passwords never are.
		const values = { name: input.name, email: input.email, github_login: input.githubLogin };

		const check = await checkSetupToken(db, expected, String(data.get('token') ?? ''), clientIp(event));
		if (!check.ok) {
			if (check.status === 429) {
				const n = check.minutes;
				return fail(429, { error: `Too many attempts, try again in ${n} minute${n === 1 ? '' : 's'}.`, values });
			}
			return fail(401, { error: "That setup token isn't right.", values });
		}

		const errors = validateFirstAdmin(input);
		if (Object.keys(errors).length) return fail(400, { errors, values });

		const created = await createFirstAdmin(db, input);
		if (!created.ok) throw error(404, 'Not found');

		cookies.set(SESSION_COOKIE, await createSession(secret, created.id), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: SESSION_MAX_AGE
		});
		// #731: the address this request arrived on is the app's address until Settings → Domain or
		// PUBLIC_BASE_URL says otherwise, so the built-in clock builds real links. Only the request's
		// own URL is used (never a header or a form field); the internal tick origin and loopback
		// hosts are never stored. Best-effort: the admin exists either way.
		try {
			await recordSeenOrigin(db, url);
		} catch (e) {
			console.error('setup: could not record the public address:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
		// #609: straight to the setup checklist, which says what is still missing. #731: `first=1`
		// opens it as the first-run wizard.
		throw redirect(303, '/settings/setup?first=1');
	}
};
