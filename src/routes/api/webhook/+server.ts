import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { ingestMailEvent, type EventRecipient } from '$lib/server/mail-event-ingest';
import { requestKeyMatches } from '$lib/server/request-key';
import { BodyTooLargeError, readCappedText } from '$lib/server/webhook-body';

// Postmark RecordType -> our event type.
const TYPE_MAP: Record<string, string> = {
	Delivery: 'delivery',
	Open: 'open',
	Click: 'click',
	Bounce: 'bounce',
	SpamComplaint: 'spam',
	SubscriptionChange: 'unsubscribe'
};

export const POST: RequestHandler = async (event) => {
	const db = getDB(event);

	// #542: shared-secret gate, fail closed. No WEBHOOK_KEY configured → every request is refused.
	const key = event.platform?.env?.WEBHOOK_KEY ?? '';
	if (!key) {
		console.error('webhook refused: WEBHOOK_KEY is not set');
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	// #750: the key may come in an Authorization header (Bearer, or Basic with the key as
	// password) or as `?key=` (the webhook URLs already set in Postmark); either one matching is enough.
	if (!requestKeyMatches(event.request, event.url, key)) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	// #750: the body is capped before it is parsed.
	let payload: Record<string, any>;
	try {
		payload = JSON.parse(await readCappedText(event.request));
	} catch (e) {
		if (e instanceof BodyTooLargeError) return json({ error: 'body too large' }, { status: 413 });
		return json({ error: 'invalid json' }, { status: 400 });
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	const recordType = String(payload.RecordType ?? '');
	const type = TYPE_MAP[recordType];
	if (!type) return json({ ignored: recordType }, { status: 200 });

	const messageId: string | null = payload.MessageID ?? null;
	const email: string | null = payload.Recipient ?? payload.Email ?? null;

	// Map back to the recipient/campaign we sent. #750: only sends Postmark made — a message id
	// another provider gave out never matches here.
	let recipient: (EventRecipient & { track_id: string | null }) | null = null;
	if (messageId) {
		recipient = await db
			.prepare("SELECT id, campaign_id, contact_id, email, track_id FROM recipients WHERE message_id = ? AND provider = 'postmark' LIMIT 1")
			.bind(messageId)
			.first();
	}

	// #701: the CRM tracked this message itself (its pixel and links), so a provider open / click
	// for it would count twice — ignore it.
	if ((type === 'open' || type === 'click') && recipient?.track_id) {
		return json({ ignored: 'tracked by the CRM' });
	}

	const res = await ingestMailEvent(db, {
		payload,
		type,
		messageId,
		email,
		recipient: recipient ? { id: recipient.id, campaign_id: recipient.campaign_id, contact_id: recipient.contact_id, email: recipient.email } : null,
		label: 'webhook',
		context: `RecordType ${recordType}`
	});
	if (res.duplicate) return json({ ok: true, duplicate: true });
	return json({ ok: true });
};
