import { describe, it, expect } from 'vitest';
import { CSRF_EXEMPT } from '../src/hooks.server';

// #749 structural guard: the hook skips its same-origin check for every CSRF_EXEMPT prefix,
// so no route under one may act on the session. Fails when a server route file beneath an
// exempt prefix reads `locals.user`, `locals.authed` or the session cookie. The list is read
// from the hook itself, so a new exempt prefix is covered without editing this test.
// Sources are bundled at build time (no fs in workerd).

const routeFiles = import.meta.glob(
	['../src/routes/**/+server.ts', '../src/routes/**/+page.server.ts', '../src/routes/**/+layout.server.ts'],
	{ query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

/** The URL path a route file serves: `(group)` folders dropped, the file name removed. */
function routePath(file: string): string {
	const segs = file
		.slice('../src/routes'.length)
		.split('/')
		.slice(0, -1)
		.filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segs.join('/');
}

function underPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix + '/');
}

const SESSION_READS: { what: string; re: RegExp }[] = [
	{ what: 'locals.user', re: /\blocals\s*\??\.\s*user\b/ },
	{ what: 'locals.authed', re: /\blocals\s*\??\.\s*authed\b/ },
	{ what: 'locals destructured for user / authed', re: /\blocals\s*:\s*\{[^}]*\b(?:user|authed)\b/ },
	{ what: 'SESSION_COOKIE', re: /\bSESSION_COOKIE\b/ },
	{ what: "the 'session' cookie name", re: /cookies\s*\.\s*\w+\(\s*['"`]session['"`]/ }
];

/** A route file key as the glob gives it. */
const R = (path: string) => `../src/routes/${path}`;

const exemptFiles = Object.keys(routeFiles).filter((f) => CSRF_EXEMPT.some((p) => underPrefix(routePath(f), p)));

describe('structural: CSRF-exempt routes never act on the session (#749)', () => {
	it('reads the exempt list from the hook and finds its route files', () => {
		expect(CSRF_EXEMPT).toContain('/api/ingest');
		expect(CSRF_EXEMPT).toContain('/newsletter/subscribe');
		expect(exemptFiles).toContain(R('api/ingest/+server.ts'));
		expect(exemptFiles).toContain(R('newsletter/subscribe/+server.ts'));
		expect(exemptFiles).toContain(R('unsubscribe/one-click/+server.ts'));
		// Siblings outside an exempt prefix are not swept in.
		expect(exemptFiles).not.toContain(R('unsubscribe/+page.server.ts'));
	});

	it('maps route files to URL paths', () => {
		expect(routePath('../src/routes/api/v1/contacts/[id]/+server.ts')).toBe('/api/v1/contacts/[id]');
		expect(routePath('../src/routes/(app)/f/[slug]/+page.server.ts')).toBe('/f/[slug]');
		expect(underPrefix('/fx/a', '/f')).toBe(false);
	});

	it('no route file under an exempt prefix reads locals.user, locals.authed or the session cookie', () => {
		const offenders: string[] = [];
		for (const f of exemptFiles) {
			for (const { what, re } of SESSION_READS) if (re.test(routeFiles[f])) offenders.push(`${f} reads ${what}`);
		}
		expect(offenders).toEqual([]);
	});

	it('other locals reads are fine (the archive flag in the newsletter sign-up)', () => {
		const src = routeFiles[R('newsletter/subscribe/+server.ts')];
		expect(src).toMatch(/locals\??\.archivePublic/);
		expect(SESSION_READS.some(({ re }) => re.test(src))).toBe(false);
		expect(SESSION_READS.some(({ re }) => re.test('event.locals.archivePublic'))).toBe(false);
		expect(SESSION_READS.some(({ re }) => re.test('if (event.locals.user?.role)'))).toBe(true);
	});
});
