import { formFrameHeaders } from '$lib/server/form-embed'; // #515
import { redirect, type Handle } from '@sveltejs/kit';
import { verifySession, sessionPredates, SESSION_COOKIE } from '$lib/server/auth';
import { parseStamp } from '$lib/server/password';
import { findActiveUserById } from '$lib/server/users';
import { withNavLayoutAttr } from '$lib/nav-layout';
import { domainConfig, publicBaseUrl, redirectTarget } from '$lib/server/public-url';
import {
	archivePublicConfig,
	archiveRequestMode,
	archiveRedirectTarget,
	archiveRouteHosts,
	feedCorsHeaders,
	SOURCE_HEADER
} from '$lib/server/archive-public';
import { configureReportHost } from '$lib/server/report-url';

// Routes reachable without logging in.
const PUBLIC_PREFIXES = [
	'/login',
	'/setup', // #606: first-run setup — 404 once any user exists; the form needs the SETUP_TOKEN secret
	'/invite', '/reset', '/verify', // #639: emailed single-use links (hashed tokens); keep CSRF
	'/auth', // GitHub OAuth start + callback (#88) — GET-only, no session yet; /auth/google (#158) checks admin itself
	'/api/webhook',
	'/api/ingest',
	'/api/contacts/upsert', // machine endpoint; specific path so /api/contacts/search stays session-gated
	'/api/inbound',
	'/api/luma', // Luma webhook — gated by its own HMAC signature (#70)
	'/api/automations/tick',
	'/api/health', // #637: health check for monitoring and deploy tooling — Bearer CRON_KEY
	'/api/v1', // Data API (#71) — each route enforces a Bearer API key + scope
	'/mcp', // MCP server (#348) — Bearer Data API key; the scope decides the tools
	'/api/track', // site tracking beacons (#151) — site_key + Origin allowlist + signed visitor id
	'/t.js', // site tracking snippet (#152) — public JS, the site_key is public by design
	'/t/o', '/t/c', // #701: CRM open pixel + click links — GET only, HMAC-signed tokens, no contact data in responses
	'/unsubscribe',
	'/confirm', // #510: double opt-in link — GET only shows the button; the POST confirms; /confirm/preview checks admin itself
	'/p', // public hosted pages (/p/[slug]) — published-only enforced in the route
	'/f', // #509: public forms (/f/[slug]) — published-only; the submit checks origin, honeypot, rate limit
	'/newsletter', // #481: newsletter archive — 404 while off / unpublished; GET-only except the #587 sign-up POST (/newsletter/subscribe)
	'/manifest.webmanifest', // PWA manifest (#188) — built from the branding settings
	'/img' // uploaded media from R2 — random UUID keys, fetched by email clients/visitors
];

// Machine webhook endpoints meant to be called cross-origin (Postmark, forms, cron).
// SvelteKit's built-in origin CSRF is off (svelte.config.js); we re-enforce it below for
// everything *except* these — they're gated by their own keys, not the session cookie.
const CSRF_EXEMPT = [
	'/api/webhook',
	'/api/ingest',
	'/api/contacts/upsert',
	'/api/inbound',
	'/api/luma',
	'/api/automations/tick',
	'/api/health', // #637: health check for monitoring and deploy tooling — Bearer CRON_KEY
	'/api/v1', // Data API (#71) — Bearer-gated; safe for cross-origin app calls
	'/mcp', // MCP server (#348) — Bearer-gated JSON-RPC from MCP clients
	'/api/track', // site tracking (#151) — called cross-origin from tracking sites (sendBeacon = text/plain)
	'/f', // #509: form submits — handleSubmission checks the Origin per form (CRM host + allowed_origins)
	'/newsletter/subscribe', // #587: the archive's sign-up form post — same handleSubmission origin check (request's own origin allowed)
	'/unsubscribe/one-click' // RFC 8058 List-Unsubscribe-Post (#264) — mailbox providers POST with no Origin; signed token
];
const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

function matchesPrefix(path: string, prefixes: string[]): boolean {
	return prefixes.some((p) => path === p || path.startsWith(p + '/'));
}

function isPublic(path: string): boolean {
	return matchesPrefix(path, PUBLIC_PREFIXES);
}

// #211: all a user with must_change_password may reach (plus public routes) until they change it.
const MUST_CHANGE_ALLOWED = ['/account/password', '/logout', '/_app'];

// ── #515 Forms embed: /f/* responses go through `formFrameHeaders` ($lib/server/form-embed):
// join point with the default security headers — /f/* sets its own CSP frame-ancestors, so a
// blanket X-Frame-Options is removed there (an embedded form must be frameable). The #540
// wrapper below adds X-Frame-Options: DENY back everywhere except the embedded form pages
// (`/f/<slug>` and `/f/<slug>/thanks` with `?embed=1`). ── end #515

