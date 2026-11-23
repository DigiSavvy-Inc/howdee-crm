import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDoiConfig } from '$lib/server/double-optin';
import { getUnsubPage } from '$lib/server/unsubscribe-page';

// Settings → Double opt-in → Preview (#510): the saved page in its states, inert. /confirm is
// a public prefix, so the admin check is here.
export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) throw redirect(303, '/login');
	if (event.locals.user.role !== 'admin') throw error(403, 'Admins only.');
	event.setHeaders({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' });
	const db = event.platform?.env?.DB;
	return { cfg: await getDoiConfig(db), accent: (await getUnsubPage(db)).accent, email: 'someone@example.com' };
};
