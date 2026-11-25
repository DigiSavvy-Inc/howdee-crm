// #700: Postmark as a `MailProvider`. A thin adapter over the low-level client in
// `../postmark.ts`: every request goes out exactly as before this interface existed (same
// endpoint, same payload, one `sendBatch` call per `sendBatch` here), so a Postmark install
// behaves the same. Only this module imports `../postmark.ts`.

import {
	isHardSuppression,
	sendBatch as pmSendBatch,
	suppress as pmSuppress,
	suppressionDump,
	suppressionsByEmail,
	suppressionStreams,
	suppressMany as pmSuppressMany,
	unsuppress as pmUnsuppress,
	type PostmarkMessage,
	type PostmarkResult
} from '../postmark';
import { safeEqual } from '../auth';
import { checkUnsubscribeHandling, fetchPostmarkDomains } from '../domain-auth';
import { webhookDedupeKey } from '../webhook-dedupe';
import {
	WebhookAuthError,
	type DomainStatus,
	type LinkTracking,
	type MailEvent,
	type MailEventType,
	type MailProvider,
	type OutboundMessage,
	type ProviderCheck,
	type ProviderCheckRow,
	type SendResult
} from './provider';

export { isHardSuppression, suppressionStreams };
export type { PostmarkMessage, PostmarkResult };

export type PostmarkProviderOptions = {
	token: string;
	/** Broadcast stream name ('' = none configured: unsubscribe suppressions are skipped, as before). */
	broadcast: string;
	/** Transactional stream name (Postmark's default is `outbound`). */
	transactional?: string;
	/** WEBHOOK_KEY — gates the event webhook. */
	webhookKey?: string;
	/** POSTMARK_ACCOUNT_TOKEN — the Domains API (DKIM / Return-Path). */
	accountToken?: string;
};

/** Postmark's batch limit. A literal, so nothing reads the client module at load time. */
export const POSTMARK_MAX_BATCH = 500;

const TRACK_LINKS: Record<LinkTracking, NonNullable<PostmarkMessage['TrackLinks']>> = {
	none: 'None',
	html_and_text: 'HtmlAndText',
	html_only: 'HtmlOnly',
	text_only: 'TextOnly'
};
const FROM_TRACK_LINKS: Record<string, LinkTracking> = {
	None: 'none',
	HtmlAndText: 'html_and_text',
	HtmlOnly: 'html_only',
	TextOnly: 'text_only'
};

/** Neutral → Postmark, in the field order the send path has always used. */
export function toPostmarkMessage(m: OutboundMessage, streams: { broadcast: string; transactional: string }): PostmarkMessage {
	const headers = (m.headers ?? []).map((h) => ({ Name: h.name, Value: h.value }));
	const opens = m.tracking?.opens;
	const links = m.tracking?.links;
	return {
		From: m.from,
		To: m.to,
		...(m.replyTo ? { ReplyTo: m.replyTo } : {}),
		...(m.bcc ? { Bcc: m.bcc } : {}),
		...(headers.length ? { Headers: headers } : {}),
		Subject: m.subject,
		HtmlBody: m.html,
		TextBody: m.text,
		// No stream name at all → the key stays undefined (left out of the JSON), as before.
		MessageStream: (m.streamName || streams[m.stream] || undefined) as string,
		...(opens !== undefined ? { TrackOpens: opens } : {}),
		...(links !== undefined ? { TrackLinks: TRACK_LINKS[links] } : {})
	};
}

