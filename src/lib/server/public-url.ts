// Settings → Domain (#120): the app's public origin, operator-set instead of hard-coded.
//
// app_state keys:
//   custom_domain           bare hostname (crm.example.com); unset = env PUBLIC_BASE_URL
//   custom_domain_status    JSON { ok, code, checkedAt, domain, error? } — last Check status
//   custom_domain_redirect  '1' = 301 browser GET/HEAD on any other host to the custom domain
//   public_base_url_seen    #731: the origin the first admin's /setup request arrived on, or the
//                           one an admin chose later with the setup wizard's "Use this address for
//                           links" (which also clears it). Used when neither Settings → Domain nor
//                           PUBLIC_BASE_URL is set, so the built-in clock (whose own origin is
//                           internal) still builds real links. Never written by a page load.
//
// `publicBaseUrl` is the one place unsubscribe links, List-Unsubscribe, hosted pages, media
// URLs, tracking snippets and the URLs shown in Settings get their origin from. The three
// keys are cached per isolate for CACHE_TTL_MS so the hot paths (every request's redirect
// check, every send) don't add a D1 read; saving in Settings clears this isolate's copy and
// other isolates catch up within the TTL.

// #596: the Worker's name and the Cloudflare account come from the WORKER_NAME and
// CF_ACCOUNT_ID vars (wrangler.jsonc) — no built-in values.
const CF_API = 'https://api.cloudflare.com/client/v4';
const CACHE_TTL_MS = 30_000;

export type DomainStatus = { ok: boolean; code: number | null; checkedAt: string; domain: string; error?: string };
export type DomainConfig = { domain: string | null; redirect: boolean; status: DomainStatus | null; seen?: string | null };
export type BaseUrlSource = 'setting' | 'env' | 'seen' | 'request' | 'none';

/** #731: app_state key of the origin recorded at first-run setup. */
export const SEEN_BASE_URL_KEY = 'public_base_url_seen';

type EnvLike =
	| { PUBLIC_BASE_URL?: string; CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string; WORKER_NAME?: string }
	| Partial<Env>
	| null
	| undefined;

/** The Worker this app is deployed as (WORKER_NAME var), '' when unset. */
export function workerName(env: EnvLike): string {
	return String((env as unknown as { WORKER_NAME?: unknown } | null | undefined)?.WORKER_NAME ?? '').trim();
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/**
 * Precedence: setting → env PUBLIC_BASE_URL → the origin seen at setup (#731) → fallback origin.
 * No trailing slash.
 */
export function resolveBaseUrl(
	customDomain: string | null | undefined,
	envBase: string | null | undefined,
	fallbackOrigin?: string | null,
	seen?: string | null
): { url: string; source: BaseUrlSource } {
	const d = customDomain?.trim();
	if (d) return { url: `https://${trimSlash(d)}`, source: 'setting' };
	const e = envBase?.trim();
	if (e) return { url: trimSlash(e), source: 'env' };
	const s = seen?.trim();
	if (s) return { url: trimSlash(s), source: 'seen' };
	const f = fallbackOrigin?.trim();
	if (f) return { url: trimSlash(f), source: 'request' };
	return { url: '', source: 'none' };
}

function parseStatus(raw: string | null | undefined): DomainStatus | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' && typeof v.ok === 'boolean' ? (v as DomainStatus) : null;
	} catch {
		return null;
	}
}

export async function readDomainConfig(db: D1Database): Promise<DomainConfig> {
	const rows = await db
		.prepare(`SELECT key, value FROM app_state WHERE key IN ('custom_domain', 'custom_domain_status', 'custom_domain_redirect', ?)`)
		.bind(SEEN_BASE_URL_KEY)
		.all<{ key: string; value: string | null }>();
	const v = new Map(rows.results.map((r) => [r.key, r.value]));
	return {
		domain: v.get('custom_domain')?.trim() || null,
		redirect: v.get('custom_domain_redirect') === '1',
		status: parseStatus(v.get('custom_domain_status')),
		seen: v.get(SEEN_BASE_URL_KEY)?.trim() || null
	};
}

// Keyed by the D1 binding object (one per isolate in practice).
const cache = new Map<object, { at: number; value: Promise<DomainConfig> }>();

/** Cached `readDomainConfig`. A failed read is never cached and reads as "nothing set". */
export function domainConfig(db: D1Database | null | undefined): Promise<DomainConfig> {
	if (!db) return Promise.resolve({ domain: null, redirect: false, status: null });
	const hit = cache.get(db);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
	const value = readDomainConfig(db).catch(() => {
		cache.delete(db);
		return { domain: null, redirect: false, status: null } as DomainConfig;
	});
	cache.set(db, { at: Date.now(), value });
	return value;
}

