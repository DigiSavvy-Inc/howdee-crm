// Reports (#354): one registry entry per metric. SQL fragments are whitelisted
// expressions over a fixed alias (`c` contacts, `ce` contact_engagement, `co`
// companies, `cm` company_metrics, `cp` campaigns). The engine binds every value;
// nothing here interpolates a caller-supplied string.
//
// Rates are not recomputed with new math. Contact open/click rates are
// `contact_engagement` unique-campaigns ÷ campaigns sent, shown with `reportPct`
// (one decimal, #453). Campaign rates use the accepted-recipient denominator.
// Zoho billing columns stay behind `zohoReportsEnabled()`, which is off until #353.

export type ReportEntity = 'contacts' | 'companies' | 'campaigns' | 'segments' | 'pipeline' | 'site_pages';

export type MetricFormat = 'count' | 'pct' | 'currency' | 'hours' | 'date' | 'text';

export type MetricExpr = { sql: string; binds: (string | number | null)[] };

/** How the engine turns a per-row expression into a grouped cell. */
export type GroupAgg = 'sum' | 'max' | 'min' | 'count-distinct';

export type MetricContext = {
	/** Time predicate for a timestamp column. Raw event scans always get one. */
	window: (column: string) => MetricExpr;
};

export type MetricDef = {
	key: string;
	label: string;
	entity: ReportEntity;
	format: MetricFormat;
	definition: string;
	/** Hours, billing and pipeline value. Admins only. */
	sensitive?: boolean;
	/** Off until that integration is merged. */
	feature?: 'zoho';
	/** Per-row SELECT expression. Omitted for rates, which use `rate`. */
	select?: (ctx: MetricContext) => MetricExpr;
	/**
	 * Numerator and denominator, already the app's own columns.
	 * The engine shows `pct(num, den)` (summed first when the report is grouped).
	 */
	rate?: { num: string; den: string };
	/** Replace a campaign open count with human opens (`classifyProxyOpen`). */
	proxyOpens?: boolean;
	groupAgg?: GroupAgg;
};

/**
 * A report rate, as a percent with one decimal (#453). Unsubscribe, bounce and
 * complaint rates under 1 % keep two decimals, so 1 in 250 reads 0.4 %, not 0 %.
 */
export function reportPct(n: number, d: number, fine = false): number | null {
	if (!d) return null;
	const p = (n / d) * 100;
	const scale = fine && p < 1 ? 100 : 10;
	return Math.round(p * scale) / scale;
}

/** Rates shown with two decimals below 1 %. */
export const FINE_RATE_KEYS: ReadonlySet<string> = new Set(['unsub_rate', 'bounce_rate', 'complaint_rate']);

const lit =
	(sql: string) =>
	(): MetricExpr => ({ sql, binds: [] });

function pageviewWindow(ctx: MetricContext): MetricExpr {
	const w = ctx.window('se.occurred_at');
	return {
		sql: `(SELECT COUNT(*) FROM site_events se WHERE se.contact_id = c.id AND se.kind = 'pageview' AND (${w.sql}))`,
		binds: w.binds
	};
}

