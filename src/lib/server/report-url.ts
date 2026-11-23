// The contact `report_url` custom field (#604: moved out of snapshot-report.ts). Core contact
// writes (API, ingest, Luma, the contact page) run `guardReportUrl` on every meta write, so a
// report link without a viewer key is never stored. Pure, no I/O.
//
// #661: the reports host is configuration, not code. It is the Worker var
// `SNAPSHOT_REPORT_HOST`, set once per request by hooks.server.ts (`configureReportHost`)
// and by tests/report-host.ts in the test pool. There is no built-in host: while it is
// unset, `report_url` is an ordinary custom field (the guard leaves it alone) and every
// report link fails validation.

let configuredHost: string | null = null;

/** A bare, lowercased hostname, or null. */
function cleanHost(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const host = value.trim().toLowerCase();
	if (!host || host.length > 253) return null;
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
	return host;
}

/** Read `SNAPSHOT_REPORT_HOST` from a Worker env (any shape; a missing or junk value = unset). */
export function configureReportHost(env: unknown): void {
	const value = env && typeof env === 'object' ? (env as Record<string, unknown>).SNAPSHOT_REPORT_HOST : undefined;
	configuredHost = cleanHost(value);
}

/** The configured reports host, or null when none is set. */
export function reportHost(): string | null {
	return configuredHost;
}

/** `https://<host>`, or '' when no host is set. */
export function reportOrigin(): string {
	return configuredHost ? `https://${configuredHost}` : '';
}

export type ReportUrlResult =
	| { ok: true; url: string }
	| { ok: false; host: string | null; reason: string };

/** True for `/api` and `/api/...` — the reports JSON URL, never the page we store or email. */
export function isApiReportPath(pathname: string): boolean {
	const path = pathname.toLowerCase();
	return path === '/api' || path.startsWith('/api/');
}

/**
 * Accept only https://<report host>/<folder>/<file>. A single `key` query
 * param is kept (the viewer key). Every other query param and the hash are stripped.
 * .com, pages.dev, workers.dev, and any `/api/v1/...` path fail. A rejected host is
 * not rewritten into this host.
 */
export function validateReportUrl(raw: string | null | undefined): ReportUrlResult {
	const text = String(raw ?? '').trim();
	if (!text) return { ok: false, host: null, reason: 'missing url' };
	const reportHostName = configuredHost;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { ok: false, host: null, reason: 'invalid url' };
	}
	const host = url.hostname.toLowerCase();
	if (url.username || url.password) return { ok: false, host, reason: 'userinfo' };
	if (url.protocol !== 'https:') return { ok: false, host, reason: 'not https' };
	if (!reportHostName) return { ok: false, host, reason: 'no report host configured' };
	if (host !== reportHostName) return { ok: false, host, reason: 'host not allowed' };
	if (isApiReportPath(url.pathname)) return { ok: false, host, reason: 'api path' };
	const key = url.searchParams.get('key');
	url.search = '';
	url.hash = '';
	const page = url.toString();
	if (key) return { ok: true, url: `${page}?key=${encodeURIComponent(key)}` };
	return { ok: true, url: page };
}

/**
 * A contact `report_url` is stored only when it is https on the report host and has `?key=`.
 * A clean link, an API url, or any other host is rejected.
 */
export function keyedContactReportUrl(raw: string | null | undefined): string | null {
	const validated = validateReportUrl(raw);
	if (!validated.ok) return null;
	try {
		const key = new URL(validated.url).searchParams.get('key');
		if (!key?.trim()) return null;
		return validated.url;
	} catch {
		return null;
	}
}

/**
 * Remove `report_url` unless it is a keyed page on the report host. No host configured =
 * the field is left alone (#661).
 */
export function guardReportUrl(meta: Record<string, unknown>): void {
	if (!configuredHost) return;
	if (!Object.prototype.hasOwnProperty.call(meta, 'report_url')) return;
	const value = meta.report_url;
	if (typeof value !== 'string') {
		delete meta.report_url;
		return;
	}
	const accepted = keyedContactReportUrl(value);
	if (!accepted) delete meta.report_url;
	else meta.report_url = accepted;
}