/** Drop this isolate's cached config (after a Settings write; tests). */
export function clearDomainCache(db?: D1Database | null) {
	if (db) cache.delete(db);
	else cache.clear();
}

/** The app's public origin, e.g. `https://crm.example.com` (no trailing slash). */
export async function publicBaseUrl(
	db: D1Database | null | undefined,
	env: EnvLike,
	fallbackOrigin?: string | null
): Promise<string> {
	const cfg = await domainConfig(db);
	return resolveBaseUrl(cfg.domain, (env as { PUBLIC_BASE_URL?: string } | null | undefined)?.PUBLIC_BASE_URL, fallbackOrigin, cfg.seen).url;
}

// ── #731: the origin seen at first-run setup ─────────────────────────────────────────

/** Origins that are never stored as the app's address. Kept in step with internal-tick.ts
 *  (`INTERNAL_TICK_ORIGIN`); a literal here so this module doesn't import the wrapper's file. */
const INTERNAL_ORIGIN = 'https://scheduled.invalid';

function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/**
 * Why `origin` can't be stored as the app's address, or null when it can. Refused: anything but
 * an http(s) origin, the internal tick origin, a reserved `.invalid` host, and a loopback host
 * unless `allowLoopback` (local development, plain http). Production (https) never stores one.
 */
export function seenOriginProblem(origin: string, opts: { allowLoopback?: boolean } = {}): string | null {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return 'not a URL';
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'not http(s)';
	if (u.origin === INTERNAL_ORIGIN || u.hostname.endsWith('.invalid')) return 'internal origin';
	if (isLoopbackHost(u.hostname) && !(opts.allowLoopback && u.protocol === 'http:')) return 'loopback host';
	if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return 'not https';
	return null;
}

/**
 * Store the origin a real request arrived on as the app's address, when none is stored yet
 * (/setup, at first-admin creation). `url` must be the request's own URL (`event.url`), never a
 * header or form value, so the stored host is one the request actually arrived on. Returns true
 * when a value was written.
 */
export async function recordSeenOrigin(db: D1Database, url: URL, opts: { allowLoopback?: boolean } = {}): Promise<boolean> {
	const origin = url.origin;
	if (seenOriginProblem(origin, opts)) return false;
	const res = await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO NOTHING`
		)
		.bind(SEEN_BASE_URL_KEY, origin)
		.run();
	clearDomainCache(db);
	return !!res.meta.changes;
}

/**
 * #731: an admin's explicit choice in the setup wizard: replace the stored origin with the one
 * this request arrived on (`event.url`, never a header or form value). Same refusals as
 * `recordSeenOrigin`. Returns the problem, or null when it was stored.
 */
export async function replaceSeenOrigin(db: D1Database, url: URL, opts: { allowLoopback?: boolean } = {}): Promise<string | null> {
	const origin = url.origin;
	const problem = seenOriginProblem(origin, opts);
	if (problem) return problem;
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(SEEN_BASE_URL_KEY, origin)
		.run();
	clearDomainCache(db);
	return null;
}

/** #731: forget the stored origin (the setup wizard's "Clear"). Links then follow the request
 *  origin, and the built-in clock skips until an address is set again. */
export async function clearSeenOrigin(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(SEEN_BASE_URL_KEY).run();
	clearDomainCache(db);
}

/**
 * #731: true when `host` has the shape of a Cloudflare version-preview address
 * (`<8 hex>-<worker>.<subdomain>.workers.dev`). Only a hint for the wizard: an ordinary Worker can
 * be named like that too, so nothing is refused on it; the wizard shows the host plainly with a
 * note and leaves the choice to the admin.
 */
export function looksLikeVersionPreview(host: string): boolean {
	const h = host.toLowerCase();
	if (!h.endsWith('.workers.dev')) return false;
	return /^[0-9a-f]{8}-[a-z0-9-]+$/.test(h.split('.')[0] ?? '');
}

/** Request-scoped convenience: the request's DB + env, its own origin as the fallback. */
export function publicBaseUrlFor(event: { platform?: App.Platform; url: URL }): Promise<string> {
	return publicBaseUrl(event.platform?.env?.DB, event.platform?.env, event.url.origin);
}

// ── Hostname validation ──────────────────────────────────────────────────────────────

export type HostnameResult = { ok: true; hostname: string } | { ok: false; error: string };

/** A bare DNS hostname: lowercased, no scheme / path / port, ≥ 2 labels, not an IP. */
export function validateHostname(raw: unknown): HostnameResult {
	const s = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
	if (!s) return { ok: false, error: 'Enter a hostname, e.g. crm.example.com.' };
	if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) return { ok: false, error: 'Leave out the scheme (https://) — just the hostname.' };
	if (/[/?#]/.test(s)) return { ok: false, error: 'Just the hostname — no path, query or #.' };
	if (s.includes(':')) return { ok: false, error: 'Leave out the port.' };
	if (s.length > 253) return { ok: false, error: 'That hostname is too long.' };
	const labels = s.split('.');
	if (labels.length < 2) return { ok: false, error: 'Use a full hostname with a dot, e.g. crm.example.com.' };
	for (const l of labels) {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) {
			return { ok: false, error: `“${s}” isn't a valid hostname.` };
		}
	}
	if (/^[0-9]+$/.test(labels[labels.length - 1])) return { ok: false, error: 'Use a hostname, not an IP address.' };
	if (s.endsWith('.workers.dev')) return { ok: false, error: 'The workers.dev address is already the default — enter your own domain.' };
	return { ok: true, hostname: s };
}

