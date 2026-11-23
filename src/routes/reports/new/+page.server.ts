import type { Actions, PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { audienceAction, loadAudience } from '$lib/server/reports/audience';
import { loadBuilder, reportViewer, saveAsReportAction, saveReportAction } from '$lib/server/reports/page';
import { describeReportAction, reportNlStatus } from '$lib/server/reports/nl-page';

export const load = (async (event) => {
	const [data, nl] = await Promise.all([loadBuilder(event, 'new'), reportNlStatus(event)]);
	const audience = data.result ? await loadAudience(getDB(event), data.spec, reportViewer(event), null) : null;
	return { ...data, audience, nl, wideLayout: true as const };
}) satisfies PageServerLoad;

export const actions = {
	save: saveReportAction,
	saveAs: saveAsReportAction,
	saveSegment: audienceAction('segment'),
	saveList: audienceAction('list'),
	addTag: audienceAction('tag'),
	removeTag: audienceAction('untag'),
	describe: (event) => describeReportAction(event)
} satisfies Actions;
