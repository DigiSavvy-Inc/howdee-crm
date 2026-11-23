import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getForm, getSubmission, verifySubmissionId } from '$lib/server/forms';
import { finishFor } from '$lib/server/form-submit';
import { sessionSecret } from '$lib/server/token';
import { frameAncestors } from '$lib/form-embed';

/**
 * Where a native (no-JS) submit lands (#509): `?s=` is the signed submission id. Shows the
 * form's thank-you message, or follows its redirect. A bad / foreign token → 404.
 */
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const slug = String(event.params.slug ?? '').toLowerCase();
	const form = await getForm(db, slug);
	if (!form || form.status !== 'published' || form.slug !== slug) throw error(404, 'Not found');
	const id = await verifySubmissionId(sessionSecret(event.platform?.env), event.url.searchParams.get('s'));
	const sub = id ? await getSubmission(db, id) : null;
	if (!sub || sub.form_id !== form.id) throw error(404, 'Not found');
	// #514: the outcomes this submission fired (contact-aware rules can't be re-run here); rows
	// from before migration 0126 evaluate the answer rules again.
	const finish = finishFor(form, sub.answers, { fired: sub.outcomes });
	if (finish.redirect) throw redirect(303, finish.redirect);
	const embed = event.url.searchParams.get('embed') === '1';
	event.setHeaders({
		'cache-control': 'no-store',
		'x-robots-tag': 'noindex',
		// #515: a no-JS submit inside an embed lands here, still inside the frame.
		'content-security-policy': frameAncestors(form.spec.settings.allowed_origins, embed)
	});
	return { title: form.spec.title, style: form.spec.style, message_html: finish.message_html ?? '' };
};
