// #700: the one way features reach a sending provider. See ./provider.ts for the interface and
// docs/sending-providers.md for the spec.

import { postmarkProvider } from './postmark';
import { resendProvider } from './resend';
import { resolveMailCredentials, type MailCredentials } from './config';
import type { MailProvider, TrackingMode } from './provider';

export * from './provider';
export {
	fromPostmarkMessage,
	toPostmarkMessage,
	fromPostmarkResult,
	postmarkCheckRows,
	postmarkProvider,
	webhookMatches,
	webhookTarget,
	mapPostmarkEvent,
	isHardSuppression,
	suppressionStreams,
	type PostmarkMessage,
	type PostmarkResult
} from './postmark';
export {
	credentialError,
	resolveMailCredentials,
	resolvePostmarkCreds,
	type MailCredentials
} from './config';
export {
	fromResendBatch,
	mapResendEvent,
	parseResendWebhook,
	resendCheckRows,
	resendDomainStatus,
	resendProvider,
	svixSignature,
	toResendEmail,
	verifySvix,
	RESEND_MAX_BATCH,
	type ResendEmail,
	type ResendMapped
} from './resend';

/** The Worker env, or any env-shaped object (tests, callers' own env types). */
type AnyEnv = unknown;

/**
 * The provider for resolved credentials, or null when the active provider isn't configured
 * (Postmark: no server token; Resend: no API key). `env` is the Worker's environment, for values a provider reads
 * that Settings doesn't hold.
 */
export function providerFor(_env: AnyEnv, config: MailCredentials): MailProvider | null {
	switch (config.provider) {
		case 'resend': {
			// #702. The stream names are the ones callers still pass (Postmark's), so a caller that
			// names the transactional stream gets the `transactional` tag.
			const rs = config.resend;
			if (!rs?.apiKey) return null;
			return withTracking(
				resendProvider({
					apiKey: rs.apiKey,
					broadcast: config.postmark.stream,
					transactional: config.postmark.txStream,
					webhookSecret: rs.webhookSecret
				}),
				config
			);
		}
		case 'postmark':
		default: {
			const pm = config.postmark;
			if (!pm.token) return null;
			return withTracking(
				postmarkProvider({
					token: pm.token,
					broadcast: pm.stream,
					transactional: pm.txStream,
					webhookKey: pm.webhookKey,
					accountToken: pm.accountToken
				}),
				config
			);
		}
	}
}

/** #701: who tracks for this install — the setting, and always the CRM for a provider that
 *  can't track itself. */
export function trackingModeFor(capabilities: MailProvider['capabilities'], config: Pick<MailCredentials, 'tracking'>): TrackingMode {
	return !capabilities.tracking ? 'crm' : config.tracking === 'crm' ? 'crm' : 'provider';
}

function withTracking(provider: MailProvider, config: MailCredentials): MailProvider {
	provider.trackingBy = trackingModeFor(provider.capabilities, config);
	return provider;
}

/** The active provider for this install (Settings → Sending, then the Worker env). Null when it
 *  isn't configured. */
export async function getMailProvider(db: D1Database | null | undefined, env: AnyEnv): Promise<MailProvider | null> {
	return providerFor(env, await resolveMailCredentials(db, env));
}

/** The provider and the credentials it was built from (routes still read the Postmark token /
 *  stream names to keep their "missing env" errors). */
export async function mailSetup(db: D1Database | null | undefined, env: AnyEnv): Promise<{ provider: MailProvider | null; creds: MailCredentials }> {
	const creds = await resolveMailCredentials(db, env);
	return { provider: providerFor(env, creds), creds };
}

/** A legacy credential bundle, as callers and tests have always passed one. */
export type MailCreds = { token?: string | null; stream?: string | null; txStream?: string | null };
/** What helpers accept: a provider, or a Postmark credential bundle. */
export type MailSource = MailProvider | MailCreds | null | undefined;

export function isMailProvider(v: unknown): v is MailProvider {
	return !!v && typeof v === 'object' && typeof (v as MailProvider).sendBatch === 'function' && typeof (v as MailProvider).check === 'function';
}

/** A provider for whatever the caller handed over: the provider itself, or a Postmark adapter
 *  for a `{ token, stream, txStream }` bundle (null without a token). */
export function asMailProvider(src: MailSource): MailProvider | null {
	if (!src) return null;
	if (isMailProvider(src)) return src;
	const token = (src.token ?? '').trim();
	if (!token) return null;
	return postmarkProvider({ token, broadcast: (src.stream ?? '').trim(), transactional: (src.txStream ?? '').trim() || undefined });
}
