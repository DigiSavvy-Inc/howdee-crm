// #741: return paths refuse a backslash. Browsers read `/\host` as `//host` (another site), and
// SvelteKit 3's redirect() throws (a 500) for an external location it wasn't allowed to follow, so
// such a value must fall back to the default page instead.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { isLocalPath } from '../src/lib/local-path';
import { nextStepHref } from '../src/lib/suggestions-panel';
import { actions as deliverabilityActions } from '../src/routes/deliverability/+page.server';

const db = (env as unknown as { DB: D1Database }).DB;

describe('#741 isLocalPath', () => {
	it('accepts same-site paths only', () => {
		expect(isLocalPath('/deliverability?x=1')).toBe(true);
		expect(isLocalPath('/')).toBe(true);
		expect(isLocalPath('//evil.example')).toBe(false);
		expect(isLocalPath('/\\evil.example')).toBe(false);
		expect(isLocalPath('/a\\b')).toBe(false);
		expect(isLocalPath('https://evil.example/')).toBe(false);
		expect(isLocalPath('deliverability')).toBe(false);
		expect(isLocalPath('')).toBe(false);
		// URL parsers drop tab, CR and LF: each of these is //evil.example once parsed.
		expect(isLocalPath('/\t/evil.example')).toBe(false);
		expect(isLocalPath('/\n/evil.example')).toBe(false);
		expect(isLocalPath('/\r/evil.example')).toBe(false);
		expect(isLocalPath('/a\tb')).toBe(false);
		expect(isLocalPath('/a\u0000b')).toBe(false);
		expect(isLocalPath('/a\u007fb')).toBe(false);
		expect(new URL('/\t/evil.example', 'https://app.test').host).toBe('evil.example');
		// Query strings and hashes are fine.
		expect(isLocalPath('/campaigns?x=1&y=2#top')).toBe(true);
		expect(isLocalPath('/contacts/1#email')).toBe(true);
	});

	it('a suggestion step with a backslash path opens the home page', () => {
		expect(nextStepHref({ type: 'open', url: '/\\evil.example' }, null)).toBe('/');
		expect(nextStepHref({ type: 'open', url: '/contacts/1' }, null)).toBe('/contacts/1');
	});
});

describe('#741 deliverability back= with a backslash', () => {
	async function dismissWith(back: string): Promise<unknown> {
		const fd = new FormData();
		fd.set('id', '999999'); // no such alert: dismissAlert is a no-op, the redirect still runs
		fd.set('back', back);
		const event = {
			locals: { user: { id: 1, role: 'admin' } },
			platform: { env: { DB: db } },
			url: new URL('https://app.test/deliverability?/dismissAlert'),
			request: new Request('https://app.test/deliverability?/dismissAlert', { method: 'POST', body: fd })
		} as any;
		try {
			await deliverabilityActions.dismissAlert(event);
		} catch (e) {
			return e;
		}
		return null;
	}

	it('returns to /deliverability instead of throwing', async () => {
		const e = await dismissWith('/\\evil.example');
		expect(isRedirect(e)).toBe(true);
		expect((e as { location: string }).location).toBe('/deliverability');
	});

	it('a tab-hidden second slash returns to /deliverability too', async () => {
		const e = await dismissWith('/\t/evil.example');
		expect(isRedirect(e)).toBe(true);
		expect((e as { location: string }).location).toBe('/deliverability');
	});

	it('a normal same-site path is kept', async () => {
		const e = await dismissWith('/campaigns?x=1');
		expect(isRedirect(e)).toBe(true);
		expect((e as { location: string }).location).toBe('/campaigns?x=1');
	});
});
