import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData } from '$lib/server/api-v1';
import { engagementSummary } from '$lib/server/engagement-query';

// GET /api/v1/engagement/summary (#114, read scope) — audience-wide engagement: contacts
// per tier, average score, contacts who opened/clicked in the last 30 days, and the
// rollup's last full recompute + pending backlog.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	return apiData(await engagementSummary(getDB(event)));
};
