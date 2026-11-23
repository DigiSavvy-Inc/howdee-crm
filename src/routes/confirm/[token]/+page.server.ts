import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB } from '$lib/server/db';
import { getUnsubPage } from '$lib/server/unsubscribe-page';
import { confirmSubscription, getDoiConfig, peekConfirmation, resendConfirmation } from '$lib/server/double-optin';

// Double opt-in (#510): the confirm link. GET only shows the page with one button — mail
// scanners and link previews follow GETs, so a GET must never confirm. The button POSTs
// `?/confirm`; an expired link offers `?/resend` (rate-limited by the module).

function noIndex(event: { setHeaders: (h: Record<string, string>) => void }) {
	event.setHeaders({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
}

export const load: PageServerLoad = async (event) => {
	noIndex(event);
	const db = getDB(event);
	const cfg = await getDoiConfig(db);
	const peek = await peekConfirmation(db, event.params.token);
	return {
		cfg,
		accent: (await getUnsubPage(db)).accent,
		state: peek.state === 'confirmed' ? ('already' as const) : peek.state,
		email: peek.state === 'invalid' ? '' : peek.email,
		canResend: peek.state === 'expired' ? peek.canResend : false
	};
};

export const actions: Actions = {
	confirm: async (event) => {
		const db = getDB(event);
		const res = await confirmSubscription(db, event.platform?.env ?? {}, event.params.token ?? '', { actor: 'self' });
		if (res.invalid) return fail(404, { state: 'invalid' as const, email: '' });
		if (res.expired) return fail(410, { state: 'expired' as const, email: res.email ?? '' });
		if (res.refused) return fail(409, { state: 'refused' as const, email: res.email ?? '', error: res.error ?? '' });
		return { state: res.alreadyConfirmed ? ('already' as const) : ('confirmed' as const), email: res.email ?? '' };
	},
	resend: async (event) => {
		const db = getDB(event);
		const res = await resendConfirmation(db, event.platform?.env ?? {}, event.params.token ?? '');
		if (res.invalid) return fail(404, { state: 'invalid' as const, email: '' });
		if (res.alreadyConfirmed) return { state: 'already' as const, email: '' };
		if (!res.sent) {
			const error =
				res.reason === 'rate_limited'
					? 'A new link was sent recently, or the limit for new links was reached. Check your inbox, or try again in a few minutes.'
					: 'We couldn’t send a new link right now. Please try again later.';
			return fail(res.reason === 'rate_limited' ? 429 : 502, { state: 'expired' as const, email: '', error });
		}
		return { state: 'resent' as const, email: '' };
	}
};
