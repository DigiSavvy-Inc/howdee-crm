import { error, fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getPasswordHash, getUserById, setUserEmail } from '$lib/server/users';
import { changeOwnPassword } from '$lib/server/account-password';
import { checkCurrentPassword, currentPasswordLockedMessage } from '$lib/server/login-attempts';
import { recordRequest, requestIp, requestLimited, sendVerification, type AccountEnv } from '$lib/server/account-tokens';
import { isEmail } from '$lib/csv';
import { setSuggestionsPanel, suggestionsPanelOn } from '$lib/server/suggestions/panel-pref';

// #211: every signed-in user's own account — profile + set/change password.
export const load: PageServerLoad = async (event) => {
	const me = event.locals.user;
	if (!me) throw error(401, 'Sign in first.');
	const row = await getUserById(getDB(event), me.id);
	if (!row) throw error(404, 'User not found.');
	return {
		account: {
			github_login: row.github_login,
			github_id: row.github_id,
			name: row.name,
			avatar_url: row.avatar_url,
			role: row.role,
			last_login_at: row.last_login_at,
			hasPassword: !!row.has_password,
			passwordSetAt: row.password_set_at,
			mustChange: !!row.must_change_password,
			email: row.email,
			emailVerified: !!row.email_verified_at
		},
		// #715: Show the suggestions panel (users.suggestions_panel, default on).
		suggestionsPanel: await suggestionsPanelOn(getDB(event), me.id)
	};
};

export const actions: Actions = {
	password: changeOwnPassword,

	// #715: show or hide the suggestions panel for yourself only. The suggestions still exist for
	// the rest of the team; the panel and its count read this through `suggestionViewer`.
	suggestionsPanel: async (event) => {
		const me = event.locals?.user ?? null;
		if (!me) return fail(401, { panelError: 'Sign in first.' });
		const data = await event.request.formData();
		const on = data.get('show') === '1';
		if (!(await setSuggestionsPanel(getDB(event), me.id, on))) {
			return fail(503, { panelError: 'This setting needs the latest database migration first.' });
		}
		return { panelOk: on ? 'The suggestions panel is on for you.' : 'The suggestions panel is hidden for you.' };
	},

	// #639: change your own email. Needs your current password when you have one (the address
	// is where resets go). The new address is unverified until its link is opened.
	email: async (event) => {
		const me = event.locals?.user ?? null;
		if (!me) return fail(401, { emailError: 'Sign in first.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '').trim().toLowerCase();
		if (email && (email.length > 254 || !isEmail(email))) {
			return fail(400, { emailError: "That doesn't look like an email address." });
		}
		const ip = requestIp(event);
		const stored = await getPasswordHash(db, me.id);
		if (stored) {
			// #750: wrong current passwords count toward a lockout, like sign-in.
			const check = await checkCurrentPassword(db, {
				userId: me.id,
				password: String(data.get('current_password') ?? ''),
				storedHash: stored,
				ip
			});
			if (!check.ok && check.status === 429) return fail(429, { emailError: currentPasswordLockedMessage(check.minutes) });
			if (!check.ok) return fail(400, { emailError: 'Your current password is incorrect.' });
		}
		const row = await getUserById(db, me.id);
		if ((row?.email ?? '').toLowerCase() === email) return { emailOk: 'Nothing changed.' };
		// #750: the confirmation mail a change sends shares the "send a new link" limit (per new
		// address and per IP). Refused before anything is saved.
		if (email && (await requestLimited(db, 'verify', email, ip))) {
			return fail(429, { emailError: 'Too many emails sent recently. Try again in an hour.' });
		}
		if (!(await setUserEmail(db, me.id, email))) return fail(400, { emailError: 'Another user already has that address.' });
		if (!email) return { emailOk: 'Email removed. Password reset is off until you add one.' };
		await recordRequest(db, 'verify', email, ip);
		const sent = await sendVerification(db, (event.platform?.env ?? {}) as AccountEnv, me.id);
		return sent.ok
			? { emailOk: `Saved. Open the link we sent to ${email} to confirm it.` }
			: { emailOk: `Saved, but the confirmation email failed: ${sent.error}` };
	},

	resendVerify: async (event) => {
		const me = event.locals?.user ?? null;
		if (!me) return fail(401, { emailError: 'Sign in first.' });
		const db = getDB(event);
		const row = await getUserById(db, me.id);
		if (!row?.email) return fail(400, { emailError: 'Add an email address first.' });
		if (await requestLimited(db, 'verify', row.email, requestIp(event))) {
			return fail(429, { emailError: 'Too many emails sent recently. Try again in an hour.' });
		}
		await recordRequest(db, 'verify', row.email, requestIp(event));
		const sent = await sendVerification(db, (event.platform?.env ?? {}) as AccountEnv, me.id);
		return sent.ok ? { emailOk: `Sent a new link to ${row.email}.` } : fail(400, { emailError: sent.error });
	}
};