const CONTACT_METRICS: MetricDef[] = [
	{
		key: 'email',
		label: 'Email',
		entity: 'contacts',
		format: 'text',
		definition: 'The contact email address.',
		select: lit('c.email')
	},
	{
		key: 'name',
		label: 'Name',
		entity: 'contacts',
		format: 'text',
		definition: 'The contact name.',
		select: lit(
			"COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''))"
		)
	},
	{
		key: 'contacts',
		label: 'Contacts',
		entity: 'contacts',
		format: 'count',
		definition: 'How many contacts are in the row.',
		select: lit('c.id'),
		groupAgg: 'count-distinct'
	},
	{
		key: 'sent',
		label: 'Sent',
		entity: 'contacts',
		format: 'count',
		definition: 'Accepted sends, from the engagement rollup (contact_engagement.sent_count).',
		select: lit('COALESCE(ce.sent_count, 0)')
	},
	{
		key: 'delivered',
		label: 'Delivered',
		entity: 'contacts',
		format: 'count',
		definition: 'Delivered messages, from contact_engagement.delivered_count.',
		select: lit('COALESCE(ce.delivered_count, 0)')
	},
	{
		key: 'opens',
		label: 'Opens',
		entity: 'contacts',
		format: 'count',
		definition: 'Opens excluding proxy (Apple MPP) opens: open_count minus proxy_open_count.',
		select: lit('COALESCE(ce.open_count, 0) - COALESCE(ce.proxy_open_count, 0)')
	},
	{
		key: 'unique_opens',
		label: 'Unique opens',
		entity: 'contacts',
		format: 'count',
		definition: 'Campaigns with an open, from contact_engagement.unique_open_campaigns.',
		select: lit('COALESCE(ce.unique_open_campaigns, 0)')
	},
	{
		key: 'clicks',
		label: 'Clicks',
		entity: 'contacts',
		format: 'count',
		definition: 'Clicks, from contact_engagement.click_count.',
		select: lit('COALESCE(ce.click_count, 0)')
	},
	{
		key: 'replies',
		label: 'Replies',
		entity: 'contacts',
		format: 'count',
		definition: 'Replies, from contact_engagement.reply_count.',
		select: lit('COALESCE(ce.reply_count, 0)')
	},
	{
		key: 'open_rate',
		label: 'Open rate',
		entity: 'contacts',
		format: 'pct',
		definition: 'Unique campaigns opened ÷ campaigns sent (contact_engagement open rate).',
		rate: { num: 'COALESCE(ce.unique_open_campaigns, 0)', den: 'COALESCE(ce.sent_count, 0)' }
	},
	{
		key: 'click_rate',
		label: 'Click rate',
		entity: 'contacts',
		format: 'pct',
		definition: 'Unique campaigns clicked ÷ campaigns sent (contact_engagement click rate).',
		rate: { num: 'COALESCE(ce.unique_click_campaigns, 0)', den: 'COALESCE(ce.sent_count, 0)' }
	},
	{
		key: 'last_open',
		label: 'Last open',
		entity: 'contacts',
		format: 'date',
		definition: 'When the contact last opened, from contact_engagement.last_open_at.',
		select: lit('ce.last_open_at')
	},
	{
		key: 'last_click',
		label: 'Last click',
		entity: 'contacts',
		format: 'date',
		definition: 'When the contact last clicked, from contact_engagement.last_click_at.',
		select: lit('ce.last_click_at')
	},
	{
		key: 'last_reply',
		label: 'Last reply',
		entity: 'contacts',
		format: 'date',
		definition: 'When the contact last replied, from contact_engagement.last_reply_at.',
		select: lit('ce.last_reply_at')
	},
	{
		key: 'days_since_engagement',
		label: 'Days since engagement',
		entity: 'contacts',
		format: 'count',
		definition: 'Days since the latest open, click or reply on the engagement rollup.',
		groupAgg: 'min',
		select: lit(
			"CAST(julianday('now') - julianday(MAX(ce.last_open_at, ce.last_click_at, ce.last_reply_at)) AS INTEGER)"
		)
	},
	{
		key: 'engagement_score',
		label: 'Engagement score',
		entity: 'contacts',
		format: 'count',
		definition: 'The 0–100 engagement score from contact_engagement.',
		select: lit('COALESCE(ce.score, 0)')
	},
	{
		key: 'engagement_tier',
		label: 'Engagement tier',
		entity: 'contacts',
		format: 'text',
		definition: 'Engagement tier from contact_engagement (new when there is no row yet).',
		select: lit("COALESCE(ce.tier, 'new')")
	},
	{
		key: 'site_visits',
		label: 'Site visits',
		entity: 'contacts',
		format: 'count',
		definition: 'Page views in the report window (last 90 days when the report has no range).',
		select: pageviewWindow
	},
	{
		key: 'last_site_visit',
		label: 'Last site visit',
		entity: 'contacts',
		format: 'date',
		definition: 'The newest page view for the contact.',
		select: lit(
			"(SELECT MAX(se.occurred_at) FROM site_events se WHERE se.contact_id = c.id AND se.kind = 'pageview')"
		)
	},
	{
		key: 'pipeline_stage',
		label: 'Pipeline stage',
		entity: 'contacts',
		format: 'text',
		definition: 'The contact\'s current pipeline stage, if they are on the board.',
		select: lit(
			'(SELECT ps.name FROM pipeline_cards pc JOIN pipeline_stages ps ON ps.id = pc.stage_id WHERE pc.contact_id = c.id)'
		)
	},
	{
		key: 'pipeline_value',
		label: 'Pipeline value',
		entity: 'contacts',
		format: 'currency',
		sensitive: true,
		definition: 'The contact\'s pipeline card value, in whole currency units.',
		select: lit('(SELECT pc.value FROM pipeline_cards pc WHERE pc.contact_id = c.id)')
	},
	{
		key: 'created',
		label: 'Created',
		entity: 'contacts',
		format: 'date',
		definition: 'When the contact was created.',
		select: lit('c.created_at')
	},
	{
		key: 'source',
		label: 'Source',
		entity: 'contacts',
		format: 'text',
		definition: 'The contact source.',
		select: lit('c.source')
	},
	{
		key: 'tags',
		label: 'Tags',
		entity: 'contacts',
		format: 'text',
		definition: 'Tag names on the contact.',
		select: lit(
			"(SELECT GROUP_CONCAT(l.name, ', ') FROM list_members lm JOIN lists l ON l.id = lm.list_id AND l.kind = 'tag' WHERE lm.contact_id = c.id)"
		)
	},
	{
		key: 'lists',
		label: 'Lists',
		entity: 'contacts',
		format: 'text',
		definition: 'List names on the contact.',
		select: lit(
			"(SELECT GROUP_CONCAT(l.name, ', ') FROM list_members lm JOIN lists l ON l.id = lm.list_id AND l.kind = 'list' WHERE lm.contact_id = c.id)"
		)
	}
];

