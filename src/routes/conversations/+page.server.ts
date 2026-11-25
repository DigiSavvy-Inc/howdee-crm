import { fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB, env, FINISH_SETUP_FROM, FINISH_SETUP_SENDING, mailToken, sendingUnconfigured } from '$lib/server/db';
import { mailSetup } from '$lib/server/mail';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { findConversation, parseConvFilter, recentConversations } from '$lib/server/conversations';
import { getSettings, fromAllowed } from '$lib/server/settings';
import { bareAddress, sendConversationReply } from '$lib/server/conversation-reply';
import { archiveThreads, deleteThreads, parseThreadKeys, unarchiveThreads } from '$lib/server/conversation-state';

const PER = 25;

/**
 * Conversations tab (#157) — replaces the Replies inbox (#78). Threads across contacts,
 * newest activity first; filter chips + search + pagination all live in the URL.
 */
export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const sp = event.url.searchParams;
	const filter = parseConvFilter(sp.get('filter'));
	const q = (sp.get('q') ?? '').trim().slice(0, 200);
	let page = Math.floor(Number(sp.get('page')) || 1);
	if (page < 1) page = 1;

	let res = await recentConversations(db, { filter, q, limit: PER, offset: (page - 1) * PER });
	const pageCount = Math.max(1, Math.ceil(res.total / PER));
	if (page > pageCount) {
		page = pageCount;
		res = await recentConversations(db, { filter, q, limit: PER, offset: (page - 1) * PER });
	}

	return {
		conversations: res.rows,
		total: res.total,
		counts: res.counts,
		gmail: res.gmail,
		filter,
		q,
		page,
		per: PER,
		pageCount,
		isAdmin: event.locals.user?.role === 'admin'
	};
};

/** `return_to` (thread page buttons): only a /conversations path, else stay on the list. */
function returnTo(data: FormData): string | null {
	const v = String(data.get('return_to') ?? '');
	return /^\/conversations(?:[/?]|$)/.test(v) && !v.startsWith('//') ? v : null;
}

const plural = (n: number) => `${n} conversation${n === 1 ? '' : 's'}`;

/**
 * Archive / unarchive / delete (#379): `key` × 1–200, validated server-side. Archive and
 * unarchive are for any signed-in user; delete is admin-only and needs `confirm=1` (the
 * dialog that states the count).
 */
async function bulk(event: RequestEvent, op: 'archive' | 'unarchive' | 'delete') {
	if (op === 'delete' && event.locals.user?.role !== 'admin') {
		return fail(403, { bulkError: 'Only admins can delete conversations.' });
	}
	const db = getDB(event);
	const data = await event.request.formData();
	const parsed = parseThreadKeys(data.getAll('key'));
	if (!parsed.ok) return fail(400, { bulkError: parsed.error });
	if (op === 'delete' && data.get('confirm') !== '1') {
		return fail(400, { bulkError: 'Confirm the delete first.' });
	}
	const user = event.locals.user;
	const res =
		op === 'archive'
			? await archiveThreads(db, parsed.keys, user)
			: op === 'unarchive'
				? await unarchiveThreads(db, parsed.keys)
				: await deleteThreads(db, parsed.keys, user, event.platform?.env?.MEDIA ?? null);
	const verb = op === 'archive' ? 'Archived' : op === 'unarchive' ? 'Unarchived' : 'Deleted';
	const back = returnTo(data);
	if (back) redirect(303, back);
	return {
		bulkSuccess: `${verb} ${plural(res.affected)}${res.skipped ? ` · ${res.skipped} skipped` : ''}`,
		affected: res.affected,
		skipped: res.skipped
	};
}

export const actions: Actions = {
	archive: (event) => bulk(event, 'archive'),
	unarchive: (event) => bulk(event, 'unarchive'),
	delete: (event) => bulk(event, 'delete'),

	// Reply box (#159) — posted from ConversationThread on this page AND the contact page.
	// Any signed-in user (admin or member). The thread is re-loaded from the DB by key, so
	// the recipient and the In-Reply-To/References headers never come from the form.
	reply: async (event) => {
		const db = getDB(event);
		const data = await event.request.formData();
		const key = String(data.get('conv_key') ?? '');
		const contactRaw = String(data.get('contact_id') ?? '').trim();
		const contactId = /^\d+$/.test(contactRaw) ? Number(contactRaw) : null;
		const email = String(data.get('email') ?? '');
		const bodyMd = String(data.get('body') ?? '');

		const conv = key ? await findConversation(db, { contactId, email }, key) : null;
		if (!conv) return fail(404, { replyKey: key, replyError: 'Conversation not found — reload and try again.' });

		const settings = await getSettings(db);
		const from = settings.default_from || event.platform?.env?.POSTMARK_FROM || '';
		if (!from) return fail(409, { replyKey: key, replyError: FINISH_SETUP_FROM });
		if (!fromAllowed(from, settings.approved_senders)) {
			return fail(400, {
				replyKey: key,
				replyError: `From “${from}” isn't an approved Postmark sender (Settings → Approved senders).`
			});
		}
		// Operator copy (Settings toggle). Users carry no email address yet, so the
		// operator mailbox is the From address the reply goes out as.
		const bcc = settings.reply_bcc_operator ? bareAddress(from) : null;

		// #700: the active sending provider; the token still falls back to the env.
		const { provider: mail, creds: mailCreds } = await mailSetup(db, event.platform?.env);
		// #731: no provider yet → the composer's error line (also on the contact page), not an error page.
		if (sendingUnconfigured(mail, mailCreds)) return fail(409, { replyKey: key, replyError: FINISH_SETUP_SENDING });
		const res = await sendConversationReply(db, {
			conv,
			bodyMd,
			from,
			bcc,
			token: mailToken(event, mailCreds),
			provider: mail,
			secret: env(event, 'SESSION_SECRET'),
			baseUrl: await publicBaseUrlFor(event),
			stream: mail?.streams.transactional ?? mailCreds.postmark.txStream,
			replyToInbound: event.platform?.env?.POSTMARK_INBOUND_ADDRESS || undefined
		});
		if (!res.ok) return fail(400, { replyKey: key, replyError: res.error });
		return { replyKey: key, replySent: true, campaignId: res.campaignId };
	}
};
