import { visibleCampaignSql } from '$lib/server/system-mail';
import { getArchiveSettings, isArchivable, publishIssue, unpublishIssue } from '$lib/server/newsletter-archive';
import { ARCHIVE_PATH } from '$lib/newsletter-archive';
import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDB, env } from '$lib/server/db';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { getSettings, fromAllowed, getTimezone, DEFAULT_TIMEZONE } from '$lib/server/settings';
import { applyWeekdayOnly, parseZonedLocal, formatLocal, toZonedLocalInput } from '$lib/server/businessdays';
import { nonOpenerRecipients, nonOpenerCount, performResend, resendPassBreakdown } from '$lib/server/resend';
import { claimScheduledResend } from '$lib/server/scheduled';
import { aiResendSubjectAvailable } from '$lib/server/ai-subject';
import { loadAudience } from '$lib/server/audience';
import { renderForRecipient, resolvePreviewTarget, type RenderedEmail } from '$lib/server/render-preview';
import { withBaseTargetBlank } from '$lib/email-preview-html';
import { engagementBreakdown, segmentWhere } from '$lib/server/campaign-engagement';
import { campaignContactsHref, campaignWhoCount, type CampaignWho } from '$lib/server/bounce-filter';
import { bestTimeLift } from '$lib/server/engagement-query';
import { deleteDraft, reopenAsDraft, duplicateAsDraft } from '$lib/server/campaign-drafts';
import { campaignLinks, campaignReplies, campaignScannerFetches } from '$lib/server/campaign-read';
import { releaseHeldCampaign } from '$lib/server/deliverability-alerts';
import { campaignActivity } from '$lib/server/campaign-activity';
import { parseActivityFilter, parseActivityRows } from '$lib/campaign-activity';