/** Postmark-shaped → neutral, for callers that still build Postmark messages (reply forwards). */
export function fromPostmarkMessage(pm: PostmarkMessage, streams: { broadcast: string; transactional: string }): OutboundMessage {
	const stream = pm.MessageStream === streams.transactional && pm.MessageStream !== streams.broadcast ? 'transactional' : 'broadcast';
	const tracking: NonNullable<OutboundMessage['tracking']> = {};
	if (pm.TrackOpens !== undefined) tracking.opens = pm.TrackOpens;
	if (pm.TrackLinks !== undefined) tracking.links = FROM_TRACK_LINKS[pm.TrackLinks];
	return {
		from: pm.From,
		to: pm.To,
		...(pm.ReplyTo ? { replyTo: pm.ReplyTo } : {}),
		...(pm.Bcc ? { bcc: pm.Bcc } : {}),
		...(pm.Headers?.length ? { headers: pm.Headers.map((h) => ({ name: h.Name, value: h.Value })) } : {}),
		subject: pm.Subject,
		html: pm.HtmlBody,
		text: pm.TextBody,
		stream,
		...(pm.MessageStream !== streams[stream] ? { streamName: pm.MessageStream } : {}),
		...(pm.TrackOpens !== undefined || pm.TrackLinks !== undefined ? { tracking } : {})
	};
}

// Recipient-level codes retrying can't fix: 300 invalid request (bad address), 406 inactive
// recipient (suppressed / hard-bounced before).
const PERMANENT_CODES = new Set([300, 406]);

export function fromPostmarkResult(r: PostmarkResult): SendResult {
	if (r.ErrorCode === 0) return { ok: true, messageId: r.MessageID ?? '', code: 0, message: r.Message, raw: r };
	return {
		ok: false,
		error: r.Message ?? 'Unknown error',
		permanent: PERMANENT_CODES.has(r.ErrorCode),
		code: r.ErrorCode,
		...(r.Transport ? { transport: true } : {}),
		raw: r
	};
}

// Postmark RecordType → normalised event type (the webhook route's TYPE_MAP).
const EVENT_TYPES: Record<string, MailEventType> = {
	Delivery: 'delivery',
	Open: 'open',
	Click: 'click',
	Bounce: 'bounce',
	SpamComplaint: 'spam',
	SubscriptionChange: 'unsubscribe'
};

/** One Postmark webhook payload → a normalised event, or null for a record type we ignore. */
export async function mapPostmarkEvent(payload: Record<string, any>): Promise<MailEvent | null> {
	const type = EVENT_TYPES[String(payload?.RecordType ?? '')];
	if (!type) return null;
	const at = payload.ReceivedAt ?? payload.DeliveredAt ?? payload.BouncedAt ?? payload.ChangedAt ?? null;
	return {
		type,
		...(type === 'bounce' ? { hard: payload.Type === 'HardBounce' || payload.Inactive === true } : {}),
		messageId: payload.MessageID ?? null,
		email: payload.Recipient ?? payload.Email ?? null,
		at: at == null ? null : String(at),
		...(type === 'click' ? { link: payload.OriginalLink ?? null } : {}),
		dedupeKey: await webhookDedupeKey(payload),
		raw: payload
	};
}

/**
 * #731: where a Postmark webhook URL points, compared with this install: `here` (`/api/webhook`
 * with our key, on `baseUrl`'s host when one is given), `elsewhere` (our path and key on another
 * host: an old address of this install) or `other` (not ours).
 */
export function webhookTarget(url: unknown, key: string, baseUrl?: string | null): 'here' | 'elsewhere' | 'other' {
	if (typeof url !== 'string' || !key) return 'other';
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return 'other';
	}
	if (u.pathname.replace(/\/+$/, '') !== '/api/webhook' || !safeEqual(u.searchParams.get('key') ?? '', key)) return 'other';
	if (!baseUrl) return 'here';
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		return 'here';
	}
	return u.host.toLowerCase() === base.host.toLowerCase() ? 'here' : 'elsewhere';
}

/** True when the Postmark webhook URL is this install's `/api/webhook` with our key — and, when
 *  `baseUrl` is given (#731), on the install's public address. */
export function webhookMatches(url: unknown, key: string, baseUrl?: string | null): boolean {
	return webhookTarget(url, key, baseUrl) === 'here';
}

