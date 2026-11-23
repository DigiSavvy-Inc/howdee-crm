// #252: read side of /api/v1/campaigns (list + one). Like campaign-drafts.ts, this module
// imports nothing that can send or schedule — tests/api-v1-campaigns-252.test.ts walks the
// import graph of the campaign handlers to keep it that way.
import { engagementBreakdown } from '$lib/server/campaign-engagement';
import { SENDLOG_TYPE_SQL } from '$lib/server/sendlog-query';
import { composeUrl } from '$lib/server/campaign-drafts';
import { storedBlocks } from '$lib/server/compose-body';
import { publicBaseUrlFor } from '$lib/server/public-url';
import { audienceViews, readAudiences } from '$lib/server/campaign-audience';
import { audienceLabel, type AudienceView } from '$lib/campaign-audience';
import { archiveUrl } from '$lib/newsletter-archive';
import { visibleCampaignSql } from '$lib/server/system-mail';

/** Origin for compose_url links: Settings → Domain, PUBLIC_BASE_URL, else the request's origin (#120). */
export function apiBaseUrl(event: { platform?: App.Platform; url: URL }): Promise<string> {
	return publicBaseUrlFor(event);
}

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent'] as const;
export type CampaignStatusFilter = (typeof CAMPAIGN_STATUSES)[number];

type CampaignRow = {
	id: number;
	subject: string;
	status: string;
	type: string;
	list_id: number | null;
	list_name: string | null;
	list_kind: string | null;
	template_id: number | null;
	scheduled_at: string | null;
	sent_at: string | null;
	created_at: string;
	recipient_count: number;
};

type CampaignDetailRow = CampaignRow & {
	preheader: string | null;
	body_md: string;
	body_blocks: string | null;
	from_email: string;
	resend_delay: string | null;
	archive_slug: string | null;
	archive_published_at: string | null;
};

const SELECT = `SELECT c.id, c.subject, c.status, ${SENDLOG_TYPE_SQL} AS type, c.list_id, l.name AS list_name,
	        l.kind AS list_kind, c.template_id, c.scheduled_at, c.sent_at, c.created_at, c.recipient_count`;

function audience(r: CampaignRow) {
	return r.list_id == null ? null : { list_id: r.list_id, name: r.list_name, kind: r.list_kind };
}

/** #332: every included / excluded group, plus "Customers + Newsletter, excluding VIP". */
function audiencesOf(v: AudienceView) {
	const g = (x: AudienceView['include'][number]) => ({ list_id: x.id, name: x.name, kind: x.kind });
	return { include: v.include.map(g), exclude: v.exclude.map(g), label: audienceLabel(v) };
}

async function viewsFor(db: D1Database, rows: CampaignRow[]): Promise<AudienceView[]> {
	const map = await readAudiences(db, rows);
	return audienceViews(db, rows.map((r) => map.get(r.id)!));
}

function serialize(r: CampaignRow, baseUrl: string, view: AudienceView) {
	return {
		id: r.id,
		subject: r.subject,
		status: r.status,
		type: r.type,
		// The first included group (pre-#332 shape); `audiences` has all of them.
		audience: audience(r),
		audiences: audiencesOf(view),
		template_id: r.template_id,
		scheduled_at: r.scheduled_at,
		sent_at: r.sent_at,
		created_at: r.created_at,
		recipient_count: r.recipient_count,
		compose_url: r.status === 'draft' ? composeUrl(baseUrl, r.id) : null
	};
}

export async function listCampaigns(
	db: D1Database,
	opts: { status?: CampaignStatusFilter; q?: string; limit: number; offset: number },
	baseUrl: string
) {
	const where: string[] = [visibleCampaignSql('c')]; // #668: account emails aren't campaigns
	const binds: unknown[] = [];
	if (opts.status) {
		where.push('c.status = ?');
		binds.push(opts.status);
	}
	if (opts.q) {
		where.push("c.subject LIKE ? ESCAPE '\\'");
		binds.push(`%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
	}
	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const total = await db
		.prepare(`SELECT COUNT(*) AS n FROM campaigns c ${whereSql}`)
		.bind(...binds)
		.first<{ n: number }>();
	const rows = await db
		.prepare(`${SELECT} FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id ${whereSql} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
		.bind(...binds, opts.limit, opts.offset)
		.all<CampaignRow>();
	const views = await viewsFor(db, rows.results);
	return { rows: rows.results.map((r, i) => serialize(r, baseUrl, views[i])), total: total?.n ?? 0 };
}

export async function getCampaign(db: D1Database, id: number, baseUrl: string) {
	const r = await db
		.prepare(
			`${SELECT}, c.preheader, c.body_md, c.body_blocks, c.from_email, c.resend_delay, c.archive_slug, c.archive_published_at
			 FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id WHERE c.id = ? AND ${visibleCampaignSql('c')}`
		)
		.bind(id)
		.first<CampaignDetailRow>();
	if (!r) return null;
	let stats = null;
	if (r.status === 'sent') {
		// The campaign page's Engagement numbers (#161). A click implies an open.
		const e = await engagementBreakdown(db, id);
		const uniqueOpens = e.clicked + e.openedOnly;
		stats = {
			sent: e.sent,
			unique_opens: uniqueOpens,
			unique_clicks: e.clicked,
			open_rate: e.sent ? uniqueOpens / e.sent : null,
			click_rate: e.sent ? e.clicked / e.sent : null,
			bounced: e.bounced,
			unsubscribed: e.unsubscribed
		};
	}
	return {
		...serialize(r, baseUrl, (await viewsFor(db, [r]))[0]),
		preheader: r.preheader,
		body: r.body_md,
		// #257: 'blocks' = made in the visual editor; body is then its markdown export, and
		// PATCHing body converts the draft to markdown.
		body_format: storedBlocks(r.body_blocks) ? 'blocks' : 'markdown',
		from_email: r.from_email,
		resend_delay: r.resend_delay,
		// #481: the public newsletter archive page, while published (null otherwise).
		archive_url: r.archive_published_at && r.archive_slug ? archiveUrl(baseUrl, r.archive_slug) : null,
		stats
	};
}
