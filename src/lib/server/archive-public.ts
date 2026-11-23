// #491: the newsletter archive on a public host (example.com/newsletter), with no link back
// to the CRM. Modelled on Settings → Domain (#120, public-url.ts).
//
// app_state keys (no migration):
//   archive_public_host        bare hostname, e.g. example.com
//   archive_public_status      JSON { ok, code, checkedAt, host, error?, via? } — last Test connection
//                              (via: 'browser' = checked from the admin's browser, #495)
//   archive_public_redirect    '1' = 301 CRM-host /newsletter* to the public host
//   archive_proxy_secret_hash  SHA-256 hex of the "Other hosts" proxy secret (shown once)
//
// A request is in **public mode** when it arrives on the public host (the Workers route in
// wrangler.jsonc) or carries `X-Archive-Proxy-Secret` matching the stored hash (nginx, Vercel,
// CloudFront…). In public mode only /newsletter and /newsletter/* are served, the pages use
// the public host for every absolute URL, and `publicizeHtml` rewrites what's left.

import { sha256Hex } from './api-keys';
import { publicBaseUrl, publicBaseUrlFor, validateHostname, type HostnameResult } from './public-url';
import { getBrandKit } from './brand-kit';
import { ARCHIVE_PATH } from '$lib/newsletter-archive';

export const PROXY_SECRET_HEADER = 'X-Archive-Proxy-Secret';
export const SOURCE_HEADER = 'X-Archive-Source';
/** Hosts whose Workers routes (wrangler.jsonc `routes`) send /newsletter* to this Worker, from
 *  the comma-separated ARCHIVE_ROUTE_HOSTS var (#596; unset = none). Keep the var in step with
 *  `routes`: a request on one of them is never served the app, and gets the archive only once
 *  Settings has that host saved. */
export function archiveRouteHosts(env: unknown): string[] {
	return String((env as { ARCHIVE_ROUTE_HOSTS?: unknown } | null | undefined)?.ARCHIVE_ROUTE_HOSTS ?? '')
		.split(',')
		.map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
		.filter(Boolean);
}

const CACHE_TTL_MS = 30_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type ArchivePublicStatus = {
	ok: boolean;
	code: number | null;
	checkedAt: string;
	host: string;
	error?: string;
	/** #495: set when the result came from the admin's browser (`recordPublicTest`). */
	via?: 'browser';
};
export type ArchivePublicConfig = {
	host: string | null;
	redirect: boolean;
	status: ArchivePublicStatus | null;
	secretHash: string | null;
};
const EMPTY: ArchivePublicConfig = { host: null, redirect: false, status: null, secretHash: null };

function parseStatus(raw: string | null | undefined): ArchivePublicStatus | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' && typeof v.ok === 'boolean' ? (v as ArchivePublicStatus) : null;
	} catch {
		return null;
	}
}

export async function readArchivePublicConfig(db: D1Database): Promise<ArchivePublicConfig> {
	const rows = await db
		.prepare(
			`SELECT key, value FROM app_state WHERE key IN ('archive_public_host', 'archive_public_status', 'archive_public_redirect', 'archive_proxy_secret_hash')`
		)
		.all<{ key: string; value: string | null }>();
	const v = new Map(rows.results.map((r) => [r.key, r.value]));
	return {
		host: v.get('archive_public_host')?.trim().toLowerCase() || null,
		redirect: v.get('archive_public_redirect') === '1',
		status: parseStatus(v.get('archive_public_status')),
		secretHash: v.get('archive_proxy_secret_hash')?.trim() || null
	};
}

const cache = new Map<object, { at: number; value: Promise<ArchivePublicConfig> }>();

/** Cached `readArchivePublicConfig` (per isolate, 30 s). A failed read is "nothing set". */
export function archivePublicConfig(db: D1Database | null | undefined): Promise<ArchivePublicConfig> {
	if (!db) return Promise.resolve(EMPTY);
	const hit = cache.get(db);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
	const value = readArchivePublicConfig(db).catch(() => {
		cache.delete(db);
		return EMPTY;
	});
	cache.set(db, { at: Date.now(), value });
	return value;
}

