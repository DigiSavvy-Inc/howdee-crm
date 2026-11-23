// #496: AVIF never reaches storage. The browser-side conversion (prepareImageForUpload /
// convertFileInput) lives in @digisavvy/block-editor and is tested there (#558); this file
// keeps the app's /api/media checks.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST as mediaPOST } from '../src/routes/api/media/+server';

const avif = () => new File(['avif-bytes'], 'photo.avif', { type: 'image/avif' });

describe('/api/media (#496)', () => {
	function ev(file: File) {
		const fd = new FormData();
		fd.append('file', file);
		const stored: string[] = [];
		const url = 'https://crm.test/api/media';
		return {
			stored,
			event: {
				request: new Request(url, { method: 'POST', body: fd }),
				url: new URL(url),
				platform: {
					env: {
						...(env as any),
						MEDIA: {
							async put(key: string) {
								stored.push(key);
							}
						}
					}
				}
			} as any
		};
	}

	it('refuses AVIF with 415 and the new message', async () => {
		const { event, stored } = ev(avif());
		const res = await mediaPOST(event);
		expect(res.status).toBe(415);
		expect(((await res.json()) as any).error).toBe('unsupported type (png, jpg, gif, webp; avif is converted in the browser)');
		expect(stored).toHaveLength(0);
	});

	it('stores WebP', async () => {
		const { event, stored } = ev(new File(['webp'], 'a.webp', { type: 'image/webp' }));
		const res = await mediaPOST(event);
		expect(res.status).toBe(200);
		const j = (await res.json()) as any;
		expect(j.url).toMatch(/\/img\/[0-9a-f-]{36}\.webp$/);
		expect(stored[0]).toMatch(/\.webp$/);
	});
});
