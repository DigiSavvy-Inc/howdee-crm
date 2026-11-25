import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { resolveMailCredentials } from '$lib/server/mail/config';
import { parseResendWebhook, type ResendMapped } from '$lib/server/mail/resend';
import { WebhookAuthError } from '$lib/server/mail/provider';
import { ingestMailEvent, type EventRecipient } from '$lib/server/mail-event-ingest';

// #702: Resend events (docs/sending-providers.md → Resend). Public through the `/api/webhook`
// prefix (PUBLIC_PREFIXES, CSRF_EXEMPT, REDIRECT_EXEMPT); the Svix signature is its only gate and
// is checked over the raw body before anything is parsed. Each event becomes the Postmark-shaped
// record the shared processing reads (`ingestMailEvent`), so dedupe (the `svix-id`, kept across
// Resend's retries), suppression, scanner clicks, tags and triggers work as for Postmark.
//
// The secret is read whatever the active provider is, so late events for mail Resend sent keep
// counting after a switch away, as long as the secret stays set.

export const POST: RequestHandler = async (event) => {
	const db = getDB(event);
	const creds = await resolveMailCredentials(db, event.platform?.env);
	const secret = creds.resend.webhookSecret;
	if (!secret) {
		console.error(
			creds.resend.webhookSecretError
				? 'resend webhook refused: the signing secret saved in Settings → Sending can’t be read'
				: 'resend webhook refused: RESEND_WEBHOOK_SECRET is not set'
		);
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	let mapped: ResendMapped[];
	try {
		mapped = await parseResendWebhook(event.request, secret);
	} catch (e) {
		if (e instanceof WebhookAuthError) return json({ error: 'unauthorized' }, { status: 401 });
		throw e;
	}
	if (!mapped.length) return json({ ok: true, ignored: true });

	let duplicates = 0;
	for (const m of mapped) {
		if (m.kind === 'failed') {
			// Resend took the email but couldn't send it: the send row is marked failed with its reason.
			if (m.messageId) {
				await db
					.prepare(`UPDATE recipients SET status = 'error', error = ? WHERE message_id = ? AND provider = 'resend'`)
					.bind(`Resend: ${m.reason}`.slice(0, 300), m.messageId)
					.run();
			}
			continue;
		}

		let recipient: (EventRecipient & { track_id: string | null }) | null = null;
		if (m.messageId) {
			recipient = await db
				.prepare('SELECT id, campaign_id, contact_id, email, track_id FROM recipients WHERE message_id = ? LIMIT 1')
				.bind(m.messageId)
				.first();
		}
		// #701: the CRM tracked this message itself, so Resend's open / click would count twice.
		if ((m.type === 'open' || m.type === 'click') && recipient?.track_id) continue;

		const payload = { ...m.payload };
		if (m.type === 'open') {
			// Resend doesn't say whether this is the first open; the proxy-open rule wants it.
			const prior = recipient
				? await db.prepare("SELECT 1 AS x FROM events WHERE recipient_id = ? AND type = 'open' LIMIT 1").bind(recipient.id).first<{ x: number }>()
				: null;
			payload.FirstOpen = !prior;
		}

		const res = await ingestMailEvent(db, {
			payload,
			type: m.type,
			messageId: m.messageId,
			email: m.email,
			recipient: recipient ? { id: recipient.id, campaign_id: recipient.campaign_id, contact_id: recipient.contact_id, email: recipient.email } : null,
			label: 'resend webhook',
			context: m.resendType,
			via: 'Resend'
		});
		if (res.duplicate) duplicates++;
	}
	return json({ ok: true, ...(duplicates ? { duplicate: true } : {}) });
};