// ── Settings writes ──────────────────────────────────────────────────────────────────

async function put(db: D1Database, key: string, value: string) {
	await db
		.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(key, value)
		.run();
}

/** Store a new domain. A change resets the status and turns the redirect off. */
export async function saveCustomDomain(db: D1Database, hostname: string) {
	const current = await readDomainConfig(db);
	if (current.domain === hostname) return;
	await db.batch([
		db.prepare(`INSERT INTO app_state (key, value) VALUES ('custom_domain', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(hostname),
		db.prepare(`DELETE FROM app_state WHERE key IN ('custom_domain_status', 'custom_domain_redirect')`)
	]);
	clearDomainCache(db);
}

/** Back to the wrangler var: drops the domain, its status and the redirect. */
export async function clearCustomDomain(db: D1Database) {
	await db.prepare(`DELETE FROM app_state WHERE key IN ('custom_domain', 'custom_domain_status', 'custom_domain_redirect')`).run();
	clearDomainCache(db);
}

/** Turning the redirect on needs a passing status check for the current domain. */
export async function setRedirect(db: D1Database, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
	if (on) {
		const cfg = await readDomainConfig(db);
		if (!cfg.domain) return { ok: false, error: 'Save a custom domain first.' };
		if (!cfg.status?.ok || cfg.status.domain !== cfg.domain) {
			return { ok: false, error: `Run Check status and get a reachable result for ${cfg.domain} before turning the redirect on.` };
		}
		await put(db, 'custom_domain_redirect', '1');
	} else {
		await db.prepare(`DELETE FROM app_state WHERE key = 'custom_domain_redirect'`).run();
	}
	clearDomainCache(db);
	return { ok: true };
}

// ── Check status ─────────────────────────────────────────────────────────────────────

/** Fetch https://<domain>/login from the Worker; a 2xx counts as reachable. Stored. */
export async function checkDomainStatus(
	db: D1Database,
	hostname: string,
	fetcher: typeof fetch = fetch,
	now = new Date()
): Promise<DomainStatus> {
	let status: DomainStatus;
	try {
		const res = await fetcher(`https://${hostname}/login`, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(8000)
		});
		status = { ok: res.status >= 200 && res.status < 300, code: res.status, checkedAt: now.toISOString(), domain: hostname };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		status = { ok: false, code: null, checkedAt: now.toISOString(), domain: hostname, error: msg.slice(0, 200) };
	}
	await put(db, 'custom_domain_status', JSON.stringify(status));
	clearDomainCache(db);
	return status;
}

// ── Attach to this Worker ────────────────────────────────────────────────────────────

export type AttachResult =
	| { mode: 'instructions'; hostname: string }
	| { mode: 'api'; ok: boolean; hostname: string; zone: string | null; message: string; result?: unknown };

/** Zone candidates, registrable-looking first: crm.a.example.com → example.com, a.example.com, crm.a.example.com. */
export function zoneCandidates(hostname: string): string[] {
	const labels = hostname.split('.');
	const out: string[] = [];
	for (let n = 2; n <= labels.length; n++) out.push(labels.slice(-n).join('.'));
	return out;
}

type CfEnvelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T };

function cfErrors(body: CfEnvelope<unknown> | null, status: number): string {
	const errs = body?.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).filter(Boolean) ?? [];
	return errs.length ? errs.join('; ') : `HTTP ${status}`;
}

/** Real Cloudflare API tokens are ~40 chars; anything shorter is too likely to occur in normal text. */
const MIN_REDACT_LENGTH = 8;

/**
 * Redact a secret (and anything shaped like `Bearer <token>`) from a message we show the operator.
 * A secret shorter than MIN_REDACT_LENGTH is not replaced literally — doing so would mangle words.
 */
