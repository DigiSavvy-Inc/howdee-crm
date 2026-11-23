/**
 * Open & click rate trend (#455): weekly campaign and automation series over the
 * last 12 months, weeks starting Monday in Settings → Timezone.
 *
 * A broadcast goes out at once, so it is bucketed by its `sent_at`. An automation
 * step campaign keeps collecting recipients forever, so its **recipients** are
 * bucketed by their own send time — the first delivery or bounce event — and a
 * recipient without one (still sending, never accepted) is left out.
 */
import { tzOffsetMinutes } from '$lib/contacts-overview';
import { reportPct } from '$lib/report-metrics';
import { isProxyEvent, openersByCampaign } from '$lib/server/reports/engine';

type Counts = { sent: number; opens: number; clicks: number };

export type TrendRow = {
	week: string;
	open_rate: number | null;
	click_rate: number | null;
	automation_open_rate: number | null;
	automation_click_rate: number | null;
	sent: number;
	automation_sent: number;
};

const AUTOMATION_SEND_SQL = '(cp.automation_step_id IS NOT NULL OR cp.automation_id IS NOT NULL)';
const DAY_MS = 86_400_000;
const ID_CHUNK = 500;

/** Monday of the local (`tz`) week containing the UTC timestamp, as `YYYY-MM-DD`. */
export function tzWeekStart(value: string, tz: string): string | null {
	const s = value.trim();
	if (!s) return null;
	const normalized = s.includes('T') ? s : s.replace(' ', 'T');
	const ms = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
	if (Number.isNaN(ms)) return null;
	const local = new Date(ms + tzOffsetMinutes(tz, new Date(ms)) * 60_000);
	local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
	return local.toISOString().slice(0, 10);
}

/** SQLite UTC timestamp 12 months before `now`. */
function windowStart(now: Date): string {
	const d = new Date(now.getTime());
	d.setUTCMonth(d.getUTCMonth() - 12);
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

function add(map: Map<string, Counts>, week: string, sent: number, opens: number, clicks: number): void {
	const c = map.get(week) ?? { sent: 0, opens: 0, clicks: 0 };
	c.sent += sent;
	c.opens += opens;
	c.clicks += clicks;
	map.set(week, c);
}

async function campaignWeeks(db: D1Database, since: string, tz: string): Promise<Map<string, Counts>> {
	const res = await db
		.prepare(
			`SELECT cp.id AS id, cp.sent_at AS sent_at,
			        (SELECT COUNT(*) FROM recipients r WHERE r.campaign_id = cp.id AND r.status = 'accepted') AS sent,
			        (SELECT COUNT(DISTINCT e.recipient_id) FROM events e WHERE e.campaign_id = cp.id AND e.type = 'click') AS clicks
			 FROM campaigns cp
			 WHERE cp.status = 'sent' AND NOT ${AUTOMATION_SEND_SQL} AND cp.list_id IS NOT NULL
			   AND cp.sent_at IS NOT NULL AND cp.sent_at >= ?`
		)
		.bind(since)
		.all<{ id: number; sent_at: string; sent: number; clicks: number }>();
	const rows = res.results ?? [];
	const openers = await openersByCampaign(db, rows.map((row) => row.id));
	const weeks = new Map<string, Counts>();
	for (const row of rows) {
		const week = tzWeekStart(row.sent_at, tz);
		if (!week) continue;
		add(weeks, week, Number(row.sent) || 0, openers.get(row.id) ?? 0, Number(row.clicks) || 0);
	}
	return weeks;
}

async function automationWeeks(db: D1Database, since: string, tz: string): Promise<Map<string, Counts>> {
	// The scan starts at the window: a recipient whose first send event is older is excluded.
	const res = await db
		.prepare(
			`SELECT r.id AS id, MIN(e.recorded_at) AS sent_at
			 FROM recipients r
			 JOIN campaigns cp ON cp.id = r.campaign_id
			 JOIN events e ON e.recipient_id = r.id AND e.campaign_id = r.campaign_id AND e.type IN ('delivery', 'bounce')
			 WHERE ${AUTOMATION_SEND_SQL} AND r.status = 'accepted' AND e.recorded_at >= ?
			   AND NOT EXISTS (SELECT 1 FROM events p WHERE p.recipient_id = r.id AND p.campaign_id = r.campaign_id
			                     AND p.type IN ('delivery', 'bounce') AND p.recorded_at < ?)
			 GROUP BY r.id`
		)
		.bind(since, since)
		.all<{ id: number; sent_at: string }>();
	const sentAt = new Map<number, string>();
	for (const row of res.results ?? []) if (row.sent_at) sentAt.set(row.id, row.sent_at);

	const opened = new Set<number>();
	const clicked = new Set<number>();
	const ids = [...sentAt.keys()];
	for (let i = 0; i < ids.length; i += ID_CHUNK) {
		const slice = ids.slice(i, i + ID_CHUNK);
		const events = await db
			.prepare(
				`SELECT recipient_id, type, detail, recorded_at FROM events
				 WHERE type IN ('open', 'click') AND recipient_id IN (SELECT value FROM json_each(?))`
			)
			.bind(JSON.stringify(slice))
			.all<{ recipient_id: number; type: string; detail: string | null; recorded_at: string }>();
		for (const ev of events.results ?? []) {
			if (ev.type === 'click') {
				clicked.add(ev.recipient_id);
				opened.add(ev.recipient_id);
			} else if (!isProxyEvent({ ...ev, delivered_at: sentAt.get(ev.recipient_id) ?? null })) {
				opened.add(ev.recipient_id);
			}
		}
	}

	const weeks = new Map<string, Counts>();
	for (const [id, at] of sentAt) {
		const week = tzWeekStart(at, tz);
		if (!week) continue;
		add(weeks, week, 1, opened.has(id) ? 1 : 0, clicked.has(id) ? 1 : 0);
	}
	return weeks;
}

/**
 * One row per week, oldest first, from the first week with a send to the last.
 * A week with nothing sent in a series has `sent` 0 and null rates (a gap in the chart).
 */
export async function rateTrend(db: D1Database, now: Date, tz: string): Promise<TrendRow[]> {
	const since = windowStart(now);
	const [campaigns, automations] = await Promise.all([campaignWeeks(db, since, tz), automationWeeks(db, since, tz)]);
	const keys = [...campaigns.keys(), ...automations.keys()].sort();
	if (!keys.length) return [];
	const rows: TrendRow[] = [];
	const last = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`);
	for (let t = Date.parse(`${keys[0]}T00:00:00Z`); t <= last; t += 7 * DAY_MS) {
		const week = new Date(t).toISOString().slice(0, 10);
		const c = campaigns.get(week) ?? { sent: 0, opens: 0, clicks: 0 };
		const a = automations.get(week) ?? { sent: 0, opens: 0, clicks: 0 };
		rows.push({
			week,
			open_rate: reportPct(c.opens, c.sent),
			click_rate: reportPct(c.clicks, c.sent),
			automation_open_rate: reportPct(a.opens, a.sent),
			automation_click_rate: reportPct(a.clicks, a.sent),
			sent: c.sent,
			automation_sent: a.sent
		});
	}
	return rows;
}
