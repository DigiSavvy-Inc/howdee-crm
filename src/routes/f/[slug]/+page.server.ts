import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getForm } from '$lib/server/forms';
import { emailField, isAnswerType } from '$lib/forms';
import { UTM_KEYS } from '$lib/server/form-submit';
import { frameAncestors, validOrigins } from '$lib/form-embed';
import { formContactFromToken } from '$lib/server/form-embed';

/** Native-post failures come back as `?error=<code>`. */
const SUBMIT_ERRORS: Record<string, string> = {
	invalid: 'Please check your answers and try again.',
	rate_limit: 'Too many submissions. Please try again in a few minutes.',
	origin: 'This form can’t be submitted from here.',
	failed: 'Something went wrong. Please try again.'
};

/** Public form (#509): published only — drafts, archived and unknown slugs 404. */
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const form = await getForm(db, String(event.params.slug ?? '').toLowerCase());
	if (!form || form.status !== 'published' || form.slug !== String(event.params.slug ?? '').toLowerCase()) {
		throw error(404, 'Not found');
	}

	// Prefill: `?email=` and `?<key>=` for any question, `utm_*` kept for the submission.
	const q = event.url.searchParams;
	const prefill: Record<string, string | string[]> = {};
	for (const f of form.spec.fields) {
		if (!isAnswerType(f.type)) continue;
		const all = q.getAll(f.key).map((v) => v.slice(0, 500));
		if (all.length) prefill[f.key] = f.type === 'checkboxes' || f.type === 'topics' ? all : all[0];
	}
	for (const k of UTM_KEYS) {
		const v = q.get(k);
		if (v) prefill[k] = v.slice(0, 200);
	}

	// #515: `?c=` from a {{form:<slug>}} email link — a valid token fills the email question and
	// hides it (the submit re-checks the token); unknown / expired = the plain form.
	const c = q.get('c');
	const contact = c ? await formContactFromToken(db, event.platform?.env, c) : null;
	const em = emailField(form.spec);
	if (contact && em) prefill[em.key] = contact.email;

	// #515: embedded mode (`?embed=1`, from embed.js or the iframe snippet): host origin + page.
	const embed = q.get('embed') === '1';
	const allowed = validOrigins(form.spec.settings.allowed_origins);
	const hostOrigin = embed ? hostOriginParam(q.get('origin'), allowed) : null;

	const errCode = q.get('error');
	// 5 minutes, per URL (prefill is in the query); the ETag moves with each published save.
	// A signed link carries an address: never cached.
	event.setHeaders({
		'cache-control': errCode || contact || c ? 'private, no-store' : 'public, max-age=300',
		...(contact || c ? {} : { etag: `W/"form-${form.id}-v${form.version}"` }),
		...(form.spec.settings.noindex ? { 'x-robots-tag': 'noindex' } : {}),
		// #515: only an embedded page may be framed, and only by the allowed origins (any when none).
		'content-security-policy': frameAncestors(allowed, embed)
	});
	return {
		form: { id: form.id, slug: form.slug, name: form.name, version: form.version },
		spec: form.spec,
		prefill,
		submitError: errCode ? (SUBMIT_ERRORS[errCode] ?? SUBMIT_ERRORS.failed) : null,
		// #515
		embed: embed
			? {
					origin: hostOrigin,
					pageUrl: (q.get('page_url') ?? '').slice(0, 500) || null,
					referrer: (q.get('referrer') ?? '').slice(0, 500) || null
				}
			: null,
		contactToken: contact && em ? c : null,
		lockedKey: contact && em ? em.key : null
	};
};

/** `?origin=` from embed.js: kept only when it's an origin the form allows (or any, when none are set). */
function hostOriginParam(raw: string | null, allowed: string[]): string | null {
	if (!raw) return null;
	let o: string;
	try {
		o = new URL(raw).origin.toLowerCase();
	} catch {
		return null;
	}
	if (o === 'null' || !/^https?:/.test(o)) return null;
	return !allowed.length || allowed.includes(o) ? o : null;
}
