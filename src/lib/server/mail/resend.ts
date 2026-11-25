// #702 (3/5 of #699): Resend as a `MailProvider`. Raw `fetch` against Resend's REST API, no SDK
// (it runs on Workers). Spec + user docs: docs/sending-providers.md → Resend.
//
// - Sending: `POST /emails/batch`, up to 100 messages per call. Validation is strict: one invalid
//   message fails the whole call, and `data[i]` matches message `i` only on a success. Each call
//   has an `Idempotency-Key`, reused when a 429 / 5xx / dropped connection / 409
//   `concurrent_idempotent_requests` is retried, so a retry can't send twice. Every request sends
//   our `User-Agent` (Resend answers 403 without one).
// - Streams: Resend has none. The message's stream kind goes out as a tag (`stream`), with the
//   campaign and contact ids, and comes back on every webhook event.
// - Events: `/api/webhook/resend` (Svix-signed). Each event is turned into the Postmark-shaped
//   payload the shared processing (`ingestMailEvent`) and every `events.detail` reader were built
//   on, with `Source: 'resend'`.
// - Suppressions: not synced (capability `none`). The app never calls Resend's suppressions API:
//   the CRM's own list is the source of truth and is checked before anything reaches Resend, and
//   `email.suppressed` webhooks (Resend refused a suppressed address) arrive as hard bounces.
//
// Never logs a request body, a recipient address or the API key; the key is scrubbed from every
// message that could carry it.

import { safeEqual } from '../auth';
import {
	WebhookAuthError,
	type DomainStatus,
	type MailEvent,
	type MailEventType,
	type MailProvider,
	type OutboundMessage,
	type ProviderCheck,
	type ProviderCheckRow,
	type SendResult,
	type TrackingMode
} from './provider';
import { USER_AGENT } from '../user-agent';

export const RESEND_API = 'https://api.resend.com';
/** Resend's batch limit (messages per `POST /emails/batch`). */
export const RESEND_MAX_BATCH = 100;
const TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 8_000;
/** Attempts per batch call: the first + retries on 429 / 5xx / a dropped connection. */
const MAX_ATTEMPTS = 3;
/** Longest wait honoured from a 429's `retry-after`, in ms (the request budget is shared). */
const MAX_RETRY_WAIT_MS = 2_000;
/** Svix's replay window: a timestamp further than this from now is refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type ResendProviderOptions = {
	apiKey: string;
	/** Stream names callers still pass (the Postmark names): only used to tell the kind apart. */
	broadcast: string;
	transactional: string;
	/** RESEND_WEBHOOK_SECRET (`whsec_…`) — gates `/api/webhook/resend`. */
	webhookSecret?: string;
	/** Seam for tests (and the retry wait). */
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

/** The JSON Resend takes per email. */
export type ResendEmail = {
	from: string;
	to: string[];
	subject: string;
	html: string;
	text: string;
	reply_to?: string[];
	bcc?: string[];
	headers?: Record<string, string>;
	tags?: { name: string; value: string }[];
};

// Resend: tag names and values are ASCII letters, numbers, underscores or dashes, ≤ 256 chars.
const TAG_SAFE = /[^A-Za-z0-9_-]/g;
const tagValue = (v: string | number) => String(v).replace(TAG_SAFE, '_').slice(0, 256);

