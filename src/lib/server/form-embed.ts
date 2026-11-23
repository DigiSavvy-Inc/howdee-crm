// Forms: share & embed (#515), server side. `{{form:<slug>}}` links carry `?c=<token>`: the
// site-tracking link token (`signVisitorToken`, contact id + 30-day expiry, HMAC with
// SESSION_SECRET). The public page prefills + hides the email from it; the submit re-checks it
// and attributes the submission to that contact.
import { sessionSecret } from './token';
import { verifyVisitorToken } from './track-token';

export type FormLinkContact = { id: number; email: string };

/** A valid, unexpired token for a contact that still exists → that contact; else null. */
export async function formContactFromToken(
	db: D1Database,
	env: { SESSION_SECRET?: string } | null | undefined,
	token: string | null | undefined
): Promise<FormLinkContact | null> {
	const secret = sessionSecret(env);
	const t = await verifyVisitorToken(secret, token);
	if (!t) return null;
	const row = await db.prepare('SELECT id, email FROM contacts WHERE id = ?').bind(t.c).first<FormLinkContact>();
	return row && row.email ? row : null;
}

/**
 * Join point with the default security headers (hooks.server.ts): /f/* pages set their own CSP
 * `frame-ancestors` (an embedded form — `?embed=1` — may be framed by the form's allowed origins,
 * or anywhere when none are set; everything else `'self'`). A blanket `X-Frame-Options` must not
 * override that, so it is removed, and a /f/* response without its own frame-ancestors gets `'self'`.
 */
export function formFrameHeaders(path: string, res: Response): Response {
	if (!path.startsWith('/f/')) return res;
	const apply = (r: Response) => {
		const csp = r.headers.get('content-security-policy');
		if (!csp || !/frame-ancestors/i.test(csp)) {
			r.headers.set('content-security-policy', csp ? `${csp}; frame-ancestors 'self'` : "frame-ancestors 'self'");
		}
		r.headers.delete('x-frame-options');
		return r;
	};
	try {
		return apply(res);
	} catch {
		// Immutable headers (e.g. a fetched response): copy, then set.
		return apply(new Response(res.body, res));
	}
}