// ---------------------------------------------------------------------------------------
// Checks (Settings → Sending's Test connection, Settings → Setup's Postmark rows)

const PM_API = 'https://api.postmarkapp.com';
const PM_TIMEOUT_MS = 8_000;

type PmRead = { status: number; body: unknown } | { status: 0; error: string };

async function pmGet(fetchFn: typeof fetch, token: string, path: string): Promise<PmRead> {
	try {
		const res = await fetchFn(`${PM_API}${path}`, {
			headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token },
			signal: AbortSignal.timeout(PM_TIMEOUT_MS)
		});
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		return { status: res.status, body };
	} catch (e) {
		return { status: 0, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
	}
}

const rejected = (r: PmRead) => r.status === 401 || r.status === 403;

/** The four Postmark rows of Settings → Setup (#609): token, streams, webhook, unsubscribe
 *  handling. Never a secret value in a row. */
export async function postmarkCheckRows(
	cfg: { token: string; broadcast: string; transactional: string; webhookKey: string },
	fetchFn: typeof fetch = fetch
): Promise<ProviderCheckRow[]> {
	const { token, webhookKey: key } = cfg;
	const broadcast = cfg.broadcast || 'broadcast';
	const tx = cfg.transactional || 'outbound';
	// Token + streams are required checks; the webhook and unsubscribe handling are Postmark's own group.
	const tokenRow = { id: 'postmark_token', group: 'required' as const, label: 'Postmark server token' };
	const streamsRow = { id: 'postmark_streams', group: 'required' as const, label: 'Message streams' };
	const webhookRow = { id: 'postmark_webhook', group: 'postmark' as const, label: 'Postmark webhook', href: '/deliverability' };
	const unsubRow = { id: 'postmark_unsubscribe', group: 'postmark' as const, label: 'Custom unsubscribe handling', href: '/deliverability#domain-auth' };

	if (!token) {
		const skipped = 'Not checked: POSTMARK_TOKEN is not set.';
		return [
			{ ...tokenRow, state: 'attention', detail: 'POSTMARK_TOKEN is not set.', fix: 'Paste it in the setup wizard (step 2) or Settings → Sending. Or run `npx wrangler secret put POSTMARK_TOKEN`.' },
			{ ...streamsRow, state: 'attention', detail: skipped },
			{ ...webhookRow, state: 'attention', detail: skipped },
			{ ...unsubRow, state: 'attention', detail: skipped }
		];
	}

	const [b, t, hooks] = await Promise.all([
		pmGet(fetchFn, token, `/message-streams/${encodeURIComponent(broadcast)}`),
		broadcast === tx ? Promise.resolve(null) : pmGet(fetchFn, token, `/message-streams/${encodeURIComponent(tx)}`),
		pmGet(fetchFn, token, `/webhooks?MessageStream=${encodeURIComponent(broadcast)}`)
	]);
	const reads = [b, t, hooks].filter((r): r is PmRead => !!r);

	let token_: ProviderCheckRow;
	if (reads.some(rejected)) {
		token_ = { ...tokenRow, state: 'attention', detail: 'Postmark rejected the token.', fix: 'Use the Server API token (Postmark → Servers → your server → API Tokens), not the account token.' };
	} else if (reads.every((r) => r.status === 0)) {
		const err = (b as { error?: string }).error ?? 'no answer';
		token_ = { ...tokenRow, state: 'attention', detail: `Couldn't reach Postmark: ${err}.`, fix: 'Reload this page to check again.' };
	} else {
		token_ = { ...tokenRow, state: 'ready', detail: 'Postmark accepted the token.' };
	}
	const tokenOk = token_.state === 'ready';

	// Streams: both must answer 200.
	let streams: ProviderCheckRow;
	if (!tokenOk) streams = { ...streamsRow, state: 'attention', detail: 'Not checked: the token check failed.' };
	else if (broadcast === tx) {
		streams = {
			...streamsRow,
			state: 'attention',
			detail: `POSTMARK_STREAM and POSTMARK_STREAM_TX are both "${broadcast}".`,
			fix: 'Use a broadcast stream for POSTMARK_STREAM and the transactional one (usually "outbound") for POSTMARK_STREAM_TX.'
		};
	} else {
		const missing: string[] = [];
		const other: string[] = [];
		for (const [name, r] of [[broadcast, b], [tx, t]] as [string, PmRead][]) {
			if (r.status === 200) continue;
			if (r.status === 404 || r.status === 422) missing.push(name);
			else other.push(`${name} (${r.status === 0 ? 'no answer' : `HTTP ${r.status}`})`);
		}
		if (!missing.length && !other.length) streams = { ...streamsRow, state: 'ready', detail: `"${broadcast}" (broadcast) and "${tx}" (transactional) exist.` };
		else
			streams = {
				...streamsRow,
				state: 'attention',
				detail: [missing.length ? `Not found: ${missing.join(', ')}.` : '', other.length ? `Couldn't read: ${other.join(', ')}.` : ''].filter(Boolean).join(' '),
				fix: 'Create the stream in Postmark (Servers → your server → Message Streams), or fix the stream names in Settings → Sending (or POSTMARK_STREAM / POSTMARK_STREAM_TX in wrangler.jsonc).'
			};
	}

	// Webhook on the broadcast stream, pointing at /api/webhook with our WEBHOOK_KEY.
	const webhookFix = 'In Postmark → Servers → your server → the broadcast stream → Webhooks, add <this app>/api/webhook?key=<WEBHOOK_KEY> with every trigger on.';
	let webhook: ProviderCheckRow;
	if (!key) webhook = { ...webhookRow, state: 'attention', detail: 'WEBHOOK_KEY is not set, so the webhook answers 401.', fix: 'Run `npx wrangler secret put WEBHOOK_KEY`, then point the Postmark webhook at /api/webhook?key=<WEBHOOK_KEY>.' };
	else if (!tokenOk) webhook = { ...webhookRow, state: 'attention', detail: 'Not checked: the token check failed.' };
	else if (hooks.status !== 200) webhook = { ...webhookRow, state: 'attention', detail: `Couldn't list webhooks (${hooks.status === 0 ? 'no answer' : `HTTP ${hooks.status}`}).`, fix: 'Reload this page to check again.' };
	else {
		const list = ((hooks.body as { Webhooks?: { Url?: unknown }[] } | null)?.Webhooks ?? []) as { Url?: unknown }[];
		webhook = list.some((h) => webhookMatches(h?.Url, key))
			? { ...webhookRow, state: 'ready', detail: `A webhook on "${broadcast}" points at this install.` }
			: { ...webhookRow, state: 'attention', detail: `No webhook on "${broadcast}" points at /api/webhook with this install's key.`, fix: webhookFix };
	}

	// Unsubscribe handling (#373), read from the broadcast stream answer.
	let unsub: ProviderCheckRow;
	if (!tokenOk) unsub = { ...unsubRow, state: 'attention', detail: 'Not checked: the token check failed.' };
	else if (broadcast === tx || b.status !== 200) unsub = { ...unsubRow, state: 'attention', detail: `Not checked: the "${broadcast}" stream couldn't be read.` };
	else {
		const c = checkUnsubscribeHandling(broadcast, { ok: true, body: b.body });
		unsub =
			c.status === 'pass'
				? { ...unsubRow, state: 'ready', detail: c.summary }
				: { ...unsubRow, state: 'attention', detail: c.summary, fix: 'Use Switch to custom on Deliverability → Domain authentication.' };
	}

	return [token_, streams, webhook, unsub];
}