function splitAddresses(v: string | undefined): string[] {
	return (v ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Neutral → Resend. Tracking flags are ignored: Resend tracks per domain, not per message. */
export function toResendEmail(m: OutboundMessage): ResendEmail {
	const headers: Record<string, string> = {};
	for (const h of m.headers ?? []) if (h.name && h.value != null) headers[h.name] = h.value;
	const tags: { name: string; value: string }[] = [{ name: 'stream', value: m.stream }];
	if (m.metadata?.campaignId != null) tags.push({ name: 'campaign_id', value: tagValue(m.metadata.campaignId) });
	if (m.metadata?.contactId != null) tags.push({ name: 'contact_id', value: tagValue(m.metadata.contactId) });
	if (m.metadata?.sendId != null) tags.push({ name: 'send_id', value: tagValue(m.metadata.sendId) });
	return {
		from: m.from,
		to: [m.to],
		subject: m.subject,
		html: m.html,
		text: m.text,
		...(m.replyTo ? { reply_to: splitAddresses(m.replyTo) } : {}),
		...(m.bcc ? { bcc: splitAddresses(m.bcc) } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
		tags
	};
}

/** Remove the key (and anything that looks like a Resend key) from a message before it's shown. */
export function scrubKey(text: string, apiKey: string): string {
	let out = text;
	if (apiKey) out = out.split(apiKey).join('••••');
	return out.replace(/\bre_[A-Za-z0-9_]{8,}/g, 're_••••');
}

type ResendError = { statusCode?: number; name?: string; message?: string };

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function errorText(status: number, body: unknown): { name: string; message: string } {
	const e = (body && typeof body === 'object' ? body : {}) as ResendError;
	return { name: String(e.name ?? `http_${status}`), message: String(e.message ?? `HTTP ${status}`) };
}

/** The rows' error when a 409 `concurrent_idempotent_requests` was seen (an earlier attempt with
 *  the same key was still being processed) and no attempt succeeded: not permanent, and not a
 *  plain failure, because the batch may have gone out. */
export const RESEND_STILL_PROCESSING_ERROR = 'Resend is still processing this batch; it may have been sent.';
/** A success whose `data` doesn't line up with the messages sent: no id is guessed. */
export const RESEND_UNMATCHED_ERROR = 'Resend accepted the batch, but its answer could not be matched to the messages; they may have been sent.';

/** Retrying can't help: 422 (`missing_required_field` / `invalid_parameter`) and 400
 *  `validation_error` (a bad address or field fails the whole batch). 401 / 403 / 429 / 5xx are
 *  about the account or the moment, not the recipient. */
export function isPermanentSendError(status: number, name: string): boolean {
	return status === 422 || (status === 400 && name === 'validation_error');
}

/** A whole-batch refusal: every message fails the same way. */
function failAll(n: number, error: string, opts: { permanent: boolean; code?: number; transport?: boolean; raw?: unknown }): SendResult[] {
	return Array.from({ length: n }, () => ({ ok: false as const, error, permanent: opts.permanent, ...(opts.code ? { code: opts.code } : {}), ...(opts.transport ? { transport: true } : {}), raw: opts.raw }));
}

/**
 * A successful batch answer → one result per message, same order. `data[i]` is the id of message
 * `i`, so ids are handed out by position, and only when `data` has exactly one entry per message.
 * Any other length: nothing is matched (no id is guessed) and every row gets
 * `RESEND_UNMATCHED_ERROR`.
 */
export function fromResendBatch(n: number, body: unknown): SendResult[] {
	const b = (body && typeof body === 'object' ? body : {}) as { data?: { id?: string }[] };
	const data = Array.isArray(b.data) ? b.data : null;
	if (!data || data.length !== n) return failAll(n, RESEND_UNMATCHED_ERROR, { permanent: false });
	return data.map((d): SendResult => {
		const id = typeof d?.id === 'string' && d.id ? d.id : null;
		return id ? { ok: true, messageId: id, code: 0, message: 'OK' } : { ok: false, error: 'Resend returned no id for this message.', permanent: false };
	});
}

/** 429 `daily_quota_exceeded` / `monthly_quota_exceeded`: waiting a second won't help. */
function quotaName(status: number, name: string): string | null {
	if (status !== 429 || !name.endsWith('quota_exceeded')) return null;
	return name.startsWith('daily') ? 'daily' : name.startsWith('monthly') ? 'monthly' : name;
}

function retryAfterMs(res: Response): number {
	const v = Number(res.headers.get('retry-after'));
	return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, MAX_RETRY_WAIT_MS) : 1_000;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// Webhooks (Svix)

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
	try {
		const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

function bytesToB64(bytes: ArrayBuffer): string {
	let s = '';
	const b = new Uint8Array(bytes);
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
	return btoa(s);
}

/** Svix signature (`v1,<base64>`) for one id / timestamp / body — what Resend sends, and what the
 *  tests sign fixtures with. Null when the secret isn't usable. */
export async function svixSignature(secret: string, id: string, timestamp: string, body: string): Promise<string | null> {
	const raw = secret.trim().startsWith('whsec_') ? secret.trim().slice(6) : secret.trim();
	const keyBytes = raw ? b64ToBytes(raw) : null;
	if (!keyBytes || !keyBytes.length) return null;
	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
	return `v1,${bytesToB64(sig)}`;
}

/**
 * True when the Svix headers sign this exact body with the secret and the timestamp is within
 * 5 minutes of now. `svix-signature` may list several space-separated `v1,<sig>` values (secret
 * rotation); any one matching is enough.
 */
export async function verifySvix(
	secret: string,
	headers: { id: string | null; timestamp: string | null; signature: string | null },
	body: string,
	nowMs = Date.now()
): Promise<boolean> {
	const { id, timestamp, signature } = headers;
	if (!secret || !id || !timestamp || !signature) return false;
	if (!/^\d{1,12}$/.test(timestamp)) return false;
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
	const expected = await svixSignature(secret, id, timestamp, body);
	if (!expected) return false;
	const want = expected.slice(3);
	let ok = false;
	for (const part of signature.split(' ')) {
		const [version, sig] = part.split(',', 2);
		if (version === 'v1' && sig && safeEqual(sig, want)) ok = true;
	}
	return ok;
}

/** One Resend event, ready for the shared processing. `failed` = `email.failed`: the send row is
 *  marked failed, nothing else. */
export type ResendMapped =
	| { kind: 'event'; type: MailEventType; hard?: boolean; messageId: string | null; email: string | null; payload: Record<string, unknown>; resendType: string }
	| { kind: 'failed'; messageId: string | null; email: string | null; reason: string; resendType: string };

const firstTo = (to: unknown): string | null => {
	const v = Array.isArray(to) ? to[0] : to;
	return typeof v === 'string' && v.trim() ? v.trim() : null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * A Resend webhook payload → the Postmark-shaped record the shared processing reads (RecordType,
 * MessageID, Recipient, the event time, Type for bounces, OriginalLink / UserAgent for clicks), or
 * null for an event type the app ignores (`email.sent`, `email.delivery_delayed`, …). `deliveryId`
 * = the `svix-id` header: a retry of the same delivery keeps it, so it's the dedupe `ID`. The IP
 * address Resend reports for opens and clicks is never kept.
 */
export function mapResendEvent(payload: Record<string, any>, deliveryId: string | null): ResendMapped | null {
	const resendType = String(payload?.type ?? '');
	const data = (payload?.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, any>;
	const messageId = str(data.email_id);
	const email = firstTo(data.to);
	const at = str(payload?.created_at) ?? str(data.created_at);
	const common = { MessageID: messageId, Recipient: email, ID: deliveryId, Source: 'resend', ResendType: resendType };

	switch (resendType) {
		case 'email.delivered':
			return { kind: 'event', type: 'delivery', messageId, email, resendType, payload: { RecordType: 'Delivery', ...common, DeliveredAt: at } };
		case 'email.opened': {
			const o = (data.open && typeof data.open === 'object' ? data.open : {}) as Record<string, any>;
			return {
				kind: 'event',
				type: 'open',
				messageId,
				email,
				resendType,
				payload: { RecordType: 'Open', ...common, ReceivedAt: str(o.timestamp) ?? at, UserAgent: str(o.userAgent) ?? '' }
			};
		}
		case 'email.clicked': {
			const c = (data.click && typeof data.click === 'object' ? data.click : {}) as Record<string, any>;
			return {
				kind: 'event',
				type: 'click',
				messageId,
				email,
				resendType,
				payload: {
					RecordType: 'Click',
					...common,
					ReceivedAt: str(c.timestamp) ?? at,
					OriginalLink: str(c.link) ?? '',
					UserAgent: str(c.userAgent) ?? '',
					ClickLocation: 'HTML'
				}
			};
		}
		case 'email.bounced': {
			const b = (data.bounce && typeof data.bounce === 'object' ? data.bounce : {}) as Record<string, any>;
			const hard = String(b.type ?? '').toLowerCase() === 'permanent';
			return {
				kind: 'event',
				type: 'bounce',
				hard,
				messageId,
				email,
				resendType,
				payload: {
					RecordType: 'Bounce',
					...common,
					Type: hard ? 'HardBounce' : 'SoftBounce',
					BouncedAt: at,
					Description: str(b.message) ?? '',
					Details: [str(b.type), str(b.subType)].filter(Boolean).join(' / ')
				}
			};
		}
		case 'email.suppressed': {
			// Resend refused to send to an address on its suppression list: a hard bounce here.
			const s = (data.suppressed && typeof data.suppressed === 'object' ? data.suppressed : {}) as Record<string, any>;
			return {
				kind: 'event',
				type: 'bounce',
				hard: true,
				messageId,
				email,
				resendType,
				payload: {
					RecordType: 'Bounce',
					...common,
					Type: 'HardBounce',
					BouncedAt: at,
					Description: str(s.message) ?? str(s.reason) ?? 'Suppressed by Resend',
					Details: 'Resend suppression list'
				}
			};
		}
		case 'email.complained':
			return { kind: 'event', type: 'spam', messageId, email, resendType, payload: { RecordType: 'SpamComplaint', ...common, BouncedAt: at } };
		case 'email.failed': {
			const f = (data.failed && typeof data.failed === 'object' ? data.failed : {}) as Record<string, any>;
			return { kind: 'failed', messageId, email, resendType, reason: (str(f.reason) ?? 'Resend could not send this email.').slice(0, 300) };
		}
		default:
			return null;
	}
}

/**
 * Check the signature over the raw body, then parse it. Throws `WebhookAuthError` on a missing
 * secret, a bad signature or a stale timestamp — before the body is read as JSON. An unparseable
 * (but correctly signed) body gives no events.
 */
export async function parseResendWebhook(request: Request, secret: string, nowMs = Date.now()): Promise<ResendMapped[]> {
	if (!secret) throw new WebhookAuthError('RESEND_WEBHOOK_SECRET is not set');
	const body = await request.text();
	const headers = {
		id: request.headers.get('svix-id') ?? request.headers.get('webhook-id'),
		timestamp: request.headers.get('svix-timestamp') ?? request.headers.get('webhook-timestamp'),
		signature: request.headers.get('svix-signature') ?? request.headers.get('webhook-signature')
	};
	if (!(await verifySvix(secret, headers, body, nowMs))) throw new WebhookAuthError();
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return [];
	}
	const list = Array.isArray(payload) ? payload : [payload];
	const out: ResendMapped[] = [];
	for (const p of list) {
		const m = p && typeof p === 'object' ? mapResendEvent(p as Record<string, any>, headers.id) : null;
		if (m) out.push(m);
	}
	return out;
}

// ---------------------------------------------------------------------------------------
// Domains + checks (Settings → Sending's Test connection, Settings → Setup)

type ResendRecord = { record?: string; type?: string; name?: string; status?: string };
type ResendDomain = { id?: string; name?: string; status?: string; records?: ResendRecord[]; open_tracking?: boolean; click_tracking?: boolean };

type Read = { status: number; body: unknown } | { status: 0; error: string };

async function resendGet(fetchFn: typeof fetch, apiKey: string, path: string): Promise<Read> {
	try {
		const res = await fetchFn(`${RESEND_API}${path}`, {
			headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
		});
		return { status: res.status, body: await readJson(res) };
	} catch (e) {
		return { status: 0, error: scrubKey((e instanceof Error ? e.message : String(e)).slice(0, 120), apiKey) };
	}
}

const errField = (r: Read, k: 'name' | 'message') => String((('body' in r ? r.body : null) as ResendError | null)?.[k] ?? '');

/** A sending-only key: Resend answers 401 `restricted_api_key` on anything but sending. (A 403
 *  `restricted_api_key`, "API key is not active", is a rejected key: see `isRejectedKey`.) */
export function isRestrictedKey(r: Read): boolean {
	return r.status === 401 && errField(r, 'name') === 'restricted_api_key';
}

/** Resend refused the key: 401 / 403 (other than a sending-only key), or 400 `validation_error`
 *  "API key is invalid", which is how endpoints other than sending answer a bad key. */
export function isRejectedKey(r: Read): boolean {
	if (isRestrictedKey(r)) return false;
	if (r.status === 401 || r.status === 403) return true;
	return r.status === 400 && errField(r, 'name') === 'validation_error' && /api key is invalid/i.test(errField(r, 'message'));
}

function domainList(body: unknown): ResendDomain[] {
	const d = (body as { data?: unknown } | null)?.data;
	return Array.isArray(d) ? (d as ResendDomain[]) : [];
}

function recordsVerified(records: ResendRecord[], kind: (r: ResendRecord) => boolean): boolean | null {
	const list = records.filter(kind);
	if (!list.length) return null;
	return list.every((r) => String(r.status ?? '').toLowerCase() === 'verified');
}

const isDkim = (r: ResendRecord) => String(r.record ?? '').toUpperCase() === 'DKIM';
// Resend's return path is the `send.` subdomain: its SPF TXT and MX records. A `record: 'SPF'` of
// type CNAME (the Forge record) stays `not_started` while Forge is off, so it is left out.
const isReturnPath = (r: ResendRecord) => {
	const type = String(r.type ?? '').toUpperCase();
	return String(r.record ?? '').toUpperCase() === 'SPF' && (type === 'MX' || type === 'TXT');
};

export function resendDomainStatus(name: string, d: ResendDomain | null, error?: string): DomainStatus {
	if (!d) return { domain: name, found: false, verified: false, dkim: null, returnPath: null, ...(error ? { error } : {}) };
	const records = Array.isArray(d.records) ? d.records : [];
	return {
		domain: name,
		found: true,
		verified: String(d.status ?? '').toLowerCase() === 'verified',
		dkim: recordsVerified(records, isDkim),
		returnPath: recordsVerified(records, isReturnPath)
	};
}

/** The Resend rows: the key (required), domains, the webhook secret and — when a domain says so
 *  — a tracking mismatch. Never a secret value in a row. */
export async function resendCheckRows(
	cfg: { apiKey: string; webhookSecret: string; trackingBy?: TrackingMode },
	fetchFn: typeof fetch = fetch
): Promise<ProviderCheckRow[]> {
	const keyRow = { id: 'resend_api_key', group: 'required' as const, label: 'Resend API key', href: '/settings/sending' };
	const domainsRow = { id: 'resend_domains', group: 'postmark' as const, label: 'Resend sending domains', href: '/settings/sending' };
	const webhookRow = { id: 'resend_webhook', group: 'postmark' as const, label: 'Resend webhook', href: '/settings/sending' };
	const webhook: ProviderCheckRow = cfg.webhookSecret
		? { ...webhookRow, state: 'ready', detail: 'Signing secret set. Resend events are accepted at /api/webhook/resend.' }
		: {
				...webhookRow,
				state: 'attention',
				detail: 'RESEND_WEBHOOK_SECRET is not set, so /api/webhook/resend answers 401 (no bounces, complaints or opens).',
				fix: 'In Resend → Webhooks, add <this app>/api/webhook/resend, then paste its signing secret in Settings → Sending.'
			};

	if (!cfg.apiKey) {
		return [
			{ ...keyRow, state: 'attention', detail: 'RESEND_API_KEY is not set.', fix: 'Paste it in Settings → Sending, or run `npx wrangler secret put RESEND_API_KEY`.' },
			{ ...domainsRow, state: 'attention', detail: 'Not checked: no API key.' },
			webhook
		];
	}

	const list = await resendGet(fetchFn, cfg.apiKey, '/domains');
	if (isRestrictedKey(list)) {
		return [
			{ ...keyRow, state: 'ready', detail: 'Resend accepted the key (sending access only).' },
			{
				...domainsRow,
				state: 'ready',
				detail: 'Not checked: a sending-only key can’t read domains. Domain status is off.',
				fix: 'Use a full-access key to see domain status here.'
			},
			webhook
		];
	}
	if (isRejectedKey(list)) {
		return [
			{ ...keyRow, state: 'attention', detail: 'Resend rejected the key.', fix: 'Create a key in Resend → API Keys and paste it in Settings → Sending.' },
			{ ...domainsRow, state: 'attention', detail: 'Not checked: the key check failed.' },
			webhook
		];
	}
	if (list.status !== 200) {
		const why = list.status === 0 ? (list as { error: string }).error : `HTTP ${list.status}`;
		return [
			{ ...keyRow, state: 'attention', detail: `Couldn't reach Resend: ${why}.`, fix: 'Try again in a minute.' },
			{ ...domainsRow, state: 'attention', detail: 'Not checked: Resend didn’t answer.' },
			webhook
		];
	}

	const domains = domainList(list.body);
	const verified = domains.filter((d) => String(d.status ?? '').toLowerCase() === 'verified');
	const rows: ProviderCheckRow[] = [{ ...keyRow, state: 'ready', detail: 'Resend accepted the key.' }];
	rows.push(
		verified.length
			? { ...domainsRow, state: 'ready', detail: `Verified: ${verified.map((d) => d.name).filter(Boolean).slice(0, 5).join(', ')}.` }
			: {
					...domainsRow,
					state: 'attention',
					detail: domains.length ? `No verified domain yet (${domains.map((d) => `${d.name}: ${d.status}`).slice(0, 5).join(', ')}).` : 'No domain in this Resend account.',
					fix: 'Add and verify your sending domain in Resend → Domains. The default From address must be on it.'
				}
	);
	rows.push(webhook);

	// Tracking is a per-domain setting in Resend. Warn when a verified domain disagrees with the
	// app's choice (only when Resend reports the fields).
	if (cfg.trackingBy) {
		const mismatched: string[] = [];
		for (const d of verified.slice(0, 5)) {
			const detail = d.id ? await resendGet(fetchFn, cfg.apiKey, `/domains/${encodeURIComponent(d.id)}`) : null;
			const full = (detail && detail.status === 200 ? (detail.body as ResendDomain) : d) ?? d;
			const opens = full.open_tracking;
			const clicks = full.click_tracking;
			if (typeof opens !== 'boolean' && typeof clicks !== 'boolean') continue;
			const resendTracks = opens === true || clicks === true;
			if (cfg.trackingBy === 'crm' ? resendTracks : opens === false && clicks === false) mismatched.push(String(full.name ?? d.name ?? ''));
		}
		if (mismatched.length) {
			rows.push({
				id: 'resend_tracking',
				group: 'postmark',
				label: 'Resend open and click tracking',
				state: 'attention',
				detail:
					cfg.trackingBy === 'crm'
						? `The CRM tracks opens and clicks, but Resend tracking is on for ${mismatched.join(', ')}: they would be counted twice for mail Resend tracks.`
						: `Resend tracking is off for ${mismatched.join(', ')}, so no opens or clicks arrive.`,
				fix:
					cfg.trackingBy === 'crm'
						? 'Turn open and click tracking off in Resend → Domains → your domain → Configuration.'
						: 'Turn open and click tracking on in Resend → Domains → your domain → Configuration, or choose By the CRM.'
			});
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------------------

export function resendProvider(opts: ResendProviderOptions): MailProvider {
	const apiKey = opts.apiKey;
	const fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	const sleep = opts.sleep ?? defaultSleep;
	const streams = { broadcast: opts.broadcast || 'broadcast', transactional: opts.transactional || 'outbound' };

	const provider: MailProvider = {
		id: 'resend',
		label: 'Resend',
		maxBatch: RESEND_MAX_BATCH,
		streams,
		capabilities: { tracking: true, suppressions: 'none', webhooks: true, inbound: false, domainApi: true, streams: false },

		async sendBatch(messages) {
			if (!messages.length) return [];
			const out: SendResult[] = [];
			for (let start = 0; start < messages.length; start += RESEND_MAX_BATCH) {
				out.push(...(await sendOne(messages.slice(start, start + RESEND_MAX_BATCH))));
			}
			return out;
		},

		async parseWebhook(request) {
			const mapped = await parseResendWebhook(request, opts.webhookSecret ?? '');
			const events: MailEvent[] = [];
			for (const m of mapped) {
				if (m.kind !== 'event') continue;
				events.push({
					type: m.type,
					...(m.type === 'bounce' ? { hard: !!m.hard } : {}),
					messageId: m.messageId,
					email: m.email,
					at: (m.payload.ReceivedAt ?? m.payload.DeliveredAt ?? m.payload.BouncedAt ?? null) as string | null,
					...(m.type === 'click' ? { link: (m.payload.OriginalLink as string) ?? null } : {}),
					dedupeKey: (m.payload.ID as string | null) ?? null,
					raw: m.payload
				});
			}
			return events;
		},

		async domainStatus(domain): Promise<DomainStatus> {
			const name = domain.trim().toLowerCase();
			const list = await resendGet(fetchFn, apiKey, '/domains');
			if (list.status !== 200) {
				const error = isRestrictedKey(list)
					? 'The Resend key has sending access only.'
					: isRejectedKey(list)
						? 'Resend rejected the API key.'
						: list.status === 0
							? (list as { error: string }).error
							: `HTTP ${list.status}`;
				return resendDomainStatus(name, null, error);
			}
			const hit = domainList(list.body).find((d) => String(d.name ?? '').toLowerCase() === name) ?? null;
			if (!hit?.id) return resendDomainStatus(name, hit);
			const detail = await resendGet(fetchFn, apiKey, `/domains/${encodeURIComponent(hit.id)}`);
			return resendDomainStatus(name, detail.status === 200 ? ((detail.body as ResendDomain) ?? hit) : hit);
		},

		async check(checkFetch = fetchFn): Promise<ProviderCheck> {
			const rows = await resendCheckRows({ apiKey, webhookSecret: opts.webhookSecret ?? '', trackingBy: provider.trackingBy }, checkFetch);
			const required = rows.filter((r) => r.group === 'required');
			const ok = required.every((r) => r.state === 'ready');
			const restricted = rows.some((r) => r.id === 'resend_domains' && r.detail.startsWith('Not checked: a sending-only key'));
			return {
				ok,
				summary: ok
					? restricted
						? 'Resend accepted the key. It has sending access only, so domain status is off.'
						: 'Resend accepted the key.'
					: required.find((r) => r.state !== 'ready')!.detail,
				rows
			};
		}
	};

	/** One `POST /emails/batch` (≤ 100), retried on 429 / 5xx / a dropped connection / 409
	 *  `concurrent_idempotent_requests` with the same idempotency key, so Resend sends each email at
	 *  most once. Once a 409 was seen, running out of attempts gives `RESEND_STILL_PROCESSING_ERROR`
	 *  (the earlier attempt may have sent the batch). */
	async function sendOne(batch: OutboundMessage[]): Promise<SendResult[]> {
		const body = JSON.stringify(batch.map(toResendEmail));
		const idempotencyKey = `crm-batch-${crypto.randomUUID()}`;
		let last: SendResult[] | null = null;
		let inFlight = false;
		const stillProcessing = () => failAll(batch.length, RESEND_STILL_PROCESSING_ERROR, { permanent: false, code: 409 });
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			let res: Response;
			try {
				res = await fetchFn(`${RESEND_API}/emails/batch`, {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
						Authorization: `Bearer ${apiKey}`,
						'User-Agent': USER_AGENT,
						'Idempotency-Key': idempotencyKey
					},
					body,
					signal: AbortSignal.timeout(TIMEOUT_MS)
				});
			} catch (e) {
				const why = scrubKey((e instanceof Error ? e.message : String(e)).slice(0, 200), apiKey);
				last = failAll(batch.length, `Resend request failed: ${why}`, { permanent: false, transport: true });
				if (attempt < MAX_ATTEMPTS) await sleep(500);
				continue;
			}
			const parsed = await readJson(res);
			if (res.ok) {
				if (!parsed || typeof parsed !== 'object') return failAll(batch.length, 'Resend sent an unreadable answer.', { permanent: false, transport: true });
				return fromResendBatch(batch.length, parsed);
			}
			const { name, message } = errorText(res.status, parsed);
			const text = scrubKey(`Resend ${name}: ${message}`, apiKey).slice(0, 300);
			if (res.status === 409 && name === 'concurrent_idempotent_requests') {
				// An earlier attempt with this key is still being processed: wait, then ask again.
				inFlight = true;
				last = stillProcessing();
				if (attempt < MAX_ATTEMPTS) await sleep(retryAfterMs(res));
				continue;
			}
			const quota = quotaName(res.status, name);
			if (quota) {
				const what = quota === 'daily' || quota === 'monthly' ? `${quota} sending quota` : `sending quota (${quota})`;
				return failAll(batch.length, scrubKey(`Resend ${what} reached: ${message}`, apiKey).slice(0, 300), { permanent: false, code: 429 });
			}
			if (res.status === 429 || res.status >= 500) {
				last = failAll(batch.length, text, { permanent: false, code: res.status, ...(res.status >= 500 ? { transport: true } : {}) });
				if (attempt < MAX_ATTEMPTS) await sleep(res.status === 429 ? retryAfterMs(res) : 500);
				continue;
			}
			return failAll(batch.length, text, { permanent: isPermanentSendError(res.status, name), code: res.status });
		}
		if (inFlight) return stillProcessing();
		return last ?? failAll(batch.length, 'Resend request failed.', { permanent: false, transport: true });
	}

	return provider;
}
