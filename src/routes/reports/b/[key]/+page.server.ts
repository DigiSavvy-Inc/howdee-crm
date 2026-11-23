import type { Actions, PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { audienceAction, loadAudience } from '$lib/server/reports/audience';
import { duplicateBuiltInAction, loadBuilder, pinBuiltInAction, reportViewer } from '$lib/server/reports/page';

export const load = (async (event) => {
	const data = await loadBuilder(event, 'builtin');
	const audience = data.result ? await loadAudience(getDB(event), data.spec, reportViewer(event), null) : null;
	return { ...data, audience, wideLayout: true as const };
}) satisfies PageServerLoad;

export const actions = {
	duplicate: duplicateBuiltInAction,
	pin: pinBuiltInAction,
	saveSegment: audienceAction('segment'),
	saveList: audienceAction('list'),
	addTag: audienceAction('tag'),
	removeTag: audienceAction('untag')
} satisfies Actions;
