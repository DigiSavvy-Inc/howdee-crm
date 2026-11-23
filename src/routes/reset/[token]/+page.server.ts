import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE } from '$lib/server/auth';
import { getDB } from '$lib/server/db';
import {
	completePasswordReset,
	OPEN_LIMITED_MESSAGE,
	openToken,
	requestIp,
	TOKEN_ERRORS
} from '$lib/server/account-tokens';

// #639: a password-reset link. GET only shows the form; the POST sets the password, ends the
// user's other sessions (password_set_at) and signs them in.

function linkError(reason: 'invalid' | 'used' | 'expired' | 'limited'): string {
	return reason === 'limited' ? OPEN_LIMITED_MESSAGE : TOKEN_ERRORS[reason];
}

export const load: ServerLoad = async (event) => {
	const r = await openToken(getDB(event), 'reset', event.params.token ?? '', requestIp(event));
	return r.ok ? { ready: true as const, error: null } : { ready: false as const, error: linkError(r.reason) };
};

export const actions: Actions = {
	default: async (event) => {
		const db = getDB(event);
		const secret = event.platform?.env?.SESSION_SECRET ?? '';
		if (!secret) return fail(500, { error: 'Server is missing SESSION_SECRET.', dead: false });
		const r = await openToken(db, 'reset', event.params.token ?? '', requestIp(event));
		if (!r.ok) return fail(r.reason === 'limited' ? 429 : 400, { error: linkError(r.reason), dead: true });

		const data = await event.request.formData();
		const done = await completePasswordReset(db, r.row, {
			password: String(data.get('password') ?? ''),
			confirm: String(data.get('confirm') ?? '')
		});
		// #668: the link was used (or the account changed) after the page opened → dead-link view.
		if (!done.ok) return fail(400, { error: done.error, dead: done.dead ?? false });

		// Issued after the new password_set_at, so this is the one session that survives.
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
