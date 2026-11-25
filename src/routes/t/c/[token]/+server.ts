// #701: the CRM's click link (docs/sending-providers.md → Open and click tracking by the CRM).
// Public (PUBLIC_PREFIXES), GET only. It redirects only to the destination inside a valid
// signature; a changed, cut or unsigned token is a 400 page that redirects nowhere, so the route
// can't be used as an open redirect. The response says nothing about the contact.
import type { RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { isSafeRedirect, verifyClickToken } from '$lib/server/crm-tracking';
import { recordCrmTrackingEvent } from '$lib/server/crm-tracking-events';

const INVALID_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>This link isn't valid</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2328;line-height:1.5}h1{font-size:1.25rem}</style></head><body><h1>This link isn't valid</h1><p>The link may have been changed or cut short. Try the link in the original email again.</p></body></html>`;

export const GET: RequestHandler = async (event) => {
	const secret = String(event.platform?.env?.SESSION_SECRET ?? '').trim();
	const parsed = await verifyClickToken(secret, event.params.token);
	// The destination is parsed again here: only an http(s) URL already in its normalised, ASCII
	// form goes in `Location` (a header value that would throw or carry raw bytes never does).
	if (!parsed || !isSafeRedirect(parsed.url)) return invalid();

	if (event.request.method === 'GET') {
		try {
			const cf = (event.platform as { cf?: { country?: unknown } } | undefined)?.cf;
			await recordCrmTrackingEvent(getDB(event), {
				trackId: parsed.trackId,
				type: 'click',
				url: parsed.url,
				userAgent: event.request.headers.get('user-agent'),
				country: typeof cf?.country === 'string' ? cf.country : null
			});
		} catch (e) {
			// Never keep the reader from their link.
			console.error('crm click tracking failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
	}
	try {
		return new Response(null, {
			status: 302,
			headers: { location: parsed.url, 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' }
		});
	} catch {
		return invalid();
	}
};

function invalid(): Response {
	return new Response(INVALID_HTML, {
		status: 400,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex',
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
		}
	});
}
