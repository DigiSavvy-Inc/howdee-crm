import { error } from '@sveltejs/kit';
import { KIT_LOGO_KEY_RE, LOGO_KEY_RE } from '$lib/branding';

// Public R2 media responses, shared by /img/[key], /img/branding/[file] and the newsletter
// archive's /newsletter/img/[...rest] (#491) so every path serves the same bytes and headers.

/** Uploaded media (#61). Keys are random UUIDs. */
export async function serveMedia(bucket: R2Bucket | undefined, key: string): Promise<Response> {
	if (!bucket || !/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(key)) throw error(404, 'Not found');

	const obj = await bucket.get(key);
	if (!obj) throw error(404, 'Not found');

	return new Response(obj.body, {
		headers: {
			'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
			etag: obj.httpEtag
		}
	});
}

/** The uploaded app logo (#188) and brand kit logos (#595) under R2 `branding/…`. Keys are content hashes, so the
 *  response is immutable. SVGs get a sandboxing CSP in case one is opened directly — inside
 *  an <img> they can't run script anyway. */
export async function serveBrandingLogo(bucket: R2Bucket | undefined, file: string): Promise<Response> {
	const key = `branding/${file}`;
	if (!bucket || !(LOGO_KEY_RE.test(key) || KIT_LOGO_KEY_RE.test(key))) throw error(404, 'Not found');

	const obj = await bucket.get(key);
	if (!obj) throw error(404, 'Not found');

	const headers: Record<string, string> = {
		'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
		'Cache-Control': 'public, max-age=31536000, immutable',
		'X-Content-Type-Options': 'nosniff',
		etag: obj.httpEtag
	};
	if (key.endsWith('.svg')) {
		headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
	}
	return new Response(obj.body, { headers });
}