const appHandle: Handle = async ({ event, resolve }) => {
	// #661: the report host for the contact `report_url` guard is a Worker var, not code.
	configureReportHost(event.platform?.env);
	// #491: the newsletter archive on a public host (Workers route / proxy with the secret).
	// There, only /newsletter* is served — everything else is a 404, so a misconfigured
	// route or proxy never exposes the app.
	const archiveCfg = await archivePublicConfig(event.platform?.env?.DB);
	const archiveMode = await archiveRequestMode(
		event.url,
		event.request.headers,
		archiveCfg,
		archiveRouteHosts(event.platform?.env)
	);
	// #495: no-store, so a 404 from before the public address was saved is never edge-cached.
	if (archiveMode.kind === 'blocked') return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
	event.locals.archivePublic = archiveMode.kind === 'public' ? { base: archiveMode.base } : null;
	if (archiveMode.kind === 'public') {
		event.locals.user = null;
		event.locals.authed = false;
		const res = await resolve(event);
		const out = new Response(res.body, res);
		out.headers.set(SOURCE_HEADER, 'crm');
		// #495: the public feed is readable cross-origin by the CRM, so Test connection can
		// fall back to checking it from the admin's browser.
		const cors = feedCorsHeaders(event.url.pathname, await publicBaseUrl(event.platform?.env?.DB, event.platform?.env));
		for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
		return out;
	}
	const archiveTarget = archiveRedirectTarget(event.url, event.request.method, archiveCfg, false);
	if (archiveTarget) return new Response(null, { status: 301, headers: { location: archiveTarget } });

	// #120: Settings → Domain "Redirect other hosts" — browser GET/HEAD on any other host
	// 301s to the custom domain; machine endpoints (REDIRECT_EXEMPT) keep answering.
	if (event.request.method === 'GET' || event.request.method === 'HEAD') {
		const target = redirectTarget(event.url, event.request.method, await domainConfig(event.platform?.env?.DB), {
			archiveHost: archiveCfg.host
		});
		if (target) return new Response(null, { status: 301, headers: { location: target } });
	}

	// Re-implement SvelteKit's origin CSRF check (disabled globally) so cross-origin form
	// posts are still rejected — except for the machine webhook endpoints.
	if (MUTATING.includes(event.request.method)) {
		const ct = (event.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
		if (
			FORM_CONTENT_TYPES.includes(ct) &&
			!matchesPrefix(event.url.pathname, CSRF_EXEMPT) &&
			event.request.headers.get('origin') !== event.url.origin
		) {
			return new Response('Cross-site POST form submissions are forbidden', { status: 403 });
		}
	}

	const secret = event.platform?.env?.SESSION_SECRET ?? '';
	const token = event.cookies.get(SESSION_COOKIE);
	const session = await verifySession(secret, token);

	const db = event.platform?.env?.DB;
	let user = null;
	if (session && db) {
		user = await findActiveUserById(db, session.userId);
		// #211: a password set/change/clear signs out every session issued before it.
		if (user && sessionPredates(session.issuedAt, parseStamp(user.passwordSetAt))) user = null;
		// A session that no longer resolves to an active user (disabled/deleted since
		// the token was issued) shouldn't linger — clear it so /login doesn't loop.
		if (!user) event.cookies.delete(SESSION_COOKIE, { path: '/' });
	}

	event.locals.user = user;
	event.locals.authed = !!user;

	if (!isPublic(event.url.pathname) && !event.locals.authed) {
		throw redirect(303, '/login');
	}

	if (
		user?.mustChangePassword &&
		!isPublic(event.url.pathname) &&
		!matchesPrefix(event.url.pathname, MUST_CHANGE_ALLOWED)
	) {
		throw redirect(303, '/account/password?first=1');
	}

	// #134: render the signed-in user's nav layout on <html> so the first paint is right.
	if (user) {
		const layout = user.navLayout;
		// Only the first chunk holds the document's <html> tag — never touch page content.
		let stamped = false;
		return formFrameHeaders(
			event.url.pathname,
			await resolve(event, {
				transformPageChunk: ({ html }) => {
					if (stamped) return html;
					stamped = true;
					return withNavLayoutAttr(html, layout);
				}
			})
		);
	}
	return formFrameHeaders(event.url.pathname, await resolve(event)); // #515
};

// --- #540: baseline security headers (frame, nosniff, referrer only — no CSP script/style rules) ---
// Never overrides a header a route already set. Only the embedded form pages (#515: `/f/<slug>`
// and `/f/<slug>/thanks` with `?embed=1`) skip the frame header: their own CSP frame-ancestors
// (the form's allowed origins) decides who may frame them. Every other /f/* response keeps
// X-Frame-Options: DENY on top of its frame-ancestors 'self'.
export const handle: Handle = async (input) => {
	const res = await appHandle(input);
	const path = input.event.url.pathname;
	const wanted: Record<string, string> = {
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin'
	};
	const embeddedForm = /^\/f\/[^/]+(\/thanks)?\/?$/.test(path) && input.event.url.searchParams.get('embed') === '1';
	if (!embeddedForm) {
		wanted['X-Frame-Options'] = 'DENY';
	}
	const apply = (r: Response) => {
		for (const [k, v] of Object.entries(wanted)) {
			if (!r.headers.has(k)) r.headers.set(k, v);
		}
	};
	try {
		apply(res);
		return res;
	} catch {
		const out = new Response(res.body, res); // immutable headers: copy
		apply(out);
		return out;
	}
};
// --- end #540 ---
