import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { sessionSecret } from '$lib/server/token';
import { signVisitorId, verifyVisitorToken } from '$lib/server/track-token';
import {
	corsHeaders,
	findSiteByKey,
	originAllowed,
	originAllowedForAnySite,
	privacyOrPrefetch
} from '$lib/server/site-tracking';

/**
 * Site tracking identify (#151). The snippet on a tracking site posts the `dsv=` token it
 * found in the landing URL; we answer with a signed visitor id (`{ id }`) that the snippet
 * keeps in the SITE's localStorage and sends with every beacon. No cookie: a Worker on the
 * app's domain can't set one for the site's domain.
 *
 * 404 unknown/disabled site_key · 403 Origin not in the site's list · 401 bad/expired
 * token · 204 (no id) when the visitor sent DNT/GPC or the contact opted out.
 */
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	const origin = event.request.headers.get('origin');

	let body: Record<string, unknown>;
	try {
		const parsed = JSON.parse(await event.request.text());
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
		body = parsed as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON' }, { status: 400 });
	}

	const site = await findSiteByKey(db, body.site_key);
	if (!site) return json({ error: 'unknown site' }, { status: 404 });
	if (!originAllowed(site, origin)) return json({ error: 'origin not allowed' }, { status: 403 });
	const cors = corsHeaders(origin!);

	if (privacyOrPrefetch(event.request.headers)) return new Response(null, { status: 204, headers: cors });

	const secret = sessionSecret(event.platform?.env);
	const tok = await verifyVisitorToken(secret, typeof body.token === 'string' ? body.token : null);
	if (!tok) return json({ error: 'invalid token' }, { status: 401, headers: cors });

	const contact = await db
		.prepare('SELECT id, tracking_optout FROM contacts WHERE id = ?')
		.bind(tok.c)
		.first<{ id: number; tracking_optout: number }>();
	if (!contact) return json({ error: 'invalid token' }, { status: 401, headers: cors });
	if (contact.tracking_optout) return new Response(null, { status: 204, headers: cors });

	const id = await signVisitorId(secret, { c: contact.id, s: site.id });
	return json({ id }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
};

export const OPTIONS: RequestHandler = async (event) => {
	const origin = event.request.headers.get('origin');
	if (!(await originAllowedForAnySite(getDB(event), origin))) return new Response(null, { status: 403 });
	return new Response(null, { status: 204, headers: corsHeaders(origin!) });
};
