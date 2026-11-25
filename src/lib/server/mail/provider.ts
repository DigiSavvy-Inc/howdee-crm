// #700 (1/5 of #699): the sending-provider interface. Every email the app sends goes through a
// `MailProvider`; Postmark is the first adapter (`./postmark.ts`). Spec + user docs:
// docs/sending-providers.md. No feature imports an adapter (or the low-level `../postmark.ts`)
// directly: they call `providerFor(env, config)` / `getMailProvider(db, env)` from `./index.ts`.
//
// This module is types and the provider list only — no adapter imports — so light modules (the
// assistant, setup checks) can use it without reaching the sending code.

export type MailProviderId = 'postmark' | 'resend' | 'ses' | 'smtp';

/** Every provider the docs describe, in the order Settings → Sending lists them. `available` =
 *  its adapter exists in this build; the others show as "coming soon" and can't be made active. */
export const MAIL_PROVIDERS: readonly { id: MailProviderId; label: string; available: boolean }[] = [
	{ id: 'postmark', label: 'Postmark', available: true },
	{ id: 'resend', label: 'Resend', available: false },
	{ id: 'ses', label: 'Amazon SES', available: false },
	{ id: 'smtp', label: 'Custom SMTP', available: false }
];

export const DEFAULT_MAIL_PROVIDER: MailProviderId = 'postmark';

export function isMailProviderId(v: unknown): v is MailProviderId {
	return typeof v === 'string' && MAIL_PROVIDERS.some((p) => p.id === v);
}

export function mailProviderAvailable(id: MailProviderId): boolean {
	return MAIL_PROVIDERS.find((p) => p.id === id)?.available === true;
}

export function mailProviderLabel(id: string | null | undefined): string {
	return MAIL_PROVIDERS.find((p) => p.id === id)?.label ?? String(id ?? '');
}

/** #701: who tracks opens and clicks — the provider (default) or the CRM's own pixel and signed
 *  links (Settings → Sending, `MAIL_TRACKING`). */
export type TrackingMode = 'provider' | 'crm';

export function isTrackingMode(v: unknown): v is TrackingMode {
	return v === 'provider' || v === 'crm';
}

/** Broadcast (marketing) or transactional mail. Each provider maps it to its own streams,
 *  configuration sets or tags. */
export type MailStream = 'broadcast' | 'transactional';

export type MailHeader = { name: string; value: string };

export type LinkTracking = 'none' | 'html_and_text' | 'html_only' | 'text_only';

/** A provider-neutral message. */
export type OutboundMessage = {
	from: string;
	to: string;
	replyTo?: string;
	bcc?: string;
	subject: string;
	html: string;
	text: string;
	/** `List-Unsubscribe`, `List-Unsubscribe-Post`, `In-Reply-To`, `References`, … */
	headers?: MailHeader[];
	stream: MailStream;
	/** A provider-specific stream name that wins over `stream` (callers that still name the
	 *  Postmark stream they want). Adapters without streams ignore it. */
	streamName?: string;
	/** Left out = the provider's own default (Postmark: the server setting). */
	tracking?: { opens?: boolean; links?: LinkTracking };
	metadata?: { campaignId?: number; contactId?: number | null; sendId?: number };
};

/** One result per message, same order. A failure is `permanent` when retrying can't help (bad
 *  address, suppressed recipient) — the engine fails fast on those, and a refusal at send time
 *  is a hard bounce. `transport` = the request itself failed, so whether the provider took the
 *  message is unknown. `raw` = the provider's own result object. */
export type SendResult =
	| { ok: true; messageId: string; code?: number; message?: string; raw?: unknown }
	| { ok: false; error: string; permanent: boolean; code?: number; transport?: boolean; raw?: unknown };

/**
 * The per-recipient result the shared send path hands back to its callers (the automation
 * engine classifies `ErrorCode`). Kept in Postmark's field names because every caller and the
 * stored history were built on them; other providers fill it from their `SendResult`
 * (`toMailResult`). `ErrorCode` 0 = accepted.
 */
export type MailResult = {
	ErrorCode: number;
	Message: string;
	MessageID?: string;
	To?: string;
	SubmittedAt?: string;
	Transport?: boolean;
	Permanent?: boolean;
};

/** Neutral → caller shape. A Postmark result passes through unchanged. */
export function toMailResult(r: SendResult | undefined | null): MailResult | undefined {
	if (!r) return undefined;
	const raw = r.raw as Partial<MailResult> | undefined;
	if (raw && typeof raw === 'object' && typeof raw.ErrorCode === 'number') return raw as MailResult;
	if (r.ok) return { ErrorCode: r.code ?? 0, Message: r.message ?? 'OK', MessageID: r.messageId };
	return {
		ErrorCode: r.code ?? -1,
		Message: r.error,
		...(r.transport ? { Transport: true } : {}),
		...(r.permanent ? { Permanent: true } : {})
	};
}

export type MailCapabilities = {
	/** Can track opens and clicks itself. */
	tracking: boolean;
	/** Its own suppression list: synced both ways, only read, or none. */
	suppressions: 'both' | 'read' | 'none';
	/** Sends delivery / bounce / complaint / open / click events to a webhook. */
	webhooks: boolean;
	/** Inbound mail (reply capture). */
	inbound: boolean;
	/** Domain verification status through its API. */
	domainApi: boolean;
	/** Separate broadcast and transactional streams. */
	streams: boolean;
};

