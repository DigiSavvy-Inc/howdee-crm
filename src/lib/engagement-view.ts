// Engagement (#114): the universal (client + server) vocabulary and view math for the
// contact Engagement card, the Contacts tier column/filter, segment rules and the Data API.
// The rollup itself lives in `$lib/server/engagement.ts` (#113).

export const TIERS = ['hot', 'warm', 'cool', 'cold', 'never', 'new'] as const;
export type TierName = (typeof TIERS)[number];

export const TIER_LABELS: Record<TierName, string> = {
	hot: 'Hot',
	warm: 'Warm',
	cool: 'Cool',
	cold: 'Cold',
	never: 'Never engaged',
	new: 'New'
};

export function isTier(v: unknown): v is TierName {
	return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hourLabel(h: number): string {
	const am = h < 12 ? 'am' : 'pm';
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return `${h12}${am}`;
}

/** tz_confidence (0–1, see inferTz) → a word. */
export function confidenceLabel(c: number | null | undefined): 'high' | 'medium' | 'low' {
	if (c != null && c >= 0.7) return 'high';
	if (c != null && c >= 0.5) return 'medium';
	return 'low';
}

/**
 * "Usually opens around 9am on Tuesday" from the UTC histogram peaks. With a timezone
 * guess the hour (and the day, when the shift crosses midnight) moves to the contact's
 * guessed local time; without one it stays UTC. Null until there's a peak to report.
 */
export function bestTimeText(
	bestHourUtc: number | null | undefined,
	bestDow: number | null | undefined,
	tzOffset: number | null | undefined,
	tzConfidence: number | null | undefined
): { text: string; zone: 'local' | 'UTC'; confidence: 'high' | 'medium' | 'low' } | null {
	if (bestHourUtc == null) return null;
	const local = tzOffset != null;
	const shifted = bestHourUtc + (local ? tzOffset : 0);
	const hour = ((shifted % 24) + 24) % 24;
	const dayShift = Math.floor(shifted / 24);
	let text = `usually opens around ${hourLabel(hour)}`;
	if (bestDow != null) text += ` on ${DAYS[(((bestDow + dayShift) % 7) + 7) % 7]}`;
	return {
		text,
		zone: local ? 'local' : 'UTC',
		confidence: local ? confidenceLabel(tzConfidence) : 'low'
	};
}

export type MonthPoint = { month: string; opens: number; clicks: number };

/** The last `n` calendar months (UTC, oldest first) as YYYY-MM keys, ending with `now`'s. */
export function lastMonths(now: Date, n = 12): string[] {
	const out: string[] = [];
	for (let i = n - 1; i >= 0; i--) {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
	}
	return out;
}

/** Fill sparse per-month rows into a dense series over `months` (missing months = 0). */
export function fillMonths(
	months: string[],
	rows: { month: string; opens: number; clicks: number }[]
): MonthPoint[] {
	const by = new Map(rows.map((r) => [r.month, r]));
	return months.map((m) => ({ month: m, opens: by.get(m)?.opens ?? 0, clicks: by.get(m)?.clicks ?? 0 }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-05" → "May 2026". */
export function monthLabel(key: string): string {
	const [y, m] = key.split('-').map(Number);
	return MONTHS[(m || 1) - 1] ? `${MONTHS[m - 1]} ${y}` : key;
}

/** Bar heights (px) for the sparkline: scaled to the largest value; non-zero ≥ `minPx`. */
export function barHeights(points: MonthPoint[], maxPx: number, minPx = 2): { opens: number; clicks: number }[] {
	const max = Math.max(0, ...points.flatMap((p) => [p.opens, p.clicks]));
	const h = (v: number) => (v <= 0 || max <= 0 ? 0 : Math.max(minPx, Math.round((v / max) * maxPx)));
	return points.map((p) => ({ opens: h(p.opens), clicks: h(p.clicks) }));
}

/** Share of opens that were classified as proxy (Apple MPP) opens; null with no opens. */
export function proxyShare(openCount: number, proxyOpenCount: number): number | null {
	return openCount > 0 ? proxyOpenCount / openCount : null;
}

/** #115 lift report: `n` of `of` as a 0–1 rate; null when nothing was sent. */
export function cohortRate(n: number, of: number): number | null {
	return of > 0 ? n / of : null;
}

/**
 * Best-time vs default, in percentage points (best rate − default rate, ×100, one
 * decimal). Null unless both cohorts have sends to compare.
 */
export function liftPoints(best: number | null, dflt: number | null): number | null {
	if (best == null || dflt == null) return null;
	return Math.round((best - dflt) * 1000) / 10;
}

/** "+4.2 pts" / "−1.0 pts" / "±0 pts"; "—" when there's nothing to compare. */
export function liftText(points: number | null): string {
	if (points == null) return '—';
	if (points === 0) return '±0 pts';
	return `${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} pts`;
}
