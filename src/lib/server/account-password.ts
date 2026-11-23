// #211: the self-service set/change-password action, shared by /account and /account/password.

import { fail, type RequestEvent } from '@sveltejs/kit';
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE } from './auth';
import { getDB } from './db';
import { credentialStamp, hashPassword, passwordPolicyError, verifyPassword } from './password';
import { getPasswordHash, setUserPassword } from './users';

/**
 * Set (no password yet) or change (current password required unless an admin-generated one
 * must be replaced) the signed-in user's password. Stamps `password_set_at`, which signs out
 * every older session, then reissues this request's cookie so the current one survives.
 */
export async function changeOwnPassword(event: RequestEvent) {
	const user = event.locals.user;
	if (!user) return fail(401, { pwError: 'Sign in first.' });
	const secret = event.platform?.env?.SESSION_SECRET ?? '';
	if (!secret) return fail(500, { pwError: 'Server is missing SESSION_SECRET.' });

	const db = getDB(event);
	const data = await event.request.formData();
	const current = String(data.get('current_password') ?? '');
	const next = String(data.get('new_password') ?? '');
	const confirm = String(data.get('confirm_password') ?? '');

	const stored = await getPasswordHash(db, user.id);
	if (stored && !user.mustChangePassword) {
		if (!current) return fail(400, { pwError: 'Enter your current password.' });
		if (!(await verifyPassword(current, stored))) {
			return fail(400, { pwError: 'Your current password is incorrect.' });
		}
	}
	const policy = passwordPolicyError(next, user.github_login);
	if (policy) return fail(400, { pwError: policy });
	if (next !== confirm) return fail(400, { pwError: "The two new passwords don't match." });

	const hash = await hashPassword(next);
	await setUserPassword(db, user.id, hash, false, credentialStamp());
	// Issued after the stamp, so this session passes the hooks' credential-age check.
	event.cookies.set(SESSION_COOKIE, await createSession(secret, user.id), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: event.url.protocol === 'https:',
		maxAge: SESSION_MAX_AGE
	});
	return {
		pwOk: stored
			? 'Password changed. Your other sessions were signed out.'
			: 'Password set. You can now sign in with your username and password.',
		wasForced: user.mustChangePassword
	};
}
