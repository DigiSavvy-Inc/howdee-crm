import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { apiError, requireKey } from '$lib/server/api-v1';
import { paramSource, parseReportRef, runReportRef } from '$lib/server/reports/access';
import { API_VIEWER, reportErrorResponse, requestedLimit, resultData, rowLimit } from '$lib/server/reports/api';

// GET /api/v1/reports/{id|builtin:key}/run (#358, read scope) — run a saved or built-in
// report → JSON rows. Built-in params come from the query as `p_<key>` or `<key>`;
// `?limit=` caps the rows returned; for a built-in it is also the run's row limit, so it can
// raise the built-in's own limit up to 5000 (#456). Admin-only reports → 403 (keys run as a member).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	const ref = parseReportRef(event.params.ref);
	if (!ref) return apiError(400, 'Report must be a saved report id or builtin:<key>.');
	const query = event.url.searchParams;
	try {
		const ran = await runReportRef(getDB(event), ref, API_VIEWER, paramSource((name) => query.get(name)), new Date(), {
			limit: requestedLimit(event.url)
		});
		if (!ran) return apiError(404, 'Report not found.');
		return resultData(ran.result, rowLimit(event.url), { report: ran.id, name: ran.name });
	} catch (err) {
		return reportErrorResponse(err);
	}
};