// ---------------------------------------------------------------------------------------

export function postmarkProvider(opts: PostmarkProviderOptions): MailProvider {
	const token = opts.token;
	const streams = { broadcast: opts.broadcast ?? '', transactional: opts.transactional || 'outbound' };
	const scopes = () => suppressionStreams(streams.broadcast || undefined, streams.transactional);

	return {
		id: 'postmark',
		label: 'Postmark',
		maxBatch: POSTMARK_MAX_BATCH,
		streams,
		capabilities: { tracking: true, suppressions: 'both', webhooks: true, inbound: true, domainApi: true, streams: true },

		async sendBatch(messages) {
			if (!messages.length) return [];
			const results = (await pmSendBatch(token, messages.map((m) => toPostmarkMessage(m, streams)))) ?? [];
			return results.map(fromPostmarkResult);
		},

		suppressions: {
			async *list() {
				for (const stream of scopes()) {
					const dump = await suppressionDump(token, stream);
					if (!dump.ok) continue;
					for (const s of dump.suppressions) {
						const reason = String(s.SuppressionReason || 'Unknown');
						yield { email: s.EmailAddress.trim().toLowerCase(), reason, hard: isHardSuppression(reason), scope: stream, createdAt: s.CreatedAt };
					}
				}
			},
			// Postmark suppresses bounces and complaints itself; an unsubscribe goes on the
			// broadcast stream only, so transactional mail (password resets) still arrives.
			async add(email, reason) {
				if (reason !== 'unsubscribe') return { ok: true };
				if (!streams.broadcast) return { ok: false, message: 'No broadcast stream configured.' };
				return pmSuppress(token, streams.broadcast, email);
			},
			async remove(email, scope) {
				const stream = scope || streams.broadcast;
				if (!stream) return { ok: false, message: 'No broadcast stream configured.' };
				return pmUnsuppress(token, stream, email);
			},
			async addMany(emails, reason) {
				if (reason !== 'unsubscribe') return { suppressed: emails.length, failed: 0 };
				if (!streams.broadcast) return { suppressed: 0, failed: emails.length };
				return pmSuppressMany(token, streams.broadcast, emails);
			},
			byEmail() {
				return suppressionsByEmail(token, scopes());
			},
			scopes
		},

		async parseWebhook(request) {
			const key = opts.webhookKey ?? '';
			if (!key || !safeEqual(new URL(request.url).searchParams.get('key') ?? '', key)) throw new WebhookAuthError();
			let payload: unknown;
			try {
				payload = await request.json();
			} catch {
				return [];
			}
			const list = Array.isArray(payload) ? payload : [payload];
			const out: MailEvent[] = [];
			for (const p of list) {
				const ev = p && typeof p === 'object' ? await mapPostmarkEvent(p as Record<string, any>) : null;
				if (ev) out.push(ev);
			}
			return out;
		},

		async domainStatus(domain): Promise<DomainStatus> {
			const name = domain.trim().toLowerCase();
			const { domains, error } = await fetchPostmarkDomains(opts.accountToken || undefined, [name]);
			const d = [...domains.values()].find((x) => x.name.toLowerCase() === name) ?? null;
			if (!d) return { domain: name, found: false, verified: false, dkim: null, returnPath: null, ...(error ? { error } : {}) };
			return { domain: name, found: true, verified: d.dkimVerified && d.returnPathVerified, dkim: d.dkimVerified, returnPath: d.returnPathVerified };
		},

		async check(fetchFn = fetch): Promise<ProviderCheck> {
			const rows = await postmarkCheckRows({ token, broadcast: streams.broadcast, transactional: streams.transactional, webhookKey: opts.webhookKey ?? '' }, fetchFn);
			const required = rows.filter((r) => r.group === 'required');
			const ok = required.every((r) => r.state === 'ready');
			return { ok, summary: ok ? `Postmark accepted the token; "${streams.broadcast || 'broadcast'}" and "${streams.transactional}" exist.` : required.find((r) => r.state !== 'ready')!.detail, rows };
		}
	};
}
