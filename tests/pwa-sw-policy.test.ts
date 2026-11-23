import { describe, it, expect } from 'vitest';
import { swPolicyFor, type SwPolicy } from '../src/lib/sw-policy';
// The manifest is a route since #188 (branding settings); with default branding it must
// match what static/manifest.webmanifest used to ship.
import { buildManifest } from '../src/lib/server/branding';
import { DEFAULT_BRANDING, PRODUCT_NAME } from '../src/lib/branding';

const ORIGIN = 'https://app.example';

function policyFor(opts: {
	path: string;
	method?: string;
	mode?: RequestMode;
	precached?: (path: string) => boolean;
}): SwPolicy {
	const url = new URL(opts.path, ORIGIN);
	return swPolicyFor({
		url,
		method: opts.method ?? 'GET',
		mode: opts.mode ?? 'same-origin',
		origin: ORIGIN,
		precached: opts.precached ?? (() => false)
	});
}

describe('swPolicyFor', () => {
	it('cross-origin requests are passthrough', () => {
		const url = new URL('https://evil.example/x');
		expect(
			swPolicyFor({ url, method: 'GET', mode: 'same-origin', origin: ORIGIN, precached: () => false })
		).toBe('passthrough');
	});

	it('POST /logout is passthrough (the cache-clear side effect is handled outside this function)', () => {
		expect(policyFor({ path: '/logout', method: 'POST' })).toBe('passthrough');
	});

	it('POST /api/v1/contacts is passthrough', () => {
		expect(policyFor({ path: '/api/v1/contacts', method: 'POST' })).toBe('passthrough');
	});

	it('a plain navigation is routed to navigate', () => {
		expect(policyFor({ path: '/contacts', mode: 'navigate' })).toBe('navigate');
	});

	it('navigations to /p/*, /auth/*, /logout are passthrough', () => {
		expect(policyFor({ path: '/p/slug', mode: 'navigate' })).toBe('passthrough');
		expect(policyFor({ path: '/auth/github/callback', mode: 'navigate' })).toBe('passthrough');
		expect(policyFor({ path: '/logout', mode: 'navigate' })).toBe('passthrough');
	});

	it('/_app/immutable/* is cache-first', () => {
		expect(policyFor({ path: '/_app/immutable/chunks/a.js' })).toBe('cache-first');
	});

	it('a precached asset with no query string is cache-first', () => {
		expect(
			policyFor({ path: '/icons/icon-192.png', precached: (p) => p === '/icons/icon-192.png' })
		).toBe('cache-first');
	});

	it('the same precached asset with a query string is passthrough', () => {
		expect(
			policyFor({
				path: '/icons/icon-192.png?v=2',
				precached: (p) => p === '/icons/icon-192.png'
			})
		).toBe('passthrough');
	});

	it('/img/* is stale-while-revalidate', () => {
		expect(policyFor({ path: '/img/abc' })).toBe('swr-media');
	});

	it('/api/avatar/* is stale-while-revalidate', () => {
		expect(policyFor({ path: '/api/avatar/5' })).toBe('swr-media');
	});

	it('/api/avatar/* with ?refresh= is passthrough', () => {
		expect(policyFor({ path: '/api/avatar/5?refresh=1' })).toBe('passthrough');
	});

	it('GET /api/v1/contacts is passthrough', () => {
		expect(policyFor({ path: '/api/v1/contacts' })).toBe('passthrough');
	});

	it('/__data.json is passthrough', () => {
		expect(policyFor({ path: '/__data.json' })).toBe('passthrough');
	});
});

describe('manifest sanity', () => {
	const manifest = buildManifest(DEFAULT_BRANDING);

	it('has the expected name/short_name/start_url/display', () => {
		expect(manifest.name).toBe(PRODUCT_NAME);
		expect(manifest.short_name).toBe(PRODUCT_NAME);
		expect(manifest.start_url).toBe('/');
		expect(manifest.display).toBe('standalone');
	});

	it('has three icons including one maskable', () => {
		expect(manifest.icons).toHaveLength(3);
		const maskable = manifest.icons.filter((i: { purpose?: string }) => i.purpose === 'maskable');
		expect(maskable).toHaveLength(1);
	});

	// NOTE: we can't verify these files actually exist under static/ here — workerd has no
	// filesystem access, so an `fs.existsSync` check isn't possible in this test runner. This is a static assertion on the recorded paths only;
	// `npm run build` (which inlines these via the SvelteKit static asset pipeline) is what
	// would actually fail if one of these files went missing.
	it('icon paths are rooted under /icons/', () => {
		for (const icon of manifest.icons) {
			expect(icon.src).toMatch(/^\/icons\//);
		}
	});
});
