import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiData, apiError, parsePaging, buildPagination } from '$lib/server/api-v1';
import { createCompany, getCompany, listCompanies, serializeCompany } from '$lib/server/companies';

// GET /api/v1/companies (#166) — list companies (read scope), ordered by name.
// Filters: q (name or domain contains). Paging: limit (default 50, max 200), offset.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const { limit, offset } = parsePaging(event.url);
	const q = event.url.searchParams.get('q') ?? '';
	const res = await listCompanies(getDB(event), { q, limit, offset });
	return apiData(res.rows.map(serializeCompany), buildPagination(limit, offset, res.total));
};

// POST /api/v1/companies — create (read_write scope). `name` required (unique,
// case-insensitive → 409 with conflict_id); optional domain/website/notes. 201 + the company.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return apiError(400, 'Invalid JSON body.');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return apiError(400, 'Body must be a JSON object.');
	}

	const db = getDB(event);
	const res = await createCompany(db, body as Record<string, unknown>);
	if (!res.ok) {
		if (res.error === 'exists') {
			return json({ error: 'A company with this name already exists.', conflict_id: res.id }, { status: 409 });
		}
		return apiError(400, 'name is required.');
	}
	return json({ data: serializeCompany((await getCompany(db, res.id))!) }, { status: 201 });
};
