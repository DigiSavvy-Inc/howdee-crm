import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { apiError, requireKey } from '$lib/server/api-v1';
import { runAdHoc } from '$lib/server/reports/access';
import { API_VIEWER, reportErrorResponse, resultData, rowLimit } from '$lib/server/reports/api';

// POST /api/v1/reports/run (#358, read scope — it changes nothing) — body = a report spec
// (or `{ "spec": … }`) → JSON rows. An invalid spec is 400 with the validation message;
// a spec naming hours, billing or pipeline value is 403 (keys run as a member).
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Body must be a JSON report spec.');
	}
	const spec =
		body && typeof body === 'object' && !Array.isArray(body) && 'spec' in body && !('entity' in body)
			? (body as { spec: unknown }).spec
			: body;
	try {
		return resultData(await runAdHoc(getDB(event), spec, API_VIEWER), rowLimit(event.url));
	} catch (err) {
		return reportErrorResponse(err);
	}
};