const COMPANY_METRICS_COLS: MetricDef[] = [
	{
		key: 'name',
		label: 'Company',
		entity: 'companies',
		format: 'text',
		definition: 'The company name.',
		select: lit('co.name')
	},
	{
		key: 'contact_count',
		label: 'Contacts',
		entity: 'companies',
		format: 'count',
		definition: 'Active contacts linked to the company: not archived, subscribed or pending confirmation.',
		// #705: = activeContactSql('c') from $lib/server/active-audience (a universal module can't
		// import it; tests/active-audience-705.test.ts pins the two together).
		select: lit(
			'(SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id AND (c.archived_at IS NULL AND (c.subscribed = 1 OR c.confirm_pending = 1)))'
		)
	},
	{
		key: 'avg_open_rate',
		label: 'Avg open rate',
		entity: 'companies',
		format: 'pct',
		definition: 'Average of linked contacts\' contact_engagement.open_rate.',
		select: lit(
			'(SELECT AVG(ce.open_rate) FROM contacts c JOIN contact_engagement ce ON ce.contact_id = c.id WHERE c.company_id = co.id AND c.archived_at IS NULL AND ce.open_rate IS NOT NULL)'
		)
	},
	{
		key: 'median_open_rate',
		label: 'Median open rate',
		entity: 'companies',
		format: 'pct',
		definition: 'Median of linked contacts\' contact_engagement.open_rate.',
		select: lit('NULL')
	},
	{
		key: 'opens',
		label: 'Opens',
		entity: 'companies',
		format: 'count',
		definition: 'Opens by linked contacts in the report window, excluding proxy (Apple MPP) opens.',
		select: lit('0'),
		proxyOpens: true
	},
	{
		key: 'clicks',
		label: 'Clicks',
		entity: 'companies',
		format: 'count',
		definition: 'Clicks by linked contacts in the report window.',
		select: (ctx) => {
			const w = ctx.window('e.recorded_at');
			return {
				sql: `(SELECT COUNT(*) FROM events e JOIN contacts c ON c.id = e.contact_id WHERE c.company_id = co.id AND c.archived_at IS NULL AND e.type = 'click' AND (${w.sql}))`,
				binds: w.binds
			};
		}
	},
	hour('hours_7d', 'Hours (7 days)', 'Hours tracked in the last 7 days (Timing, company_metrics.hours_7d).'),
	hour('hours_30d', 'Hours (30 days)', 'Hours tracked in the last 30 days (Timing, company_metrics.hours_30d).'),
	hour('hours_90d', 'Hours (90 days)', 'Hours tracked in the last 90 days (Timing, company_metrics.hours_90d).'),
	hour('hours_total', 'Hours (all time)', 'Hours tracked all time (Timing, company_metrics.hours_total).'),
	{
		key: 'issues_open',
		label: 'Open issues',
		entity: 'companies',
		format: 'count',
		definition: 'Open GitHub issues, from company_metrics.issues_open.',
		select: lit('cm.issues_open')
	},
	{
		key: 'issues_closed',
		label: 'Closed issues',
		entity: 'companies',
		format: 'count',
		definition: 'Closed GitHub issues, from company_metrics.issues_closed.',
		select: lit('cm.issues_closed')
	},
	{
		key: 'issues_opened_30d',
		label: 'Issues opened (30 days)',
		entity: 'companies',
		format: 'count',
		definition: 'GitHub issues opened in 30 days, from company_metrics.issues_opened_30d.',
		select: lit('cm.issues_opened_30d')
	},
	{
		key: 'issues_closed_30d',
		label: 'Issues closed (30 days)',
		entity: 'companies',
		format: 'count',
		definition: 'GitHub issues closed in 30 days, from company_metrics.issues_closed_30d.',
		select: lit('cm.issues_closed_30d')
	},
	{
		key: 'last_issue_at',
		label: 'Last GitHub activity',
		entity: 'companies',
		format: 'date',
		definition: 'Last GitHub issue activity, from company_metrics.last_issue_at.',
		select: lit('cm.last_issue_at')
	},
	{
		key: 'pipeline_value',
		label: 'Pipeline value',
		entity: 'companies',
		format: 'currency',
		sensitive: true,
		definition: 'Sum of pipeline card values for the company\'s active contacts.',
		select: lit(
			'(SELECT SUM(pc.value) FROM pipeline_cards pc JOIN contacts c ON c.id = pc.contact_id WHERE c.company_id = co.id AND c.archived_at IS NULL)'
		)
	},
	zoho('zoho_ar', 'Accounts receivable', 'Open accounts receivable from Zoho Books.'),
	zoho('zoho_invoiced', 'Invoiced', 'Amount invoiced in Zoho Books.'),
	zoho('zoho_paid', 'Paid', 'Amount paid in Zoho Books.')
];

