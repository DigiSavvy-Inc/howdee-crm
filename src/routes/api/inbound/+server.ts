import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { safeEqual } from '$lib/server/auth';
import { mailSetup } from '$lib/server/mail';
import { getSettings, parseEmailList } from '$lib/server/settings';
import { pickInboundText } from '$lib/server/inbound-text';
import { markDirty } from '$lib/server/engagement';
import {
	conversationsFor,
	inReplyToFromHeaders,
	messageIdFromHeaders,
	messageIdKey
} from '$lib/server/conversations';
import {
	buildReplyForward,
	forwardFallbackAddress,
	forwardSenderAddress,
	sendReplyForward,
	withSenderStandIn
} from '$lib/server/reply-forward';
import { bareAddress } from '$lib/server/conversation-reply';
import { publicBaseUrl } from '$lib/server/public-url';
import { getBranding } from '$lib/server/branding';
import { snapshot } from '$lib/server/snapshot';
import { loadInternalSet } from '$lib/server/mail-sync';
import { isInternal } from '$lib/mail-filter';

/**
 * Postmark Inbound webhook (#39). Captures a reply, stores it, and forwards a copy to
 * the operator's inbox so replies still land there too.
 *
 * Auth: `?key=<INBOUND_KEY>` (set on the Postmark inbound webhook URL). In PUBLIC_PREFIXES.
 * Correlation: the reply's `MailboxHash` is our per-recipient tag `c<campaignId>r<contactId>`
 * (from the Reply-To we set on sends, #38) → exact campaign + contact. Falls back to
 * matching the sender's email to a contact.
 */
