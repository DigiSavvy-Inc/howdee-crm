// #731: the setup link the deploy prints is `/setup#token=<SETUP_TOKEN>`. The token sits in the
// fragment, so the browser never sends it to the server or a log; the /setup page reads it here.
// Universal (no server imports).

/** Longest token accepted from a link (the deploy generates 32 base64url characters). */
export const SETUP_LINK_TOKEN_MAX = 512;

/** The `token` value of a `#token=…` fragment ('' when absent or unusable). */
export function tokenFromHash(hash: string | null | undefined): string {
	const raw = String(hash ?? '').replace(/^#/, '');
	if (!raw) return '';
	let value: string | null;
	try {
		value = new URLSearchParams(raw).get('token');
	} catch {
		return '';
	}
	const t = (value ?? '').trim();
	if (!t || t.length > SETUP_LINK_TOKEN_MAX || /[\u0000-\u001f\u007f]/.test(t)) return '';
	return t;
}