export function scrubSecret(s: string, secret: string): string {
	let out = s.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
	if (secret.length >= MIN_REDACT_LENGTH) out = out.split(secret).join('[REDACTED]');
	return out;
}

/**
 * With CF_API_TOKEN: find the zone (`GET /zones?name=`) and attach the hostname as a Workers
 * custom domain (`PUT /accounts/{id}/workers/domains`). Without it: instructions only.
 * The token is never echoed back.
 */
export async function attachDomain(hostname: string, env: EnvLike, fetcher: typeof fetch = fetch): Promise<AttachResult> {
	const e = (env ?? {}) as { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string };
	const token = (e.CF_API_TOKEN ?? '').trim();
	if (!token) return { mode: 'instructions', hostname };
	const account = (e.CF_ACCOUNT_ID ?? '').trim();
	const service = workerName(env);
	const missing = [account ? '' : 'CF_ACCOUNT_ID', service ? '' : 'WORKER_NAME'].filter(Boolean);
	if (missing.length) {
		return { mode: 'api', ok: false, hostname, zone: null, message: `Not configured: set the ${missing.join(' and ')} var${missing.length > 1 ? 's' : ''} in wrangler.jsonc.` };
	}
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const scrub = (s: string) => scrubSecret(s, token);

	try {
		let zoneId: string | null = null;
		let zoneName: string | null = null;
		for (const name of zoneCandidates(hostname)) {
			const res = await fetcher(`${CF_API}/zones?name=${encodeURIComponent(name)}`, { headers });
			const body = (await res.json().catch(() => null)) as CfEnvelope<{ id: string; name: string }[]> | null;
			if (!res.ok || !body?.success) {
				return { mode: 'api', ok: false, hostname, zone: null, message: scrub(`Zone lookup failed: ${cfErrors(body, res.status)}`) };
			}
			const z = body.result?.[0];
			if (z?.id) {
				zoneId = z.id;
				zoneName = z.name ?? name;
				break;
			}
		}
		if (!zoneId) {
			return { mode: 'api', ok: false, hostname, zone: null, message: `No zone for ${hostname} on this Cloudflare account (or the token can't see it).` };
		}
		const res = await fetcher(`${CF_API}/accounts/${encodeURIComponent(account)}/workers/domains`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ hostname, zone_id: zoneId, service, environment: 'production' })
		});
		const body = (await res.json().catch(() => null)) as CfEnvelope<unknown> | null;
		if (!res.ok || !body?.success) {
			return { mode: 'api', ok: false, hostname, zone: zoneName, message: scrub(`Attach failed: ${cfErrors(body, res.status)}`) };
		}
		return {
			mode: 'api',
			ok: true,
			hostname,
			zone: zoneName,
			message: `Attached ${hostname} to ${service} (zone ${zoneName}). DNS and the certificate usually take a few minutes.`,
			result: body.result
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { mode: 'api', ok: false, hostname, zone: null, message: scrub(`Cloudflare API unreachable: ${msg}`).slice(0, 300) };
	}
}

// ── Redirect (hooks.server.ts) ───────────────────────────────────────────────────────

/** Machine endpoints that keep answering on every host — no 301. */
export const REDIRECT_EXEMPT = [
	'/api/webhook',
	'/api/ingest',
	'/api/inbound',
	'/api/luma',
	'/api/automations/tick',
	'/api/health',
	'/api/contacts/upsert',
	'/api/v1',
	'/mcp',
	'/unsubscribe/one-click',
	'/img',
	'/t.js',
	'/api/track',
	// #701: tracking links in mail already sent keep working on every host the app answers on.
	'/t/o',
	'/t/c'
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Where to 301 this request, or null. Only GET/HEAD, only when the redirect is on and a
 * domain is set, never for localhost, the custom domain itself or the newsletter archive's
 * public host (#491), never for REDIRECT_EXEMPT.
 */
export function redirectTarget(url: URL, method: string, cfg: DomainConfig, opts: { archiveHost?: string | null } = {}): string | null {
	if (!cfg.redirect || !cfg.domain) return null;
	if (method !== 'GET' && method !== 'HEAD') return null;
	const host = url.hostname.toLowerCase();
	if (host === cfg.domain || LOCAL_HOSTS.has(host)) return null;
	// #491: the newsletter archive's public host is never sent to the CRM.
	if (opts.archiveHost && host === opts.archiveHost.toLowerCase()) return null;
	const path = url.pathname;
	if (REDIRECT_EXEMPT.some((p) => path === p || path.startsWith(p + '/'))) return null;
	return `https://${cfg.domain}${path}${url.search}`;
}