export const POST: RequestHandler = async (event) => {
	// #605: no INBOUND_KEY = reply capture isn't set up. A quiet 404, not a 500.
	const key = event.platform?.env?.INBOUND_KEY ?? '';
	if (!key) return json({ error: 'Reply capture is not set up' }, { status: 404 });
	if (!safeEqual(event.url.searchParams.get('key') ?? '', key)) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	let p: Record<string, any>;
	try {
		p = await event.request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	const db = getDB(event);
	// #380: StrippedTextReply, then a real TextBody, then text converted from HTML.
	const picked = pickInboundText(p);

	const fromEmail = String(p.FromFull?.Email ?? p.From ?? '')
		.trim()
		.toLowerCase();
	if (!fromEmail) return json({ ignored: 'no sender' }, { status: 200 });

	// Snapshot review replies (#130): "approve" / "hold <notes>" from the review's
	// recipient act on the job and stop here. Runs before the self check (that sender is
	// usually POSTMARK_FROM). Anything else falls through to the normal reply path.
	// A reply in a review thread is never a lead reply, so it never tags snapshot:replied (#190).
	let reviewThread = false;
	// #604: SNAPSHOT_MODE unset / off = no review-reply handling and no snapshot:replied tag.
	const snapshots = snapshot.enabled(event.platform?.env);
	if (snapshots) {
		try {
			const review = await snapshot.handleReviewReply(db, event.platform?.env, {
				fromEmail,
				headers: p.Headers,
				text: picked.text
			});
			reviewThread = !!review;
			if (review && !review.outcome.startsWith('ignored_')) {
				return json({ ok: true, snapshot_job_id: review.jobId, snapshot: review.outcome });
			}
		} catch (e) {
			console.error('snapshot review reply failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
		}
	}

	// Forward destinations (#43): the in-app setting wins; fall back to the env var.
	const settings = await getSettings(db);
	const forwardList = parseEmailList(
		settings.inbound_forward_to ?? event.platform?.env?.INBOUND_FORWARD_TO ?? ''
	);
	const forwardTo = forwardList.join(',');

	// Ignore our own forwards / operator mail (avoid loops + self-captures). #731: the sending
	// address is POSTMARK_FROM, else Settings → General → Default From (withSenderStandIn), compared
	// as a bare address so `Brand <a@example.com>` matches a@example.com.
	const platformEnv = withSenderStandIn((event.platform?.env ?? {}) as Record<string, string | undefined>, settings.default_from);
	const fromAddr = bareAddress(platformEnv.POSTMARK_FROM ?? '');
	if (forwardList.includes(fromEmail) || fromEmail === fromAddr) {
		return json({ ignored: 'self' }, { status: 200 });
	}
	// #585: mail from any internal address (a connected mailbox, a user's email, an internal
	// domain) is our own mail, never a contact's reply. A teammate's answer reaches the thread
	// through Gmail sync when their mailbox is connected.
	try {
		if (isInternal(fromEmail, await loadInternalSet(db))) return json({ ignored: 'internal' }, { status: 200 });
	} catch (e) {
		console.error('inbound internal check failed:', e instanceof Error ? e.message.slice(0, 200) : e);
	}

	const subject = String(p.Subject ?? '').slice(0, 500);
	// StrippedTextReply/TextBody are EMPTY STRINGS (not undefined) for HTML-only replies
	// (Apple Mail and others), and some senders put HTML in the text part (#380):
	// pickInboundText handles both. `html` is the markup the text came from ("View original").
	const htmlBody = String(p.HtmlBody ?? '');
	const usedHtmlFallback = picked.fromHtmlBody;
	const text = picked.text.slice(0, 20000);
	const raw = JSON.stringify(p).slice(0, 20000);

	// Correlate via MailboxHash: c<campaignId>r<contactId>.
	const hash = String(p.MailboxHash ?? '');
	const m = hash.match(/^c(\d+)r(\d+)$/);
	let campaignId: number | null = null;
	let contactId: number | null = null;
	if (m) {
		const cid = Number(m[1]);
		const rid = Number(m[2]);
		const camp = await db.prepare('SELECT id FROM campaigns WHERE id = ?').bind(cid).first<{ id: number }>();
		if (camp) campaignId = camp.id;
		if (rid > 0) {
			const con = await db.prepare('SELECT id FROM contacts WHERE id = ?').bind(rid).first<{ id: number }>();
			if (con) contactId = con.id;
		}
	}
	// In-Reply-To (#157): stored for exact threading. When the MailboxHash tag didn't
	// identify the campaign (e.g. a reply to a copy without our Reply-To), the header can:
	// Postmark's Message-ID is `<MessageID@…>`, and recipients store the bare MessageID.
	const inReplyTo = inReplyToFromHeaders(p.Headers);
	if (inReplyTo && campaignId === null) {
		const rec = await db
			.prepare('SELECT campaign_id, contact_id FROM recipients WHERE message_id = ? LIMIT 1')
			.bind(messageIdKey(inReplyTo))
			.first<{ campaign_id: number; contact_id: number | null }>();
		if (rec) {
			campaignId = rec.campaign_id;
			if (contactId === null) contactId = rec.contact_id;
		}
	}
	// Fallback: match the sender's email to a contact.
	if (contactId === null) {
		const con = await db
			.prepare('SELECT id FROM contacts WHERE email = ?')
			.bind(fromEmail)
			.first<{ id: number }>();
		if (con) contactId = con.id;
	}

	// The sender's own Message-ID (#159) — what a reply from the app answers.
	const messageIdHeader = messageIdFromHeaders(p.Headers, 'message-id');

	const inserted = await db
		.prepare(
			`INSERT INTO replies (contact_id, campaign_id, from_email, subject, text, raw, in_reply_to_message_id, message_id_header, html_body)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 RETURNING id`
		)
		.bind(contactId, campaignId, fromEmail, subject || null, text || null, raw, inReplyTo, messageIdHeader, picked.html)
		.first<{ id: number }>();

	// Contact engagement rollup (#111/#113): a reply is a strong engagement signal —
	// flag the contact for recompute on the next heartbeat tick. Best-effort.
	if (contactId) {
		try {
			await markDirty(db, [contactId]);
		} catch (e) {
			console.error('engagement markDirty failed:', e);
		}
		// Snapshot feature (#190): a real reply tags snapshot:replied; an auto-reply doesn't.
		if (snapshots && !reviewThread) {
			try {
				await snapshot.tagReply(db, event.platform?.env, contactId, p.Headers, subject, fromEmail);
			} catch (e) {
				console.error('snapshot reply tag failed:', e instanceof Error ? e.message.slice(0, 200) : e);
			}
		}
	}

	// Forward a copy to the operator's inbox (best-effort, #381). From = a dedicated sender
	// with the contact's name ("Ann Lee via <app name>", Settings → Branding), Reply-To = the contact, so
	// replying from the inbox reaches them directly.
	// The sender must be on the verified sending domain (POSTMARK_FROM's, else the Default From's)
	// — never the forward-to inbox, which may be on another domain and fail SPF/DMARC alignment.
	const senderAddress = forwardTo ? forwardSenderAddress(platformEnv) : '';
	if (forwardTo && !senderAddress) {
		console.error(
			'inbound forward skipped: no sender on the verified sending domain. Set INBOUND_FORWARD_FROM, ' +
				'REVIEW_FROM, POSTMARK_FROM or the Default From to an address on the sending domain.'
		);
	}
	if (forwardTo && senderAddress) {
		try {
			// #700: the active sending provider (Settings → Sending, else the env).
			const { provider: mail, creds: mailCreds } = await mailSetup(db, event.platform?.env);
			if (!mail) throw new Error(mailCreds.postmark.tokenError ?? 'no sending provider is configured (POSTMARK_TOKEN)');
			const txStream = mail.streams.transactional;
			const baseUrl = await publicBaseUrl(db, event.platform?.env, event.url.origin);

			// Link the thread when we can find it, else the contact, else the inbox list.
			let crmUrl = `${baseUrl}/conversations`;
			if (contactId) {
				crmUrl = `${baseUrl}/contacts/${contactId}`;
				try {
					const thread = (await conversationsFor(db, contactId)).find((t) =>
						t.messages.some((m) => m.reply_id === inserted?.id)
					);
					if (thread) crmUrl = `${baseUrl}/conversations/${encodeURIComponent(thread.key)}`;
				} catch (e) {
					console.error('inbound forward: thread lookup failed:', e instanceof Error ? e.message.slice(0, 200) : e);
				}
			}

			// The message the contact answered: their In-Reply-To, else our send to them.
			let parentId: string | null = inReplyTo;
			if (!parentId && campaignId && contactId) {
				const rec = await db
					.prepare(
						`SELECT message_id FROM recipients
						 WHERE campaign_id = ? AND contact_id = ? AND message_id IS NOT NULL
						 ORDER BY id DESC LIMIT 1`
					)
					.bind(campaignId, contactId)
					.first<{ message_id: string }>();
				parentId = rec?.message_id ?? null;
			}

			const message = buildReplyForward({
				senderAddress,
				to: forwardTo,
				stream: txStream,
				contactEmail: fromEmail,
				contactName: String(p.FromFull?.Name ?? '').trim() || null,
				subject,
				text,
				// When the text was derived from HTML (no real StrippedTextReply/TextBody),
				// forward the ORIGINAL HtmlBody — a more faithful copy of what they sent.
				originalHtml: usedHtmlFallback ? htmlBody : null,
				crmUrl,
				parentMessageId: parentId,
				replyMessageId: messageIdHeader,
				appName: (await getBranding(db)).appName
			});
			const sent = await sendReplyForward(
				mail,
				message,
				senderAddress,
				forwardFallbackAddress(platformEnv)
			);
			if (!sent.ok) console.error('inbound forward failed:', sent.error);
			// #585: answering the forward from a mail client names it in In-Reply-To / References;
			// its id on the reply row is how that answer finds this thread.
			if (sent.ok && sent.messageId && inserted?.id) {
				await db.prepare('UPDATE replies SET forward_message_id = ?, forward_provider = ? WHERE id = ?').bind(sent.messageId, mail.id, inserted.id).run();
			}
		} catch (e) {
			console.error('inbound forward failed:', e);
		}
	}

	return json({ ok: true, contact_id: contactId, campaign_id: campaignId });
};
