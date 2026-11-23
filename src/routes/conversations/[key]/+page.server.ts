import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { conversationByKey, conversationNeighbors, isArchived, parseConvFilter } from '$lib/server/conversations';
import { threadArchiveState } from '$lib/server/conversation-state';

const PER = 25; // the list page's page size — the back link lands on this thread's page

/**
 * One conversation as a GitHub-style issue page (#226): header, message timeline, composer.
 * `?filter=&q=` carry the list's context so Previous / Next walk that filtered list and the
 * back link returns to it. The Reply box still posts /conversations?/reply.
 */
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const key = event.params.key;
	const conv = await conversationByKey(db, key);
	if (!conv) error(404, 'Conversation not found');

	const sp = event.url.searchParams;
	const filter = parseConvFilter(sp.get('filter'));
	const q = (sp.get('q') ?? '').trim().slice(0, 200);
	const neighbors = await conversationNeighbors(db, key, { filter, q });
	const carried = Math.max(1, Math.floor(Number(sp.get('page')) || 1));
	const page = neighbors.index >= 0 ? Math.floor(neighbors.index / PER) + 1 : carried;

	const archived = isArchived(conv, await threadArchiveState(db, key)); // #379

	// Display flag only (shows the Delete control). Missing locals/user reads as non-admin; the
	// delete action in /conversations re-checks the role server-side and 403s members.
	const isAdmin = event.locals?.user?.role === 'admin';

	return { conv, filter, q, page, neighbors, archived, isAdmin };
};
