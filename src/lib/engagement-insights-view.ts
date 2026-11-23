// Dashboard engagement intelligence (#116): universal view math for the tier trend rows
// and the day × hour heatmap. The queries live in `$lib/server/engagement-insights.ts`.

/** Heatmap rows, Monday first (values are JS/SQLite dow: 0 = Sunday). */
export const HEAT_DAYS: { dow: number; label: string }[] = [
	{ dow: 1, label: 'Mon' },
	{ dow: 2, label: 'Tue' },
	{ dow: 3, label: 'Wed' },
	{ dow: 4, label: 'Thu' },
	{ dow: 5, label: 'Fri' },
	{ dow: 6, label: 'Sat' },
	{ dow: 0, label: 'Sun' }
];

export const HEAT_LEVELS = 4;

/** #457: shown when the heatmap read hit its 20,000-event cap (HEATMAP_ROW_CAP). */
export const HEAT_SAMPLED_NOTE = 'sampled: first 20,000 events';

/** 0 for an empty cell, else 1…HEAT_LEVELS scaled to the busiest cell. */
export function heatLevel(v: number, max: number): number {
	if (v <= 0 || max <= 0) return 0;
	return Math.max(1, Math.min(HEAT_LEVELS, Math.ceil((v / max) * HEAT_LEVELS)));
}

export function hourShort(h: number): string {
	if (h === 0) return '12a';
	if (h === 12) return '12p';
	return h < 12 ? `${h}a` : `${h - 12}p`;
}

export function hourLong(h: number): string {
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return `${h12}${h < 12 ? 'am' : 'pm'}`;
}

/** The busiest cell, or null when the grid is empty. */
export function heatPeak(grid: number[][]): { dow: number; hour: number; n: number } | null {
	let best: { dow: number; hour: number; n: number } | null = null;
	for (let d = 0; d < grid.length; d++) {
		for (let h = 0; h < grid[d].length; h++) {
			if (grid[d][h] > 0 && (!best || grid[d][h] > best.n)) best = { dow: d, hour: h, n: grid[d][h] };
		}
	}
	return best;
}

/**
 * SVG polyline points for a trend sparkline over `values` (nulls = no snapshot that day,
 * skipped). x spans the full width by index so gaps stay in place; y is scaled to `max`
 * (shared across rows when given, so the rows compare). '' when fewer than 2 points.
 */
export function sparkPoints(values: (number | null)[], width: number, height: number, max?: number): string {
	const known = values.filter((v): v is number => v !== null);
	if (known.length < 2) return '';
	const top = Math.max(1, max ?? Math.max(...known));
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	const pts: string[] = [];
	values.forEach((v, i) => {
		if (v === null) return;
		const x = Math.round(i * step * 10) / 10;
		const y = Math.round((height - (v / top) * height) * 10) / 10;
		pts.push(`${x},${y}`);
	});
	return pts.join(' ');
}

/** First and last known values of a series (null when there are none). */
export function trendEnds(values: (number | null)[]): { first: number; last: number; firstIdx: number } | null {
	const firstIdx = values.findIndex((v) => v !== null);
	if (firstIdx < 0) return null;
	let lastIdx = values.length - 1;
	while (values[lastIdx] === null) lastIdx--;
	return { first: values[firstIdx]!, last: values[lastIdx]!, firstIdx };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-08" → "Jul 8". */
export function monthDay(day: string): string {
	const [, m, d] = day.split('-').map(Number);
	return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : day;
}

/** "+3" / "−2" / "±0". */
export function signed(n: number): string {
	if (n > 0) return `+${n}`;
	if (n < 0) return `−${Math.abs(n)}`;
	return '±0';
}
