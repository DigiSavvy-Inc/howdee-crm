import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData } from '$lib/server/api-v1';
import { scoreDefinitions } from '$lib/server/scoring/query';

// GET /api/v1/scores (#467, read scope) — every named score: id, name, slug, description,
// status, decay mode, bands [{label, min}] (highest first) and its rule count.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	return apiData(await scoreDefinitions(getDB(event)));
};
