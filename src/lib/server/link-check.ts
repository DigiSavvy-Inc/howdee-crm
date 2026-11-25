// #311: the "Check links" pre-send step — a HEAD (GET when HEAD isn't allowed) per link,
// 5 s timeout, at most 60 links (#479: was 30), redirects followed by hand (≤ 3 hops) so every
// hop goes through the same SSRF guard. Only http(s) on default ports to public hostnames;
// IP literals in private / loopback / link-local / reserved ranges and internal-looking
// names are refused before any request is made. #479: runs on its own (compose panel, the
// send gate, the scheduled-send tick); a 500–504 / 530 or no answer is retried once after 2 s.
// Hard budgets: a deadline that aborts fetches in flight, and a cap on outbound fetches (the
// probes share the Worker request's subrequest allowance with the real send and the tick's
// other jobs). Links the budgets didn't reach are "not checked yet".
// Never log a probed URL: it may carry a query string with personal data.
import type { LinkProbe } from '$lib/presend-checks';

export const LINK_CHECK_MAX = 60;
export const LINK_CHECK_CONCURRENCY = 6;
export const LINK_CHECK_TIMEOUT_MS = 5000;
export const LINK_RETRY_DELAY_MS = 2000;
/** #479: one interactive check (compose Send now / panel, Re-check now, the API checks
 *  endpoint, the MCP tool): at most 20 s and 200 outbound fetches. */
export const LINK_CHECK_DEADLINE_MS = 20_000;
export const LINK_CHECK_MAX_FETCHES = 200;
/** #479: the scheduled-send tick: one 20 s deadline and one budget of 300 fetches for every
 *  campaign of the tick together; each campaign gets an equal slice (at least 30). */
export const TICK_LINK_DEADLINE_MS = 20_000;
export const TICK_MAX_FETCHES = 300;
export const TICK_MIN_FETCHES_PER_CAMPAIGN = 30;
const MAX_HOPS = 3;
const CONCURRENCY = LINK_CHECK_CONCURRENCY;

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

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** #479: an outbound-fetch allowance. Every fetch (HEAD, GET fallback, each redirect hop, each
 *  retry) takes one from this budget and from its `parent` (when set), so several calls can
 *  share one budget: the tick gives each campaign a slice of one budget for the whole tick. */
export type FetchBudget = { remaining: number; parent?: FetchBudget };

export function fetchBudget(n: number, parent?: FetchBudget): FetchBudget {
	return { remaining: Math.max(0, Math.floor(n)), ...(parent ? { parent } : {}) };
}

/** Takes one fetch from the budget (and every parent). False when any of them is empty. */
export function takeFetch(b: FetchBudget): boolean {
	for (let x: FetchBudget | undefined = b; x; x = x.parent) if (x.remaining <= 0) return false;
	for (let x: FetchBudget | undefined = b; x; x = x.parent) x.remaining--;
	return true;
}

/** #479: a concurrency limiter for outbound probes. The tick passes ONE for every campaign it
 *  checks, so the whole tick has at most `max` fetches in flight (the runtime allows about six
 *  connections and queues the rest, and a queued fetch would burn its own timeout waiting).
 *  A probe's timeout starts when it gets a slot, not when it asks for one. */
export type Limiter = { max: number; active: number; waiting: (() => void)[] };

export function linkLimiter(max: number = LINK_CHECK_CONCURRENCY): Limiter {
	return { max: Math.max(1, Math.floor(max)), active: 0, waiting: [] };
}

async function acquire(l: Limiter): Promise<void> {
	if (l.active < l.max) {
		l.active++;
		return;
	}
	// The releasing caller hands its slot straight to the next waiter (active stays the same).
	await new Promise<void>((resolve) => l.waiting.push(resolve));
}

function release(l: Limiter): void {
	const next = l.waiting.shift();
	if (next) next();
	else l.active--;
}

