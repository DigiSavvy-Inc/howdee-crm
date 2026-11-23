import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { requireKey, apiError } from '$lib/server/api-v1';
import { recordServerEvent } from '$lib/server/site-events-api';

/**
 * Server-to-server site events (#154): `POST /api/track/server` with a **read_write** Data
 * API key (`Authorization: Bearer dk_live_…`) — never the public site key. Body
 * `{ email | contact_id, name, props?, occurred_at?, site? }`. Resolves an existing contact
 * (never creates one) and stores a custom event (`kind='event'`).
 *
 * 201 stored · 200 `{ stored: false }` for an opted-out contact · 400 bad body · 401/403
 * key · 404 unknown contact/site.
 */
export const POST: RequestHandler = async (event) => {
	const gate = await requireKey(event, 'read_write');
	if ('response' in gate) return gate.response;

	let body: unknown;
	try {
		body = JSON.parse(await event.request.text());
	} catch {
		return apiError(400, 'Body must be JSON.');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'Body must be a JSON object.');

	const res = await recordServerEvent(getDB(event), body as Record<string, unknown>);
	if ('error' in res) return apiError(res.status, res.error);
	if (res.status === 200) return json({ data: { stored: false, reason: res.reason, contact_id: res.contact_id } });
	return json(
		{ data: { stored: true, id: res.id, contact_id: res.contact_id, site_id: res.site_id, occurred_at: res.occurred_at } },
		{ status: 201 }
	);
};