const CAMPAIGN_METRICS: MetricDef[] = [
	{
		key: 'subject',
		label: 'Subject',
		entity: 'campaigns',
		format: 'text',
		definition: 'The campaign subject.',
		select: lit('cp.subject')
	},
	{
		key: 'recipients',
		label: 'Sent',
		entity: 'campaigns',
		format: 'count',
		definition: 'Recipients Postmark accepted, the denominator of every campaign rate.',
		select: lit("(SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = cp.id AND r.status = 'accepted')")
	},
	{
		key: 'rejected',
		label: 'Rejected',
		entity: 'campaigns',
		format: 'count',
		definition: 'Recipients Postmark refused at send time (recipients.status = error). Not in the rate denominators.',
		select: lit("(SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = cp.id AND r.status = 'error')")
	},
	{
		key: 'delivered',
		label: 'Delivered',
		entity: 'campaigns',
		format: 'count',
		definition: 'Distinct recipients with a delivery event.',
		select: lit(
			"(SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'delivery')"
		)
	},
	{
		key: 'opens',
		label: 'Opens',
		entity: 'campaigns',
		format: 'count',
		definition:
			'Unique openers: distinct recipients with a human open or a click (a click proves the email was opened, even with images blocked). Proxy (Apple MPP) opens are excluded, so this is human opens only; the campaign page shows all opens.',
		proxyOpens: true,
		select: lit(
			"(SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'open')"
		)
	},
	{
		key: 'open_rate',
		label: 'Open rate',
		entity: 'campaigns',
		format: 'pct',
		definition: 'Unique openers (human open or click) ÷ sent. Human opens only; the campaign page counts all opens.',
		proxyOpens: true,
		select: lit('NULL')
	},
	{
		key: 'clicks',
		label: 'Clicks',
		entity: 'campaigns',
		format: 'count',
		definition: 'Unique clickers: distinct recipients with a click.',
		select: lit(
			"(SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'click')"
		)
	},
	{
		key: 'total_opens',
		label: 'Total opens',
		entity: 'campaigns',
		format: 'count',
		definition: 'Every open event, repeat and proxy (Apple MPP) opens included.',
		select: lit("(SELECT COUNT(*) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'open')")
	},
	{
		key: 'total_clicks',
		label: 'Total clicks',
		entity: 'campaigns',
		format: 'count',
		definition: 'Every click event, repeat clicks included.',
		select: lit("(SELECT COUNT(*) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'click')")
	},
	{
		key: 'click_rate',
		label: 'Click rate',
		entity: 'campaigns',
		format: 'pct',
		definition: 'Unique clickers ÷ sent.',
		select: lit('NULL')
	},
	{
		key: 'ctor',
		label: 'CTOR',
		entity: 'campaigns',
		format: 'pct',
		definition: 'Unique clickers ÷ unique openers (click-to-open rate). Never above 100 %: every clicker counts as an opener.',
		proxyOpens: true,
		select: lit('NULL')
	},
	{
		key: 'unsubs',
		label: 'Unsubscribes',
		entity: 'campaigns',
		format: 'count',
		definition: 'Distinct recipients with an unsubscribe event.',
		select: lit(
			"(SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'unsubscribe')"
		)
	},
	{
		key: 'unsub_rate',
		label: 'Unsub rate',
		entity: 'campaigns',
		format: 'pct',
		definition: 'Unsubscribes ÷ sent. Two decimals below 1 %.',
		select: lit('NULL')
	},
	{
		key: 'bounces',
		label: 'Bounces',
		entity: 'campaigns',
		format: 'count',
		definition: 'Distinct recipients with a bounce event.',
		select: lit(
			"(SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'bounce')"
		)
	},
	{
		key: 'bounce_rate',
		label: 'Bounce rate',
		entity: 'campaigns',
		format: 'pct',
		definition: 'Bounces ÷ sent. Two decimals below 1 %.',
		select: lit('NULL')
	},
	{
		key: 'spam',
		label: 'Spam complaints',
		entity: 'campaigns',
		format: 'count',
		definition: 'Distinct recipients with a spam complaint event.',
		select: lit(
			"(SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'spam')"
		)
	},
	{
		key: 'complaint_rate',
		label: 'Complaint rate',
		entity: 'campaigns',
		format: 'pct',
		definition: 'Spam complaints ÷ sent. Two decimals below 1 %.',
		select: lit('NULL')
	},
	{
		key: 'replies',
		label: 'Replies',
		entity: 'campaigns',
		format: 'count',
		definition: 'Replies captured for the campaign.',
		select: lit('(SELECT COUNT(*) FROM replies rp WHERE rp.campaign_id = cp.id)')
	},
	{
		key: 'sent_at',
		label: 'Sent on',
		entity: 'campaigns',
		format: 'date',
		definition: 'When the campaign was sent.',
		select: lit('cp.sent_at')
	},
	{
		key: 'audience',
		label: 'Audience',
		entity: 'campaigns',
		format: 'text',
		definition: 'Included audiences (campaign_audiences).',
		select: lit(
			"(SELECT GROUP_CONCAT(name, ', ') FROM (SELECT l.name AS name FROM campaign_audiences ca JOIN lists l ON l.id = ca.list_id WHERE ca.campaign_id = cp.id AND ca.mode = 'include' ORDER BY ca.position, l.name))"
		)
	},
	{
		key: 'kind',
		label: 'Kind',
		entity: 'campaigns',
		format: 'text',
		definition: 'Campaign, automation step (a step since deleted included), or direct 1:1 send.',
		select: lit(`CASE WHEN cp.automation_step_id IS NOT NULL OR cp.automation_id IS NOT NULL THEN 'automation' WHEN cp.list_id IS NULL THEN 'direct' ELSE 'campaign' END`)
	}
];

