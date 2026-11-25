import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { safeEqual } from '$lib/server/auth';
import { ingestMailEvent, type EventRecipient } from '$lib/server/mail-event-ingest';

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
	if (!safeEqual(event.url.searchParams.get('key') ?? '', key)) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	let payload: Record<string, any>;
	try {
		payload = await event.request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	const recordType = String(payload.RecordType ?? '');
	const type = TYPE_MAP[recordType];
	if (!type) return json({ ignored: recordType }, { status: 200 });

	const messageId: string | null = payload.MessageID ?? null;
	const email: string | null = payload.Recipient ?? payload.Email ?? null;

	// Map back to the recipient/campaign we sent.
	let recipient: (EventRecipient & { track_id: string | null }) | null = null;
	if (messageId) {
		recipient = await db
			.prepare('SELECT id, campaign_id, contact_id, email, track_id FROM recipients WHERE message_id = ? LIMIT 1')
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
