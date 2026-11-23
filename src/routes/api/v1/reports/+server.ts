import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { apiData, requireKey } from '$lib/server/api-v1';
import { reportCatalog } from '$lib/server/reports/access';
import { API_VIEWER } from '$lib/server/reports/api';

// GET /api/v1/reports (#358, read scope) — the built-in library (`builtin:<key>`, with
// params) and every saved report (numeric id). Runs as a member: built-ins that are
// admin-only are left out, and saved reports that need an admin are flagged `admin_only`.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	const reports = await reportCatalog(getDB(event), API_VIEWER);
	const folder = event.url.searchParams.get('folder')?.trim().toLowerCase();
	return apiData(folder ? reports.filter((r) => r.folder.toLowerCase() === folder) : reports);
};