const SEGMENT_METRICS: MetricDef[] = [
	{
		key: 'name',
		label: 'Name',
		entity: 'segments',
		format: 'text',
		definition: 'The list or segment name.',
		select: lit('l.name')
	},
	{
		key: 'member_count',
		label: 'Members',
		entity: 'segments',
		format: 'count',
		definition: 'Active contacts in the list, or matching a dynamic segment.',
		select: lit('0')
	},
	{
		key: 'subscribed_count',
		label: 'Subscribed',
		entity: 'segments',
		format: 'count',
		definition: 'Subscribed active members.',
		select: lit('0')
	},
	{
		key: 'avg_open_rate',
		label: 'Avg open rate',
		entity: 'segments',
		format: 'pct',
		definition: 'Average contact_engagement.open_rate of the members.',
		select: lit('NULL')
	},
	{
		key: 'avg_click_rate',
		label: 'Avg click rate',
		entity: 'segments',
		format: 'pct',
		definition: 'Average contact_engagement.click_rate of the members.',
		select: lit('NULL')
	},
	{
		key: 'campaigns_sent',
		label: 'Campaigns sent',
		entity: 'segments',
		format: 'count',
		definition: 'Sent campaigns that include this group (campaign_audiences).',
		select: lit('0')
	},
	{
		key: 'campaign_open_rate',
		label: 'Campaign open rate',
		entity: 'segments',
		format: 'pct',
		definition: 'Human opens ÷ accepted recipients, pooled across campaigns sent to this group.',
		select: lit('NULL')
	}
];

