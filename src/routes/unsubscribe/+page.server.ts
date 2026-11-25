import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB, env } from '$lib/server/db';
import { verifyUnsub, verifyUnsubToken, resubscribeAllowed, RESUB_LINK_EXPIRED } from '$lib/server/token';
import { unsubscribeAll } from '$lib/server/unsubscribe';
import { getMailProvider } from '$lib/server/mail';
import { getUnsubPage, selfResubscribe } from '$lib/server/unsubscribe-page';
import { campaignTopicId, publicTopics, topicLabel, type PublicTopic } from '$lib/server/topics';
import { saveTopicChoicesAndFire } from '$lib/server/subscription-trigger';
import { unsubscribeCsp } from '$lib/unsubscribe-page';
import { PREFERENCES_REASON } from '$lib/topics';
import { recordUnsubscribePageView } from '$lib/server/crm-tracking-events';

/**
 * The footer (#54, #414): the campaign's topic label when it has one, and the consent note
 * (`origin`) of its first audience group. Never a list, segment or tag name.
 */
async function provenance(db: D1Database, campaignId: number | null): Promise<{ footerTopic: string | null; listOrigin: string | null }> {
	if (!campaignId) return { footerTopic: null, listOrigin: null };
	const first = await db
		.prepare(
			`SELECT l.origin FROM campaigns c
			 JOIN lists l ON l.id = COALESCE(
			   (SELECT ca.list_id FROM campaign_audiences ca WHERE ca.campaign_id = c.id AND ca.mode = 'include' ORDER BY ca.position, ca.rowid LIMIT 1),
			   c.list_id)
			 WHERE c.id = ? AND l.kind IN ('list', 'segment')`
		)
		.bind(campaignId)
		.first<{ origin: string | null }>();
	return {
		footerTopic: await topicLabel(db, await campaignTopicId(db, campaignId)),
		listOrigin: first?.origin?.trim() || null
	};
}

export const load: PageServerLoad = async (event) => {
	const secret = event.platform?.env?.SESSION_SECRET ?? '';
	const token = event.url.searchParams.get('t') ?? undefined;
	// #374: video embeds only from the three player hosts, uploaded media only from us.
	event.setHeaders({ 'Content-Security-Policy': unsubscribeCsp() });
	const page = await getUnsubPage(event.platform?.env?.DB);
	const verified = await verifyUnsubToken(secret, token);
	if (!verified) return { invalid: true as const, page };
	const payload = verified.payload;
	// #750: the Resubscribe button and "Resubscribe me" show only for a link that may resubscribe.
	const canResubscribe = resubscribeAllowed(verified);

	// #701 / #518: in CRM tracking mode the unsubscribe link isn't rewritten, so a page view of a
	// CRM-tracked send is stored as its `unsubscribe_click` (the scanner-burst rule needs it).
	// Real page loads only (not the data reload after a form action). Best-effort: after the
	// response when the platform allows it, never throws, never unsubscribes anyone.
	if ((event.request?.method ?? 'GET') === 'GET' && !event.isDataRequest) {
		const db = event.platform?.env?.DB;
		if (db) {
			const cf = (event.platform as { cf?: { country?: unknown } } | undefined)?.cf;
			const work = recordUnsubscribePageView(db, payload, {
				origin: event.url.origin,
				userAgent: event.request?.headers.get('user-agent') ?? null,
				country: typeof cf?.country === 'string' ? cf.country : null
			}).catch((e: unknown) => {
				console.error('unsubscribe page view tracking failed:', (e instanceof Error ? e.message : String(e)).slice(0, 200));
			});
			const ctx = (event.platform as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } } | undefined)?.ctx;
			if (ctx?.waitUntil) ctx.waitUntil(work);
			else await work;
		}
	}

	// Subscriber-facing provenance (#54) — the topic label + consent note only (#414).
	let footerTopic: string | null = null;
	let listOrigin: string | null = null;
	try {
		({ footerTopic, listOrigin } = await provenance(getDB(event), payload.c));
	} catch {
		/* provenance is nice-to-have — never block the unsubscribe page */
	}

	// Preference center (#68, #414): curated topics (label + blurb), ticked where they're a member.
	let topics: PublicTopic[] = [];
	let subscribed = true;
	try {
		const db = getDB(event);
		const contact = await db
			.prepare('SELECT id, subscribed FROM contacts WHERE email = ?')
			.bind(payload.e.toLowerCase())
			.first<{ id: number; subscribed: number }>();
		subscribed = contact ? contact.subscribed === 1 : true;
		topics = await publicTopics(db, contact?.id ?? null);
	} catch {
		/* topics are optional — never block the unsubscribe page */
	}

	return { invalid: false as const, page, email: payload.e, token, footerTopic, listOrigin, topics, subscribed, canResubscribe };
};

