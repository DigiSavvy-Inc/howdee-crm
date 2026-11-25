// #701: an open or click on the CRM's own tracking links (/t/o, /t/c) → the same `events` row and
// processing a provider webhook would give (ingestMailEvent): scanner-click reclassification,
// the unsubscribe-link rule, engagement, tag-on-open / -click and the engagement triggers.
//
// The stored detail is Postmark-shaped so every reader works unchanged. It keeps the user agent
// and Cloudflare's country, never the IP address.

import { ingestMailEvent } from './mail-event-ingest';
import { SCANNER_CLICK, UNSUBSCRIBE_CLICK } from './engagement';
import type { UnsubPayload } from './token';

/** Most open events stored per tracked message in a rolling hour. Past it the pixel still
 *  answers, but nothing is written and nothing runs (a reload loop can't grow `events`). */
export const MAX_CRM_OPENS_PER_HOUR = 30;
/** Most click events (click, scanner_click, unsubscribe_click) stored per tracked message in a
 *  rolling hour. Past it the link still redirects, but nothing is written and nothing runs. */
export const MAX_CRM_CLICKS_PER_HOUR = 60;

export type CrmTrackInput = {
	trackId: string;
	type: 'open' | 'click';
	/** Clicks: the signed destination. */
	url?: string;
	userAgent?: string | null;
	country?: string | null;
	now?: Date;
};

type TrackedRecipient = { id: number; campaign_id: number; contact_id: number | null; email: string; message_id: string | null };

/** Record one tracked open / click. `recorded: false` when no send carries that id (the row was
 *  deleted with its contact), the same event was already stored, or the per-hour cap for this
 *  message is reached (`capped: true`). Throws only when processing fails (the caller logs it and
 *  still answers the reader). */
export async function recordCrmTrackingEvent(db: D1Database, input: CrmTrackInput): Promise<{ recorded: boolean; capped?: boolean }> {
	const r = await db
		.prepare('SELECT id, campaign_id, contact_id, email, message_id FROM recipients WHERE track_id = ? LIMIT 1')
		.bind(input.trackId)
		.first<TrackedRecipient>();
	if (!r) return { recorded: false };

	// Write cap: one COUNT on idx_events_recipient_type_time (recipient_id, type, recorded_at).
	const recent =
		input.type === 'open'
			? await db
					.prepare("SELECT COUNT(*) AS n FROM events WHERE recipient_id = ? AND type = 'open' AND recorded_at >= datetime('now', '-1 hour')")
					.bind(r.id)
					.first<{ n: number }>()
			: await db
					.prepare(
						`SELECT COUNT(*) AS n FROM events WHERE recipient_id = ? AND type IN ('click', '${SCANNER_CLICK}', '${UNSUBSCRIBE_CLICK}')
						 AND recorded_at >= datetime('now', '-1 hour')`
					)
					.bind(r.id)
					.first<{ n: number }>();
	const cap = input.type === 'open' ? MAX_CRM_OPENS_PER_HOUR : MAX_CRM_CLICKS_PER_HOUR;
	if ((recent?.n ?? 0) >= cap) return { recorded: false, capped: true };

	// Second precision, so a reload within the same second is one event (the dedupe key uses it).
	const at = (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
	const ua = (input.userAgent ?? '').slice(0, 500);
	const country = (input.country ?? '').trim().toUpperCase().slice(0, 2);
	const common = {
		MessageID: r.message_id,
		Recipient: r.email,
		ReceivedAt: at,
		UserAgent: ua,
		...(country ? { Geo: { CountryISOCode: country } } : {}),
		Source: 'crm'
	};
	let payload: Record<string, unknown>;
	if (input.type === 'open') {
		const prior = await db
			.prepare("SELECT 1 AS x FROM events WHERE recipient_id = ? AND type = 'open' LIMIT 1")
			.bind(r.id)
			.first<{ x: number }>();
		payload = { RecordType: 'Open', ...common, FirstOpen: !prior };
	} else {
		payload = { RecordType: 'Click', ...common, OriginalLink: input.url ?? '', ClickLocation: 'HTML' };
	}

	const res = await ingestMailEvent(db, {
		payload,
		type: input.type,
		messageId: r.message_id,
		email: r.email,
		recipient: { id: r.id, campaign_id: r.campaign_id, contact_id: r.contact_id, email: r.email },
		label: 'crm tracking',
		context: input.type
	});
	return { recorded: !res.duplicate };
}

/**
 * #518 in CRM mode: the unsubscribe link is never rewritten (compliance), so no click on it would
 * ever be stored and the "unsubscribe link plus any other link" scanner rule could not fire. A GET
 * of the public unsubscribe page stands in for that click: when the signed unsubscribe token
 * (campaign + contact + email) names exactly one accepted send and that send is CRM-tracked
 * (`track_id` set), an `unsubscribe_click` is recorded through `recordCrmTrackingEvent` (same
 * dedupe and per-hour cap as the click route), so `reclassifyScannerClicks` sees it.
 *
 * Does nothing when the token names no campaign, no send, a send without `track_id`, or more than
 * one send (a resend or a second automation pass reuses the same token, so the page view can't be
 * pinned to one message — no guessing). Never unsubscribes anyone. The stored link is the bare
 * page address (`/unsubscribe?t=`), never the token.
 */
export async function recordUnsubscribePageView(
	db: D1Database,
	payload: UnsubPayload,
	input: { origin: string; userAgent?: string | null; country?: string | null; now?: Date }
): Promise<{ recorded: boolean }> {
	if (!payload.c || !payload.e) return { recorded: false };
	const byContact = payload.k != null && payload.k > 0;
	const rows = await db
		.prepare(
			`SELECT id, track_id FROM recipients
			 WHERE campaign_id = ? AND status = 'accepted' AND ${byContact ? 'contact_id = ?' : 'email = ? COLLATE NOCASE'}
			 LIMIT 2`
		)
		.bind(payload.c, byContact ? payload.k : payload.e)
		.all<{ id: number; track_id: string | null }>();
	const trackId = rows.results.length === 1 ? rows.results[0].track_id : null;
	if (!trackId) return { recorded: false };
	const res = await recordCrmTrackingEvent(db, {
		trackId,
		type: 'click',
		url: `${input.origin.replace(/\/+$/, '')}/unsubscribe?t=`,
		userAgent: input.userAgent,
		country: input.country,
		now: input.now
	});
	return { recorded: res.recorded };
}
