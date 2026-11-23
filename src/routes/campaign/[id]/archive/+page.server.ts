import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { MERGE_TAGS } from '$lib/server/email';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { ARCHIVE_PATH } from '$lib/newsletter-archive';
import {
	getArchiveSettings,
	parseIssueNumber,
	resetWebVersion,
	saveWebVersion,
	setIssueNumber,
	webVersionForEditor,
	webVersionFromForm
} from '$lib/server/newsletter-archive';

// #483: edit an issue's web-only version (title, teaser, body) for the newsletter archive. The
// sent email is never changed. Admins only; sent broadcasts only (else 404).

export const load: PageServerLoad = async (event) => {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Only an admin can edit the newsletter archive version.');
	const db = getDB(event);
	const issue = await webVersionForEditor(db, Number(event.params.id));
	if (!issue) throw error(404, 'Only sent broadcasts have a newsletter archive version.');
	const base = await publicBaseUrlFor(event);
	return {
		issue,
		url: issue.slug ? `${base}${ARCHIVE_PATH}/${issue.slug}` : null,
		archiveEnabled: (await getArchiveSettings(db)).enabled,
		mergeTags: MERGE_TAGS
	};
};

export const actions: Actions = {
	save: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Only an admin can edit the newsletter archive version.' });
		const db = getDB(event);
		const id = Number(event.params.id);
		const data = await event.request.formData();
		// #499: the issue number is its own column (not posted = untouched); a bad / taken one saves nothing.
		if (data.has('number')) {
			const num = parseIssueNumber(String(data.get('number') ?? ''));
			if (!num.ok) return fail(400, { error: num.error });
			const set = await setIssueNumber(db, id, num.number);
			if (!set.ok) return fail(set.status, { error: set.error });
		}
		// Only the number changed and there's no web version yet: don't create one.
		if (data.get('web_changed') !== '0') {
			const res = await saveWebVersion(db, id, webVersionFromForm(data));
			if (!res.ok) return fail(res.status, { error: res.error });
		}
		return { saved: true };
	},
	reset: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Only an admin can edit the newsletter archive version.' });
		const db = getDB(event);
		const id = Number(event.params.id);
		if (!(await webVersionForEditor(db, id))) return fail(404, { error: 'Only sent broadcasts have a newsletter archive version.' });
		await resetWebVersion(db, id);
		return { reset: true };
	}
};
