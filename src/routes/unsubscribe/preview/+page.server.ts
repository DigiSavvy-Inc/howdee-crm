import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getUnsubPage } from '$lib/server/unsubscribe-page';
import { publicTopics, type PublicTopic } from '$lib/server/topics';
import { unsubscribeCsp } from '$lib/unsubscribe-page';

// Settings → Unsubscribe page → Preview (#374): the saved page in both states with a fake
// address and no token. /unsubscribe is a public prefix, so the admin check is here.
export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) throw redirect(303, '/login');
	if (event.locals.user.role !== 'admin') throw error(403, 'Admins only.');
	event.setHeaders({ 'Content-Security-Policy': unsubscribeCsp(), 'Cache-Control': 'no-store' });
	const db = event.platform?.env?.DB;
	// #414: the same curated topics (label + blurb) the real page shows, all ticked.
	let topics: PublicTopic[] = [];
	try {
		if (db) topics = (await publicTopics(db, null)).map((t) => ({ ...t, subscribed: true }));
	} catch {
		/* topics are optional */
	}
	return { page: await getUnsubPage(db), topics, email: 'someone@example.com' };
};
