import { visibleCampaignSql } from '$lib/server/system-mail';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { publishIssues, unpublishIssue } from '$lib/server/newsletter-archive';
import { getDB } from '$lib/server/db';
import {
	SENDLOG_TYPE_SQL,
	parseSendLogFilter,
	sendLogFilterParams,
	sendLogWhere,
	withVisible,
	isSendLogFiltered,
	SENDLOG_SORTS,
	sendLogRows,
	type SendLogRow
} from '$lib/server/sendlog-query';
import { describeAudience, audienceLabel, type AudienceRow } from '$lib/server/audience';
import { multiGroupLabels } from '$lib/server/campaign-audience';
import { ratePct, sendLogRates } from '$lib/sendlog-columns';
import { pct as wholePct } from '$lib/server/dashboard';

const PER_OPTIONS = [25, 50, 100];

/** Audience label for a send log row (#118) — under the subject and in the Audience column (#336). */
function sendLogAudience(row: SendLogRow): string {
	const sample: AudienceRow[] = row.sample_emails
		? row.sample_emails.split(', ').map((email) => ({ id: null, email, contact_id: null }))
		: [];
	return audienceLabel(
		describeAudience({
			list_id: row.list_id,
			list_name: row.list_name,
			automation_id: row.automation_id,
			automation_name: row.automation_name,
			recipient_count: row.recipient_count,
			sample
		})
	);
}

