import { error, type RequestHandler } from '@sveltejs/kit';
import { MEDIA_KEY_RE } from '$lib/unsubscribe-page';

/** Serve the unsubscribe page's uploaded video / poster (#374) from R2 `unsubscribe/…`.
 *  Public via the `/img` prefix (the page has no session). Keys are random UUIDs, so the
 *  response is immutable. Byte ranges are honoured — Safari / iOS won't play a video without. */
export const GET: RequestHandler = async (event) => {
	const bucket = event.platform?.env?.MEDIA;
	const key = `unsubscribe/${event.params.file ?? ''}`;
	if (!bucket || !MEDIA_KEY_RE.test(key)) throw error(404, 'Not found');

	const range = parseRange(event.request.headers.get('range'));
	let obj: R2ObjectBody | R2Object | null;
	try {
		obj = await bucket.get(key, range ? { range } : undefined);
	} catch {
		// R2 refuses a range past the end of the object.
		const head = await bucket.head(key);
		if (!head) throw error(404, 'Not found');
		return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
	}
	if (!obj || !('body' in obj)) throw error(404, 'Not found');

	const headers: Record<string, string> = {
		'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
		'Cache-Control': 'public, max-age=31536000, immutable',
		'X-Content-Type-Options': 'nosniff',
		'Accept-Ranges': 'bytes',
		etag: obj.httpEtag
	};
	if (range && obj.range && 'offset' in obj.range) {
		const offset = obj.range.offset ?? 0;
		if (offset >= obj.size) {
			return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${obj.size}` } });
		}
		const length = Math.min(obj.range.length ?? obj.size - offset, obj.size - offset);
		headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
		headers['Content-Length'] = String(length);
		return new Response(obj.body, { status: 206, headers });
	}
	if (range && obj.range && 'suffix' in obj.range) {
		const length = Math.min(obj.range.suffix, obj.size);
		headers['Content-Range'] = `bytes ${obj.size - length}-${obj.size - 1}/${obj.size}`;
		headers['Content-Length'] = String(length);
		return new Response(obj.body, { status: 206, headers });
	}
	headers['Content-Length'] = String(obj.size);
	return new Response(obj.body, { headers });
};

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` → an R2 range; anything else (incl. multi-range) → none. */
function parseRange(h: string | null): R2Range | null {
	const m = /^bytes=(\d*)-(\d*)$/.exec((h ?? '').trim());
	if (!m || (m[1] === '' && m[2] === '')) return null;
	if (m[1] === '') return { suffix: Number(m[2]) };
	const offset = Number(m[1]);
	if (m[2] === '') return { offset };
	const end = Number(m[2]);
	return end >= offset ? { offset, length: end - offset + 1 } : null;
}