export function clearArchivePublicCache(db?: D1Database | null) {
	if (db) cache.delete(db);
	else cache.clear();
}

export const isArchivePath = (path: string) => path === ARCHIVE_PATH || path.startsWith(ARCHIVE_PATH + '/');

// ── Public mode (hooks.server.ts) ────────────────────────────────────────────────────

export type ArchiveRequestMode =
	/** Serve the archive for the public host; `base` = https://<public host>. */
	| { kind: 'public'; base: string }
	/** A public-host / proxied request for a path that isn't the archive (or the host isn't set up). */
	| { kind: 'blocked' }
	/** A normal CRM request. */
	| { kind: 'crm' };

/** Decide how hooks treat this request. Never reads a header to pick the base. */
export async function archiveRequestMode(
	url: URL,
	headers: Headers,
	cfg: ArchivePublicConfig,
	routeHosts: string[] = []
): Promise<ArchiveRequestMode> {
	const host = url.hostname.toLowerCase();
	const onPublicHost = !!cfg.host && host === cfg.host;
	const onRouteHost = routeHosts.includes(host);
	const secret = headers.get(PROXY_SECRET_HEADER);
	const bySecret = !!secret && !!cfg.secretHash && !!cfg.host && (await sha256Hex(secret)) === cfg.secretHash;
	if (!onPublicHost && !onRouteHost && !bySecret) return { kind: 'crm' };
	if (!cfg.host || !(onPublicHost || bySecret) || !isArchivePath(url.pathname)) return { kind: 'blocked' };
	return { kind: 'public', base: `https://${cfg.host}` };
}

/** CRM host → public host 301 for GET/HEAD /newsletter*, when the redirect is on. Never in
 *  public mode, never on the public host itself or localhost. */
export function archiveRedirectTarget(url: URL, method: string, cfg: ArchivePublicConfig, publicMode: boolean): string | null {
	if (publicMode || !cfg.redirect || !cfg.host) return null;
	if (method !== 'GET' && method !== 'HEAD') return null;
	const host = url.hostname.toLowerCase();
	if (host === cfg.host || LOCAL_HOSTS.has(host)) return null;
	if (!isArchivePath(url.pathname)) return null;
	return `https://${cfg.host}${url.pathname}${url.search}`;
}

// ── Rewriting ────────────────────────────────────────────────────────────────────────

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/**
 * Point every CRM URL in a public page / feed at the public host:
 *   <crmBase>/img/         → <publicBase>/newsletter/img/
 *   <crmBase>/newsletter   → <publicBase>/newsletter
 *   <publicBase>/img/      → <publicBase>/newsletter/img/   (the logo, built from the origin)
 *   root-relative /img/    → /newsletter/img/               (template blocks)
 * `crmBase` may be several origins (Settings → Domain and the wrangler var).
 */
