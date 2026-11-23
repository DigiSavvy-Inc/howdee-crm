// Company timeline (#566, 3 of 4): the account's activity in one feed on /companies/[id].
//
// Contact activity comes from `recentActivity` with the company's active contacts as
// `contactIds` (each source walks its contact index). Merged with:
//   - Gmail messages linked to those contacts — always, like the contact page (the
//     Conversations-tab setting only governs that tab, #443);
//   - GitHub: the recent issues kept on company_metrics (#169);
//   - Zoho Books invoices and payments (#353) — only when the caller passes `billing: true`
//     (`canSeeBilling`); otherwise nothing billing is read at all;
//   - Timing: the latest tracked entry (#168).
// Replies and Gmail rows carry their conversation thread key (`conversationKeys`), so the row
// links into /conversations/<key>. A Gmail copy of a message the app already holds has no key
// (the threading drops it) and is left out, so it never repeats the reply or send it copies.

import { recentActivity, type ActivityItem } from './activity';
import { conversationKeys } from './conversations';
import {
	CONTACT_SOURCES,
	TIMELINE_SOURCES,
	contactTypesFor,
	mergeTimeline,
	parseTimelineFilter,
	parseTimelineSize,
	toUtcStamp,
	wants,
	type TimelineFilter,
	type TimelineSource
} from '$lib/company-timeline';

export type CompanyTimeline = {
	items: ActivityItem[];
	filter: TimelineFilter;
	size: number;
	/** More rows exist beyond `size` for this filter ("Show more"). */
	more: boolean;
	/**
	 * The sources with at least one row for this company, in chip order (a chip only shows for
	 * these). Contact sources: one `recentActivity` row of that source's types.
	 */
	sources: TimelineSource[];
};

type RecentIssue = { number: number; title: string; state: string; html_url: string; updated_at: string; repo?: string };

function blank(at: string, type: ActivityItem['type']): ActivityItem {
	return {
		at,
		type,
		contact_id: null,
		email: null,
		name: null,
		campaign_id: null,
		subject: null,
		automation_id: null,
		automation_name: null,
		detail: null
	};
}

function parseIssues(raw: string | null | undefined): RecentIssue[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? (v as RecentIssue[]).filter((i) => i && typeof i.title === 'string') : [];
	} catch {
		return [];
	}
}

const IN_IDS = 'IN (SELECT value FROM json_each(?))';
const NAME_SQL = `COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''))`;

