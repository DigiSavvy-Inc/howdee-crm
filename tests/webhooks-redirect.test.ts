import { describe, it, expect } from 'vitest';
import { GET } from '../src/routes/webhooks/+server';

function ev(path: string) {
	return { url: new URL('https://app.test' + path) } as any;
}

describe('GET /webhooks (#136)', () => {
	it('301s to /settings/webhooks', async () => {
		const res = await GET(ev('/webhooks'));
		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe('/settings/webhooks');
	});

	it('preserves the query string', async () => {
		const res = await GET(ev('/webhooks?key=3&x=a%20b'));
		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe('/settings/webhooks?key=3&x=a%20b');
	});
});
