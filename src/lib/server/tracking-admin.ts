// Settings → Tracking (#152): site CRUD helpers, key minting, origin parsing, and the
// "is it receiving?" status query. Ingest/beacon logic stays in site-tracking.ts.

export const SITE_KEY_RE = /^dsv_[0-9a-f]{24}$/;
export const MAX_ORIGINS = 20;
/** "Receiving" = at least one stored event in this window. */
export const STATUS_WINDOW_MINUTES = 10;

/** A public site key: `dsv_` + 24 hex chars (96 random bits). */
export function generateSiteKey(): string {
	const b = new Uint8Array(12);
	crypto.getRandomValues(b);
	return 'dsv_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A bare host (`example.com`, `blog.example.com`) from user input, or null. Accepts a
 *  pasted URL and drops the scheme, path and a leading `www.`. */
export function parseDomain(raw: string): string | null {
	const d = raw
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/[/?#].*$/, '')
		.replace(/^www\./, '');
	if (d.length > 253) return null;
	return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : null;
}

export type OriginsResult = { origins: string[]; invalid: string[] };

/** One origin per line (commas also split). Each must be `http(s)://host[:port]` with no
 *  path; normalised to lowercase without a trailing slash, deduped, capped. */
export function parseOrigins(raw: string): OriginsResult {
	const origins: string[] = [];
	const invalid: string[] = [];
	for (const line of raw.split(/[\n,]+/)) {
		const t = line.trim();
		if (!t) continue;
		let u: URL | null = null;
		try {
			u = new URL(t);
		} catch {
			u = null;
		}
		const pathless = u && u.pathname === '/' && !u.search && !u.hash;
		if (!u || !/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || !pathless) {
			invalid.push(t);
			continue;
		}
		if (!origins.includes(u.origin)) origins.push(u.origin);
	}
	return { origins: origins.slice(0, MAX_ORIGINS), invalid };
}

export type SiteRow = {
	id: number;
	name: string;
	domain: string;
	origins: string;
	site_key: string;
	enabled: number;
	created_at: string;
	last_event_at: string | null;
	events_7d: number;
};

export async function listSites(db: D1Database): Promise<SiteRow[]> {
	const r = await db
		.prepare(
			`SELECT s.id, s.name, s.domain, s.origins, s.site_key, s.enabled, s.created_at, s.last_event_at,
			        (SELECT COUNT(*) FROM site_events e
			          WHERE e.site_id = s.id AND e.occurred_at >= datetime('now', '-7 days')) AS events_7d
			   FROM tracking_sites s
			  ORDER BY s.name COLLATE NOCASE, s.id`
		)
		.all<SiteRow>();
	return r.results;
}

export type SiteInput = { name: string; domain: string; origins: string[] };

/** Validate the add/edit form. Returns the clean values or an error message. */
export function validateSiteForm(data: FormData): { ok: true; value: SiteInput } | { ok: false; error: string } {
	const name = String(data.get('name') ?? '').trim().slice(0, 100);
	if (!name) return { ok: false, error: 'Give the site a name.' };
	const domain = parseDomain(String(data.get('domain') ?? ''));
	if (!domain) return { ok: false, error: 'Enter the site’s domain, e.g. example.com.' };
	const { origins, invalid } = parseOrigins(String(data.get('origins') ?? ''));
	if (invalid.length) {
		return { ok: false, error: `Not a valid origin (use https://host, no path): ${invalid.slice(0, 3).join(', ')}` };
	}
	return { ok: true, value: { name, domain, origins } };
}

export async function addSite(db: D1Database, v: SiteInput): Promise<{ id: number; site_key: string }> {
	const key = generateSiteKey();
	const row = await db
		.prepare(`INSERT INTO tracking_sites (name, domain, origins, site_key) VALUES (?, ?, ?, ?) RETURNING id`)
		.bind(v.name, v.domain, JSON.stringify(v.origins), key)
		.first<{ id: number }>();
	return { id: row!.id, site_key: key };
}

export async function updateSite(db: D1Database, id: number, v: SiteInput): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE tracking_sites SET name = ?, domain = ?, origins = ? WHERE id = ?`)
		.bind(v.name, v.domain, JSON.stringify(v.origins), id)
		.run();
	return (r.meta.changes ?? 0) > 0;
}

export async function setSiteEnabled(db: D1Database, id: number, enabled: boolean): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE tracking_sites SET enabled = ? WHERE id = ?`)
		.bind(enabled ? 1 : 0, id)
		.run();
	return (r.meta.changes ?? 0) > 0;
}

/** New key; the old one stops working at once (snippets using it 404). Visitor ids are
 *  bound to the site id, not the key, so known visitors stay identified. */
export async function rotateSiteKey(db: D1Database, id: number): Promise<string | null> {
	const key = generateSiteKey();
	const r = await db.prepare(`UPDATE tracking_sites SET site_key = ? WHERE id = ?`).bind(key, id).run();
	return (r.meta.changes ?? 0) > 0 ? key : null;
}

export type SiteStatus = {
	receiving: boolean;
	recentCount: number;
	lastEventAt: string | null;
};

/** Events stored for the site in the last STATUS_WINDOW_MINUTES, plus its last event. */
export async function siteStatus(db: D1Database, siteId: number): Promise<SiteStatus | null> {
	const site = await db
		.prepare(`SELECT last_event_at FROM tracking_sites WHERE id = ?`)
		.bind(siteId)
		.first<{ last_event_at: string | null }>();
	if (!site) return null;
	const r = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM site_events
			  WHERE site_id = ? AND received_at >= datetime('now', ?)`
		)
		.bind(siteId, `-${STATUS_WINDOW_MINUTES} minutes`)
		.first<{ n: number }>();
	const n = r?.n ?? 0;
	return { receiving: n > 0, recentCount: n, lastEventAt: site.last_event_at };
}
