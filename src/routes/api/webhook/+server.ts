import { json, type RequestHandler } from '@sveltejs/kit';
import { getDB } from '$lib/server/db';
import { addTag, autoEnroll } from '$lib/server/automations';
import { clickTypeFor, getEngagementConfig, markDirty, reclassifyScannerClicks } from '$lib/server/engagement';
import { fireEngagementTriggers } from '$lib/server/engagement-trigger';
import { compactEventDetail } from '$lib/server/event-detail';
import { subscriptionChanged } from '$lib/server/subscription-trigger';
import { safeEqual } from '$lib/server/auth';
import { webhookDedupeKey } from '$lib/server/webhook-dedupe';

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
	let recipient: { id: number; campaign_id: number; contact_id: number | null; email: string } | null = null;
	if (messageId) {
		recipient = await db
			.prepare('SELECT id, campaign_id, contact_id, email FROM recipients WHERE message_id = ? LIMIT 1')
			.bind(messageId)
			.first();
	}

	// #518: a click on our own unsubscribe link is stored as `unsubscribe_click` — a page view,
	// never engagement.
	const storedType = type === 'click' ? clickTypeFor(payload.OriginalLink) : type;
	const dedupeKey = await webhookDedupeKey(payload);
	const inserted = await db
		.prepare(
			`INSERT OR IGNORE INTO events (campaign_id, recipient_id, contact_id, type, message_id, detail, dedupe_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
		)
		.bind(
			recipient?.campaign_id ?? null,
			recipient?.id ?? null,
			recipient?.contact_id ?? null,
			storedType,
			messageId,
			// #412: valid JSON even for long payloads (was a 4,000-character slice).
			compactEventDetail(payload),
			dedupeKey
		)
		.first<{ id: number }>();
	// #542: already stored = a Postmark retry of the same record. #570: it is a no-op only when
	// that row finished processing. A row left unprocessed (processEvent failed, the request died)
	// is processed again on the retry instead of hiding behind the dedupe key.
	let eventId: number;
	if (inserted) {
		eventId = inserted.id;
	} else {
		const existing = dedupeKey
			? await db
					.prepare('SELECT id, processed_at FROM events WHERE dedupe_key = ?')
					.bind(dedupeKey)
					.first<{ id: number; processed_at: string | null }>()
			: null;
		if (!existing || existing.processed_at) return json({ ok: true, duplicate: true });
		eventId = existing.id;
	}

	const step: StepRef = { name: 'start' };
	try {
		await processEvent(db, { payload, type, storedType, email, recipient, eventId }, step);
		step.name = 'mark processed';
		await db.prepare("UPDATE events SET processed_at = datetime('now') WHERE id = ?").bind(eventId).run();
	} catch (e) {
		// #570: never the address. RecordType + MessageID identify the record in Postmark.
		console.error(
			`webhook processing failed at "${step.name}" (RecordType ${recordType}, MessageID ${messageId ?? 'none'}):`,
			(e instanceof Error ? e.message : String(e)).slice(0, 200)
		);
		// The row keeps processed_at NULL, so Postmark's retry runs the processing again.
		throw e;
	}
	return json({ ok: true });
};

/** The step processEvent is in, for the failure log (#570). */
type StepRef = { name: string };

async function processEvent(
	db: D1Database,
	ctx: {
		payload: Record<string, any>;
		type: string;
		storedType: string;
		email: string | null;
		recipient: { id: number; campaign_id: number; contact_id: number | null; email: string } | null;
		eventId: number;
	},
	step: StepRef = { name: 'start' }
): Promise<void> {
	// #570: every step below is safe to run twice — a retry of an unprocessed event repeats them.
	const { payload, type, storedType, email, recipient } = ctx;

	// #518: security-scanner bursts. Re-check this recipient's clicks BEFORE tags / triggers run,
	// so the 2nd+ click of a burst (and any click paired with the unsubscribe link) never fires
	// them. The first click of a burst can't be known as one yet — it is a real `click` until a
	// later click reclassifies it, so its tag-on-click / trigger may already have run (gap).
	step.name = 'scanner clicks';
	let isRealClick = storedType === 'click';
	if (type === 'click' && recipient?.id) {
		try {
			const changed = await reclassifyScannerClicks(db, recipient.id, await getEngagementConfig(db));
			if (changed.includes(ctx.eventId)) isRealClick = false;
		} catch (e) {
			console.error('scanner click classification failed:', e);
		}
	}

	// Contact engagement rollup (#111/#113): flag the contact for recompute on the
	// next heartbeat tick. Best-effort — never let a logging-adjacent failure here
	// fail the webhook itself.
	step.name = 'engagement dirty';
	if (recipient?.contact_id) {
		try {
			await markDirty(db, [recipient.contact_id]);
		} catch (e) {
			console.error('engagement markDirty failed:', e);
		}
	}

	// Engagement auto-tagging (#42/#12): if this open/click is for an email configured to
	// tag on that engagement (automation step OR broadcast campaign), tag the contact —
	// and fire tag triggers, so "opened/clicked → enroll in automation" works end to end.
	// Idempotent: addTag is INSERT OR IGNORE and enroll() dedupes, so repeat events of the
	// same kind can't double-tag or double-enroll.
	if ((type === 'open' || (type === 'click' && isRealClick)) && recipient?.contact_id && recipient?.campaign_id) {
		step.name = 'engagement tag';
		// Step-level tags win; campaign-level (#12, broadcasts) fill in otherwise.
		const stepTags = await db
			.prepare(
				`SELECT COALESCE(s.tag_on_open, c.tag_on_open) AS tag_on_open,
				        COALESCE(s.tag_on_click, c.tag_on_click) AS tag_on_click
				 FROM campaigns c
				 LEFT JOIN automation_steps s ON s.id = c.automation_step_id
				 WHERE c.id = ?`
			)
			.bind(recipient.campaign_id)
			.first<{ tag_on_open: string | null; tag_on_click: string | null }>();
		const tagName = type === 'open' ? stepTags?.tag_on_open : stepTags?.tag_on_click;
		if (tagName && tagName.trim()) {
			await addTag(db, tagName.trim(), recipient.contact_id);
			try {
				const tag = await db
					.prepare("SELECT id FROM lists WHERE name = ? AND kind = 'tag'")
					.bind(tagName.trim())
					.first<{ id: number }>();
				if (tag) await autoEnroll(db, tag.id, [recipient.contact_id]);
			} catch (e) {
				console.error('engagement auto-enroll failed:', e);
			}
		}

		// #412: the "Opens an email" / "Clicks a link in an email" triggers. Best-effort — a
		// trigger failure never fails the webhook (Postmark would retry the whole event).
		step.name = 'engagement triggers';
		try {
			await fireEngagementTriggers(db, {
				type,
				campaignId: recipient.campaign_id,
				contactId: recipient.contact_id,
				recipientId: recipient.id,
				detail: payload
			});
		} catch (e) {
			console.error('engagement triggers failed:', e);
		}
	}

	// Suppress the contact on hard unsubscribe / spam / hard bounce.
	const suppress =
		type === 'spam' ||
		(type === 'unsubscribe' && payload.SuppressSending !== false) ||
		(type === 'bounce' && (payload.Type === 'HardBounce' || payload.Inactive === true));

	// #542: only for an address we actually sent this message to — a payload naming any other
	// address (or no / an unknown MessageID) is stored as an event and changes nobody.
	const matchesSend = !!email && !!recipient && recipient.email.trim().toLowerCase() === email.trim().toLowerCase();
	if (suppress && email && !matchesSend) {
		console.warn('webhook: suppression ignored, MessageID does not match a send to that address');
	}

	if (suppress && email && matchesSend) {
		// Unsubscribe the contact and record why (Postmark-originated, reason from its payload).
		// #285: a hard bounce gets its audit row too (reason `HardBounce`). #570: one row per
		// email, campaign and reason — a retry (or a second record for the same send) never adds
		// another — and both writes go in one batch, so a failure leaves neither behind.
		step.name = 'unsubscribe contact';
		const reason =
			type === 'spam'
				? 'Marked as spam'
				: type === 'bounce'
					? 'HardBounce'
					: String(payload.SuppressionReason ?? 'Unsubscribed via email client');
		const campaignId = recipient?.campaign_id ?? null;
		const [flipped, inserted] = await db.batch<{ id: number }>([
			db.prepare('UPDATE contacts SET subscribed = 0 WHERE email = ? AND subscribed = 1 RETURNING id').bind(email.toLowerCase()),
			db
				.prepare(
					`INSERT INTO unsubscribes (contact_id, campaign_id, email, reason, detail)
					 SELECT ?, ?, ?, ?, 'via Postmark'
					 WHERE NOT EXISTS (
					   SELECT 1 FROM unsubscribes
					   WHERE email = ? AND campaign_id IS ? AND reason = ? AND detail = 'via Postmark'
					 )
					 RETURNING id`
				)
				.bind(recipient?.contact_id ?? null, campaignId, email.toLowerCase(), reason, email.toLowerCase(), campaignId, reason)
		]);
		const added = inserted.results.length > 0;

		// #444: "Subscription changes" trigger — `unsubscribed` (source postmark) when it flipped
		// `subscribed`, bounced / complained for a hard bounce / spam complaint. #570: those two
		// fire only with a new audit row, so a reprocessed retry never fires them twice.
		// Best-effort inside subscriptionChanged.
		step.name = 'subscription triggers';
		const contactId =
			flipped.results[0]?.id ??
			recipient?.contact_id ??
			(await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email.toLowerCase()).first<{ id: number }>())?.id;
		if (contactId) {
			if (flipped.results.length) await subscriptionChanged(db, [contactId], 'unsubscribed', { source: 'postmark' });
			if (added && type === 'bounce') await subscriptionChanged(db, [contactId], 'bounced', { source: 'postmark' });
			if (added && type === 'spam') await subscriptionChanged(db, [contactId], 'complained', { source: 'postmark' });
		}
	}
}
