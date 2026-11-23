import type { Actions, PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { audienceAction, loadAudience } from '$lib/server/reports/audience';
import {
	deleteReportAction,
	duplicateSavedAction,
	loadBuilder,
	pinReportAction,
	reportViewer,
	saveAsReportAction,
	saveReportAction
} from '$lib/server/reports/page';

export const load = (async (event) => {
	const data = await loadBuilder(event, 'saved');
	const audience = data.result ? await loadAudience(getDB(event), data.spec, reportViewer(event), data.saved?.id ?? null) : null;
	return { ...data, audience, wideLayout: true as const };
}) satisfies PageServerLoad;

export const actions = {
	save: saveReportAction,
	saveAs: saveAsReportAction,
	duplicate: duplicateSavedAction,
	pin: pinReportAction,
	delete: deleteReportAction,
	saveSegment: audienceAction('segment'),
	saveList: audienceAction('list'),
	addTag: audienceAction('tag'),
	removeTag: audienceAction('untag')
} satisfies Actions;
