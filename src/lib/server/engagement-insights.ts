// Dashboard engagement intelligence (#116): tier trend, the global day × hour heatmap and
// the "going cold this month" list. Read-only over `contact_engagement`,
// `engagement_tier_daily` (migration 0061, written by the heartbeat — see
// `snapshotTierCounts` in engagement.ts) and `events`. View math lives in the universal
// `$lib/engagement-insights-view.ts`.

import { classifyProxyOpen } from './engagement';
import { TIERS, type TierName } from '$lib/engagement-view';

// ---------------------------------------------------------------------------
// Tier trend
// ---------------------------------------------------------------------------

export type TierTrend = {
	days: string[]; // YYYY-MM-DD, oldest first, dense
	series: Record<TierName, (number | null)[]>; // null = no snapshot that day
	snapshots: number; // how many of `days` have a snapshot
};

/** The last `n` UTC days ending today, oldest first. */
export function lastDays(now: Date, n: number): string[] {
	const out: string[] = [];
	const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
	return out;
}

/** Dense per-tier series over `days` from sparse snapshot rows (a missing day = null). */
export function fillTrend(days: string[], rows: { day: string; tier: string; n: number }[]): TierTrend {
	const byDay = new Map<string, Map<string, number>>();
	for (const r of rows) {
		if (!byDay.has(r.day)) byDay.set(r.day, new Map());
		byDay.get(r.day)!.set(r.tier, r.n);
	}
	const series = Object.fromEntries(
		TIERS.map((t) => [t, days.map((d) => (byDay.has(d) ? (byDay.get(d)!.get(t) ?? 0) : null))])
	) as Record<TierName, (number | null)[]>;
	return { days, series, snapshots: days.filter((d) => byDay.has(d)).length };
}

export async function tierTrend(db: D1Database, now: Date = new Date(), n = 90): Promise<TierTrend> {
	const days = lastDays(now, n);
	const rows = await db
		.prepare(`SELECT day, tier, n FROM engagement_tier_daily WHERE day >= ? ORDER BY day`)
		.bind(days[0])
		.all<{ day: string; tier: string; n: number }>();
	return fillTrend(days, rows.results);
}

// ---------------------------------------------------------------------------
// Day × hour heatmap
// ---------------------------------------------------------------------------

export type HeatRow = {
	type: string;
	recorded_at: string;
	ua: string | null;
	client_name: string | null;
	client_family: string | null;
	first_open: number | null;
	delivered_at: string | null;
	/** #457: who engaged; a slot counts each person once. Missing = each event on its own. */
	contact_id?: number | null;
};

export type Heatmap = {
	grid: number[][]; // [dow 0=Sunday][hour 0–23], in `tz`: distinct people per slot (#457)
	total: number; // distinct people with a real (non-proxy) open or click
	proxySkipped: number;
	tz: string;
	days: number;
	truncated: boolean; // hit HEATMAP_ROW_CAP — the oldest events in the window were left out
};

const HEATMAP_ROW_CAP = 20_000;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toUtcMs(s: string): number {
	let iso = s.trim();
	if (iso.includes(' ') && !iso.includes('T')) iso = iso.replace(' ', 'T');
	if (!/[zZ]|[+-]\d\d:\d\d$/.test(iso)) iso += 'Z';
	return Date.parse(iso);
}

/**
 * Bucket open/click rows into a 7×24 day-of-week × hour grid in `tz`. Proxy opens (the same
 * `classifyProxyOpen` the per-contact histograms use) are skipped — they fire on delivery
 * and would just paint "right after we sent". #457: a cell counts **people** (distinct
 * `contact_id`), not events; `total` is the distinct people over the whole grid.
 */
export function bucketHeatmap(rows: HeatRow[], tz: string): { grid: number[][]; total: number; proxySkipped: number } {
	const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
	const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
	const cells = new Map<number, Set<string>>();
	const people = new Set<string>();
	let proxySkipped = 0;
	for (const [index, r] of rows.entries()) {
		if (r.type === 'open') {
			const detail = {
				UserAgent: r.ua ?? '',
				Client: { Name: r.client_name ?? '', Family: r.client_family ?? '' },
				FirstOpen: r.first_open === 1
			};
			if (classifyProxyOpen(detail, r.delivered_at, r.recorded_at)) {
				proxySkipped++;
				continue;
			}
		}
		const ms = toUtcMs(r.recorded_at);
		if (!Number.isFinite(ms)) continue;
		let dow = -1;
		let hour = -1;
		for (const p of fmt.formatToParts(new Date(ms))) {
			if (p.type === 'weekday') dow = WEEKDAY_INDEX[p.value] ?? -1;
			else if (p.type === 'hour') hour = Number(p.value) % 24;
		}
		if (dow < 0 || hour < 0 || !Number.isFinite(hour)) continue;
		const who = r.contact_id != null ? `c${r.contact_id}` : `e${index}`;
		const slot = dow * 24 + hour;
		let set = cells.get(slot);
		if (!set) cells.set(slot, (set = new Set()));
		if (!set.has(who)) {
			set.add(who);
			grid[dow][hour]++;
		}
		people.add(who);
	}
	return { grid, total: people.size, proxySkipped };
}

/**
 * People with a real open or click in the last `days` days, by weekday × hour in the
 * operator timezone. #457: review / system sends (direct campaigns: no list, no
 * automation) are left out, and the fast-first-open proxy check compares with the delivery
 * of the same recipient row — the same pass, so a resend's fast open is caught too.
 */