// Shared UTC-string format for resend_at (custom time) — 'YYYY-MM-DD HH:MM:SS',
// directly comparable to SQLite's datetime('now'). Mirrors compose's toUtcString (#83).
function toUtcString(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Stat-box drill-down (#79): which key from ?who= maps to which query below.
// #161: clicked | opened | none are the Engagement bar's segments (unique recipients,
// mutually exclusive — see $lib/server/campaign-engagement.ts).
const WHO_KEYS = ['sent', 'opens', 'clicks', 'unsubs', 'bounces', 'clicked', 'opened', 'none'] as const;
type Who = (typeof WHO_KEYS)[number];
// #279: each drill-down's "Open in Contacts" target (/contacts?campaign=&campaign_who=).
const WHO_CONTACTS: Record<Who, CampaignWho> = {
	sent: 'sent',
	opens: 'opens',
	clicks: 'clicked',
	unsubs: 'unsubscribed',
	bounces: 'bounced',
	clicked: 'clicked',
	opened: 'opened',
	none: 'none'
};
type WhoRow = { email: string; contact_id: number | null; recipient_id: number | null; when: string; extra: string | null };

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);
	const id = Number(event.params.id);
	if (!id) throw error(404, 'Campaign not found');

	const campaign = await db
		.prepare(
			`SELECT c.*, l.name AS list_name
			 FROM campaigns c
			 LEFT JOIN lists l ON l.id = c.list_id
			 WHERE c.id = ? AND ${visibleCampaignSql('c')}`
		)
		.bind(id)
		.first<Record<string, unknown>>();
	// #668: account emails (invite / reset / verify) aren't campaigns — not even by id.
	if (!campaign) throw error(404, 'Campaign not found');

	// "View email" dialog (#127): render through the exact send-time pipeline so the
	// viewer sees what a recipient actually received, not the raw stored template.
	// #155: ?as=<recipientId> / ?as_contact=<contactId> pick who (deep links from a contact,
	// the activity feed, …); no param → the template as authored, not an arbitrary recipient.
	const previewTarget = await resolvePreviewTarget(db, id, {
		as: event.url.searchParams.get('as'),
		asContact: event.url.searchParams.get('as_contact')
	});

	const previewRecipientTotal =
		(
			await db
				.prepare(`SELECT COUNT(*) AS total FROM recipients WHERE campaign_id = ?`)
				.bind(id)
				.first<{ total: number }>()
		)?.total ?? 0;

	const secret = env(event, 'SESSION_SECRET');
	const baseUrl = await publicBaseUrlFor(event);
	const renderedPreview = await renderForRecipient(db, {
		campaignId: id,
		recipientId: previewTarget.recipientId,
		secret,
		baseUrl
	});
	// Defensive fallback for type safety — should be unreachable in practice (the
	// campaign row was just loaded above, so renderForRecipient can't return null).
	const preview: RenderedEmail = renderedPreview
		? { ...renderedPreview, html: withBaseTargetBlank(renderedPreview.html) }
		: { subject: String(campaign.subject ?? ''), html: '', text: '', recipient: null };

	const stats = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM recipients WHERE campaign_id = ?1 AND status = 'accepted') AS sent,
			   (SELECT COUNT(*) FROM recipients WHERE campaign_id = ?1 AND status = 'error') AS errored,
			   (SELECT COUNT(DISTINCT recipient_id) FROM events WHERE campaign_id = ?1 AND type = 'open') AS unique_opens,
			   (SELECT COUNT(*) FROM events WHERE campaign_id = ?1 AND type = 'open') AS total_opens,
			   (SELECT COUNT(DISTINCT recipient_id) FROM events WHERE campaign_id = ?1 AND type = 'click') AS unique_clicks,
			   (SELECT COUNT(*) FROM events WHERE campaign_id = ?1 AND type = 'click') AS total_clicks,
			   (SELECT COUNT(*) FROM events WHERE campaign_id = ?1 AND type = 'unsubscribe') AS unsubs,
			   (SELECT COUNT(*) FROM events WHERE campaign_id = ?1 AND type = 'bounce') AS bounces,
			   (SELECT COUNT(*) FROM events WHERE campaign_id = ?1 AND type = 'spam') AS spam`
		)
		.bind(id)
		.first<Record<string, number>>();

	const reasons = await db
		.prepare(
			`SELECT COALESCE(NULLIF(reason, ''), 'No reason given') AS reason, COUNT(*) AS count
			 FROM unsubscribes WHERE campaign_id = ? GROUP BY reason ORDER BY count DESC`
		)
		.bind(id)
		.all();

	// #529: Activity panel — filter + size from ?activity= / ?rows=, filtered in SQL.
	const activityFilter = parseActivityFilter(event.url.searchParams.get('activity'));
	const activityRows = parseActivityRows(event.url.searchParams.get('rows'));
	const activity = await campaignActivity(db, id, activityFilter, activityRows);

	const errors = await db
		.prepare(
			`SELECT email, error FROM recipients
			 WHERE campaign_id = ? AND status = 'error' LIMIT 50`
		)
		.bind(id)
		.all();

	// Link-level click breakdown (#69) + replies captured for this campaign (inbound).
	// #518: + the scanner link fetches hidden from every click count.
	const [links, replies, scannerFetches] = await Promise.all([
		campaignLinks(db, id),
		campaignReplies(db, id),
		campaignScannerFetches(db, id)
	]);

	// Stat-box drill-down (#79): who's behind a given number. Whitelisted key only —
	// anything else (including no param) means no drill-down.
	const whoParam = event.url.searchParams.get('who');
	const who: Who | null = (WHO_KEYS as readonly string[]).includes(whoParam ?? '')
		? (whoParam as Who)
		: null;

	let whoRows: WhoRow[] = [];
	if (who === 'clicked' || who === 'opened' || who === 'none') {
		const sentWhen = String(campaign.sent_at ?? campaign.created_at ?? '');
		const rows = await db
			.prepare(
				`SELECT r.email, r.contact_id, r.id AS recipient_id FROM recipients r
				 WHERE r.campaign_id = ? AND r.status = 'accepted' AND ${segmentWhere(who)}
				 ORDER BY r.id ASC LIMIT 500`
			)
			.bind(id)
			.all<{ email: string; contact_id: number | null; recipient_id: number }>();
		whoRows = rows.results.map((r) => ({ ...r, when: sentWhen, extra: null }));
	} else if (who === 'sent') {
		// recipients carries no per-row timestamp (see migrations/0001_init.sql) — the
		// campaign's own sent_at (falling back to created_at) is the best "when" we have.
		const sentWhen = String(campaign.sent_at ?? campaign.created_at ?? '');
		const rows = await db
			.prepare(
				`SELECT email, contact_id, id AS recipient_id FROM recipients
				 WHERE campaign_id = ? AND status = 'accepted' ORDER BY id ASC LIMIT 500`
			)
			.bind(id)
			.all<{ email: string; contact_id: number | null; recipient_id: number }>();
		whoRows = rows.results.map((r) => ({ ...r, when: sentWhen, extra: null }));
	} else if (who === 'opens' || who === 'clicks') {
		const eventType = who === 'opens' ? 'open' : 'click';
		const rows = await db
			.prepare(
				`SELECT COALESCE(r.email, e.message_id) AS email,
				        COALESCE(e.contact_id, r.contact_id) AS contact_id,
				        MAX(e.recipient_id) AS recipient_id,
				        MIN(e.recorded_at) AS "when",
				        COUNT(*) AS cnt
				 FROM events e
				 LEFT JOIN recipients r ON r.id = e.recipient_id
				 WHERE e.campaign_id = ? AND e.type = ?
				 GROUP BY COALESCE(e.recipient_id, e.message_id, e.id)
				 ORDER BY "when" ASC
				 LIMIT 500`
			)
			.bind(id, eventType)
			.all<{ email: string; contact_id: number | null; recipient_id: number | null; when: string; cnt: number }>();
		whoRows = rows.results.map((r) => ({
			email: r.email,
			contact_id: r.contact_id,
			recipient_id: r.recipient_id,
			when: r.when,
			extra: r.cnt > 1 ? `${r.cnt}x` : null
		}));
	} else if (who === 'unsubs') {
		const rows = await db
			.prepare(
				`SELECT COALESCE(r.email, e.message_id) AS email,
				        COALESCE(e.contact_id, r.contact_id) AS contact_id,
				        e.recipient_id AS recipient_id,
				        e.recorded_at AS "when",
				        u.reason AS extra
				 FROM events e
				 LEFT JOIN recipients r ON r.id = e.recipient_id
				 LEFT JOIN unsubscribes u ON u.campaign_id = e.campaign_id AND u.email = r.email
				 WHERE e.campaign_id = ? AND e.type = 'unsubscribe'
				 ORDER BY e.recorded_at DESC
				 LIMIT 500`
			)
			.bind(id)
			.all<WhoRow>();
		whoRows = rows.results;
	} else if (who === 'bounces') {
		// The box sums bounce + spam (see +page.svelte), so the drill-down does too.
		const rows = await db
			.prepare(
				`SELECT COALESCE(r.email, e.message_id) AS email,
				        COALESCE(e.contact_id, r.contact_id) AS contact_id,
				        e.recipient_id AS recipient_id,
				        e.recorded_at AS "when",
				        e.type AS extra
				 FROM events e
				 LEFT JOIN recipients r ON r.id = e.recipient_id
				 WHERE e.campaign_id = ? AND e.type IN ('bounce', 'spam')
				 ORDER BY e.recorded_at DESC
				 LIMIT 500`
			)
			.bind(id)
			.all<WhoRow>();
		whoRows = rows.results;
	}

	const whoContacts = who
		? { href: campaignContactsHref(id, WHO_CONTACTS[who]), n: await campaignWhoCount(db, id, WHO_CONTACTS[who]) }
		: null;

	// "Resend to non-openers" (#81): only worth computing for a sent campaign, and a
	// COUNT-only query so the page load doesn't fetch full recipient rows every visit.
	const nonOpeners = campaign.status === 'sent' ? await nonOpenerCount(db, id) : 0;

	// Who did this send go to? (#118) — list name, else automation name, else a sample of
	// `recipients` rows (direct sends, SEO Snapshot reviews, or anything else list-less).
	const audience = await loadAudience(db, id);

	// Engagement bar (#161): who interacted vs. who didn't, unique per recipient.
	const engagement = await engagementBreakdown(db, id);

	// #115: best-time sends — cohort sizes + best-time vs default lift on opens/clicks.
	const bestTime = campaign.best_time ? await bestTimeLift(db, id) : null;

	// #246: a pending resend shows (and the Edit modal prefills) in the operator timezone.
	let resendSchedule: { text: string; input: string } | null = null;
	if (campaign.resend_status === 'pending' && campaign.resend_at) {
		const at = new Date(`${String(campaign.resend_at).replace(' ', 'T')}Z`);
		if (!Number.isNaN(at.getTime())) {
			const tz = await getTimezone(db);
			resendSchedule = { text: formatLocal(at, tz), input: toZonedLocalInput(at, tz) };
		}
	}

	// #246: original vs resend, once a resend went out (the tiles stay combined).
	const passes = campaign.resent_at ? await resendPassBreakdown(db, id) : null;

	return {
		campaign,
		preview,
		previewNotice: previewTarget.notice,
		previewRecipientTotal,
		stats: stats ?? {},
		reasons: reasons.results,
		// #529 (#518: scanner fetches left out; an unsubscribe-page visit reads as one).
		activity: { ...activity, filter: activityFilter, size: activityRows },
		links,
		scannerFetches,
		errors: errors.results,
		replies,
		who,
		whoRows,
		whoContacts,
		nonOpeners,
		audience,
		engagement,
		bestTime,
		resendSchedule,
		passes: passes && passes.resend.sent > 0 ? passes : null,
		// #481: newsletter archive state (actions are admin-only).
		archive: {
			eligible: isArchivable(campaign as never),
			published: !!campaign.archive_published_at,
			edited: !!campaign.archive_edited_at, // #483: has a web-only version
			url: campaign.archive_slug ? `${baseUrl}${ARCHIVE_PATH}/${campaign.archive_slug}` : null,
			enabled: (await getArchiveSettings(db)).enabled
		},
		aiSubject: await aiResendSubjectAvailable(db, event.platform?.env)
	};
};

export const actions: Actions = {
	// Withdraw a scheduled send (#35). Only valid while still 'scheduled'.
	cancelSchedule: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const res = await db
			.prepare(`UPDATE campaigns SET status = 'canceled' WHERE id = ? AND status = 'scheduled'`)
			.bind(id)
			.run();
		if (!res.meta.changes) return fail(400, { error: 'This campaign is no longer scheduled.' });
		return { ok: true };
	},

	// #240: Edit a scheduled campaign — flip it back to a draft (saved fields and
	// scheduled_at kept) and reopen it in compose; re-scheduling promotes the same row.
	// resend_status is cleared so the resend engine can't fire on a draft; compose sets
	// it again when the draft is scheduled. recipient_count was only an estimate.
	// #313: a canceled campaign that never sent reopens the same way (reopenAsDraft).
	editScheduled: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const res = await reopenAsDraft(db, id);
		if (!res.ok) return fail(400, { error: res.error, partlySent: res.reason === 'sent' });
		throw redirect(303, `/compose?draft=${id}`);
	},

	// #313: copy the content into a new draft (the way out for a partly sent campaign).
	duplicate: async (event) => {
		const db = getDB(event);
		const newId = await duplicateAsDraft(db, Number(event.params.id));
		if (!newId) return fail(400, { error: 'This campaign can’t be duplicated.' });
		throw redirect(303, `/compose?draft=${newId}`);
	},

	// #240: delete a draft (only a zero-recipient draft; see deleteDraft).
	deleteDraft: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		if (!(await deleteDraft(db, id))) return fail(400, { error: 'Only an unsent draft can be deleted.' });
		throw redirect(303, '/campaigns');
	},

	// #305: release a send held by a critical deliverability alert (admins only). It goes back
	// to its schedule; a time already past fires on the next tick.
	releaseHold: async (event) => {
		if (event.locals.user?.role !== 'admin') return fail(403, { error: 'Only an admin can release a held send.' });
		const ok = await releaseHeldCampaign(getDB(event), Number(event.params.id));
		if (!ok) return fail(400, { error: 'This campaign is not held.' });
		return { ok: true, released: true };
	},

	// #481: Publish to / Remove from the newsletter archive — sent broadcasts only, admins only.
	archivePublish: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { error: 'Only an admin can publish to the newsletter archive.' });
		const res = await publishIssue(getDB(event), Number(event.params.id));
		if (!res.ok) return fail(400, { error: res.error });
		return { ok: true, archived: true };
	},
	archiveRemove: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { error: 'Only an admin can remove an issue from the newsletter archive.' });
		await unpublishIssue(getDB(event), Number(event.params.id));
		return { ok: true, unarchived: true };
	},

	// Pull the schedule forward: fires on the next heartbeat tick (within ~1 min).
	sendNow: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const res = await db
			.prepare(`UPDATE campaigns SET scheduled_at = datetime('now') WHERE id = ? AND status = 'scheduled'`)
			.bind(id)
			.run();
		if (!res.meta.changes) return fail(400, { error: 'This campaign is no longer scheduled.' });
		return { ok: true, sendingSoon: true };
	},

	// "Resend to non-openers" (#81, scheduling added #83): re-sends on the SAME campaign
	// row to the original recipients who never opened it. sendCampaignEmail inserts fresh
	// `recipients` rows with new MessageIDs on this campaign, so webhook opens/clicks/etc.
	// from the resend attribute back to the original campaign automatically — no new
	// campaign row. `resend_when` 'now' keeps the original immediate behavior; '24h' | '3d'
	// | 'custom' instead schedule the resend (resend_status='pending') for
	// processScheduledResends to pick up — recipients are re-resolved at fire time, so the
	// N shown now may differ from who actually gets it later.
	resend: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);

		const data = await event.request.formData();
		const subject = String(data.get('subject') ?? '').trim().slice(0, 500);
		if (!subject) return fail(400, { error: 'Subject is required.' });

		const resendWhen = String(data.get('resend_when') ?? 'now').trim();
		if (!['now', '24h', '3d', 'custom'].includes(resendWhen)) {
			return fail(400, { error: 'Invalid resend timing option.' });
		}
		// #246: Edit on the pending-resend banner reschedules THAT resend — every write below
		// is guarded on resend_status = 'pending', so a resend that went out (or was
		// cancelled) since the page loaded fails instead of scheduling a new one.
		const editing = String(data.get('edit') ?? '') === '1';
		const pendingGuard = editing ? ` AND resend_status = 'pending'` : '';
		const GONE = 'This resend already went out or was cancelled.';

		const original = await db
			.prepare(
				`SELECT subject, body_html, body_text, from_email, status
				 FROM campaigns WHERE id = ?`
			)
			.bind(id)
			.first<{
				subject: string;
				body_html: string;
				body_text: string | null;
				from_email: string;
				status: string;
			}>();
		if (!original || original.status !== 'sent' || !original.body_html) {
			return fail(400, { error: 'This campaign has no sent email to resend.' });
		}

		const settings = await getSettings(db);
		if (!fromAllowed(original.from_email, settings.approved_senders)) {
			return fail(400, { error: `From “${original.from_email}” isn't an approved Postmark sender (Settings → Approved senders).` });
		}

		if (resendWhen === 'now') {
			const recipients = await nonOpenerRecipients(db, id);
			if (recipients.length === 0) {
				return fail(400, { error: "Everyone opened this one — nothing to resend." });
			}

			const token = env(event, 'POSTMARK_TOKEN');
			const stream = env(event, 'POSTMARK_STREAM');
			const secret = env(event, 'SESSION_SECRET');
			const baseUrl = await publicBaseUrlFor(event);

			// Editing a pending resend into "now": claim it (pending → sending) so the tick
			// can't send it too, and mark it sent afterwards either way (never send twice).
			if (editing && !(await claimScheduledResend(db, id))) return fail(400, { error: GONE });
			try {
				await performResend(
					db,
					{ id, subject: original.subject, body_html: original.body_html, body_text: original.body_text, from_email: original.from_email },
					subject,
					recipients,
					{ token, secret, baseUrl, stream, replyToInbound: event.platform?.env?.POSTMARK_INBOUND_ADDRESS || undefined }
				);
			} finally {
				if (editing) await db.prepare(`UPDATE campaigns SET resend_status = 'sent' WHERE id = ?`).bind(id).run();
			}

			throw redirect(303, `/campaign/${id}`);
		}

		// Scheduled instead: same resend_subject convention as performResend (#81) —
		// NULL when it matches the original subject, so a same-subject resend doesn't
		// show a redundant "resent as ..." note.
		const resendSubjectRaw = subject === original.subject ? null : subject;

		// #119: opt-in "weekdays only" — a Sat/Sun due time (operator tz) moves to Monday,
		// same local time.
		const weekdayOnly = String(data.get('weekday_only') ?? '') === '1';
		const resendAtLocal = String(data.get('resend_at') ?? '').trim();
		// Custom picker values are operator wall-clock. Read the zone only when the
		// weekday box is ticked or that custom time has to be interpreted.
		const tz = weekdayOnly || resendWhen === 'custom' ? await getTimezone(db) : null;
		let resendMoved = false;
		let res: D1Result;

		if (resendWhen === 'custom') {
			if (!resendAtLocal) return fail(400, { error: 'Choose a date & time for the resend.' });
			const rt = parseZonedLocal(resendAtLocal, tz ?? DEFAULT_TIMEZONE);
			if (!rt) return fail(400, { error: 'Invalid resend date & time.' });
			if (rt.getTime() < Date.now() + 15 * 60 * 1000) {
				return fail(400, { error: 'Resend time must be at least 15 minutes from now.' });
			}
			let finalRt = rt;
			if (weekdayOnly && tz) {
				finalRt = applyWeekdayOnly(rt, tz);
				resendMoved = finalRt.getTime() !== rt.getTime();
			}
			// An unticked box leaves campaigns.weekday_only alone. Writing 0 here used
			// to clear the flag the original send had set.
			if (weekdayOnly) {
				res = await db
					.prepare(`UPDATE campaigns SET resend_at = ?, resend_status = 'pending', resend_subject = ?, weekday_only = 1 WHERE id = ?${pendingGuard}`)
					.bind(toUtcString(finalRt), resendSubjectRaw, id)
					.run();
			} else {
				res = await db
					.prepare(`UPDATE campaigns SET resend_at = ?, resend_status = 'pending', resend_subject = ? WHERE id = ?${pendingGuard}`)
					.bind(toUtcString(finalRt), resendSubjectRaw, id)
					.run();
			}
		} else if (weekdayOnly && tz) {
			// '24h' | '3d', shifted off a weekend — computed in JS since the shift needs tz math.
			const baseMs = Date.now() + (resendWhen === '24h' ? 1 : 3) * 24 * 60 * 60 * 1000;
			const shifted = applyWeekdayOnly(new Date(baseMs), tz);
			resendMoved = shifted.getTime() !== baseMs;
			res = await db
				.prepare(`UPDATE campaigns SET resend_at = ?, resend_status = 'pending', resend_subject = ?, weekday_only = 1 WHERE id = ?${pendingGuard}`)
				.bind(toUtcString(shifted), resendSubjectRaw, id)
				.run();
		} else {
			// '24h' | '3d', no weekday shift — computed from now in SQL; no JS date math needed.
			// Do not reset weekday_only; the box was not ticked.
			const offset = resendWhen === '24h' ? '+1 day' : '+3 days';
			res = await db
				.prepare(`UPDATE campaigns SET resend_at = datetime('now', ?), resend_status = 'pending', resend_subject = ? WHERE id = ?${pendingGuard}`)
				.bind(offset, resendSubjectRaw, id)
				.run();
		}
		if (!res.meta.changes) return fail(400, { error: editing ? GONE : 'This campaign has no sent email to resend.' });

		// Overwrites any existing pending schedule (or flips a canceled/sent one back to
		// pending) — that's the intended "replace" semantics; the pending banner + Cancel
		// on the campaign page is the confirmation, same as the auto-resend from compose.
		// #119: a one-time query-param flag for "(moved to Monday — weekdays only)".
		throw redirect(303, `/campaign/${id}${resendMoved ? '?resend_moved=1' : ''}`);
	},

	// Withdraw a pending auto-resend (#82). Only valid while still 'pending'.
	cancelResend: async (event) => {
		const db = getDB(event);
		const id = Number(event.params.id);
		const res = await db
			.prepare(`UPDATE campaigns SET resend_status = 'canceled' WHERE id = ? AND resend_status = 'pending'`)
			.bind(id)
			.run();
		if (!res.meta.changes) return fail(400, { error: 'No pending auto-resend to cancel.' });
		return { ok: true };
	}
};
