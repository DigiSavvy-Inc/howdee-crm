// #154: site tracking in the Data API — the shared row shape for
// GET /api/v1/contacts/:id/site-activity and GET /api/v1/site-events, the `site` lookup they
// and POST /api/track/server share, and the server-to-server event writer.

import { parseJson } from './api-v1';
import { cleanProps, cleanText, sqlTime } from './site-tracking';
import { markDirty } from './engagement';

export type SiteEventApiRow = {
	id: number;
	site_id: number;
	site_name: string | null;
	site_domain: string | null;
	contact_id: number;
	email: string | null;
	kind: string;
	name: string;
	path: string | null;
	title: string | null;
	referrer_host: string | null;
	utm: string | null;
	props: string | null;
	country: string | null;
	occurred_at: string;
	received_at: string;
};

export const SITE_EVENT_SELECT = `SELECT se.id, se.site_id, ts.name AS site_name, ts.domain AS site_domain, se.contact_id,
	        ct.email, se.kind, se.name, se.path, se.title, se.referrer_host, se.utm, se.props, se.country,
	        se.occurred_at, se.received_at
	 FROM site_events se
	 LEFT JOIN tracking_sites ts ON ts.id = se.site_id
	 LEFT JOIN contacts ct ON ct.id = se.contact_id`;

export function serializeSiteEvent(r: SiteEventApiRow) {
	return {
		id: r.id,
		site: { id: r.site_id, name: r.site_name, domain: r.site_domain },
		contact_id: r.contact_id,
		email: r.email,
		kind: r.kind,
		name: r.name,
		path: r.path,
		title: r.title,
		referrer_host: r.referrer_host,
		utm: parseJson(r.utm),
		props: parseJson(r.props),
		country: r.country,
		occurred_at: r.occurred_at,
		received_at: r.received_at
	};
}

/** `site` = numeric id, domain (www. ignored), site name, or site_key → the site id, or null. */
export async function resolveSiteParam(db: D1Database, raw: unknown): Promise<number | null> {
	if (typeof raw === 'number') raw = String(raw);
	if (typeof raw !== 'string' || !raw.trim()) return null;
	const v = raw.trim();
	if (/^\d+$/.test(v)) {
		const r = await db.prepare('SELECT id FROM tracking_sites WHERE id = ?').bind(Number(v)).first<{ id: number }>();
		return r?.id ?? null;
	}
	const host = v.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
	const r = await db
		.prepare(
			`SELECT id FROM tracking_sites WHERE site_key = ? OR LOWER(domain) = ? OR name = ? COLLATE NOCASE
			 ORDER BY enabled DESC, id LIMIT 1`
		)
		.bind(v, host, v)
		.first<{ id: number }>();
	return r?.id ?? null;
}

/** API `since`/`until`: an ISO-8601 string or a `YYYY-MM-DD[ HH:MM:SS]` → stored-format UTC. */
export function parseApiTime(raw: string | null | undefined): string | null | undefined {
	if (raw == null || !raw.trim()) return undefined;
	const v = raw.trim();
	if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(v)) return v.length === 10 ? `${v} 00:00:00` : v;
	const t = Date.parse(v);
	return Number.isFinite(t) ? sqlTime(t) : null;
}

// ---- POST /api/track/server -------------------------------------------------------------

export const SERVER_EVENT_MAX_AGE_DAYS = 180; // same as the prune window — older rows would just be deleted

export type ServerEventResult =
	| { status: 201; id: number; contact_id: number; site_id: number; occurred_at: string }
	| { status: 200; stored: false; reason: 'tracking_optout'; contact_id: number }
	| { status: 400 | 404; error: string };

/**
 * A server-side custom event (WooCommerce order, booking, …) for an EXISTING contact,
 * resolved by `contact_id` or `email` — never creates one. Stored as `kind='event'` exactly
 * like a beacon event, so the contact timeline, segment `event` rules and the `visited`
 * Condition see it. `site` is optional when exactly one site is enabled (else required).
 * A contact who opted out of tracking is acknowledged (200) but nothing is stored.
 */
