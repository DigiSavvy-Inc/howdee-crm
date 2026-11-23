// Contacts overview (#423): period vocabulary and chart bucketing, shared by the server
// loader and the page. Pure — no DB, no DOM.
//
// Period windows ("new in period", "unsubscribed in period", the feed's "this period") are
// UTC calendar days: the period starts at UTC midnight of today − (days − 1), the same day
// boundary the `added_from` / `unsub_from` filters compare with `date(created_at)`. The
// growth chart buckets by the operator's local day instead (Settings → Timezone, like the
// heatmap): SQL shifts timestamps by the zone's current UTC offset (`tzOffsetMinutes`) before
// taking the date, so a week or month starts at local midnight. A DST change inside the
// window moves at most an hour of rows across a day boundary.

export type PeriodKey = '7d' | '30d' | '90d' | '12m';
export type BucketUnit = 'day' | 'week' | 'month';

export const PERIODS: { key: PeriodKey; label: string; days: number; unit: BucketUnit }[] = [
	{ key: '7d', label: '7d', days: 7, unit: 'day' },
	{ key: '30d', label: '30d', days: 30, unit: 'week' },
	{ key: '90d', label: '90d', days: 90, unit: 'week' },
	{ key: '12m', label: '12m', days: 365, unit: 'month' }
];

export const DEFAULT_PERIOD: PeriodKey = '30d';

export function parsePeriod(v: string | null | undefined): PeriodKey {
	return PERIODS.some((p) => p.key === v) ? (v as PeriodKey) : DEFAULT_PERIOD;
}

export function periodDef(key: PeriodKey) {
	return PERIODS.find((p) => p.key === key)!;
}

const DAY_MS = 86_400_000;

function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** First UTC day (YYYY-MM-DD) of the period ending today. */
export function periodStartDate(key: PeriodKey, now: Date): string {
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return utcDay(today - (periodDef(key).days - 1) * DAY_MS);
}

/** The period start as a SQLite UTC timestamp ('YYYY-MM-DD 00:00:00'). */
export function periodSince(key: PeriodKey, now: Date): string {
	return `${periodStartDate(key, now)} 00:00:00`;
}

/** Minutes `tz` is ahead of UTC at `at` (e.g. −420 for Los Angeles in summer). Bad zone → 0. */
export function tzOffsetMinutes(tz: string, at: Date): number {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).formatToParts(at);
		const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
		const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
		return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
	} catch {
		return 0;
	}
}

/** SQLite date() modifier for an offset, e.g. '-420 minutes'. */
export function offsetModifier(offsetMin: number): string {
	return `${offsetMin >= 0 ? '+' : ''}${offsetMin} minutes`;
}

/** The bucket a local day (YYYY-MM-DD) falls in: itself, its Monday, or the 1st of its month. */
export function bucketOf(day: string, unit: BucketUnit): string {
	if (unit === 'day') return day;
	if (unit === 'month') return `${day.slice(0, 7)}-01`;
	const ms = Date.parse(`${day}T00:00:00Z`);
	const dow = new Date(ms).getUTCDay(); // 0 = Sunday
	return utcDay(ms - ((dow + 6) % 7) * DAY_MS);
}

export type GrowthBucket = { start: string; label: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bucketLabel(start: string, unit: BucketUnit): string {
	const m = MONTHS[Number(start.slice(5, 7)) - 1];
	if (unit === 'month') return `${m} ${start.slice(0, 4)}`;
	return `${m} ${Number(start.slice(8, 10))}`;
}

/**
 * The chart's buckets for the period, oldest first, in local days: today is `now` shifted by
 * `offsetMin`; the first bucket is the one holding the period's first local day.
 */
export function growthBuckets(key: PeriodKey, now: Date, offsetMin: number): GrowthBucket[] {
	const { days, unit } = periodDef(key);
	const localNow = now.getTime() + offsetMin * 60_000;
	const today = utcDay(localNow);
	const first = bucketOf(utcDay(localNow - (days - 1) * DAY_MS), unit);
	const out: GrowthBucket[] = [];
	let cur = first;
	while (cur <= today && out.length < 400) {
		out.push({ start: cur, label: bucketLabel(cur, unit) });
		if (unit === 'month') {
			const y = Number(cur.slice(0, 4));
			const m = Number(cur.slice(5, 7));
			cur = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
		} else {
			cur = utcDay(Date.parse(`${cur}T00:00:00Z`) + (unit === 'week' ? 7 : 1) * DAY_MS);
		}
	}
	return out;
}

/** UTC 'YYYY-MM-DD HH:MM:SS' of the first bucket's local midnight — the SQL lower bound. */
export function growthSince(buckets: GrowthBucket[], offsetMin: number): string {
	const ms = Date.parse(`${buckets[0].start}T00:00:00Z`) - offsetMin * 60_000;
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export type GrowthPoint = GrowthBucket & { added: number; unsubscribed: number };

/** Per-local-day counts → one point per bucket (days outside every bucket are dropped). */
export function fillGrowth(
	buckets: GrowthBucket[],
	unit: BucketUnit,
	added: { d: string; n: number }[],
	unsubscribed: { d: string; n: number }[]
): GrowthPoint[] {
	const idx = new Map(buckets.map((b, i) => [b.start, i]));
	const points = buckets.map((b) => ({ ...b, added: 0, unsubscribed: 0 }));
	for (const r of added) {
		const i = idx.get(bucketOf(r.d, unit));
		if (i !== undefined) points[i].added += r.n;
	}
	for (const r of unsubscribed) {
		const i = idx.get(bucketOf(r.d, unit));
		if (i !== undefined) points[i].unsubscribed += r.n;
	}
	return points;
}

/** The top `n` rows by count, the rest summed into one "Other" row (omitted when 0). */
export function topWithOther<T extends { label: string; n: number }>(rows: T[], n = 8): (T | { label: string; n: number; other: true })[] {
	const sorted = [...rows].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
	const top: (T | { label: string; n: number; other: true })[] = sorted.slice(0, n);
	const rest = sorted.slice(n).reduce((a, r) => a + r.n, 0);
	if (rest > 0) top.push({ label: 'Other', n: rest, other: true });
	return top;
}
