import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { getForm, parseSubmissionFilter, submissionsCsv } from '$lib/server/forms';

/** #509: a form's submissions as CSV (session-gated, ≤ 5,000 rows, the tab's filter). */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) throw error(401, 'Sign in first.');
	const db = getDB(event);
	const form = await getForm(db, Number(event.params.id) || 0);
	if (!form) throw error(404, 'Form not found');
	const csv = await submissionsCsv(db, form, parseSubmissionFilter(event.url.searchParams));
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="form-${form.slug}-submissions.csv"`,
			'cache-control': 'no-store'
		}
	});
};
