// Double opt-in (#510): the confirmation email + /confirm page config, its validation and the
// status vocabulary. Universal (no server imports). Stored in app_state `double_optin` (JSON),
// like the unsubscribe page (#374). Sending + confirming live in `src/lib/server/double-optin.ts`.

import { cleanLinkUrl } from './unsubscribe-page';

export const DOI_KEY = 'double_optin';

export const EXPIRY_HOURS = [24, 48, 72] as const;
export type ExpiryHours = (typeof EXPIRY_HOURS)[number];

/** A confirmation can be re-sent at most this many times, this far apart. */
export const RESEND_MAX = 3;
export const RESEND_GAP_MINUTES = 10;

export const SUBJECT_MAX = 150;
export const BODY_MAX = 4000;
export const BUTTON_MAX = 40;
export const AFTER_MAX = 1000;

export const DEFAULT_SUBJECT = 'Please confirm your subscription';
export const DEFAULT_BODY =
	'Hi {{first_name}},\n\nThanks for signing up. Please confirm your subscription so we can start sending you email:\n\n{{confirm_url}}\n\nIf you didn’t sign up, ignore this email and you won’t hear from us again.';
export const DEFAULT_BUTTON = 'Confirm my subscription';
export const DEFAULT_AFTER = 'Thanks for confirming. You’ll start getting our emails soon.';

export const CONFIRM_URL_TAG = '{{confirm_url}}';

export type DoiConfig = {
	subject: string;
	/** Markdown; must contain {{confirm_url}}. {{first_name}} (and the other merge tags) allowed. */
	body: string;
	/** The button on the /confirm page (and in the email). */
	button: string;
	/** Shown on the page after confirming. Markdown. */
	afterMessage: string;
	/** Optional http(s) "next" link shown after confirming. */
	redirectUrl: string;
	expiryHours: ExpiryHours;
};

export const DEFAULT_DOI: DoiConfig = {
	subject: DEFAULT_SUBJECT,
	body: DEFAULT_BODY,
	button: DEFAULT_BUTTON,
	afterMessage: DEFAULT_AFTER,
	redirectUrl: '',
	expiryHours: 48
};

const isExpiry = (n: unknown): n is ExpiryHours => (EXPIRY_HOURS as readonly unknown[]).includes(n);

/** Stored JSON → config. Lenient: junk → defaults, a body without {{confirm_url}} → the default body. */
export function normalizeDoi(raw: unknown): DoiConfig {
	let o: Record<string, unknown> = {};
	if (typeof raw === 'string') {
		try {
			const p = JSON.parse(raw);
			if (p && typeof p === 'object') o = p;
		} catch {
			/* defaults */
		}
	} else if (raw && typeof raw === 'object') o = raw as Record<string, unknown>;
	const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
	const body = s(o.body);
	const hours = Number(o.expiryHours);
	return {
		subject: s(o.subject).slice(0, SUBJECT_MAX) || DEFAULT_SUBJECT,
		body: body && body.includes(CONFIRM_URL_TAG) ? body.slice(0, BODY_MAX) : DEFAULT_BODY,
		button: s(o.button).slice(0, BUTTON_MAX) || DEFAULT_BUTTON,
		afterMessage: s(o.afterMessage).slice(0, AFTER_MAX),
		redirectUrl: cleanLinkUrl(s(o.redirectUrl)) ?? '',
		expiryHours: isExpiry(hours) ? hours : 48
	};
}

export type DoiInput = Partial<Record<'subject' | 'body' | 'button' | 'afterMessage' | 'redirectUrl' | 'expiryHours', string>>;

/** The strict save check (Settings → Double opt-in). */
export function validateDoiText(input: DoiInput): { ok: true; value: DoiConfig } | { ok: false; error: string } {
	const t = (v: string | undefined) => (v ?? '').trim();
	const subject = t(input.subject);
	if ([...subject].length > SUBJECT_MAX) return { ok: false, error: `The subject must be ${SUBJECT_MAX} characters or fewer.` };
	const body = t(input.body);
	if (!body) return { ok: false, error: 'The email needs a body.' };
	if ([...body].length > BODY_MAX) return { ok: false, error: `The email body must be ${BODY_MAX.toLocaleString('en-US')} characters or fewer.` };
	if (!body.includes(CONFIRM_URL_TAG)) return { ok: false, error: `The email body must contain ${CONFIRM_URL_TAG}, where the confirm link goes.` };
	const button = t(input.button);
	if ([...button].length > BUTTON_MAX) return { ok: false, error: `The button label must be ${BUTTON_MAX} characters or fewer.` };
	const afterMessage = t(input.afterMessage);
	if ([...afterMessage].length > AFTER_MAX) return { ok: false, error: `The after-confirm message must be ${AFTER_MAX.toLocaleString('en-US')} characters or fewer.` };
	const rawUrl = t(input.redirectUrl);
	const redirectUrl = rawUrl ? cleanLinkUrl(rawUrl) : '';
	if (rawUrl && !redirectUrl) return { ok: false, error: 'The next link must be an http(s) URL.' };
	const hours = Number(t(input.expiryHours) || 48);
	if (!isExpiry(hours)) return { ok: false, error: 'Pick a link expiry: 24, 48 or 72 hours.' };
	return {
		ok: true,
		value: {
			subject: subject || DEFAULT_SUBJECT,
			body,
			button: button || DEFAULT_BUTTON,
			afterMessage,
			redirectUrl: redirectUrl ?? '',
			expiryHours: hours
		}
	};
}

export type SubscriptionStatus = 'subscribed' | 'unsubscribed' | 'pending';

export function subscriptionStatus(subscribed: unknown, confirmPending: unknown): SubscriptionStatus {
	if (subscribed === 1 || subscribed === true) return 'subscribed';
	return confirmPending === 1 || confirmPending === true ? 'pending' : 'unsubscribed';
}

/** "subscribed" / "unsubscribed" / "pending confirmation" — the assistant's wording. */
export function subscriptionStatusText(subscribed: unknown, confirmPending: unknown): string {
	const s = subscriptionStatus(subscribed, confirmPending);
	return s === 'pending' ? 'pending confirmation' : s;
}

/** The /confirm page's states. */
export type ConfirmState = 'ready' | 'confirmed' | 'already' | 'expired' | 'invalid' | 'refused' | 'resent';
