import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import {
	requireKey,
	apiData,
	apiError,
	serializeContact,
	CONTACT_GROUPS_SQL,
	type ContactRow
} from '$lib/server/api-v1';
import { getCompany, serializeCompany, updateCompany } from '$lib/server/companies';
import { activeContactSql } from '$lib/server/active-audience';

const MAX_CONTACTS = 500;

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/v1/companies/:id (#166) — one company with its linked contacts (read scope).
// `contacts` is capped at 500 (newest first); `contact_count` is the full count — page the
// rest via GET /api/v1/contacts?company_id=.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid company id.');

	const db = getDB(event);
	const company = await getCompany(db, id);
	if (!company) return apiError(404, 'Company not found.');

	const rows = await db
		.prepare(
			`SELECT c.id, c.email, c.name, c.first_name, c.last_name, c.company, c.company_id, c.subscribed,
			        c.source, c.created_at, c.archived_at, c.meta, ${CONTACT_GROUPS_SQL}
			 FROM contacts c WHERE c.company_id = ? AND ${activeContactSql('c')}
			 ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
		)
		.bind(id, MAX_CONTACTS)
		.all<ContactRow>();

	return apiData({ ...serializeCompany(company), contacts: rows.results.map(serializeContact) });
};

// PATCH /api/v1/companies/:id — partial update (read_write scope). Key-present semantics
// for name/domain/website/notes ("" / null clears; name can't be cleared). A rename also
// rewrites the linked contacts' `company` text. 409 when the new name is taken.
export const PATCH: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	const id = parseId(event.params.id);
	if (id === null) return apiError(400, 'Invalid company id.');

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
	const res = await updateCompany(db, id, body as Record<string, unknown>);
	if (!res.ok) {
		if (res.error === 'not_found') return apiError(404, 'Company not found.');
		if (res.error === 'exists') return json({ error: 'A company with this name already exists.' }, { status: 409 });
		return apiError(400, 'name cannot be empty.');
	}
	return apiData(serializeCompany((await getCompany(db, id))!));
};
