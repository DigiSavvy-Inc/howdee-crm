import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { FINISH_SETUP_SENDING } from '$lib/finish-setup';

/** Get the D1 binding or fail loudly (helps when platform proxy isn't wired in dev). */
export function getDB(event: { platform?: App.Platform }): D1Database {
	const db = event.platform?.env?.DB;
	if (!db) {
		throw error(
			500,
			'D1 binding (DB) is not available. Run via `npm run dev` so the Cloudflare platform proxy is active.'
		);
	}
	return db;
}

/** Read a required config/secret value from the platform env. */
export function env<K extends keyof Env>(event: RequestEvent, key: K): Env[K] {
	const val = event.platform?.env?.[key];
	if (val === undefined || val === null || val === '') {
		throw error(500, `Missing required env: ${String(key)}`);
	}
	return val as Env[K];
}

// #731: the shared "Finish setup" messages (one constant each, universal module).
export { FINISH_SETUP_FROM, FINISH_SETUP_SENDING } from '$lib/finish-setup';

/**
 * #731: true when no sending provider is configured yet: the provider resolution
 * (`providerFor` / `mailSetup`) found none and nothing saved is merely unreadable. Form actions
 * check it before any write and answer `fail(409, …)` with `FINISH_SETUP_SENDING` inline; an
 * unreadable saved token still goes through `mailToken` (a 500, as before).
 */
export function sendingUnconfigured(provider: unknown, creds: CredsLike): boolean {
	return !provider && !activeError(creds);
}

/** #702: the slice of MailCredentials these helpers read (tests pass a Postmark-only shape). */
type CredsLike = {
	provider?: string;
	postmark: { token: string; tokenError: string | null };
	resend?: { apiKey: string; apiKeyError: string | null };
};

/** The active provider's unreadable-secret error (Postmark token, or #702 the Resend key). */
function activeError(creds: CredsLike): string | null {
	return creds.provider === 'resend' ? (creds.resend?.apiKeyError ?? null) : creds.postmark.tokenError;
}

/**
 * #700: the Postmark server token the mail config resolved (Settings → Sending, else
 * POSTMARK_TOKEN). A token saved in Settings that can't be read → a 500 with that message, never
 * the env token (docs/sending-providers.md). #731: none at all → a 409 "Finish setup" (an install
 * that hasn't connected a provider yet), not a 500.
 */
export function mailToken(_event: RequestEvent, creds: CredsLike): string {
	// #702: with Resend active the routes send through the provider; the Postmark token they still
	// thread is only a fallback no caller uses then, so it may be ''.
	if (creds.provider === 'resend') {
		if (creds.resend?.apiKeyError) throw error(500, creds.resend.apiKeyError);
		if (!creds.resend?.apiKey) throw error(409, FINISH_SETUP_SENDING);
		return creds.postmark.token;
	}
	if (creds.postmark.tokenError) throw error(500, creds.postmark.tokenError);
	if (!creds.postmark.token) throw error(409, FINISH_SETUP_SENDING);
	return creds.postmark.token;
}