export async function engagementHeatmap(
	db: D1Database,
	tz: string,
	now: Date = new Date(),
	days = 90
): Promise<Heatmap> {
	const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
	// Only the detail fields the proxy classifier reads (not the whole JSON), and the
	// delivery time only where the "first open < 60s after delivery" rule needs it.
	const rows = await db
		.prepare(
			`SELECT type, recorded_at,
			        json_extract(dj, '$.UserAgent') AS ua,
			        json_extract(dj, '$.Client.Name') AS client_name,
			        json_extract(dj, '$.Client.Family') AS client_family,
			        json_extract(dj, '$.FirstOpen') AS first_open,
			        contact_id,
			        CASE WHEN type = 'open' AND json_extract(dj, '$.FirstOpen') = 1 THEN
			          (SELECT MIN(d.recorded_at) FROM events d
			           WHERE d.campaign_id = x.campaign_id AND d.type = 'delivery'
			             AND (CASE WHEN x.recipient_id IS NOT NULL THEN d.recipient_id = x.recipient_id
			                       ELSE d.contact_id = x.contact_id END))
			        END AS delivered_at
			 FROM (SELECT ev.type, ev.recorded_at, ev.contact_id, ev.campaign_id, ev.recipient_id,
			              CASE WHEN json_valid(ev.detail) THEN ev.detail END AS dj
			       FROM events ev
			       WHERE ev.type IN ('open', 'click') AND ev.recorded_at >= ?
			         AND NOT EXISTS (SELECT 1 FROM campaigns cp WHERE cp.id = ev.campaign_id
			                         AND cp.list_id IS NULL AND cp.automation_id IS NULL AND cp.automation_step_id IS NULL)
			       ORDER BY ev.recorded_at DESC
			       LIMIT ?) x`
		)
		.bind(since, HEATMAP_ROW_CAP)
		.all<HeatRow>();
	const b = bucketHeatmap(rows.results, tz);
	return { ...b, tz, days, truncated: rows.results.length >= HEATMAP_ROW_CAP };
}

// ---------------------------------------------------------------------------
// Going cold
// ---------------------------------------------------------------------------

export const GOING_COLD_DAYS = 30;
export const GOING_COLD_ACTION_CAP = 500;

// A contact is "going cold" when its tier moved DOWN into cool or cold within the window
// (hot/warm → cool/cold, cool → cold) and it's still subscribed. `never`/`new` aren't
// part of the ladder: you can't fall into them from an engaged tier.
const RANK = `CASE %s WHEN 'hot' THEN 4 WHEN 'warm' THEN 3 WHEN 'cool' THEN 2 WHEN 'cold' THEN 1 ELSE 0 END`;
const DROPPED = `ce.tier IN ('cool', 'cold')
	AND ce.tier_changed_at >= ?
	AND ${RANK.replace('%s', 'ce.prev_tier')} > ${RANK.replace('%s', 'ce.tier')}`;
const GOING_COLD_WHERE = `c.subscribed = 1
	AND c.archived_at IS NULL
	AND ${DROPPED}`;

function coldCutoff(now: Date, days = GOING_COLD_DAYS): string {
	return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * #423: "tier dropped into cool/cold since `since`" as an EXISTS over `idExpr` — the
 * `cooled_days` contacts filter. Subscribed / archived are left to the caller's own filter.
 */
export function goingColdClause(idExpr: string, since: Date): { clause: string; binds: unknown[] } {
	return {
		clause: `EXISTS (SELECT 1 FROM contact_engagement ce WHERE ce.contact_id = ${idExpr} AND ${DROPPED})`,
		binds: [since.toISOString()]
	};
}

export type GoingColdContact = {
	id: number;
	email: string;
	name: string | null;
	tier: string;
	prev_tier: string;
	tier_changed_at: string;
	score: number;
};

export async function goingCold(
	db: D1Database,
	opts: { limit?: number; now?: Date } = {}
): Promise<{ total: number; contacts: GoingColdContact[] }> {
	const cutoff = coldCutoff(opts.now ?? new Date());
	const [count, list] = await Promise.all([
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM contact_engagement ce JOIN contacts c ON c.id = ce.contact_id WHERE ${GOING_COLD_WHERE}`
			)
			.bind(cutoff)
			.first<{ n: number }>(),
		db
			.prepare(
				`SELECT c.id, c.email,
				        COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), c.name) AS name,
				        ce.tier, ce.prev_tier, ce.tier_changed_at, ce.score
				 FROM contact_engagement ce JOIN contacts c ON c.id = ce.contact_id
				 WHERE ${GOING_COLD_WHERE}
				 ORDER BY ${RANK.replace('%s', 'ce.prev_tier')} DESC, ce.tier_changed_at DESC, c.id
				 LIMIT ?`
			)
			.bind(cutoff, opts.limit ?? 8)
			.all<GoingColdContact>()
	]);
	return { total: count?.n ?? 0, contacts: list.results };
}

/** Every going-cold contact id (capped), for the dashboard's one-click actions. */
export async function goingColdIds(db: D1Database, now: Date = new Date()): Promise<number[]> {
	const rows = await db
		.prepare(
			`SELECT c.id FROM contact_engagement ce JOIN contacts c ON c.id = ce.contact_id
			 WHERE ${GOING_COLD_WHERE} ORDER BY c.id LIMIT ?`
		)
		.bind(coldCutoff(now), GOING_COLD_ACTION_CAP)
		.all<{ id: number }>();
	return rows.results.map((r) => r.id);
}