/** One line per capability for Settings → Sending (the docs' table rows). */
export function capabilityLines(id: MailProviderId, c: MailCapabilities, trackingBy?: TrackingMode): string[] {
	const label = mailProviderLabel(id);
	const providerTracks = c.tracking && trackingBy !== 'crm';
	return [
		c.streams ? 'Separate broadcast and transactional streams' : 'One account for broadcast and transactional mail',
		providerTracks ? `Opens and clicks tracked by ${label}` : 'Opens and clicks tracked by the CRM',
		c.webhooks ? 'Bounces, complaints, opens and clicks arrive by webhook' : 'No event webhook',
		c.suppressions === 'both'
			? `${label} suppression list synced both ways`
			: c.suppressions === 'read'
				? `${label} suppression list read only`
				: 'No provider suppression list: the CRM list only',
		c.domainApi ? 'Domain status shown in the app' : 'Domain status: check DNS yourself',
		'Reply capture: Postmark Inbound'
	];
}

/** A suppression on the provider's own list. `reason` is the provider's word (Postmark:
 *  HardBounce | SpamComplaint | ManualSuppression); `hard` = a bounce or complaint, one an
 *  operator must not resubscribe over. `scope` = where it sits (Postmark: the stream). */
export type ProviderSuppression = { email: string; reason: string; hard: boolean; scope?: string; createdAt?: string };

export type SuppressionMap = Map<string, { reason: string; stream: string }>;

export type ProviderSuppressions = {
	list(since?: string): AsyncIterable<ProviderSuppression>;
	add(email: string, reason: 'bounce' | 'complaint' | 'unsubscribe'): Promise<{ ok: boolean; message?: string }>;
	/** `scope` = where the entry sits (Postmark: its stream); unset = the provider decides. */
	remove(email: string, scope?: string): Promise<{ ok: boolean; message?: string }>;
	/** Many at once (bulk unsubscribe); a failed request is counted and the rest continue. */
	addMany(emails: string[], reason: 'bounce' | 'complaint' | 'unsubscribe'): Promise<{ suppressed: number; failed: number }>;
	/** The whole list keyed by lowercased email (a hard entry wins); `errors` = one line per
	 *  part that couldn't be read, `read` = parts read. */
	byEmail(): Promise<{ map: SuppressionMap; errors: string[]; read: number }>;
	/** The scopes `byEmail` reads, for messages ("Postmark sync (broadcast)"). */
	scopes(): string[];
};

/** A normalised provider event. `raw` = the provider payload, for `events.detail`. */
export type MailEventType = 'delivery' | 'open' | 'click' | 'bounce' | 'spam' | 'unsubscribe';

export type MailEvent = {
	type: MailEventType;
	/** Bounces: a hard (permanent) bounce suppresses the contact; a soft one is only recorded. */
	hard?: boolean;
	messageId: string | null;
	email: string | null;
	at: string | null;
	/** Clicks: the original link. */
	link?: string | null;
	dedupeKey: string | null;
	raw: Record<string, unknown>;
};

/** Thrown by `parseWebhook` when the request isn't signed / keyed correctly (→ 401). */
export class WebhookAuthError extends Error {
	constructor(message = 'unauthorized') {
		super(message);
		this.name = 'WebhookAuthError';
	}
}

export type DomainStatus = {
	domain: string;
	/** Known to the provider at all. */
	found: boolean;
	verified: boolean;
	dkim: boolean | null;
	returnPath: boolean | null;
	error?: string;
};

/** One row of a provider check, shaped like a Settings → Setup row. */
export type ProviderCheckRow = {
	id: string;
	group: 'required' | 'postmark';
	label: string;
	state: 'ready' | 'attention' | 'optional';
	detail: string;
	fix?: string;
	href?: string;
};

export type ProviderCheck = {
	/** Credentials accepted and the streams exist. */
	ok: boolean;
	summary: string;
	rows: ProviderCheckRow[];
};

export interface MailProvider {
	id: MailProviderId;
	label: string;
	/** Messages per `sendBatch` call. */
	maxBatch: number;
	streams: { broadcast: string; transactional: string };
	capabilities: MailCapabilities;
	/** #701: who tracks opens and clicks for mail sent through this provider. Unset = the
	 *  provider (how every send worked before). `crm` = the send path adds the CRM's pixel and
	 *  signed links and asks the provider not to track. Set by `providerFor` from the install's
	 *  setting; always `crm` when `capabilities.tracking` is false. */
	trackingBy?: TrackingMode;
	/** One result per message, same order. Never throws on a provider failure: a failed request
	 *  comes back as `ok: false` results (a throw is still caught by the send path). */
	sendBatch(messages: OutboundMessage[]): Promise<SendResult[]>;
	suppressions?: ProviderSuppressions;
	parseWebhook?(request: Request): Promise<MailEvent[]>;
	domainStatus?(domain: string): Promise<DomainStatus>;
	/** Settings → Sending's Test connection and Settings → Setup. Sends nothing. */
	check(fetchFn?: typeof fetch): Promise<ProviderCheck>;
}

/** Stream kind for a stream name the caller passed (legacy callers name the Postmark stream). */
export function streamKindFor(provider: Pick<MailProvider, 'streams'>, name: string | null | undefined): MailStream {
	const n = (name ?? '').trim();
	return n && n === provider.streams.transactional && n !== provider.streams.broadcast ? 'transactional' : 'broadcast';
}

/** A neutral message for a stream name: the kind, plus the name itself when the provider
 *  doesn't know it (so a caller's explicit stream is never silently changed). */
export function streamFields(provider: Pick<MailProvider, 'streams'>, name: string | null | undefined): { stream: MailStream; streamName?: string } {
	const kind = streamKindFor(provider, name);
	const n = (name ?? '').trim();
	return n && n !== provider.streams[kind] ? { stream: kind, streamName: n } : { stream: kind };
}
