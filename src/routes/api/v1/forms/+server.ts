import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { listFormsForApi } from '$lib/server/forms-api';
import { publicBaseUrlFor } from '$lib/server/public-url';

const STATUSES = ['draft', 'published', 'archived'] as const;
type Status = (typeof STATUSES)[number];

// GET /api/v1/forms (#620) — forms, newest edit first (read scope). Each: id, name, slug, status,
// version, url (published only), fields (key, type, label, required), pages, submissions
// (accepted only), last_submission_at, published_at, updated_at. Archived forms are left out
// unless `?include_archived=1` (or `?status=archived`). Paging: limit (default 50, max 200), offset.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const sp = event.url.searchParams;
	const status = sp.get('status');
	if (status && !(STATUSES as readonly string[]).includes(status)) return apiError(400, 'status must be draft, published or archived.');
	const includeArchived = status === 'archived' || sp.get('include_archived') === '1' || sp.get('include_archived') === 'true';
	const { limit, offset } = parsePaging(event.url);
	const all = await listFormsForApi(getDB(event), await publicBaseUrlFor(event), {
		includeArchived,
		status: status ? (status as Status) : null
	});
	return apiData(all.slice(offset, offset + limit), buildPagination(limit, offset, all.length));
};