export function publicizeHtml(html: string, crmBase: string | string[], publicBase: string): string {
	const pub = trimSlash(publicBase);
	let out = html;
	const crms = [...new Set((Array.isArray(crmBase) ? crmBase : [crmBase]).map(trimSlash).filter((b) => b && b !== pub))];
	for (const crm of crms) {
		out = out.replace(new RegExp(`${escRe(crm)}/img/`, 'gi'), `${pub}${ARCHIVE_PATH}/img/`);
		out = out.replace(new RegExp(`${escRe(crm)}${ARCHIVE_PATH}(?=[/?#"'<\\s&)]|$)`, 'gi'), `${pub}${ARCHIVE_PATH}`);
	}
	out = out.replace(new RegExp(`${escRe(pub)}/img/`, 'gi'), `${pub}${ARCHIVE_PATH}/img/`);
	// Root-relative: `/img/` not preceded by a host or path character.
	out = out.replace(/(^|[^\w.:/%-])\/img\//g, `$1${ARCHIVE_PATH}/img/`);
	return out;
}

// ── Settings writes ──────────────────────────────────────────────────────────────────

async function put(db: D1Database, key: string, value: string) {
	await db
		.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(key, value)
		.run();
}

/** validateHostname, plus: not the CRM's own host. */
export function validatePublicHost(raw: unknown, crmBases: string[]): HostnameResult {
	const v = validateHostname(raw);
	if (!v.ok) return v;
	for (const b of crmBases) {
		try {
			if (b && new URL(b).hostname.toLowerCase() === v.hostname) {
				return { ok: false, error: `${v.hostname} is the CRM's own address. Enter the website's hostname, e.g. example.com.` };
			}
		} catch {
			/* not a URL */
		}
	}
	return v;
}

/** Store the host. A change resets the status and turns the redirect off. */
export async function savePublicHost(db: D1Database, hostname: string) {
	const current = await readArchivePublicConfig(db);
	if (current.host === hostname) return;
	await db.batch([
		db.prepare(`INSERT INTO app_state (key, value) VALUES ('archive_public_host', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(hostname),
		db.prepare(`DELETE FROM app_state WHERE key IN ('archive_public_status', 'archive_public_redirect')`)
	]);
	clearArchivePublicCache(db);
}

/** Drop the host, its status and the redirect (the proxy secret stays until removed). */
export async function clearPublicHost(db: D1Database) {
	await db.prepare(`DELETE FROM app_state WHERE key IN ('archive_public_host', 'archive_public_status', 'archive_public_redirect')`).run();
	clearArchivePublicCache(db);
}

/** Turning the redirect on needs a passing Test connection for the current host. */
export async function setArchiveRedirect(db: D1Database, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
	if (on) {
		const cfg = await readArchivePublicConfig(db);
		if (!cfg.host) return { ok: false, error: 'Save a public address first.' };
		if (!cfg.status?.ok || cfg.status.host !== cfg.host) {
			return { ok: false, error: `Run Test connection and get a pass for ${cfg.host} before turning the redirect on.` };
		}
		await put(db, 'archive_public_redirect', '1');
	} else {
		await db.prepare(`DELETE FROM app_state WHERE key = 'archive_public_redirect'`).run();
	}
	clearArchivePublicCache(db);
	return { ok: true };
}

/** GET https://<host>/newsletter/feed.xml from the Worker. Pass = 200 + `X-Archive-Source: crm`.
 *  #495: `.xml` is edge-cacheable by default, so the URL gets a `?t=<ms>` cache-buster and the
 *  fetch is `no-store` — a 404 cached before the address was saved is never read back. */
export async function testPublicConnection(
	db: D1Database,
	hostname: string,
	fetcher: typeof fetch = fetch,
	now = new Date()
): Promise<ArchivePublicStatus> {
	let status: ArchivePublicStatus;
	try {
		const res = await fetcher(`https://${hostname}${ARCHIVE_PATH}/feed.xml?t=${now.getTime()}`, {
			method: 'GET',
			cache: 'no-store',
			headers: { 'cache-control': 'no-cache' },
			redirect: 'manual',
			signal: AbortSignal.timeout(8000)
		});
		const fromCrm = res.headers.get(SOURCE_HEADER) === 'crm';
		status = { ok: res.status === 200 && fromCrm, code: res.status, checkedAt: now.toISOString(), host: hostname };
		if (res.status === 200 && !fromCrm) status.error = 'The page answered, but not from the CRM (no X-Archive-Source header).';
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		status = { ok: false, code: null, checkedAt: now.toISOString(), host: hostname, error: msg.slice(0, 200) };
	}
	await put(db, 'archive_public_status', JSON.stringify(status));
	clearArchivePublicCache(db);
	return status;
}

/** #495: store a Test connection result the admin's browser got (the Worker's own fetch of
 *  its public route can fall through to the website's origin). Same shape as
 *  `testPublicConnection`, plus `via: 'browser'`, so it gates the redirect the same way. */
export async function recordBrowserTest(
	db: D1Database,
	hostname: string,
	result: { ok: boolean; code: number | null },
	now = new Date()
): Promise<ArchivePublicStatus> {
	const status: ArchivePublicStatus = { ok: result.ok, code: result.code, checkedAt: now.toISOString(), host: hostname, via: 'browser' };
	await put(db, 'archive_public_status', JSON.stringify(status));
	clearArchivePublicCache(db);
	return status;
}

/** #495: CORS headers for the public feed only (public mode, exactly /newsletter/feed.xml), so
 *  the CRM page can read its status and `X-Archive-Source` from the browser. `crmBase` = the
 *  CRM's public base URL; nothing when it isn't a URL. */
export function feedCorsHeaders(pathname: string, crmBase: string): Record<string, string> {
	if (pathname !== `${ARCHIVE_PATH}/feed.xml`) return {};
	let origin: string;
	try {
		origin = new URL(crmBase).origin;
	} catch {
		return {};
	}
	if (!origin || origin === 'null') return {};
	return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': SOURCE_HEADER };
}

/** A new proxy secret: stores only its SHA-256 and returns the plaintext once. Replaces any old one. */
export async function rotateProxySecret(db: D1Database): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const secret = `aps_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
	await put(db, 'archive_proxy_secret_hash', await sha256Hex(secret));
	clearArchivePublicCache(db);
	return secret;
}

export async function removeProxySecret(db: D1Database) {
	await db.prepare(`DELETE FROM app_state WHERE key = 'archive_proxy_secret_hash'`).run();
	clearArchivePublicCache(db);
}

/** Copy-paste snippets for the "Other hosts" panel. `secret` = the plaintext when just shown,
 *  else a placeholder. */
export function proxySnippets(crmBase: string, secret: string | null): { nginx: string; vercel: string; cloudfront: string } {
	const s = secret ?? '<your proxy secret>';
	const crm = trimSlash(crmBase);
	const crmHost = (() => {
		try {
			return new URL(crm).hostname;
		} catch {
			return crm;
		}
	})();
	return {
		nginx: `location /newsletter {
    proxy_pass ${crm};
    proxy_set_header Host ${crmHost};
    proxy_set_header ${PROXY_SECRET_HEADER} "${s}";
    proxy_ssl_server_name on;
}`,
		vercel: `// vercel.json — Vercel rewrites can't add request headers, so put the secret
// in a middleware or Edge function that forwards to the CRM; the route is:
{
  "rewrites": [
    { "source": "/newsletter", "destination": "${crm}/newsletter" },
    { "source": "/newsletter/:path*", "destination": "${crm}/newsletter/:path*" }
  ]
}
// header to add on the forwarded request: ${PROXY_SECRET_HEADER}: ${s}`,
		cloudfront: `Origin: ${crmHost} (HTTPS only)
  Custom header: ${PROXY_SECRET_HEADER} = ${s}
Behaviours (both → that origin, cache policy CachingOptimized, all query strings forwarded):
  /newsletter
  /newsletter/*`
	};
}

