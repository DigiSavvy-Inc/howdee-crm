/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
// PWA service worker (#135). SvelteKit registers this automatically.
//
// What is (and isn't) cached — keep CLAUDE.md "PWA" in sync:
// - Precache: the build output (_app/immutable/*), static/ files (icons, offline.html)
//   and the logged-out /login shell. The manifest is a route (#188), not a static file,
//   so it isn't precached — it passes straight to the network (5-min HTTP cache).
// - Navigations: network-only; on a network failure we serve the cached /login shell for
//   /login, else static/offline.html. Logged-in HTML is NEVER stored — no stale-auth pages.
// - /_app/immutable/*: cache-first (content-hashed file names).
// - /img/* and /api/avatar/*: stale-while-revalidate, capped at RUNTIME_MAX entries, image
//   responses only; cleared on sign-out.
// - Everything else (/api/*, __data.json, /auth/*, /logout, /p/*, non-GET, cross-origin)
//   is not intercepted — straight to the network.
import { build, files, version } from '$service-worker';
import { swPolicyFor } from '$lib/sw-policy';

const sw = self as unknown as ServiceWorkerGlobalScope;

// `version` changes on every deploy, so each deploy gets fresh caches; activate drops old ones.
const PRECACHE = `precache-${version}`;
const RUNTIME = `runtime-${version}`;
const RUNTIME_MAX = 150;
const OFFLINE_URL = '/offline.html';
const LOGIN_URL = '/login';

const PRECACHE_URLS = new Set([...build, ...files]);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(PRECACHE);
			await cache.addAll([...PRECACHE_URLS]);
			// The login shell is best-effort, and fetched without cookies so a signed-in
			// user's redirect to the dashboard can never be stored under /login.
			try {
				const res = await fetch(LOGIN_URL, { credentials: 'omit', redirect: 'manual' });
				if (res.ok) await cache.put(LOGIN_URL, res);
			} catch {
				/* offline at install — the offline page still covers /login */
			}
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== PRECACHE && key !== RUNTIME) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

async function navigate(request: Request, path: string): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		const cache = await caches.open(PRECACHE);
		return (
			(path === LOGIN_URL ? await cache.match(LOGIN_URL) : undefined) ??
			(await cache.match(OFFLINE_URL)) ??
			Response.error()
		);
	}
}

async function cacheFirst(request: Request): Promise<Response> {
	const hit = await caches.match(request);
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok) {
		const cache = await caches.open(PRECACHE);
		await cache.put(request, res.clone());
	}
	return res;
}

async function trim(cache: Cache) {
	const keys = await cache.keys();
	for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(request: Request, event: FetchEvent): Promise<Response> {
	const cache = await caches.open(RUNTIME);
	const hit = await cache.match(request);
	const refresh = fetch(request).then(async (res) => {
		// Only real images: an expired session redirects /api/avatar to /login (HTML).
		if (res.ok && !res.redirected && res.headers.get('content-type')?.startsWith('image/')) {
			await cache.put(request, res.clone());
			await trim(cache);
		}
		return res;
	});
	if (hit) {
		event.waitUntil(refresh.catch(() => undefined));
		return hit;
	}
	return refresh;
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	// Signing out drops cached contact avatars/images (the POST itself goes to the network).
	// This side effect lives outside swPolicyFor — it isn't a routing decision, and the
	// policy function already treats non-GET requests as passthrough. Guarded by origin
	// here too, matching the original same-origin-only fetch handling.
	if (url.origin === sw.location.origin && request.method === 'POST' && url.pathname === '/logout') {
		event.waitUntil(caches.delete(RUNTIME));
		return;
	}

	const policy = swPolicyFor({
		url,
		method: request.method,
		mode: request.mode,
		origin: sw.location.origin,
		precached: (path) => PRECACHE_URLS.has(path)
	});

	switch (policy) {
		case 'navigate':
			event.respondWith(navigate(request, url.pathname));
			return;
		case 'cache-first':
			event.respondWith(cacheFirst(request));
			return;
		case 'swr-media':
			event.respondWith(staleWhileRevalidate(request, event));
			return;
		case 'passthrough':
			return;
	}
});
