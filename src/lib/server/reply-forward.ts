// The copy of a captured reply forwarded to the operator's inbox (#381).
//
// From = a dedicated, non-personal sender with the contact's name as display name
// ("Jordan Rivera via <app name>" <crm@example.com>), so Gmail doesn't show
// the reply as the operator writing to himself. The contact's own address is never the
// From (that would be spoofing and fail DMARC) — it's the Reply-To.

import { sendBatch, type PostmarkMessage, type PostmarkResult } from './postmark';
import { stripReplyPrefixes } from './conversations';
import { stripTrailingQuoteIntro } from '$lib/email-text';
import { DEFAULT_APP_NAME } from '$lib/branding';

/** "via <app name>" — the app name comes from Settings → Branding (#596). */
export function forwardNameSuffix(appName?: string | null): string {
	return `via ${String(appName ?? '').trim() || DEFAULT_APP_NAME}`;
}

const EMAIL_RE = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;

/**
 * `"Display name" <email>`: CR/LF and control characters dropped, `\` and `"` escaped
 * inside a quoted string; a non-ASCII name becomes an RFC 2047 encoded word. No name →
 * the bare address.
 */
export function formatAddress(name: string | null | undefined, email: string): string {
	const clean = String(name ?? '')
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!clean) return email;
	if (/[^\x20-\x7e]/.test(clean)) {
		const bytes = new TextEncoder().encode(clean);
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return `=?UTF-8?B?${btoa(bin)}?= <${email}>`;
	}
	return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${email}>`;
}

type SenderEnv = {
	INBOUND_FORWARD_FROM?: string;
	REVIEW_FROM?: string;
	POSTMARK_FROM?: string;
};

/** Lower-cased domain of a bare email address, or '' when it isn't one. */
export function emailDomain(address: string | null | undefined): string {
	const a = String(address ?? '').trim();
	if (!EMAIL_RE.test(a)) return '';
	return a.slice(a.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * The verified sending domain: the domain of `POSTMARK_FROM` (the Postmark-verified
 * sender's domain). '' when POSTMARK_FROM isn't a usable address.
 */
export function sendingDomain(env: SenderEnv): string {
	return emailDomain(env.POSTMARK_FROM);
}

/** True when `address` is an email address on `domain` (case-insensitive exact match). */
export function isOnSendingDomain(address: string | null | undefined, domain: string): boolean {
	const d = String(domain ?? '').trim().toLowerCase();
	return !!d && emailDomain(address) === d;
}

/**
 * The forward's sender address: the first of `INBOUND_FORWARD_FROM`, `REVIEW_FROM`,
 * `POSTMARK_FROM` that is an email address on the verified sending domain (the domain of
 * `POSTMARK_FROM`) — anything else would fail SPF/DMARC alignment. '' when none passes;
 * the caller then skips the forward.
 */
export function forwardSenderAddress(env: SenderEnv): string {
	const domain = sendingDomain(env);
	if (!domain) return '';
	for (const v of [env.INBOUND_FORWARD_FROM, env.REVIEW_FROM, env.POSTMARK_FROM]) {
		const a = String(v ?? '').trim();
		if (isOnSendingDomain(a, domain)) return a;
	}
	return '';
}

/**
 * Where a refused forward is retried from: `POSTMARK_FROM` (on the sending domain by
 * definition), or '' when it isn't a usable address.
 */
export function forwardFallbackAddress(env: SenderEnv): string {
	const a = String(env.POSTMARK_FROM ?? '').trim();
	return isOnSendingDomain(a, sendingDomain(env)) ? a : '';
}

/** `Re: <original>`, any existing Re:/Fwd: run collapsed so it's never `Re: Re:`. */
export function forwardSubject(subject: string | null | undefined): string {
	return `Re: ${stripReplyPrefixes(subject) || '(no subject)'}`;
}

/** Angle-bracketed message id; a bare Postmark MessageID gets Postmark's domain. */
function bracketId(id: string): string {
	const bare = id.trim().replace(/^<|>$/g, '');
	return `<${bare.includes('@') ? bare : `${bare}@mtasv.net`}>`;
}

/**
 * In-Reply-To / References for the forward, so it threads with the original conversation.
 * Only when the parent (the message the contact answered) is known; the reply's own
 * Message-ID is added to References when present.
 */
export function threadingHeaders(
	parentId: string | null | undefined,
	replyMessageId: string | null | undefined
): { Name: string; Value: string }[] {
	if (!parentId || !parentId.trim()) return [];
	const parent = bracketId(parentId);
	const refs = [parent];
	if (replyMessageId && replyMessageId.trim()) {
		const own = bracketId(replyMessageId);
		if (own.toLowerCase() !== parent.toLowerCase()) refs.push(own);
	}
	return [
		{ Name: 'In-Reply-To', Value: parent },
		{ Name: 'References', Value: refs.join(' ') }
	];
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type ForwardInput = {
	senderAddress: string;
	to: string;
	stream: string;
	contactEmail: string;
	contactName: string | null;
	subject: string | null;
	text: string;
	/** The sender's original HTML, forwarded as-is when the text came from it. */
	originalHtml?: string | null;
	crmUrl: string;
	parentMessageId?: string | null;
	replyMessageId?: string | null;
	/** Settings → Branding's app name, shown as "<Contact> via <app name>" (#596). */
	appName?: string | null;
};

export function buildReplyForward(f: ForwardInput): PostmarkMessage {
	const name = (f.contactName ?? '').trim();
	const who = name ? `${name} <${f.contactEmail}>` : f.contactEmail;
	const body = stripTrailingQuoteIntro(f.text) || '(no text)';
	const footerText = `Reply from ${who} · View in CRM: ${f.crmUrl}`;
	const footerHtml = `<hr><p style="color:#888;font-size:13px">Reply from ${escapeHtml(who)} · <a href="${escapeHtml(f.crmUrl)}">View in CRM</a></p>`;
	const html = f.originalHtml
		? `${f.originalHtml}${footerHtml}`
		: `<p style="white-space:pre-wrap">${escapeHtml(body)}</p>${footerHtml}`;
	const headers = threadingHeaders(f.parentMessageId, f.replyMessageId);
	return {
		From: formatAddress(`${name || f.contactEmail} ${forwardNameSuffix(f.appName)}`, f.senderAddress),
		To: f.to,
		ReplyTo: formatAddress(name, f.contactEmail),
		Subject: forwardSubject(f.subject),
		TextBody: `${body}\n\n— ${footerText}`,
		HtmlBody: html,
		MessageStream: f.stream,
		TrackOpens: false,
		TrackLinks: 'None',
		...(headers.length ? { Headers: headers } : {})
	};
}

/**
 * Send the forward. When the dedicated sender is refused (e.g. not an approved Postmark
 * sender signature), log it and send once more from `fallbackAddress` with the same
 * display name, so the operator still gets the reply. The fallback is only used when it is
 * on the same domain as `senderAddress` (itself domain-checked by `forwardSenderAddress`),
 * so a retry can never go out from an unaligned domain.
 */
export async function sendReplyForward(
	token: string,
	message: PostmarkMessage,
	senderAddress: string,
	fallbackAddress: string,
	send: typeof sendBatch = sendBatch
): Promise<{ ok: boolean; fallbackUsed: boolean; error: string | null; messageId: string | null }> {
	const first = await sendOne(send, token, message);
	if (first.ok) return { ok: true, fallbackUsed: false, error: null, messageId: first.messageId };
	const fallback = fallbackAddress.trim();
	if (!fallback || fallback.toLowerCase() === senderAddress.toLowerCase()) {
		return { ok: false, fallbackUsed: false, error: first.error, messageId: null };
	}
	if (!isOnSendingDomain(fallback, emailDomain(senderAddress))) {
		console.error(
			`inbound forward: Postmark refused sender ${senderAddress} (${first.error}); ` +
				`not retrying because the fallback sender is not on the sending domain.`
		);
		return { ok: false, fallbackUsed: false, error: first.error, messageId: null };
	}
	console.error(
		`inbound forward: Postmark refused sender ${senderAddress} (${first.error}). ` +
			`Check that INBOUND_FORWARD_FROM / REVIEW_FROM is an approved Postmark sender. Retrying from ${fallback}.`
	);
	const From = /<[^<>]*>$/.test(message.From)
		? message.From.replace(/<[^<>]*>$/, `<${fallback}>`)
		: fallback;
	const second = await sendOne(send, token, { ...message, From });
	return { ok: second.ok, fallbackUsed: true, error: second.error, messageId: second.messageId };
}

async function sendOne(
	send: typeof sendBatch,
	token: string,
	message: PostmarkMessage
): Promise<{ ok: boolean; error: string | null; messageId: string | null }> {
	try {
		const [r] = (await send(token, [message])) as PostmarkResult[];
		// #585: Postmark's MessageID — the forward's Message-ID is `<MessageID@mtasv.net>`.
		if (r && r.ErrorCode === 0) return { ok: true, error: null, messageId: r.MessageID ?? null };
		return { ok: false, error: r ? `${r.ErrorCode}: ${r.Message}` : 'no result', messageId: null };
	} catch (e) {
		return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), messageId: null };
	}
}
