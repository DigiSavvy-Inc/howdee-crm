// #750: read a webhook request body with a size cap. A provider event is a few KB (a bounce
// with its content a few hundred KB at most), so anything above the cap is refused (413) before
// it is parsed or stored.

export const WEBHOOK_BODY_MAX_BYTES = 2 * 1024 * 1024;

export class BodyTooLargeError extends Error {
	constructor() {
		super('request body too large');
		this.name = 'BodyTooLargeError';
	}
}

/**
 * The body as text, or throws BodyTooLargeError when it is (or says it is) over `max` bytes.
 * Reads the stream itself so an oversized body without a Content-Length is cut off early.
 */
export async function readCappedText(request: Request, max = WEBHOOK_BODY_MAX_BYTES): Promise<string> {
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError();
	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > max) {
			try {
				await reader.cancel();
			} catch {
				/* already closed */
			}
			throw new BodyTooLargeError();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return new TextDecoder().decode(out);
}
