// Customizable unsubscribe page (#374): the stored config (app_state `unsubscribe_page`,
// JSON — no migration), uploaded media in R2 (`MEDIA`, `unsubscribe/…`, served by
// /img/unsubscribe/[file]) and the opt-in "Changed your mind? Resubscribe" action.
import { isHardSuppression, suppressionsByEmail, suppressionStreams, unsuppress } from './postmark';
import type { UnsubPayload } from './token';
import { subscriptionChanged } from './subscription-trigger';
import {
	DEFAULT_UNSUB_PAGE,
	UNSUB_PAGE_KEY,
	mediaKeys,
	normalizeUnsubPage,
	type UnsubPageConfig
} from '$lib/unsubscribe-page';

export async function getUnsubPage(db: D1Database | undefined | null): Promise<UnsubPageConfig> {
	if (!db) return { ...DEFAULT_UNSUB_PAGE };
	try {
		const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(UNSUB_PAGE_KEY).first<{ value: string | null }>();
		return normalizeUnsubPage(row?.value ?? null);
	} catch {
		// Cosmetic: a failed read must never break the unsubscribe page.
		return { ...DEFAULT_UNSUB_PAGE };
	}
}

export async function saveUnsubPage(db: D1Database, cfg: UnsubPageConfig): Promise<void> {
	await db
		.prepare(
			`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(UNSUB_PAGE_KEY, JSON.stringify(cfg))
		.run();
}

/** Store an uploaded video or poster; returns its key. The caller has validated type + size. */
export async function storeUnsubMedia(
	bucket: R2Bucket,
	kind: 'video' | 'poster',
	file: { type: string; arrayBuffer(): Promise<ArrayBuffer> },
	ext: string
): Promise<string> {
	const key = `unsubscribe/${kind}-${crypto.randomUUID()}.${ext}`;
	await bucket.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' }
	});
	return key;
}

/** Delete the media the previous config used and the new one no longer does. Best-effort. */
export async function pruneUnsubMedia(bucket: R2Bucket | undefined, prev: UnsubPageConfig, next: UnsubPageConfig) {
	if (!bucket) return;
	const keep = new Set(mediaKeys(next));
	const gone = mediaKeys(prev).filter((k) => !keep.has(k));
	if (gone.length) await bucket.delete(gone).catch(() => undefined);
}

export type ResubscribeResult =
	| { ok: true }
	| { ok: false; reason: 'off' | 'not_found' | 'suppressed'; error: string };

export const RESUB_REFUSED =
	"We can't resubscribe this address here because earlier emails to it bounced or were reported as spam. Please contact us.";

/**
 * "Changed your mind? Resubscribe" (#374): the signed unsubscribe token's own address only.
 * Same guard as the bulk Resubscribe (#285): a HardBounce / SpamComplaint suppression in
 * Postmark refuses it; ManualSuppression (what our unsubscribe adds) or none is fine, and that
 * manual suppression is lifted so mail reaches them again. Postmark not configured or
 * unreachable → resubscribed without the check (as the bulk action does). Recorded on the
 * contact's latest `unsubscribes` row's detail.
 */
export async function selfResubscribe(
	db: D1Database,
	postmark: { token?: string; stream?: string; txStream?: string },
	payload: UnsubPayload,
	cfg: UnsubPageConfig,
	now: Date = new Date()
): Promise<ResubscribeResult> {
	if (!cfg.resubscribe) return { ok: false, reason: 'off', error: 'Resubscribing here is turned off.' };
	const email = payload.e.toLowerCase();
	const contact = await db.prepare('SELECT id FROM contacts WHERE email = ?').bind(email).first<{ id: number }>();
	if (!contact) return { ok: false, reason: 'not_found', error: 'We couldn’t find this address.' };

	let manualStream: string | null = null;
	if (postmark.token) {
		const streams = suppressionStreams(postmark.stream, postmark.txStream);
		try {
			const { map } = await suppressionsByEmail(postmark.token, streams);
			const s = map.get(email);
			if (s && isHardSuppression(s.reason)) return { ok: false, reason: 'suppressed', error: RESUB_REFUSED };
			if (s) manualStream = s.stream;
		} catch {
			/* unreachable → not checked, like bulkResubscribe */
		}
	}

	const flipped = await db.prepare('UPDATE contacts SET subscribed = 1 WHERE id = ? AND subscribed = 0').bind(contact.id).run();
	const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
	await db
		.prepare(
			`UPDATE unsubscribes SET detail = TRIM(COALESCE(detail || ' · ', '') || ?)
			 WHERE id = (SELECT id FROM unsubscribes WHERE email = ? ORDER BY id DESC LIMIT 1)`
		)
		.bind(`Resubscribed via the unsubscribe page ${stamp} UTC`, email)
		.run();

	if (postmark.token && manualStream) {
		try {
			await unsuppress(postmark.token, manualStream, email);
		} catch {
			/* best-effort */
		}
	}
	// #444: "Subscription changes" trigger + tier refresh (best-effort).
	if ((flipped.meta.changes ?? 0) > 0) await subscriptionChanged(db, [contact.id], 'resubscribed', { source: 'link', now });
	return { ok: true };
}
