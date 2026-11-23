// Deliverability filters (#279) — "who bounced / complained / did X on campaign N" as SQL
// over a contact id expression, shared by the /contacts filters (contacts-query.ts) and the
// segment rules `bounced` / `spam_complaint` (segment-query.ts).
//
// Bounces come from Postmark's Bounce webhook (`events.type = 'bounce'`, `detail` = the raw
// payload as JSON, truncated at 4000 chars). Hard = Postmark `Type` HardBounce or
// BadEmailAddress, or `Inactive: true` (Postmark deactivated the address) — the same rule
// the webhook uses to unsubscribe. Matched with LIKE on the JSON text, not json_extract: a
// truncated payload is not valid JSON, and json_extract would fail the whole query.
// Spam = a SpamComplaint event, or our own `unsubscribes` row with reason 'Marked as spam'.
import { segmentWhere } from './campaign-engagement';

export type BounceKind = 'hard' | 'any';
export const CAMPAIGN_WHO = ['sent', 'opens', 'opened', 'clicked', 'none', 'bounced', 'unsubscribed'] as const;
export type CampaignWho = (typeof CAMPAIGN_WHO)[number];

export const CAMPAIGN_WHO_LABELS: Record<CampaignWho, string> = {
	sent: 'were sent',
	opens: 'opened',
	opened: 'opened (no click)',
	clicked: 'clicked',
	none: 'did not interact with',
	bounced: 'bounced on',
	unsubscribed: 'unsubscribed from'
};

export function isCampaignWho(v: string): v is CampaignWho {
	return (CAMPAIGN_WHO as readonly string[]).includes(v);
}

const HARD_BOUNCE = `(x.detail LIKE '%"Type":"HardBounce"%' OR x.detail LIKE '%"Type":"BadEmailAddress"%' OR x.detail LIKE '%"Inactive":true%')`;

/** The hard-bounce test over an `events` row aliased `alias` (scoring, #466). */
export function hardBounceSql(alias: string): string {
	return HARD_BOUNCE.replaceAll('x.detail', `${alias}.detail`);
}

/** Has a bounce event (any, or hard only). `negate` = has none of that kind. */
export function bouncedClause(kind: BounceKind, idExpr: string, negate = false): { clause: string; binds: unknown[] } {
	const inner = `SELECT 1 FROM events x WHERE x.contact_id = ${idExpr} AND x.type = 'bounce'${kind === 'hard' ? ` AND ${HARD_BOUNCE}` : ''}`;
	return { clause: `${negate ? 'NOT ' : ''}EXISTS (${inner})`, binds: [] };
}

/** Has a spam complaint (webhook event, or the unsubscribe row the webhook writes for it). */
export function spamClause(idExpr: string, negate = false): { clause: string; binds: unknown[] } {
	const any = `(EXISTS (SELECT 1 FROM events x WHERE x.contact_id = ${idExpr} AND x.type = 'spam')
		OR EXISTS (SELECT 1 FROM unsubscribes u WHERE u.reason = 'Marked as spam'
		     AND (u.contact_id = ${idExpr} OR u.email = (SELECT cc.email FROM contacts cc WHERE cc.id = ${idExpr}))))`;
	return { clause: negate ? `NOT ${any}` : any, binds: [] };
}

const HAS = (type: string) =>
	`EXISTS (SELECT 1 FROM events x WHERE x.campaign_id = r.campaign_id AND x.type = '${type}' AND x.recipient_id = r.id)`;

/** Predicate over `recipients r` for one campaign segment. opened/clicked/none = the
 *  campaign page's Engagement bar segments (segmentWhere); opens = any open. */
function recipientWhere(who: CampaignWho): string {
	switch (who) {
		case 'sent':
			return '1';
		case 'opens':
			return HAS('open');
		case 'opened':
		case 'clicked':
		case 'none':
			return segmentWhere(who);
		case 'bounced':
			return HAS('bounce');
		case 'unsubscribed':
			// Postmark's SubscriptionChange event, or our own /unsubscribe page's row.
			return `(${HAS('unsubscribe')} OR EXISTS (SELECT 1 FROM unsubscribes u WHERE u.campaign_id = r.campaign_id AND u.email = r.email))`;
	}
}

/** Accepted recipients of campaign `campaignId` in segment `who`. */
export function campaignWhoClause(campaignId: number, who: CampaignWho, idExpr: string): { clause: string; binds: unknown[] } {
	return {
		clause: `EXISTS (SELECT 1 FROM recipients r WHERE r.campaign_id = ? AND r.status = 'accepted'
			AND r.contact_id = ${idExpr} AND ${recipientWhere(who)})`,
		binds: [campaignId]
	};
}

/** `/contacts?campaign=<id>&campaign_who=<who>` — the "Open in Contacts" link target. */
export function campaignContactsHref(campaignId: number, who: CampaignWho): string {
	return `/contacts?campaign=${campaignId}&campaign_who=${who}`;
}

/**
 * How many contacts that link would show (same clause, so the number matches). The link opens
 * the default Active view, so archived contacts (#280) are left out here too.
 */
export async function campaignWhoCount(db: D1Database, campaignId: number, who: CampaignWho): Promise<number> {
	const { clause, binds } = campaignWhoClause(campaignId, who, 'contacts.id');
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${clause} AND archived_at IS NULL`)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
