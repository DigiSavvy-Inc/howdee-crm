import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError, apiData, parsePaging, buildPagination } from '$lib/server/api-v1';
import { parseDraftInput, createDraft, composeUrl } from '$lib/server/campaign-drafts';
import { listCampaigns, apiBaseUrl, CAMPAIGN_STATUSES, type CampaignStatusFilter } from '$lib/server/campaigns-api';

// GET /api/v1/campaigns (#252, read) — newest first, paged; ?status=draft|scheduled|sending|sent, ?q= (subject).
export const GET: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read');
	if ('response' in gate) return gate.response;

	const sp = event.url.searchParams;
	const status = sp.get('status') || undefined;
	if (status && !(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
		return apiError(400, `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}.`);
	}
	const q = sp.get('q')?.trim() || undefined;
	const { limit, offset } = parsePaging(event.url);
	const { rows, total } = await listCampaigns(
		getDB(event),
		{ status: status as CampaignStatusFilter | undefined, q, limit, offset },
		await apiBaseUrl(event)
	);
	return apiData(rows, buildPagination(limit, offset, total));
};

// POST /api/v1/campaigns (#238) — create a Compose DRAFT from { subject, body (markdown) }.
// Never sends, never schedules, sets no recipients. Needs a read_write or campaigns:draft key.
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'campaigns:draft');
	if ('response' in gate) return gate.response;

	let raw: unknown;
	try {
		raw = await event.request.json();
	} catch {
		return apiError(400, 'Body must be valid JSON.');
	}
	const input = parseDraftInput(raw);
	if ('error' in input) return apiError(400, input.error);

	const env = event.platform?.env as Record<string, string> | undefined;
	const id = await createDraft(getDB(event), input, env?.POSTMARK_FROM ?? '');
	return json(
		{ data: { id, status: 'draft', recipient_count: 0, compose_url: composeUrl(await apiBaseUrl(event), id) } },
		{ status: 201 }
	);
};
