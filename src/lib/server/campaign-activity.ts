// Campaign page Activity panel (#529): the latest events of one campaign, filtered by type
// in SQL, plus per-filter counts. scanner_click is always left out (#518).
import { ACTIVITY_FILTERS, ACTIVITY_MAX_ROWS, ACTIVITY_TYPES, activityLabel, type ActivityFilter } from '$lib/campaign-activity';

export type ActivityRow = {
	id: number;
	type: string;
	label: string;
	recorded_at: string;
	who: string;
	contact_id: number | null;
	recipient_id: number | null;
};

export type CampaignActivity = {
	rows: ActivityRow[];
	hasMore: boolean;
	counts: Record<ActivityFilter, number>;
};

export async function campaignActivity(
	db: D1Database,
	campaignId: number,
	filter: ActivityFilter,
	rows: number
): Promise<CampaignActivity> {
	const limit = Math.max(1, Math.min(ACTIVITY_MAX_ROWS, Math.floor(rows) || 1));
	const types = ACTIVITY_TYPES[filter];
	const typeSql = types ? `AND e.type IN (${types.map(() => '?').join(', ')})` : '';
	// One extra row tells us whether "Show more" has anything to show.
	const [list, grouped] = await Promise.all([
		db
			.prepare(
				`SELECT e.id, e.type, e.recorded_at, COALESCE(r.email, e.message_id) AS who,
				        COALESCE(r.contact_id, e.contact_id) AS contact_id, e.recipient_id
				 FROM events e
				 LEFT JOIN recipients r ON r.id = e.recipient_id
				 WHERE e.campaign_id = ? AND e.type <> 'scanner_click' ${typeSql}
				 ORDER BY e.recorded_at DESC, e.id DESC
				 LIMIT ?`
			)
			.bind(campaignId, ...(types ?? []), limit + 1)
			.all<Omit<ActivityRow, 'label'>>(),
		db
			.prepare(
				`SELECT type, COUNT(*) AS n FROM events
				 WHERE campaign_id = ? AND type <> 'scanner_click'
				 GROUP BY type`
			)
			.bind(campaignId)
			.all<{ type: string; n: number }>()
	]);

	const byType = new Map(grouped.results.map((g) => [g.type, g.n]));
	const counts = {} as Record<ActivityFilter, number>;
	for (const f of ACTIVITY_FILTERS) {
		const t = ACTIVITY_TYPES[f.key];
		counts[f.key] = t
			? t.reduce((sum, k) => sum + (byType.get(k) ?? 0), 0)
			: [...byType.values()].reduce((sum, n) => sum + n, 0);
	}

	const found = list.results;
	return {
		rows: found.slice(0, limit).map((e) => ({ ...e, label: activityLabel(e.type) })),
		hasMore: found.length > limit,
		counts
	};
}
