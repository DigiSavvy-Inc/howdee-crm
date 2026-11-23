import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { sessionSecret } from '$lib/server/token';
import { verifyVisitorId } from '$lib/server/track-token';
import { markDirty } from '$lib/server/engagement';
import { fireSiteVisitTriggers } from '$lib/server/site-trigger';
import { fireSiteActivityTriggers } from '$lib/server/site-activity-trigger';
import {
	corsHeaders,
	findSiteByKey,
	isBotUserAgent,
	occurredAt,
	originAllowed,
	originAllowedForAnySite,
	overDbRateLimit,
	privacyOrPrefetch,
	sanitizeBeacon,
	sqlTime,
	takeRateToken
} from '$lib/server/site-tracking';

/**
 * Site tracking beacon (#151). Body `{ site_key, id, kind, name, path, title, referrer,
 * utm, props, ts }` (JSON; `text/plain` works too so `sendBeacon` needs no preflight).
 * The visitor id may also come in the `X-DSV-Id` header.
 *
 * 400 bad JSON · 404 unknown/disabled site_key · 403 Origin not allowed · 429 rate
 * limited. Everything else answers 204 whether or not a row was stored: no valid id
 * (v1 is known contacts only), opted-out contact, DNT/GPC, bot UA, prefetch, invalid
 * kind/name, or a duplicate pageview (same contact + path within 10 s).
 */
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	const headers = event.request.headers;
	const origin = headers.get('origin');

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
	const done = () => new Response(null, { status: 204, headers: cors });

	if (!takeRateToken(site.site_key)) return json({ error: 'rate limited' }, { status: 429, headers: cors });

	if (privacyOrPrefetch(headers) || isBotUserAgent(headers.get('user-agent'))) return done();

	const rawId = typeof body.id === 'string' && body.id ? body.id : headers.get('x-dsv-id');
	const visitor = await verifyVisitorId(sessionSecret(event.platform?.env), rawId);
	if (!visitor || visitor.s !== site.id) return done();

	const input = sanitizeBeacon(body);
	if (!input) return done();

	const contact = await db
		.prepare('SELECT tracking_optout FROM contacts WHERE id = ?')
		.bind(visitor.c)
		.first<{ tracking_optout: number }>();
	if (!contact || contact.tracking_optout) return done();

	if (await overDbRateLimit(db, site.id)) return json({ error: 'rate limited' }, { status: 429, headers: cors });

	const at = occurredAt(body.ts);
	if (input.kind === 'pageview') {
		const t = Date.parse(at.replace(' ', 'T') + 'Z');
		const dup = await db
			.prepare(
				`SELECT 1 FROM site_events
				 WHERE contact_id = ? AND site_id = ? AND kind = 'pageview' AND path IS ?
				   AND occurred_at BETWEEN ? AND ? LIMIT 1`
			)
			.bind(visitor.c, site.id, input.path, sqlTime(t - 10_000), sqlTime(t + 10_000))
			.first();
		if (dup) return done();
	}

	const cf = (event.request as Request & { cf?: { country?: unknown } }).cf;
	const rawCountry = typeof cf?.country === 'string' ? cf.country : headers.get('cf-ipcountry');
	const country = rawCountry && /^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : null;

	await db.batch([
		db
			.prepare(
				`INSERT INTO site_events (site_id, contact_id, kind, name, path, title, referrer_host, utm, props, country, occurred_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				site.id,
				visitor.c,
				input.kind,
				input.name,
				input.path,
				input.title,
				input.referrer_host,
				input.utm,
				input.props,
				country,
				at
			),
		db.prepare(`UPDATE tracking_sites SET last_event_at = datetime('now') WHERE id = ?`).bind(site.id)
	]);

	try {
		await markDirty(db, [visitor.c]);
	} catch (e) {
		console.error('site tracking markDirty failed:', e);
	}
	// #154: "Visits a page" automation triggers — best-effort, never fails the beacon.
	if (input.kind === 'pageview') {
		try {
			await fireSiteVisitTriggers(db, { siteId: site.id, contactId: visitor.c, path: input.path });
		} catch (e) {
			console.error('site_visit trigger failed:', e);
		}
		// #434: "Visits the site often" — counts include this (already stored) pageview.
		try {
			await fireSiteActivityTriggers(db, { siteId: site.id, contactId: visitor.c, path: input.path });
		} catch (e) {
			console.error('site_activity trigger failed:', e);
		}
	}
	return done();
};

export const OPTIONS: RequestHandler = async (event) => {
	const origin = event.request.headers.get('origin');
	if (!(await originAllowedForAnySite(getDB(event), origin))) return new Response(null, { status: 403 });
	return new Response(null, { status: 204, headers: corsHeaders(origin!) });
};
