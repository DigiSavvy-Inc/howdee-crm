import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData } from '$lib/server/api-v1';
import { apiStages } from '$lib/server/pipeline-api';

// GET /api/v1/pipeline/stages — every pipeline stage by position (#207, read scope):
// { id, name, color, position, kind, card_count, total_value }.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	return apiData(await apiStages(getDB(event)));
};