export async function recordServerEvent(
	db: D1Database,
	body: Record<string, unknown>,
	now: Date = new Date()
): Promise<ServerEventResult> {
	const name = cleanText(body.name, 100);
	if (!name) return { status: 400, error: '`name` is required (≤ 100 chars).' };

	let props: string | null = null;
	if (body.props !== undefined && body.props !== null) {
		const p = body.props;
		const isObject = typeof p === 'object' && !Array.isArray(p);
		props = isObject ? cleanProps(p) : null; // {} → null (no props)
		if (!isObject || (!props && Object.keys(p as object).length > 0)) {
			return { status: 400, error: '`props` must be a JSON object of at most 2 KB.' };
		}
	}

	let at = sqlTime(now.getTime());
	if (body.occurred_at !== undefined && body.occurred_at !== null && body.occurred_at !== '') {
		const raw = body.occurred_at;
		const t = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
		if (!Number.isFinite(t)) return { status: 400, error: '`occurred_at` must be an ISO-8601 time or epoch milliseconds.' };
		if (t > now.getTime() + 300_000) return { status: 400, error: '`occurred_at` is in the future.' };
		if (t < now.getTime() - SERVER_EVENT_MAX_AGE_DAYS * 86_400_000) {
			return { status: 400, error: `\`occurred_at\` is older than ${SERVER_EVENT_MAX_AGE_DAYS} days.` };
		}
		at = sqlTime(Math.min(t, now.getTime()));
	}

	type ContactHit = { id: number; tracking_optout: number };
	let contact: ContactHit | null = null;
	if (body.contact_id !== undefined && body.contact_id !== null) {
		const id = Number(body.contact_id);
		if (!Number.isInteger(id) || id <= 0) return { status: 400, error: 'Invalid `contact_id`.' };
		contact = await db.prepare('SELECT id, tracking_optout FROM contacts WHERE id = ?').bind(id).first<ContactHit>();
	} else if (typeof body.email === 'string' && body.email.trim()) {
		contact = await db
			.prepare('SELECT id, tracking_optout FROM contacts WHERE email = ?')
			.bind(body.email.trim().toLowerCase())
			.first<ContactHit>();
	} else {
		return { status: 400, error: '`email` or `contact_id` is required.' };
	}
	if (!contact) return { status: 404, error: 'Contact not found (server events never create contacts).' };

	let siteId: number | null;
	if (body.site !== undefined && body.site !== null && body.site !== '') {
		siteId = await resolveSiteParam(db, body.site);
		if (!siteId) return { status: 404, error: 'Unknown `site`.' };
	} else {
		const enabled = await db.prepare('SELECT id FROM tracking_sites WHERE enabled = 1 LIMIT 2').all<{ id: number }>();
		if (enabled.results.length !== 1) {
			return { status: 400, error: '`site` is required (id, domain, name or site_key) unless exactly one site is enabled.' };
		}
		siteId = enabled.results[0].id;
	}

	if (contact.tracking_optout) return { status: 200, stored: false, reason: 'tracking_optout', contact_id: contact.id };

	const [ins] = await db.batch([
		db
			.prepare(
				`INSERT INTO site_events (site_id, contact_id, kind, name, props, occurred_at)
				 VALUES (?, ?, 'event', ?, ?, ?) RETURNING id`
			)
			.bind(siteId, contact.id, name, props, at),
		db.prepare(`UPDATE tracking_sites SET last_event_at = datetime('now') WHERE id = ?`).bind(siteId)
	]);
	const id = (ins.results[0] as { id: number }).id;

	try {
		await markDirty(db, [contact.id]);
	} catch (e) {
		console.error('server event markDirty failed:', e);
	}
	return { status: 201, id, contact_id: contact.id, site_id: siteId, occurred_at: at };
}
