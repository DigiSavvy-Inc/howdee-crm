import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { apiCards, resolveOwner, resolveStage, stageRefFromParam, type CardListFilter } from '$lib/server/pipeline-api';

// GET /api/v1/pipeline/cards — pipeline cards (#207, read scope), ordered by stage position
// then card position. Filters: `stage` (id or name, case-insensitive; unknown → 400),
// `owner` (user id, GitHub login, or `none` = unassigned; unknown → 400). Paged.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const db = getDB(event);
	const { limit, offset } = parsePaging(event.url);
	const filter: CardListFilter = {};

	const stageParam = event.url.searchParams.get('stage')?.trim();
	if (stageParam) {
		const stage = await resolveStage(db, stageRefFromParam(stageParam));
		if (!stage) return apiError(400, 'Unknown stage.');
		filter.stageId = stage.id;
	}
	const ownerParam = event.url.searchParams.get('owner')?.trim();
	if (ownerParam) {
		const owner = await resolveOwner(db, ownerParam);
		if (owner === undefined) return apiError(400, 'Unknown owner.');
		filter.owner = owner;
	}

	const { rows, total } = await apiCards(db, filter, limit, offset);
	return apiData(rows, buildPagination(limit, offset, total));
};
