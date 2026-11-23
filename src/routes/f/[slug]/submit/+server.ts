import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { getForm, signSubmissionId } from '$lib/server/forms';
import { handleSubmission, waitUntilFor, HONEYPOT_NAME, UTM_KEYS, type SubmitEnv } from '$lib/server/form-submit';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { sessionSecret } from '$lib/server/token';
import { emailField, type RawAnswers } from '$lib/forms';
import { formContactFromToken } from '$lib/server/form-embed';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Public form submit (#509). POST only; in PUBLIC_PREFIXES + CSRF_EXEMPT — `handleSubmission`
 * checks the Origin per form instead. A fetch (Accept: application/json) gets JSON; a native
 * post gets a 303 to the thanks page (or back to the form with `?error=`).
 */
export const POST: RequestHandler = async (event) => {
	const slug = String(event.params.slug ?? '').toLowerCase();
	const wantsJson = (event.request.headers.get('accept') ?? '').includes('application/json');
	const db = getDB(event);
	const form = await getForm(db, slug);
	if (!form || form.status !== 'published' || form.slug !== slug) {
		return json({ ok: false, error: 'This form isn’t available.' }, { status: 404, headers: NO_STORE });
	}

	const answers: RawAnswers = {};
	const extra: Record<string, string> = {};
	const ctype = event.request.headers.get('content-type') ?? '';
	try {
		if (ctype.includes('application/json')) {
			const body = (await event.request.json()) as Record<string, unknown>;
			for (const [k, v] of Object.entries(body && typeof body === 'object' ? body : {})) {
				const vals = Array.isArray(v) ? v.map(String) : v === null || v === undefined ? [] : [String(v)];
				if (k.startsWith('_')) extra[k] = vals[0] ?? '';
				else answers[k] = vals.length > 1 ? vals : vals[0];
			}
		} else {
			const fd = await event.request.formData();
			for (const k of new Set(fd.keys())) {
				const vals = fd.getAll(k).filter((x): x is string => typeof x === 'string');
				if (k.startsWith('_')) extra[k] = vals[0] ?? '';
				else answers[k] = vals.length > 1 ? vals : vals[0];
			}
		}
	} catch {
		return json({ ok: false, error: 'Couldn’t read the form.' }, { status: 400, headers: NO_STORE });
	}

	const utm: Record<string, string> = {};
	for (const k of UTM_KEYS) if (extra[`_${k}`]) utm[k] = extra[`_${k}`].slice(0, 200);
	const env = (event.platform?.env ?? {}) as SubmitEnv;
	const baseUrl = await publicBaseUrlFor(event);
	// #515: a {{form:<slug>}} link's signed contact token — its address wins over the (hidden) answer.
	if (extra._c) {
		const contact = await formContactFromToken(db, env, extra._c);
		const em = emailField(form.spec);
		if (contact && em) answers[em.key] = contact.email;
	}
	const embedded = event.url.searchParams.get('embed') === '1';
	const result = await handleSubmission(
		db,
		env,
		form,
		{
			answers,
			honeypot: extra[HONEYPOT_NAME] ?? null,
			utm,
			referrer: extra._ref || event.request.headers.get('referer'),
			// #515: the host page of an embedded form (embed.js passes it to the iframe).
			pageUrl: extra._page_url || null,
			userAgent: event.request.headers.get('user-agent')
		},
		{
			origin: event.request.headers.get('origin'),
			crmOrigins: [event.url.origin, baseUrl],
			ip: event.request.headers.get('cf-connecting-ip'),
			baseUrl,
			waitUntil: waitUntilFor(event)
		}
	);

	if (wantsJson) {
		const { ok, redirect, message_html, errors, error } = result;
		const headers: Record<string, string> = { ...NO_STORE };
		if (result.status === 429) headers['retry-after'] = '600';
		return json({ ok, redirect, message_html, errors, error }, { status: result.status, headers });
	}
	if (result.ok && result.submissionId) {
		const s = await signSubmissionId(sessionSecret(env), result.submissionId);
		return new Response(null, { status: 303, headers: { ...NO_STORE, location: `/f/${form.slug}/thanks?s=${encodeURIComponent(s)}${embedded ? '&embed=1' : ''}` } });
	}
	return new Response(null, { status: 303, headers: { ...NO_STORE, location: `/f/${form.slug}?error=${encodeURIComponent(result.detail)}${embedded ? '&embed=1' : ''}` } });
};
