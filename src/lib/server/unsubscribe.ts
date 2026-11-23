// Shared "unsubscribe from everything" effect: the /unsubscribe page's ?/unsubscribeAll
// action and the RFC 8058 one-click endpoint (#264) both land here.
import { suppress } from './postmark';
import type { UnsubPayload } from './token';
import { subscriptionChanged } from './subscription-trigger';
import type { SubscriptionSource } from '$lib/subscription-trigger';

export async function unsubscribeAll(
	db: D1Database,
	postmark: { token?: string; stream?: string },
	payload: UnsubPayload,
	reason: string | null,
	detail: string | null,
	// #444: `source` for the "Subscription changes" trigger — `link` (the page / one-click) or
	// `preference_center` (a preference-page save with every topic unticked).
	opts: { onlyOnce?: boolean; source?: SubscriptionSource } = {}
): Promise<{ recorded: boolean }> {
	const email = payload.e.toLowerCase();

	const changed = await db
		.prepare('UPDATE contacts SET subscribed = 0 WHERE email = ? AND subscribed = 1 RETURNING id')
		.bind(email)
		.all<{ id: number }>();
	// Only a contact that was subscribed fires (a repeat click changes nothing). Best-effort.
	const fire = () => subscriptionChanged(db, changed.results.map((r) => r.id), 'unsubscribed', { source: opts.source ?? 'link' });

	// One-click POSTs can be retried by the mailbox provider: one row per email + campaign + reason.
	if (opts.onlyOnce) {
		const seen = await db
			.prepare('SELECT 1 FROM unsubscribes WHERE email = ? AND campaign_id IS ? AND reason IS ? LIMIT 1')
			.bind(email, payload.c, reason)
			.first();
		if (seen) {
			await fire();
			return { recorded: false };
		}
	}

	// A token can outlive its contact or campaign row; NULL the reference instead of tripping the FK.
	await db
		.prepare(
			`INSERT INTO unsubscribes (contact_id, campaign_id, email, reason, detail)
			 VALUES ((SELECT id FROM contacts WHERE id = ?), (SELECT id FROM campaigns WHERE id = ?), ?, ?, ?)`
		)
		.bind(payload.k, payload.c, email, reason, detail)
		.run();

	// Best-effort: also suppress on the Postmark broadcast stream.
	try {
		if (postmark.token && postmark.stream) await suppress(postmark.token, postmark.stream, email);
	} catch {
		/* don't fail the unsubscribe if Postmark sync errors */
	}
	await fire();
	return { recorded: true };
}