export async function companyTimeline(
	db: D1Database,
	companyId: number,
	opts: { billing: boolean; filter?: string | null; size?: string | number | null }
): Promise<CompanyTimeline> {
	const size = parseTimelineSize(opts.size == null ? null : String(opts.size));
	const take = size + 1;

	const idRows = await db
		.prepare(`SELECT id FROM contacts WHERE company_id = ? AND archived_at IS NULL`)
		.bind(companyId)
		.all<{ id: number }>();
	const ids = idRows.results.map((r) => r.id);
	const idsJson = JSON.stringify(ids);

	const [gmailRow, metrics, linkRow] = await db.batch([
		db.prepare(`SELECT EXISTS (SELECT 1 FROM mail_message_contacts WHERE contact_id ${IN_IDS}) AS n`).bind(idsJson),
		db
			.prepare(`SELECT last_tracked_at, last_tracked_title, recent_issues, github_synced_at FROM company_metrics WHERE company_id = ?`)
			.bind(companyId),
		// Billing: not even counted without access.
		opts.billing
			? db.prepare(`SELECT COUNT(*) AS n FROM company_zoho_contacts WHERE company_id = ?`).bind(companyId)
			: db.prepare(`SELECT 0 AS n`)
	]);
	const m = (metrics.results[0] ?? null) as {
		last_tracked_at: string | null;
		last_tracked_title: string | null;
		recent_issues: string | null;
		github_synced_at: string | null;
	} | null;
	const issues = m?.github_synced_at ? parseIssues(m.recent_issues) : [];
	const timingAt = toUtcStamp(m?.last_tracked_at);

	// Gmail messages that would be listed: not hidden, and with a thread key (a Gmail copy of a
	// message the app already holds has none). Filtered in SQL, so the LIMIT — and with it "Show
	// more" — counts only rows that show; the chip probe (#567) uses the same query with LIMIT 1.
	let keys: Awaited<ReturnType<typeof conversationKeys>> | null = null;
	const gmailRows = async (limit: number) => {
		keys ??= await conversationKeys(db, ids);
		const keyed = JSON.stringify([...keys.gmail.keys()]);
		const rows = await db
			.prepare(
				`SELECT g.mail_message_id, g.contact_id, c.email, ${NAME_SQL} AS name, g.subject, g.at, g.direction, g.sender
				 FROM (SELECT mm.id AS mail_message_id, MIN(mmc.contact_id) AS contact_id, mm.subject, mm.sent_at AS at,
				              mm.direction, COALESCE(mm.from_name, mm.from_email) AS sender
				       FROM mail_message_contacts mmc
				       JOIN mail_messages mm ON mm.id = mmc.message_id
				       WHERE mmc.contact_id ${IN_IDS} AND mm.id ${IN_IDS}
				         AND NOT EXISTS (SELECT 1 FROM conversation_hidden_gmail hg
				           WHERE hg.gmail_id = mm.gmail_id
				             AND hg.mailbox = (SELECT LOWER(ma.email) FROM mail_accounts ma WHERE ma.id = mm.account_id))
				       GROUP BY mm.id) g
				 JOIN contacts c ON c.id = g.contact_id
				 ORDER BY g.at DESC, g.mail_message_id DESC LIMIT ?`
			)
			.bind(idsJson, keyed, limit)
			.all<{
				mail_message_id: number;
				contact_id: number;
				email: string;
				name: string | null;
				subject: string | null;
				at: string;
				direction: 'in' | 'out';
				sender: string | null;
			}>();
		return rows.results;
	};

	// A contact source only has a chip when it has a row: one probe per source, all at once.
	const [probes, gmailProbe] = await Promise.all([
		Promise.all(CONTACT_SOURCES.map((k) => recentActivity(db, { contactIds: ids, types: contactTypesFor(k), limit: 1 }))),
		((gmailRow.results[0] as { n: number } | undefined)?.n ?? 0) > 0 ? gmailRows(1) : Promise.resolve([])
	]);
	const found = (k: TimelineSource) => probes[CONTACT_SOURCES.indexOf(k)].length > 0;
	const has: Record<TimelineSource, boolean> = {
		email: found('email'),
		replies: found('replies'),
		site: found('site'),
		pipeline: found('pipeline'),
		automations: found('automations'),
		contacts: found('contacts'),
		gmail: gmailProbe.length > 0,
		github: issues.length > 0,
		billing: opts.billing && ((linkRow.results[0] as { n: number } | undefined)?.n ?? 0) > 0,
		timing: !!timingAt
	};
	const sources = TIMELINE_SOURCES.map((s) => s.key).filter((k) => has[k]);
	const requested = parseTimelineFilter(opts.filter);
	const filter: TimelineFilter = requested === 'all' || has[requested] ? requested : 'all';

	const lists: ActivityItem[][] = [];
	const gmailIds = new Map<ActivityItem, number>(); // row → mail_messages.id

	const types = contactTypesFor(filter);
	if (types.length && ids.length) lists.push(await recentActivity(db, { contactIds: ids, types, limit: take }));

	if (wants(filter, 'gmail') && has.gmail) {
		const rows = { results: await gmailRows(take) };
		const gmailItems: ActivityItem[] = rows.results.map((r) => ({
				...blank(r.at, 'gmail'),
				contact_id: r.contact_id,
				email: r.email,
				name: r.name,
				subject: r.subject,
				detail: r.sender,
				direction: r.direction
			}));
		for (const [i, r] of rows.results.entries()) gmailIds.set(gmailItems[i], r.mail_message_id);
		lists.push(gmailItems);
	}

	if (wants(filter, 'github') && has.github) {
		const items: ActivityItem[] = [];
		for (const i of issues) {
			const at = toUtcStamp(i.updated_at);
			if (!at) continue;
			items.push({
				...blank(at, 'github'),
				detail: i.title,
				url: /^https:\/\/github\.com\//.test(i.html_url) ? i.html_url : null,
				ref: `${i.repo ? i.repo : ''}#${i.number}`,
				status: i.state === 'closed' ? 'closed' : 'open'
			});
		}
		lists.push(items);
	}

	if (wants(filter, 'billing') && has.billing) {
		const [inv, pay] = await db.batch([
			db
				.prepare(
					`SELECT i.invoice_id, i.invoice_number, i.status, i.date, i.total, i.currency_code, i.zoho_url
					 FROM zoho_invoices i JOIN company_zoho_contacts z ON z.zoho_contact_id = i.zoho_contact_id
					 WHERE z.company_id = ? AND i.date IS NOT NULL AND COALESCE(i.status, '') NOT IN ('draft', 'void')
					 ORDER BY i.date DESC, i.invoice_number DESC LIMIT ?`
				)
				.bind(companyId, take),
			db
				.prepare(
					`SELECT p.payment_id, p.payment_number, p.date, p.amount, p.currency_code, p.invoice_numbers
					 FROM zoho_payments p JOIN company_zoho_contacts z ON z.zoho_contact_id = p.zoho_contact_id
					 WHERE z.company_id = ? AND p.date IS NOT NULL
					 ORDER BY p.date DESC, p.payment_number DESC LIMIT ?`
				)
				.bind(companyId, take)
		]);
		const items: ActivityItem[] = [];
		for (const r of inv.results as {
			invoice_id: string;
			invoice_number: string | null;
			status: string | null;
			date: string;
			total: number | null;
			currency_code: string | null;
			zoho_url: string | null;
		}[]) {
			const at = toUtcStamp(r.date);
			if (!at) continue;
			items.push({
				...blank(at, 'invoice'),
				ref: r.invoice_number ?? r.invoice_id,
				status: r.status,
				amount: r.total,
				currency: r.currency_code,
				url: r.zoho_url && /^https:\/\//.test(r.zoho_url) ? r.zoho_url : null
			});
		}
		for (const r of pay.results as {
			payment_id: string;
			payment_number: string | null;
			date: string;
			amount: number | null;
			currency_code: string | null;
			invoice_numbers: string | null;
		}[]) {
			const at = toUtcStamp(r.date);
			if (!at) continue;
			items.push({
				...blank(at, 'payment'),
				ref: r.payment_number ?? r.payment_id,
				detail: r.invoice_numbers,
				amount: r.amount,
				currency: r.currency_code
			});
		}
		lists.push(items);
	}

	if (wants(filter, 'timing') && has.timing && timingAt) {
		lists.push([{ ...blank(timingAt, 'timing'), detail: m?.last_tracked_title ?? null }]);
	}

	const merged = mergeTimeline(lists, take);
	const items = merged.slice(0, size);

	// Link replies and Gmail rows to their conversation thread.
	if (items.some((i) => i.type === 'reply' || i.type === 'gmail')) {
		keys ??= await conversationKeys(db, ids);
		for (const it of items) {
			if (it.type === 'reply' && it.reply_id != null) it.conv_key = keys.replies.get(it.reply_id) ?? null;
			else if (it.type === 'gmail') it.conv_key = keys.gmail.get(gmailIds.get(it) ?? 0) ?? null;
		}
	}

	return { items, filter, size, more: merged.length > size, sources };
}
