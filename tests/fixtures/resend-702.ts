// #702: Resend request / response / webhook fixtures, shaped after Resend's documented API
// (batch send, errors, webhook event payloads). Written by hand from the docs' shapes — not
// captured from a live account — with invented ids and addresses. Replace them with recorded
// copies once a real Resend account has sent through this build (see the hand-off notes).

export const FAKE_RESEND_KEY = 're_test_FakeKeyForTests0000000000'; // gitleaks:allow
// Base64 of 24 fixed bytes, Svix style. Not a real secret.
export const FAKE_WEBHOOK_SECRET = 'whsec_' + btoa('fake-webhook-secret-0702!'); // gitleaks:allow

/** `POST /emails/batch` → 200: one id per message, in order. */
export const batchOk = (n: number, prefix = 'rs-msg') => ({ data: Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` })) });

export const errorRateLimit = { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. You can only make 10 requests per second.' };
export const errorRestricted = { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' };
export const errorInvalidKey = { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' };
/** An inactive key: 403 with the same name as a sending-only key. */
export const errorInactiveKey = { statusCode: 403, name: 'restricted_api_key', message: 'API key is not active' };
/** A bad key on an endpoint other than sending. */
export const errorInvalidKeyValidation = { statusCode: 400, name: 'validation_error', message: 'API key is invalid' };
/** 422: a field is missing or has a bad value. */
export const errorInvalidParameter = { statusCode: 422, name: 'invalid_parameter', message: 'The `from` field is invalid.' };
/** 400 validation_error: one invalid email fails the whole batch. */
export const errorBatchValidation = {
	statusCode: 400,
	name: 'validation_error',
	message: 'Invalid `to` field. The email address needs to follow the `email@example.com` format.'
};
/** 409: an earlier request with the same Idempotency-Key is still being processed. */
export const errorConcurrentIdempotent = {
	statusCode: 409,
	name: 'concurrent_idempotent_requests',
	message: 'Same idempotency key used while original request is still in progress. It is safe to retry this request later.'
};
export const errorDailyQuota = { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' };

export const domainsList = {
	object: 'list',
	data: [
		{ id: 'dom-1', name: 'ourco.example', status: 'verified', created_at: '2026-11-01 10:00:00.000000+00', region: 'us-east-1' },
		{ id: 'dom-2', name: 'news.ourco.example', status: 'pending', created_at: '2026-11-02 10:00:00.000000+00', region: 'us-east-1' }
	]
};

export const domainDetail = (tracking: { open: boolean; click: boolean } | null) => ({
	object: 'domain',
	id: 'dom-1',
	name: 'ourco.example',
	status: 'verified',
	region: 'us-east-1',
	records: [
		{ record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'verified', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
		{ record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'verified', value: '"v=spf1 include:amazonses.com ~all"' },
		{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'p=FAKEPUBLICKEY' },
		// The Forge record: stays not_started while Forge is off, and is not part of the return path.
		{ record: 'SPF', name: 'forge', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'forge.resend.example' }
	],
	...(tracking ? { open_tracking: tracking.open, click_tracking: tracking.click } : {})
});

const base = (type: string, emailId: string, to: string, extra: Record<string, unknown> = {}) => ({
	type,
	created_at: '2026-11-25T10:00:05.000Z',
	data: {
		created_at: '2026-11-25T10:00:00.000Z',
		email_id: emailId,
		from: 'News <news@ourco.example>',
		to: [to],
		subject: 'November news',
		tags: { stream: 'broadcast', campaign_id: '1' },
		...extra
	}
});

export const evDelivered = (id: string, to: string) => base('email.delivered', id, to);
/** Resend's `email.opened` documents no `open` object: no user agent, no open time. */
export const evOpened = (id: string, to: string) => base('email.opened', id, to);
export const evClicked = (id: string, to: string, link = 'https://ourco.example/pricing') =>
	base('email.clicked', id, to, { click: { ipAddress: '192.0.2.10', link, timestamp: '2026-11-25T11:01:00.000Z', userAgent: 'Mozilla/5.0' } });
export const evBounced = (id: string, to: string, type = 'Permanent', subType = 'General') =>
	base('email.bounced', id, to, { bounce: { message: "The recipient's email address does not exist.", subType, type } });
export const evComplained = (id: string, to: string) => base('email.complained', id, to);
export const evSuppressed = (id: string, to: string) => base('email.suppressed', id, to, { suppressed: { message: 'Recipient is on the suppression list.', type: 'OnAccountSuppressionList' } });
export const evFailed = (id: string, to: string) => base('email.failed', id, to, { failed: { reason: 'reached_daily_quota' } });
export const evSent = (id: string, to: string) => base('email.sent', id, to);
