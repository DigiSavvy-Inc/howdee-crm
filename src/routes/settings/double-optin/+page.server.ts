import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getDoiConfig, saveDoiConfig, sendDoiTest } from '$lib/server/double-optin';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { validateDoiText } from '$lib/double-optin';

// Settings → Double opt-in (#510), admin-only (load + every action): the confirmation
// email, the /confirm page's button + after message, the link expiry. Stored in app_state
// `double_optin`. Whether a sign-up needs confirming is set per form / webhook key / request.

function requireAdmin(event: { locals: App.Locals }) {
	if (event.locals.user?.role !== 'admin') throw error(403, 'Admins only.');
}

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const db = getDB(event);
	const pending = await db
		.prepare('SELECT COUNT(*) AS n FROM contacts WHERE confirm_pending = 1')
		.first<{ n: number }>();
	const keys = await db
		.prepare('SELECT COUNT(*) AS n FROM webhook_keys WHERE require_confirm = 1 AND revoked_at IS NULL')
		.first<{ n: number }>();
	return { config: await getDoiConfig(db), pending: pending?.n ?? 0, keysRequiring: keys?.n ?? 0 };
};

export const actions: Actions = {
	save: async (event) => {
		requireAdmin(event);
		const data = await event.request.formData();
		const get = (k: string) => String(data.get(k) ?? '');
		const res = validateDoiText({
			subject: get('subject'),
			body: get('body'),
			button: get('button'),
			afterMessage: get('afterMessage'),
			redirectUrl: get('redirectUrl'),
			expiryHours: get('expiryHours')
		});
		if (!res.ok) return fail(400, { error: res.error });
		await saveDoiConfig(getDB(event), res.value);
		return { saved: true };
	},

	// Send me a test: the saved email to the signed-in user's address, with a preview link.
	test: async (event) => {
		requireAdmin(event);
		const db = getDB(event);
		const me = await db.prepare('SELECT email FROM users WHERE id = ?').bind(event.locals.user!.id).first<{ email: string | null }>();
		if (!me?.email) return fail(400, { testError: 'Add an email address to your user record (Account) first.' });
		const res = await sendDoiTest(db, event.platform?.env ?? {}, me.email, { baseUrl: await publicBaseUrlFor(event) });
		if (!res.ok) return fail(400, { testError: res.error });
		return { testSent: me.email };
	}
};