export const actions: Actions = {
	// Save topic preferences (#68, #414). Ticked topics → member (opt-out cleared); a topic they
	// were in and unticked → opt-out (so a segment that includes them skips that topic too).
	// Every topic unticked = unsubscribe from everything (reason `preferences`). Saving never
	// turns `subscribed` back on, unless the page's Resubscribe option is on and they ticked
	// "Resubscribe me" (same Postmark bounce / spam guard as the Resubscribe button).
	preferences: async (event) => {
		const db = getDB(event);
		const secret = env(event, 'SESSION_SECRET');
		const data = await event.request.formData();
		const verified = await verifyUnsubToken(secret, String(data.get('token') ?? ''));
		if (!verified) return fail(400, { error: 'This link is invalid or expired.' });
		const payload = verified.payload;
		const email = payload.e.toLowerCase();
		const contact = await db
			.prepare('SELECT id, subscribed FROM contacts WHERE email = ?')
			.bind(email)
			.first<{ id: number; subscribed: number }>();
		if (!contact) return fail(400, { error: 'Contact not found.' });

		const topics = await publicTopics(db, contact.id);
		const ids = topics.map((t) => t.id);
		const posted = new Set(data.getAll('topic').map((v) => Number(v)).filter(Boolean));
		const keep = new Set(ids.filter((id) => posted.has(id)));
		const pm = event.platform?.env;

		if (ids.length && !keep.size) {
			await saveTopicChoicesAndFire(db, contact.id, ids, keep);
			await unsubscribeAll(db, await getMailProvider(db, pm), payload, PREFERENCES_REASON, null, {
				source: 'preference_center'
			});
			return { success: true as const, email };
		}

		let stillUnsubscribed = contact.subscribed !== 1;
		const wantsResubscribe = stillUnsubscribed && String(data.get('resubscribe') ?? '') === '1';
		// #750: resubscribing needs a recent link. Checked before anything is saved, so a refused
		// request changes nothing; saving topics without "Resubscribe me" works with any link.
		if (wantsResubscribe && !resubscribeAllowed(verified)) return fail(400, { error: RESUB_LINK_EXPIRED });
		const kept = await saveTopicChoicesAndFire(db, contact.id, ids, keep);
		if (wantsResubscribe) {
			const res = await selfResubscribe(
				db,
				await getMailProvider(db, pm),
				payload,
				await getUnsubPage(db)
			);
			if (!res.ok) return fail(res.reason === 'suppressed' ? 409 : 400, { error: res.error });
			stillUnsubscribed = false;
		}
		return { prefsSaved: true as const, kept: kept.length, stillUnsubscribed, email };
	},

	unsubscribeAll: async (event) => {
		const db = getDB(event);
		const secret = env(event, 'SESSION_SECRET');
		const data = await event.request.formData();

		const token = String(data.get('token') ?? '');
		const reason = String(data.get('reason') ?? '').trim();
		const detail = String(data.get('detail') ?? '').trim();

		const payload = await verifyUnsub(secret, token);
		if (!payload) return fail(400, { error: 'This unsubscribe link is invalid or expired.' });

		const email = payload.e.toLowerCase();
		await unsubscribeAll(
			db,
			await getMailProvider(db, event.platform?.env),
			payload,
			reason || null,
			detail || null
		);

		return { success: true as const, email };
	},

	// #374: "Changed your mind? Resubscribe" (Settings → Unsubscribe page, off by default).
	resubscribe: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const verified = await verifyUnsubToken(env(event, 'SESSION_SECRET'), String(data.get('token') ?? ''));
		if (!verified) return fail(400, { resubError: 'This link is invalid or expired.', email: '' });
		const payload = verified.payload;
		const email = payload.e.toLowerCase();
		// #750: only a link issued in the last RESUB_TOKEN_MAX_AGE_DAYS may resubscribe.
		if (!resubscribeAllowed(verified)) return fail(400, { resubError: RESUB_LINK_EXPIRED, email });
		const pm = event.platform?.env;
		const res = await selfResubscribe(
			db,
			await getMailProvider(db, pm),
			payload,
			await getUnsubPage(db)
		);
		if (!res.ok) return fail(res.reason === 'suppressed' ? 409 : 400, { resubError: res.error, email });
		return { resubscribed: true as const, email };
	}
};
