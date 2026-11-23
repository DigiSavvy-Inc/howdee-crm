import { fail, type Actions, type ServerLoad } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { completeVerification, OPEN_LIMITED_MESSAGE, openToken, requestIp, TOKEN_ERRORS } from '$lib/server/account-tokens';

// #639: confirm a changed email address. GET only shows the button (mail scanners follow
// links); the POST marks the address verified, while it is still the account's email.

function linkError(reason: 'invalid' | 'used' | 'expired' | 'limited'): string {
	return reason === 'limited' ? OPEN_LIMITED_MESSAGE : TOKEN_ERRORS[reason];
}

export const load: ServerLoad = async (event) => {
	const r = await openToken(getDB(event), 'verify', event.params.token ?? '', requestIp(event));
	return r.ok ? { ready: true as const, error: null, email: r.row.email } : { ready: false as const, error: linkError(r.reason), email: null };
};

export const actions: Actions = {
	default: async (event) => {
		const db = getDB(event);
		const r = await openToken(db, 'verify', event.params.token ?? '', requestIp(event));
		if (!r.ok) return fail(r.reason === 'limited' ? 429 : 400, { error: linkError(r.reason) });
		const done = await completeVerification(db, r.row);
		if (!done.ok) return fail(400, { error: done.error });
		return { verified: true, signedIn: !!event.locals?.user };
	}
};
