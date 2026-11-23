import { error, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { archivePageCtx } from '$lib/server/archive-public';
import { PUBLIC_PAGE_HEADERS } from '$lib/server/public-csp';
import { getArchiveSettings, renderSubscribePage, signupFormFor } from '$lib/server/newsletter-archive';
import { handleSubmission, waitUntilFor, HONEYPOT_NAME, type SubmitEnv } from '$lib/server/form-submit';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { ARCHIVE_SUBSCRIBE_PATH } from '$lib/newsletter-archive';
import type { RawAnswers } from '$lib/forms';

const NO_STORE = { 'cache-control': 'no-store' };
const see = (location: string) => new Response(null, { status: 303, headers: { ...NO_STORE, location } });

/** #587: the archive's sign-up form on its own page (the popup's no-popover fallback and a
 *  shareable address). `?error=<code>` after a failed post. 404 while the archive is off or no
 *  usable form is chosen. Public (PUBLIC_PREFIXES), also on the public host. */
export const GET: RequestHandler = async (event) => {
	const db = getDB(event);
	const code = event.url.searchParams.get('error');
	const html = await renderSubscribePage(db, await archivePageCtx(event), code);
	if (!html) throw error(404, 'Not found');
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': code ? 'no-store' : 'public, max-age=300',
			...PUBLIC_PAGE_HEADERS
		}
	});
};

/** #587: the popup's / page's native post. The chosen form goes through `handleSubmission` exactly
 *  like /f/[slug]/submit (rate limit, origin, honeypot, validation, double opt-in, outcomes,
 *  notifications). The request's own origin counts as allowed — the public host or the CRM host.
 *  Success → 303 to /newsletter/subscribe/thanks (which shows the message, or forwards to the
 *  outcome's redirect); failure → 303 back to /newsletter/subscribe?error=<code>. CSRF-exempt in
 *  hooks (handleSubmission checks the Origin). Root-relative Locations only. */
export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	const settings = await getArchiveSettings(db);
	const form = settings.enabled ? await signupFormFor(db, settings) : null;
	if (!form) throw error(404, 'Not found');

	const answers: RawAnswers = {};
	const extra: Record<string, string> = {};
	try {
		const fd = await event.request.formData();
		for (const k of new Set(fd.keys())) {
			const vals = fd.getAll(k).filter((x): x is string => typeof x === 'string');
			if (k.startsWith('_')) extra[k] = vals[0] ?? '';
			else answers[k] = vals.length > 1 ? vals : vals[0];
		}
	} catch {
		return see(`${ARCHIVE_SUBSCRIBE_PATH}?error=invalid`);
	}

	const env = (event.platform?.env ?? {}) as SubmitEnv;
	const baseUrl = await publicBaseUrlFor(event);
	const pub = event.locals?.archivePublic?.base;
	const result = await handleSubmission(
		db,
		env,
		form,
		{
			answers,
			honeypot: extra[HONEYPOT_NAME] ?? null,
			utm: null,
			referrer: event.request.headers.get('referer'),
			userAgent: event.request.headers.get('user-agent')
		},
		{
			origin: event.request.headers.get('origin'),
			crmOrigins: [event.url.origin, baseUrl, ...(pub ? [pub] : [])],
			ip: event.request.headers.get('cf-connecting-ip'),
			baseUrl,
			waitUntil: waitUntilFor(event)
		}
	);
	if (result.ok) return see(`${ARCHIVE_SUBSCRIBE_PATH}/thanks`);
	return see(`${ARCHIVE_SUBSCRIBE_PATH}?error=${encodeURIComponent(result.detail)}`);
};
