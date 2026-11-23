import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError } from '$lib/server/api-v1';
import { getCompany } from '$lib/server/companies';
import { companyMetrics } from '$lib/server/company-metrics';

// GET /api/v1/companies/:id/metrics (#170) — the company's Timing + GitHub rollup (read
// scope). Every field is present; null = never synced (or no project/repo attached).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) return apiError(400, 'Invalid company id.');

	const db = getDB(event);
	if (!(await getCompany(db, id))) return apiError(404, 'Company not found.');
	return apiData(await companyMetrics(db, id));
};
