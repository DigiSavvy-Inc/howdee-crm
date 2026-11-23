import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { listForms, restoreForm } from '$lib/server/forms';
import { publicBaseUrlFor } from '$lib/server/public-url';

/** Forms list (#509). Everyone sees it; creating and changing forms is admin-only. */
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const archived = event.url.searchParams.get('archived') === '1';
	const [forms, baseUrl] = await Promise.all([listForms(db, { archived }), publicBaseUrlFor(event)]);
	return { forms, archived, baseUrl, isAdmin: event.locals.user?.role === 'admin' };
};

export const actions: Actions = {
	restore: async (event) => {
		if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
		const id = Number((await event.request.formData()).get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Missing form.' });
		await restoreForm(getDB(event), id, event.locals.user.id);
		return { restored: true };
	}
};
