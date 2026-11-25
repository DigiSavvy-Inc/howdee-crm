// Reply from the app (#159) — the Reply box under a conversation. A 1:1 send on the
// transactional stream through the shared send path, with In-Reply-To / References taken
// from the thread's stored Message-IDs so it threads in the contact's inbox. Logged as a
// direct campaign (list_id NULL) carrying `in_reply_to_message_id`, so conversations.ts
// files it under the same thread on the next read.

import { renderEmailHtml, renderEmailText } from './email';
import { getSignature } from './email-signature';
import { sendCampaignEmail, type SendableRecipient } from './send';
import type { MailProvider } from './mail';
import { replyThreadingIds, stripReplyPrefixes, type Conversation } from './conversations';

export const MAX_REPLY_LENGTH = 20_000;

/** `Re: <thread subject>` — the thread subject is already prefix-stripped. */
export function replySubject(conv: Conversation): string {
	const base = stripReplyPrefixes(conv.subject);
	return base && base !== '(no subject)' ? `Re: ${base}` : 'Re:';
}

/** In-Reply-To / References header values (`<id>` form) for a reply to `conv`. */
export function replyHeaders(conv: Conversation): { Name: string; Value: string }[] {
	const { inReplyTo, references } = replyThreadingIds(conv);
	if (!inReplyTo) return [];
	return [
		{ Name: 'In-Reply-To', Value: `<${inReplyTo}>` },
		{ Name: 'References', Value: references.map((id) => `<${id}>`).join(' ') }
	];
}

/** The address from `"Name" <addr>` or `addr`, case kept (for an address that is sent from). */
export function addressOf(from: string): string {
	const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
	return (m ? m[1] : from).trim();
}

/** Bare address from `"Name" <addr>` or `addr`, lowercased (for comparing). */
export function bareAddress(from: string): string {
	return addressOf(from).toLowerCase();
}

export type ReplyResult = { ok: true; campaignId: number } | { ok: false; campaignId: number | null; error: string };

export async function sendConversationReply(
	db: D1Database,
	opts: {
		conv: Conversation;
		bodyMd: string;
		from: string;
		/** BCC address (the operator) when the Settings toggle is on; omitted = no BCC. */
		bcc?: string | null;
		token: string;
		/** #700: the active sending provider (unset = a Postmark adapter for `token`). */
		provider?: MailProvider | null;
		secret: string;
		baseUrl: string;
		stream: string;
		replyToInbound?: string;
	}
): Promise<ReplyResult> {
	const { conv, from } = opts;
	const bodyMd = opts.bodyMd.trim();
	if (!bodyMd) return { ok: false, campaignId: null, error: 'Write a reply first.' };
	if (bodyMd.length > MAX_REPLY_LENGTH) return { ok: false, campaignId: null, error: 'That reply is too long.' };

	// Personalise against the current contact record, like compose's 1:1 send.
	let recipient: SendableRecipient = {
		id: null,
		email: conv.email,
		name: null,
		first_name: null,
		last_name: null,
		company: null
	};
	if (conv.contact_id != null) {
		const c = await db
			.prepare('SELECT id, email, name, first_name, last_name, company FROM contacts WHERE id = ?')
			.bind(conv.contact_id)
			.first<SendableRecipient & { id: number }>();
		if (!c) return { ok: false, campaignId: null, error: 'That contact no longer exists.' };
		recipient = c;
	}

	const subject = replySubject(conv);
	const headers = replyHeaders(conv);
	const inReplyTo = replyThreadingIds(conv).inReplyTo;
	const signature = await getSignature(db);
	const htmlTemplate = renderEmailHtml(bodyMd, { unsubscribe: false, signature });
	const textTemplate = renderEmailText(bodyMd, { unsubscribe: false, signature });

	const campaign = await db
		.prepare(
			`INSERT INTO campaigns (subject, body_md, body_html, list_id, from_email, status, sent_at, in_reply_to_message_id)
			 VALUES (?, ?, ?, NULL, ?, 'sending', datetime('now'), ?)
			 RETURNING id`
		)
		.bind(subject, bodyMd, htmlTemplate, from, inReplyTo)
		.first<{ id: number }>();
	const campaignId = campaign!.id;

	let accepted = 0;
	let firstError: string | null = null;
	try {
		({ accepted, firstError } = await sendCampaignEmail(db, {
			token: opts.token,
			provider: opts.provider,
			secret: opts.secret,
			baseUrl: opts.baseUrl,
			campaignId,
			recipients: [recipient],
			subject,
			htmlTemplate,
			textTemplate,
			from,
			stream: opts.stream,
			unsubscribe: false,
			replyToInbound: opts.replyToInbound,
			bcc: opts.bcc || undefined,
			headers
		}));
	} catch (e) {
		firstError = e instanceof Error ? e.message : String(e);
	}
	const ok = accepted > 0;
	await db
		.prepare(`UPDATE campaigns SET status = ?, recipient_count = ?, error = ? WHERE id = ?`)
		.bind(ok ? 'sent' : 'failed', accepted, ok ? null : firstError, campaignId)
		.run();
	return ok ? { ok: true, campaignId } : { ok: false, campaignId, error: firstError ?? 'Send failed.' };
}