export type CheckLinksOptions = {
	/** #479: wait before the one retry of a 5xx / no answer (tests pass 0). */
	retryDelayMs?: number;
	/** #479: epoch ms. A hard stop: fetches in flight are aborted at this time, nothing starts
	 *  after it, and every link not finished by then is returned as `unfinished` ("not checked
	 *  yet"). Default: LINK_CHECK_DEADLINE_MS from the start of the call. */
	deadline?: number;
	/** #479: the outbound-fetch budget (shared between calls when the same object is passed).
	 *  When it runs out, the links left are `unfinished`. Default: LINK_CHECK_MAX_FETCHES. */
	maxFetches?: FetchBudget;
	/** #479: the concurrency limiter (shared between calls when the same object is passed, as
	 *  the tick does). Default: a limiter of LINK_CHECK_CONCURRENCY (6) for this call alone. */
	limiter?: Limiter;
};

/** #479: a DNS failure (the host doesn't exist): only a resolver error says so (ENOTFOUND /
 *  getaddrinfo / "could not resolve" …). A status alone never does: a 530 is Cloudflare's "no
 *  answer from the origin", which can be many things, so it's treated like a 5xx. */
export function isDnsFailure(_status: number | null, error?: string): boolean {
	return !!error && /ENOTFOUND|EAI_AGAIN|getaddrinfo|\bdns\b|name not resolved|could not resolve|\b1016\b/i.test(error);
}

/** #479: a server-side failure that gets one retry and then blocks (500–504, and 530). */
export function isServerError(status: number | null): boolean {
	return status !== null && ((status >= 500 && status <= 504) || status === 530);
}

/** #479: a 500–504 / 530 or no answer (timeout / network) is tried once more after a short
 *  wait, so one blip doesn't block a send. A DNS failure, a refused target or a loop is final. */
export function shouldRetry(p: LinkProbe): boolean {
	if (p.status !== null) return isServerError(p.status);
	return p.kind === 'timeout';
}

/** What one probe may spend: the hard deadline and the fetch budget. */
type ProbeCtx = { fetcher: Fetcher; retryDelayMs: number; deadline: number; budget: FetchBudget; limiter: Limiter };

/** "Not checked yet": out of time or out of fetches. */
const UNFINISHED = Symbol('unfinished');
type ProbeResult = LinkProbe | typeof UNFINISHED;

const timeLeft = (ctx: ProbeCtx) => ctx.deadline - Date.now();

/** One fetch, or UNFINISHED when the deadline or the budget doesn't allow it. It waits for a
 *  slot of the limiter first; the time left, the budget and the timeout are only looked at once
 *  it has one, so time spent waiting never counts against the link. The signal fires at the
 *  per-request timeout or at the deadline, whichever comes first. */
async function budgetedFetch(ctx: ProbeCtx, url: string, method: 'HEAD' | 'GET'): Promise<Response | typeof UNFINISHED> {
	if (timeLeft(ctx) <= 0) return UNFINISHED;
	await acquire(ctx.limiter);
	try {
		const left = timeLeft(ctx);
		if (left <= 0 || !takeFetch(ctx.budget)) return UNFINISHED;
		const signal = AbortSignal.timeout(Math.min(LINK_CHECK_TIMEOUT_MS, left));
		const res = await ctx.fetcher(url, { method, redirect: 'manual', signal, headers: { 'user-agent': 'DS-Email-LinkCheck/1.0' } });
		return res;
	} finally {
		release(ctx.limiter);
	}
}

async function probeOne(url: string, ctx: ProbeCtx): Promise<ProbeResult> {
	const first = await probeOnce(url, ctx);
	if (first === UNFINISHED || !shouldRetry(first)) return first;
	// No time for the wait and the retry: the link is "not checked yet", not judged on one try.
	if (timeLeft(ctx) <= ctx.retryDelayMs) return UNFINISHED;
	if (ctx.retryDelayMs > 0) await new Promise((r) => setTimeout(r, ctx.retryDelayMs));
	const second = await probeOnce(url, ctx);
	return second === UNFINISHED ? UNFINISHED : { ...second, retried: true };
}

