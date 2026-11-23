// #311: the optional "Check links" pre-send step — a HEAD (GET when HEAD isn't allowed)
// per link, 5 s timeout, at most 30 links, redirects followed by hand (≤ 3 hops) so every
// hop goes through the same SSRF guard. Only http(s) on default ports to public hostnames;
// IP literals in private / loopback / link-local / reserved ranges and internal-looking
// names are refused before any request is made.
import type { LinkProbe } from '$lib/presend-checks';

export const LINK_CHECK_MAX = 30;
export const LINK_CHECK_TIMEOUT_MS = 5000;
const MAX_HOPS = 3;
const CONCURRENCY = 6;

function ipv4Blocked(host: string): boolean | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/** May the server fetch this URL? Returns the parsed URL or why not. */
export function ssrfGuard(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: 'not a URL' };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'only http(s) links are checked' };
	if (url.username || url.password) return { ok: false, reason: 'credentials in URL' };
	if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'non-standard port' };
	// WHATWG URL already normalises 0x7f.1, 2130706433, etc. to dotted IPv4.
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!host) return { ok: false, reason: 'no host' };
	if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'IP address' };
	const v4 = ipv4Blocked(host);
	if (v4 === true) return { ok: false, reason: 'private address' };
	if (v4 === null) {
		if (!host.includes('.')) return { ok: false, reason: 'not a public host' };
		if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|test|invalid|example)$/.test(host)) return { ok: false, reason: 'not a public host' };
	}
	return { ok: true, url };
}

/** Did a redirect land on a sign-in page? */
export function looksLikeLogin(u: string): boolean {
	try {
		const { hostname, pathname } = new URL(u);
		return /(^|\/)(login|log-in|signin|sign-in|sign_in|sso|auth|oauth|session\/new|users\/sign_in|wp-login\.php)(\/|$|\?)/i.test(pathname) || /^(accounts\.google\.com|login\.microsoftonline\.com|login\.)/i.test(hostname);
	} catch {
		return false;
	}
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

async function probeOne(url: string, fetcher: Fetcher): Promise<LinkProbe> {
	let current = url;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		const g = ssrfGuard(current);
		if (!g.ok) return { url, status: null, error: `blocked: ${g.reason}`, finalUrl: current };
		let res: Response;
		try {
			const init = { redirect: 'manual' as const, signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS), headers: { 'user-agent': 'DS-Email-LinkCheck/1.0' } };
			res = await fetcher(g.url.toString(), { ...init, method: 'HEAD' });
			if (res.status === 405 || res.status === 501 || res.status === 403) {
				res = await fetcher(g.url.toString(), { ...init, method: 'GET' });
				res.body?.cancel().catch(() => {});
			}
		} catch (e) {
			const msg = e instanceof Error ? (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : e.message) : String(e);
			return { url, status: null, error: msg.slice(0, 120), finalUrl: current };
		}
		const loc = res.headers.get('location');
		if (res.status >= 300 && res.status < 400 && loc) {
			current = new URL(loc, g.url).toString();
			continue;
		}
		return { url, status: res.status, finalUrl: current, login: current !== url && looksLikeLogin(current) };
	}
	return { url, status: null, error: 'too many redirects', finalUrl: current };
}

/** Probe up to LINK_CHECK_MAX distinct http(s) links. `skipped` = how many were left out. */
export async function checkLinks(urls: string[], fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<{ probes: LinkProbe[]; skipped: number }> {
	const distinct = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
	const todo = distinct.slice(0, LINK_CHECK_MAX);
	const probes: LinkProbe[] = [];
	for (let i = 0; i < todo.length; i += CONCURRENCY) {
		probes.push(...(await Promise.all(todo.slice(i, i + CONCURRENCY).map((u) => probeOne(u, fetcher)))));
	}
	return { probes, skipped: distinct.length - todo.length };
}
