import type { Actions, ServerLoad } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import {
	padTo,
	requestIp,
	requestPasswordReset,
	RESET_MIN_MS,
	RESET_SENT_MESSAGE,
	type AccountEnv
} from '$lib/server/account-tokens';

// #639: "Forgot password?" — always the same sentence, in about the same time, whether or not
// the address belongs to a user. A link goes only to an active user's verified address.

export const load: ServerLoad = async () => ({});

export const actions: Actions = {
	default: async (event) => {
		const start = Date.now();
		const db = getDB(event);
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '');
		// The send runs after the response when the Worker offers waitUntil (tests have no ctx).
		const ctx = event.platform?.ctx;
		const defer = ctx?.waitUntil ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
		try {
			await requestPasswordReset(db, (event.platform?.env ?? {}) as AccountEnv, { email, ip: requestIp(event) }, { defer });
		} catch {
			// Same answer on any failure — never reveal whether the address exists.
		}
		await padTo(start, RESET_MIN_MS);
		return { sent: RESET_SENT_MESSAGE };
	}
};
