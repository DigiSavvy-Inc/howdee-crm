import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE } from '$lib/server/auth';
import { getDB } from '$lib/server/db';
import { acceptInvite, OPEN_LIMITED_MESSAGE, openToken, requestIp, TOKEN_ERRORS } from '$lib/server/account-tokens';

// #639: accept an invitation — name + password (+ optional GitHub login), then signed in.
// The account gets the invite's address (marked verified) and role.

function linkError(reason: 'invalid' | 'used' | 'expired' | 'limited'): string {
	return reason === 'limited' ? OPEN_LIMITED_MESSAGE : TOKEN_ERRORS[reason];
}

export const load: ServerLoad = async (event) => {
	const r = await openToken(getDB(event), 'invite', event.params.token ?? '', requestIp(event));
	if (!r.ok) return { ready: false as const, error: linkError(r.reason), email: null, role: null };
	return { ready: true as const, error: null, email: r.row.email, role: r.row.role === 'admin' ? 'admin' : 'member' };
};

export const actions: Actions = {
	default: async (event) => {
		const db = getDB(event);
		const secret = event.platform?.env?.SESSION_SECRET ?? '';
		if (!secret) return fail(500, { error: 'Server is missing SESSION_SECRET.' });
		const r = await openToken(db, 'invite', event.params.token ?? '', requestIp(event));
		if (!r.ok) return fail(r.reason === 'limited' ? 429 : 400, { error: linkError(r.reason), dead: true });

		const data = await event.request.formData();
		const input = {
			name: String(data.get('name') ?? ''),
			password: String(data.get('password') ?? ''),
			confirm: String(data.get('confirm') ?? ''),
			githubLogin: String(data.get('github_login') ?? '')
		};
		// Echoed back on a failure; passwords never are.
		const values = { name: input.name, github_login: input.githubLogin };
		const done = await acceptInvite(db, r.row, input);
		if (!done.ok) return fail(400, { error: done.error ?? null, errors: done.errors ?? {}, values });

		event.cookies.set(SESSION_COOKIE, await createSession(secret, done.userId), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: SESSION_MAX_AGE
		});
		throw redirect(303, '/');
	}
};
