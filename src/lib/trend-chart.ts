// Multi-series line chart math (#565) for `TrendChart.svelte` — the generalised `GrowthChart`
// (#423). Pure, no DOM: totals, the shared peak, polyline coordinates and readout text.

export type TrendSeries = { key: string; label: string; color: string; dash: string | null };
export type TrendPoint = { start: string; label: string } & Record<string, number | string>;
export type TrendGeom = { width: number; base: number; pad: number };

const val = (p: TrendPoint, key: string): number => {
	const v = p[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** Sum of each series over every point. */
export function trendTotals(points: TrendPoint[], series: TrendSeries[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of series) out[s.key] = points.reduce((a, p) => a + val(p, s.key), 0);
	return out;
}

/** The largest value of any series at any point (at least 1, so an empty chart has a scale). */
export function trendPeak(points: TrendPoint[], series: TrendSeries[]): number {
	let peak = 1;
	for (const p of points) for (const s of series) peak = Math.max(peak, val(p, s.key));
	return peak;
}

/** x of point `i` of `n`; a single point sits in the middle. */
export function trendX(i: number, n: number, g: TrendGeom): number {
	return n > 1 ? g.pad + (i * (g.width - g.pad * 2)) / (n - 1) : g.width / 2;
}

/** SVG `points` for one series, every series on the same scale (`peak`). */
export function trendLine(points: TrendPoint[], key: string, peak: number, g: TrendGeom): string {
	return points
		.map((p, i) => `${trendX(i, points.length, g).toFixed(1)},${(g.base - (val(p, key) / peak) * (g.base - g.pad)).toFixed(1)}`)
		.join(' ');
}

/** "Week of Nov 9: Delivered 12 · Human opens 3 · …" — one point, every series, worded like the legend. */
export function trendPointText(p: TrendPoint, series: TrendSeries[], prefix = ''): string {
	return `${prefix}${p.label}: ` + series.map((s) => `${s.label} ${val(p, s.key).toLocaleString('en-US')}`).join(' · ');
}

/** True when no series has a value anywhere (the chart shows an empty state instead). */
export function trendEmpty(points: TrendPoint[], series: TrendSeries[]): boolean {
	return points.every((p) => series.every((s) => val(p, s.key) === 0));
}
