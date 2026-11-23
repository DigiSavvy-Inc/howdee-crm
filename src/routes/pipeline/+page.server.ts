import type { Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { boardData, ownerOptions } from '$lib/server/pipeline';
import { runPipelineAction } from '$lib/server/pipeline-form';
import { parseView, VIEW_COOKIE } from '$lib/pipeline';

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const sp = event.url.searchParams;

	// Kanban / list: ?view= wins and is remembered (like #200); else the cookie; else null —
	// the page then picks by viewport (list ≤ 768px).
	const fromParam = parseView(sp.get('view'));
	if (fromParam) {
		event.cookies.set(VIEW_COOKIE, fromParam, {
			path: '/pipeline',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 365
		});
	}
	const view = fromParam ?? parseView(event.cookies.get(VIEW_COOKIE));

	const ownerRaw = sp.get('owner') ?? '';
	const owner = ownerRaw === 'none' ? 'none' : Number(ownerRaw) > 0 ? Number(ownerRaw) : null;
	const q = (sp.get('q') ?? '').trim().slice(0, 100);

	const [board, owners] = await Promise.all([boardData(db, { owner, q }), ownerOptions(db)]);
	return {
		board,
		owners,
		view,
		filter: { owner: ownerRaw === 'none' ? 'none' : owner ? String(owner) : '', q },
		isAdmin: event.locals.user?.role === 'admin',
		me: event.locals.user?.id ?? null
	};
};

const act =
	(action: 'add' | 'move' | 'mark' | 'edit' | 'remove'): NonNullable<Actions[string]> =>
	async (event) =>
		runPipelineAction(getDB(event), event.locals, action, await event.request.formData());

export const actions: Actions = {
	add: act('add'),
	move: act('move'),
	mark: act('mark'),
	edit: act('edit'),
	remove: act('remove')
};
