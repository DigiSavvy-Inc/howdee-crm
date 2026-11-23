import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError, apiData } from '$lib/server/api-v1';
import { deleteDraft, parseDraftPatch, updateDraft } from '$lib/server/campaign-drafts';
import { getCampaign, apiBaseUrl } from '$lib/server/campaigns-api';

function parseId(raw: string | undefined): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/v1/campaigns/:id (#252, read) — the full record; a sent campaign adds `stats`.
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid id.');
	const c = await getCampaign(getDB(event), id, await apiBaseUrl(event));
	if (!c) return apiError(404, 'No campaign with that id.');
	return apiData(c);
};

// PATCH /api/v1/campaigns/:id (#252) — edit a DRAFT (read_write or campaigns:draft key).
// Anything that isn't a draft is 409. Never sends or schedules: scheduled_at is stored as
// the intended time and the row stays a draft.
export const PATCH: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'campaigns:draft');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid id.');

	let raw: unknown;
	try {
		raw = await event.request.json();
	} catch {
		return apiError(400, 'Body must be valid JSON.');
	}
	const patch = parseDraftPatch(raw);
	if ('error' in patch) return apiError(400, patch.error);

	const db = getDB(event);
	const res = await updateDraft(db, id, patch);
	if (!res.ok) return apiError(res.status, res.error);
	return apiData(await getCampaign(db, id, await apiBaseUrl(event)));
};

// DELETE /api/v1/campaigns/:id (#238) — remove a zero-recipient DRAFT only. Sent,
// scheduled or sending campaigns are never touched (404). read_write keys only:
// a campaigns:draft key cannot delete (403).
export const DELETE: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;
	const id = parseId(event.params.id);
	if (!id) return apiError(400, 'Invalid id.');
	if (!(await deleteDraft(getDB(event), id))) return apiError(404, 'No zero-recipient draft with that id.');
	return new Response(null, { status: 204 });
};
