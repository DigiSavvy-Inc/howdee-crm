import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { buildSignature, clearSignature, getSignatureSetting, saveSignature } from '$lib/server/email-signature';

// Settings → Signature (#594), admin-only (load + every action): the signature appended to
// every email (HTML part + plain-text part). Simple text or pasted HTML (sanitised on save).
// Stored in app_state `email_signature_html` / `_text` / `_source`; none = no signature.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { signature: await getSignatureSetting(getDB(event)) };
};

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const get = (k: string) => String(data.get(k) ?? '');
		const res = buildSignature({
			mode: get('mode') === 'html' ? 'html' : 'simple',
			source: get('source'),
			html: get('html'),
			text: get('text')
		});
		if (!res.ok) return fail(400, { error: res.error });
		await saveSignature(getDB(event), res.value);
		return { saved: true, empty: !res.value.html.trim() && !res.value.text.trim() };
	},

	clear: async (event) => {
		requireAdmin(event);
		await clearSignature(getDB(event));
		return { cleared: true };
	}
};