async function probeOnce(url: string, ctx: ProbeCtx): Promise<ProbeResult> {
	let current = url;
	const seen = new Set<string>();
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		// The SSRF guard runs on every hop and every retry, before any request.
		const g = ssrfGuard(current);
		if (!g.ok) return { url, status: null, error: `blocked: ${g.reason}`, finalUrl: current, kind: 'blocked' };
		seen.add(g.url.toString());
		let res: Response;
		try {
			const head = await budgetedFetch(ctx, g.url.toString(), 'HEAD');
			if (head === UNFINISHED) return UNFINISHED;
			res = head;
			if (res.status === 405 || res.status === 501 || res.status === 403) {
				const get = await budgetedFetch(ctx, g.url.toString(), 'GET');
				if (get === UNFINISHED) return UNFINISHED;
				res = get;
				res.body?.cancel().catch(() => {});
			}
		} catch (e) {
			// Aborted because the deadline passed: not checked yet (not a timeout of the link).
			if (timeLeft(ctx) <= 0) return UNFINISHED;
			const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
			const msg = e instanceof Error ? (timeout ? 'timed out' : e.message) : String(e);
			return { url, status: null, error: msg.slice(0, 120), finalUrl: current, kind: isDnsFailure(null, msg) ? 'dns' : 'timeout' };
		}
		const loc = res.headers.get('location');
		if (res.status >= 300 && res.status < 400 && loc) {
			let next: string;
			try {
				next = new URL(loc, g.url).toString();
			} catch {
				return { url, status: res.status, error: 'bad redirect', finalUrl: current, kind: 'hops' };
			}
			if (seen.has(next)) return { url, status: null, error: 'redirect loop', finalUrl: next, kind: 'loop' };
			current = next;
			continue;
		}
		return { url, status: res.status, finalUrl: current, login: current !== url && looksLikeLogin(current) };
	}
	return { url, status: null, error: 'too many redirects', finalUrl: current, kind: 'hops' };
}

/** Probe up to LINK_CHECK_MAX distinct http(s) links, six at a time. `skipped` = over the cap;
 *  `unfinished` = not finished before `opts.deadline` or after `opts.maxFetches` ran out ("not
 *  checked yet"). The results live for this call only: no cache across requests, so a fixed
 *  link shows on the next check. Never throws for a link: a fetch error is that link's result. */
export async function checkLinks(
	urls: string[],
	fetcher: Fetcher = (u, i) => fetch(u, i),
	opts: CheckLinksOptions = {}
): Promise<{ probes: LinkProbe[]; skipped: number; unfinished: string[] }> {
	const distinct = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
	const todo = distinct.slice(0, LINK_CHECK_MAX);
	const ctx: ProbeCtx = {
		fetcher,
		retryDelayMs: opts.retryDelayMs ?? LINK_RETRY_DELAY_MS,
		deadline: opts.deadline ?? Date.now() + LINK_CHECK_DEADLINE_MS,
		budget: opts.maxFetches ?? fetchBudget(LINK_CHECK_MAX_FETCHES),
		limiter: opts.limiter ?? linkLimiter(LINK_CHECK_CONCURRENCY)
	};
	const results: ProbeResult[] = new Array(todo.length).fill(UNFINISHED);
	let next = 0;
	// A pool of six: each worker takes the next link as soon as it's free. Fetches also wait for
	// a slot of the limiter, which the tick shares between campaigns.
	const worker = async (): Promise<void> => {
		while (next < todo.length) {
			const i = next++;
			try {
				results[i] = await probeOne(todo[i], ctx);
			} catch {
				results[i] = UNFINISHED; // defensive: probeOnce catches fetch errors itself
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));
	const probes: LinkProbe[] = [];
	const unfinished: string[] = [];
	results.forEach((r, i) => (r === UNFINISHED ? unfinished.push(todo[i]) : probes.push(r)));
	return { probes, skipped: distinct.length - todo.length, unfinished };
}
