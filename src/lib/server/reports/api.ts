// /api/v1/reports (#358) shared bits. API keys carry a scope but no role, so every report
// runs as a member: hours, billing and pipeline value (admin-only in the app) are refused
// with 403 for every key. Validation failures are 400 with the parser's message.

import { ReportError, type ReportViewer } from '$lib/report-spec';
import { apiData, apiError } from '$lib/server/api-v1';
import { capRows } from '$lib/server/reports/access';
import type { ReportResult } from '$lib/server/reports/engine';

export const API_VIEWER: ReportViewer = { role: 'member' };
export const API_ROWS_MAX = 5000;

/** `?limit=` rows to return (default and max {@link API_ROWS_MAX}). */
export function rowLimit(url: URL): number {
	const n = Math.floor(Number(url.searchParams.get('limit')));
	return Number.isFinite(n) && n > 0 ? Math.min(n, API_ROWS_MAX) : API_ROWS_MAX;
}

/** #456: the `?limit=` asked for, or null. A built-in runs with it, so it can raise the built-in's own limit. */
export function requestedLimit(url: URL): number | null {
	const n = Math.floor(Number(url.searchParams.get('limit')));
	return Number.isFinite(n) && n > 0 ? Math.min(n, API_ROWS_MAX) : null;
}

export function resultData(result: ReportResult, max: number, extra: Record<string, unknown> = {}): Response {
	const capped = capRows(result, max);
	return apiData({
		...extra,
		columns: capped.columns,
		rows: capped.rows,
		total: result.total,
		truncated: capped.truncated,
		record_ids: capped.recordIds ?? null
	});
}

/** A ReportError → 403 for an admin-only refusal, else 400; anything else is rethrown. */
export function reportErrorResponse(err: unknown): Response {
	if (err instanceof ReportError) {
		return apiError(err.message.startsWith('Admins only') ? 403 : 400, err.message);
	}
	throw err;
}
