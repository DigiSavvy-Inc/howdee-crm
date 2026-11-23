import { error, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getUserById } from '$lib/server/users';
import { changeOwnPassword } from '$lib/server/account-password';

// #211: the only page (besides sign-out) a user with must_change_password can reach.
export const load: PageServerLoad = async (event) => {
	const me = event.locals.user;
	if (!me) throw error(401, 'Sign in first.');
	const row = await getUserById(getDB(event), me.id);
	if (!row) throw error(404, 'User not found.');
	return {
		hasPassword: !!row.has_password,
		mustChange: !!row.must_change_password
	};
};

export const actions: Actions = {
	password: async (event) => {
		const result = await changeOwnPassword(event);
		// Forced change done → straight into the app.
		if ('wasForced' in result && result.wasForced) throw redirect(303, '/');
		return result;
	}
};
