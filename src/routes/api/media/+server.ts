import { json, type RequestHandler } from '@sveltejs/kit';
import { publicBaseUrlFor } from '$lib/server/public-url';

// Image upload for the block builder (#61). Session-authed (NOT in PUBLIC_PREFIXES —
// hooks redirect unauthed requests). Stores in the MEDIA R2 bucket; returns an absolute
// URL (emails need absolute src), served back via /img/[key].
const ALLOWED: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
	// no AVIF: email clients can't show it; the editor converts it to WebP before upload (#496)
	// no SVG: same-origin inline scripts in SVG are an XSS vector on hosted pages
};
const MAX_BYTES = 5 * 1024 * 1024;

export const POST: RequestHandler = async (event) => {
	const bucket = event.platform?.env?.MEDIA;
	if (!bucket) return json({ error: 'media storage not configured' }, { status: 500 });

	let file: File | null = null;
	try {
		const fd = await event.request.formData();
		const f = fd.get('file');
		if (f instanceof File) file = f;
	} catch {
		return json({ error: 'invalid upload' }, { status: 400 });
	}
	if (!file || file.size === 0) return json({ error: 'no file' }, { status: 400 });
	if (file.size > MAX_BYTES) return json({ error: 'file too large (5 MB max)' }, { status: 413 });
	const ext = ALLOWED[file.type];
	if (!ext) return json({ error: 'unsupported type (png, jpg, gif, webp; avif is converted in the browser)' }, { status: 415 });

	const key = `${crypto.randomUUID()}.${ext}`;
	await bucket.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' }
	});

	const base = await publicBaseUrlFor(event);
	return json({ ok: true, url: `${base}/img/${key}`, key });
};
