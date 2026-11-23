import { error, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { createForm } from '$lib/server/forms';

// #509: a POST creates the draft (from `emptyForm()`) and opens the builder — never a GET,
// so link preloading can't create forms.
export const load: PageServerLoad = async (event) => {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Only admins can create forms.');
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		if (event.locals.user?.role !== 'admin') throw error(403, 'Only admins can create forms.');
		const name = String((await event.request.formData()).get('name') ?? '');
		const id = await createForm(getDB(event), name, event.locals.user.id);
		throw redirect(303, `/forms/${id}`);
	}
};