const PIPELINE_METRICS: MetricDef[] = [
	{
		key: 'pipeline_stage',
		label: 'Stage',
		entity: 'pipeline',
		format: 'text',
		definition: 'The pipeline stage name.',
		select: lit('ps.name')
	},
	{
		key: 'cards',
		label: 'Cards',
		entity: 'pipeline',
		format: 'count',
		definition: 'Pipeline cards.',
		select: lit('1'),
		groupAgg: 'sum'
	},
	{
		key: 'pipeline_value',
		label: 'Value',
		entity: 'pipeline',
		format: 'currency',
		sensitive: true,
		definition: 'Pipeline card value, in whole currency units.',
		select: lit('pc.value')
	},
	{
		key: 'avg_days_in_stage',
		label: 'Avg days in stage',
		entity: 'pipeline',
		format: 'count',
		definition: 'Days since the card entered its stage (entered_stage_at).',
		groupAgg: 'max',
		select: lit("CAST(julianday('now') - julianday(pc.entered_stage_at) AS INTEGER)")
	},
	{
		key: 'moves',
		label: 'Moves',
		entity: 'pipeline',
		format: 'count',
		definition: 'Stage entries recorded in pipeline_history during the report window.',
		select: lit('0')
	},
	{
		key: 'won',
		label: 'Won',
		entity: 'pipeline',
		format: 'count',
		definition: 'Moves into a won stage during the report window (pipeline_history).',
		select: lit('0')
	},
	{
		key: 'lost',
		label: 'Lost',
		entity: 'pipeline',
		format: 'count',
		definition: 'Moves into a lost stage during the report window (pipeline_history).',
		select: lit('0')
	}
];

const SITE_METRICS: MetricDef[] = [
	{
		key: 'path',
		label: 'Path',
		entity: 'site_pages',
		format: 'text',
		definition: 'Page path, without the query string.',
		select: lit("COALESCE(se.path, '')")
	},
	{
		key: 'views',
		label: 'Views',
		entity: 'site_pages',
		format: 'count',
		definition: 'Page views in the report window.',
		select: lit('1'),
		groupAgg: 'sum'
	},
	{
		key: 'unique_contacts',
		label: 'Unique contacts',
		entity: 'site_pages',
		format: 'count',
		definition: 'Distinct contacts with a page view in the report window.',
		select: lit('se.contact_id'),
		groupAgg: 'count-distinct'
	}
];

function hour(key: string, label: string, definition: string): MetricDef {
	return {
		key,
		label,
		entity: 'companies',
		format: 'hours',
		sensitive: true,
		definition,
		select: lit(`cm.${key}`)
	};
}

function zoho(key: string, label: string, definition: string): MetricDef {
	return {
		key,
		label,
		entity: 'companies',
		format: 'currency',
		sensitive: true,
		feature: 'zoho',
		definition,
		select: () => {
			throw new Error(`Zoho Books metrics aren't available yet (${key}).`);
		}
	};
}

export const REPORT_METRICS: readonly MetricDef[] = [
	...CONTACT_METRICS,
	...COMPANY_METRICS_COLS,
	...CAMPAIGN_METRICS,
	...SEGMENT_METRICS,
	...PIPELINE_METRICS,
	...SITE_METRICS
];

const BY_ENTITY = new Map<ReportEntity, Map<string, MetricDef>>();
for (const metric of REPORT_METRICS) {
	let bucket = BY_ENTITY.get(metric.entity);
	if (!bucket) {
		bucket = new Map();
		BY_ENTITY.set(metric.entity, bucket);
	}
	bucket.set(metric.key, metric);
}

export function metricsFor(entity: ReportEntity): MetricDef[] {
	return [...(BY_ENTITY.get(entity)?.values() ?? [])];
}

export function findMetric(entity: ReportEntity, key: string): MetricDef | undefined {
	return BY_ENTITY.get(entity)?.get(key);
}

export function isFieldColumn(key: string): boolean {
	return key.startsWith('field:');
}

/**
 * Zoho Books report metrics (#353). Stays off until that integration is merged —
 * the columns exist in the catalog so the check has somewhere to live.
 */
export function zohoReportsEnabled(): boolean {
	return false;
}

/** Hours, billing (including Zoho) and pipeline value. */
export function isSensitiveKey(entity: ReportEntity, key: string): boolean {
	return findMetric(entity, key)?.sensitive === true;
}
