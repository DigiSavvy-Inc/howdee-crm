// Pure routing decision for the PWA service worker (#135). Extracted out of
// src/service-worker.ts so the routing rules can be unit tested without a real
// ServiceWorkerGlobalScope — the `fetch` listener calls this once per request and
// switches on the result. Keep this in sync with the "PWA" section of CLAUDE.md.

export type SwPolicy = 'passthrough' | 'navigate' | 'cache-first' | 'swr-media';

export function swPolicyFor(input: {
	url: URL;
	method: string;
	mode: RequestMode;
	origin: string;
	precached: (path: string) => boolean;
}): SwPolicy {
	const { url, method, mode, origin, precached } = input;

	// Cross-origin requests are never intercepted.
	if (url.origin !== origin) return 'passthrough';

	// Only GET requests are candidates for caching. (The service worker's POST /logout
	// cache-clear side effect is handled separately, before this function is called —
	// it is not a routing decision and must not be moved here.)
	if (method !== 'GET') return 'passthrough';

	const path = url.pathname;

	if (mode === 'navigate') {
		// Hosted pages (/p/*) and the auth round-trip (/auth/*, /logout) stay plain
		// network requests — never served from the navigation cache fallback.
		if (/^\/(p|auth|logout)(\/|$)/.test(path)) return 'passthrough';
		return 'navigate';
	}

	// Build output (content-hashed filenames) and any other precached asset (as long
	// as it has no query string, which would mean a cache-busted/variant request) are
	// served cache-first.
	if (path.startsWith('/_app/immutable/') || (precached(path) && !url.search)) {
		return 'cache-first';
	}

	if (path.startsWith('/img/') || path.startsWith('/api/avatar/')) {
		// A forced re-check (?refresh=1) must hit the server, not the runtime cache.
		if (url.searchParams.has('refresh')) return 'passthrough';
		return 'swr-media';
	}

	// Everything else (/api/*, __data.json, etc.) is not intercepted.
	return 'passthrough';
}