// ── Route context ────────────────────────────────────────────────────────────────────

/** Every CRM origin that may sit in a stored body: Settings → Domain / PUBLIC_BASE_URL, the
 *  wrangler var itself, and the host of the brand kit's logos served from this app's
 *  `/img/` (#595: the kit replaced the bundled logo list). */
export async function crmBases(db: D1Database | null | undefined, env: { PUBLIC_BASE_URL?: string } | null | undefined): Promise<string[]> {
	const out = [await publicBaseUrl(db, env), env?.PUBLIC_BASE_URL ?? ''];
	for (const l of (await getBrandKit(db)).logos) {
		try {
			const u = new URL(l.src);
			if (u.pathname.startsWith('/img/')) out.push(u.origin);
		} catch {
			/* skip */
		}
	}
	return [...new Set(out.map(trimSlash).filter(Boolean))];
}

/** The archive routes' render context: the public host in public mode, else as before. */
export async function archivePageCtx(event: {
	platform?: App.Platform;
	url: URL;
	locals?: App.Locals;
}): Promise<{ base: string; origin: string; publicMode?: boolean; crmBase?: string[] }> {
	const pub = event.locals?.archivePublic;
	if (pub) {
		return { base: pub.base, origin: pub.base, publicMode: true, crmBase: await crmBases(event.platform?.env?.DB, event.platform?.env) };
	}
	return { base: await publicBaseUrlFor(event), origin: event.url.origin };
}