export const load: PageServerLoad = async (event) => {
	const db = getDB(event);

	const sortParam = event.url.searchParams.get('sort') ?? 'date';
	const sort = SENDLOG_SORTS[sortParam] ? sortParam : 'date';
	const dir: 'asc' | 'desc' = event.url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

	// Pagination + Filters popover (#106) — mirrors /contacts (#94).
	let per = Number(event.url.searchParams.get('per')) || 25;
	if (!PER_OPTIONS.includes(per)) per = 25;
	let page = Math.floor(Number(event.url.searchParams.get('page')) || 1);
	if (page < 1) page = 1;

	const filter = parseSendLogFilter(event.url.searchParams);
	const { where, params } = sendLogWhere(filter);

	const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM campaigns c ${withVisible('')}`).first<{ n: number }>();
	const total = totalRow?.n ?? 0;

	const matchRow = await db
		.prepare(`SELECT COUNT(*) AS n FROM campaigns c ${withVisible(where)}`)
		.bind(...params)
		.first<{ n: number }>();
	const matched = matchRow?.n ?? 0;
	const pageCount = Math.max(1, Math.ceil(matched / per));
	if (page > pageCount) page = pageCount;
	const offset = (page - 1) * per;

	const rows = await sendLogRows(db, filter, { sort, dir, limit: per, offset });

	// Build the per-row audience label in JS from those columns (no schema change — see
	// `audience.ts`). `sample_emails` is a plain GROUP_CONCAT string, so contact linking
	// isn't available here (only on the campaign page's richer per-campaign query) — the
	// send log just shows the email text. Rates (#336): `sendLogRates`, the same rule as the
	// 30-day tiles above (unique ÷ accepted).
	// #332: several included groups / exclusions → "Customers + Newsletter, excluding VIP"
	// (single-group campaigns fall back to the #118 label).
	// #481: which visible rows are in the newsletter archive.
	// #483: …and which have a web-only version ("edited for web").
	const archiveRows = rows.length
		? (
				await db
					.prepare(
						`SELECT id, archive_published_at IS NOT NULL AS published, archive_edited_at IS NOT NULL AS edited FROM campaigns
						 WHERE id IN (SELECT value FROM json_each(?)) AND (archive_published_at IS NOT NULL OR archive_edited_at IS NOT NULL)`
					)
					.bind(JSON.stringify(rows.map((r) => r.id)))
					.all<{ id: number; published: number; edited: number }>()
			).results
		: [];
	const inArchive = new Set(archiveRows.filter((r) => r.published).map((r) => r.id));
	const editedForWeb = new Set(archiveRows.filter((r) => r.edited).map((r) => r.id));
	const multi = await multiGroupLabels(db, rows);
	const campaigns = rows.map((row) => ({
		...row,
		audience: multi.get(row.id) ?? sendLogAudience(row),
		in_archive: inArchive.has(row.id), // #481
		edited_for_web: editedForWeb.has(row.id), // #483
		...sendLogRates(row),
		// #196: whole-percent open/click over accepted recipients — the exact `pct` the
		// dashboard Recent campaigns card uses, so the two always agree. Same numerator and
		// denominator as `open_rate` / `click_rate` above (those keep one decimal).
		open_pct: wholePct(row.opens, row.accepted),
		click_pct: wholePct(row.clicks, row.accepted)
	}));

	const totals = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM campaigns c WHERE c.status = 'sent' AND ${visibleCampaignSql('c')}) AS campaigns,
			   (SELECT COUNT(*) FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
			      WHERE r.status = 'accepted' AND ${visibleCampaignSql('c')}) AS emails_sent,
			   (SELECT COUNT(*) FROM campaigns WHERE status = 'scheduled') AS scheduled`
		)
		.first<{ campaigns: number; emails_sent: number; scheduled: number }>();

	// 30-day rates (#132) across broadcast sends only (the send log's 'campaign' kind — not
	// direct 1:1 or automation steps): unique openers / clickers ÷ accepted recipients of
	// campaigns sent in the last 30 days. NULL when nothing was delivered (no 0% on empty).
	const rates = await db
		.prepare(
			`WITH b AS (
			   SELECT c.id FROM campaigns c
			   WHERE c.status = 'sent' AND ${SENDLOG_TYPE_SQL} = 'campaign'
			     AND COALESCE(c.sent_at, c.created_at) >= datetime('now', '-30 days')
			 )
			 SELECT
			   (SELECT COUNT(*) FROM recipients WHERE status = 'accepted' AND campaign_id IN (SELECT id FROM b)) AS delivered,
			   (SELECT COUNT(DISTINCT recipient_id) FROM events
			      WHERE type = 'open' AND recipient_id IS NOT NULL AND campaign_id IN (SELECT id FROM b)) AS opens,
			   (SELECT COUNT(DISTINCT recipient_id) FROM events
			      WHERE type = 'click' AND recipient_id IS NOT NULL AND campaign_id IN (SELECT id FROM b)) AS clicks`
		)
		.first<{ delivered: number; opens: number; clicks: number }>();
	const delivered30 = rates?.delivered ?? 0;
	const pct = (n: number): number | null => ratePct(n, delivered30);

	// Upcoming (#132): scheduled sends + pending auto-resends, soonest first.
	const scheduledRows = await db
		.prepare(
			`SELECT c.id, c.subject, c.scheduled_at AS at, c.weekday_only, c.list_id, l.name AS list_name
			 FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id
			 WHERE c.status = 'scheduled' AND c.scheduled_at IS NOT NULL
			 ORDER BY c.scheduled_at`
		)
		.all<{ id: number; subject: string; at: string; weekday_only: number; list_id: number | null; list_name: string | null }>();
	const resendRows = await db
		.prepare(
			`SELECT c.id, c.subject, c.resend_at AS at, c.weekday_only, l.name AS list_name
			 FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id
			 WHERE c.resend_status = 'pending' AND c.resend_at IS NOT NULL
			 ORDER BY c.resend_at`
		)
		.all<{ id: number; subject: string; at: string; weekday_only: number; list_name: string | null }>();
	const upcomingLabels = await multiGroupLabels(db, scheduledRows.results);
	const upcoming = [
		...scheduledRows.results.map((r) => ({ ...r, list_name: upcomingLabels.get(r.id) ?? r.list_name, kind: 'send' as const })),
		...resendRows.results.map((r) => ({ ...r, kind: 'resend' as const }))
	].sort((a, b) => a.at.localeCompare(b.at));

	return {
		campaigns,
		totals: totals ?? { campaigns: 0, emails_sent: 0, scheduled: 0 },
		rates: { delivered: delivered30, openRate: pct(rates?.opens ?? 0), clickRate: pct(rates?.clicks ?? 0) },
		upcoming,
		sort,
		dir,
		filter,
		filterParams: sendLogFilterParams(filter),
		filtered: isSendLogFiltered(filter),
		matched,
		total,
		page,
		per,
		pageCount,
		perOptions: PER_OPTIONS
	};
};

export const actions: Actions = {
	// #481: bulk Publish to / Remove from the newsletter archive (admins; sent broadcasts only —
	// anything else is skipped and counted).
	archiveBulk: async (event) => {
		if (event.locals?.user?.role !== 'admin') return fail(403, { archiveError: 'Only an admin can change the newsletter archive.' });
		const db = getDB(event);
		const data = await event.request.formData();
		const op = String(data.get('op') ?? '');
		const ids = [...new Set(data.getAll('id').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
		if (!ids.length || (op !== 'publish' && op !== 'remove')) return fail(400, { archiveError: 'Pick campaigns first.' });
		let changed = 0;
		let skipped = 0;
		if (op === 'publish') {
			// #499: oldest first, so new issue numbers follow the sent order.
			for (const r of await publishIssues(db, ids)) {
				if (r.ok && !r.already) changed++;
				else if (!r.ok) skipped++;
			}
		} else for (const id of ids) if (await unpublishIssue(db, id)) changed++;
		return { archiveDone: { op, changed, skipped } };
	}
};
