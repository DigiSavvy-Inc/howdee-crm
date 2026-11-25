// #701: the CRM's open pixel (docs/sending-providers.md → Open and click tracking by the CRM).
// Public (PUBLIC_PREFIXES), GET only, answers a 1x1 GIF and nothing about the contact. A token
// whose signature doesn't check is a 400 with no event.
import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { PIXEL_GIF, verifyOpenToken } from '$lib/server/crm-tracking';
import { recordCrmTrackingEvent } from '$lib/server/crm-tracking-events';

const HEADERS = {
	'content-type': 'image/gif',
	'cache-control': 'no-store, no-cache, must-revalidate, private',
	'x-robots-tag': 'noindex'
};

export const GET: RequestHandler = async (event) => {
	const secret = String(event.platform?.env?.SESSION_SECRET ?? '').trim();
	const parsed = await verifyOpenToken(secret, event.params.token);
	if (!parsed) return new Response(null, { status: 400, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

	if (event.request.method === 'GET') {
		try {
			await recordCrmTrackingEvent(getDB(event), {
				trackId: parsed.trackId,
				type: 'open',
				userAgent: event.request.headers.get('user-agent'),
				country: countryOf(event)
			});
		} catch (e) {
			console.error('crm open tracking failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
	}
	return new Response(PIXEL_GIF, { status: 200, headers: HEADERS });
};

function countryOf(event: Parameters<RequestHandler>[0]): string | null {
	const cf = (event.platform as { cf?: { country?: unknown } } | undefined)?.cf;
	return typeof cf?.country === 'string' ? cf.country : null;
}
