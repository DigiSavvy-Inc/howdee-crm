import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { getForm } from '$lib/server/forms';
import { formSubmissionsForApi, parseSince } from '$lib/server/forms-api';

// GET /api/v1/forms/:id/submissions (#620) — a form's accepted submissions (added / updated /
// anonymous; spam and rejected stay in the app), newest first (read scope). Read-only.
// `since` (YYYY-MM-DD or ISO date-time, UTC) = only submissions after it. Paging: limit
// (default 50, max 200), offset. Each: id, form_id, form_version, contact_id, email, status,
// answers, utm, page_url (embedded form: the stored host page, #656; else the referrer), referrer,
// submitted_at (ISO, UTC).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(400, 'Invalid form id.');
	const since = parseSince(event.url.searchParams.get('since'));
	if (since === null) return apiError(400, 'since must be a date (YYYY-MM-DD) or an ISO date-time.');

	const db = getDB(event);
	const form = await getForm(db, id);
	if (!form) return apiError(404, 'Form not found.');
	const { limit, offset } = parsePaging(event.url);
	const res = await formSubmissionsForApi(db, form.id, { since, limit, offset });
	return apiData(res.rows, buildPagination(res.limit, res.offset, res.total));
};
