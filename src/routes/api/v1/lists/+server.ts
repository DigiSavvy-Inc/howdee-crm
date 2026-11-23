import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { listGroupsForApi } from '$lib/server/group-archive';

// GET /api/v1/lists (#472) — lists and segments (read scope), by name. Each carries
// `archived_at` (null = active). Archived ones are left out unless `?include_archived=1`.
// Filters: kind (list | segment), q (name contains). Paging: limit (default 50, max 200), offset.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const sp = event.url.searchParams;
	const kind = sp.get('kind');
	if (kind && kind !== 'list' && kind !== 'segment') return apiError(400, 'kind must be list or segment.');
	const { limit, offset } = parsePaging(event.url);
	const res = await listGroupsForApi(getDB(event), {
		kind: kind as 'list' | 'segment' | null,
		q: sp.get('q') ?? '',
		includeArchived: sp.get('include_archived') === '1' || sp.get('include_archived') === 'true',
		limit,
		offset
	});
	return apiData(res.rows, buildPagination(limit, offset, res.total));
};
