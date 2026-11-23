import { describe, it, expect } from 'vitest';
import {
	chartSeriesKeys,
	chartView,
	heatmapGrid,
	hourIndex,
	lineSegments,
	shortLabel,
	timeSlots,
	weekdayIndex
} from '../src/lib/report-view';
import { BUILT_IN_REPORTS, resolveParams } from '../src/lib/server/reports/builtins';
import { parseReportSpec } from '../src/lib/report-spec';
import chartSource from '../src/lib/components/ReportChart.svelte?raw';
import resultsSource from '../src/lib/components/ReportResults.svelte?raw';
import homeSource from '../src/routes/reports/+page.svelte?raw';

const pct = (key: string, label = key) => ({ key, label, format: 'pct' as const });

describe('#454 chart series helpers', () => {
	it('series keys: explicit yKeys win, else y plus the numeric columns of its format, at most 4', () => {
		const columns = [
			{ key: 'subject', label: 'Subject', format: 'text' as const },
			pct('open_rate'),
			pct('click_rate'),
			{ key: 'recipients', label: 'Sent', format: 'count' as const }
		];
		expect(chartSeriesKeys(columns, 'open_rate')).toEqual(['open_rate', 'click_rate']);
		expect(chartSeriesKeys(columns, 'open_rate', ['open_rate'])).toEqual(['open_rate']);
		expect(chartSeriesKeys(columns, 'open_rate', ['nope', 'click_rate'])).toEqual(['click_rate']);
		const many = ['a', 'b', 'c', 'd', 'e'].map((key) => pct(key));
		expect(chartSeriesKeys(many, 'a')).toEqual(['a', 'b', 'c', 'd']);
	});

	it('multi-series shaping keeps labels and nulls (never 0)', () => {
		const view = chartView(
			{
				columns: [{ key: 'week', label: 'Week', format: 'text' }, pct('open_rate', 'Campaign open rate'), pct('automation_open_rate', 'Automation open rate')],
				rows: [
					{ week: '2026-09-07', open_rate: 30, automation_open_rate: null },
					{ week: '2026-09-14', open_rate: 0, automation_open_rate: 40 }
				],
				chartSeries: { xKey: 'week', yKey: 'open_rate', yKeys: ['open_rate', 'automation_open_rate'] }
			},
			{ chart: 'line' }
		)!;
		expect(view.series.map((series) => series.label)).toEqual(['Campaign open rate', 'Automation open rate']);
		expect(view.series[0]!.values).toEqual([30, 0]);
		expect(view.series[1]!.values).toEqual([null, 40]);
	});

	it('time axis: weeks are placed by time, gaps left empty, oldest first', () => {
		const view = chartView(
			{
				columns: [{ key: 'week', label: 'Week', format: 'text' }, pct('open_rate')],
				rows: [
					{ week: '2026-10-05', open_rate: 20 },
					{ week: '2026-08-03', open_rate: 10 },
					{ week: '2026-08-10', open_rate: 15 }
				],
				chartSeries: { xKey: 'week', yKey: 'open_rate' }
			},
			{ chart: 'line' }
		)!;
		expect(view.time).toBe('week');
		expect(view.labels).toEqual(['2026-08-03', '2026-08-10', '2026-10-05']);
		expect(view.slots).toEqual([0, 1, 9]);
		expect(view.slotCount).toBe(10);
		// The 8-week gap breaks the line.
		expect(lineSegments(view.series[0]!.values, view.slots)).toEqual([[0, 1], [2]]);
	});

	it('time slots: months, days, and index placement for non-time categories', () => {
		expect(timeSlots(['2026-01', '2026-03'])).toEqual({ unit: 'month', index: [2026 * 12, 2026 * 12 + 2] });
		const days = timeSlots(['2026-10-01', '2026-10-02', '2026-10-04'])!;
		expect(days.unit).toBe('day');
		expect(days.index.map((day) => day - days.index[0]!)).toEqual([0, 1, 3]);
		const weeks = timeSlots(['2026-10-05', '2026-10-19'], 'period')!;
		expect(weeks.unit).toBe('week');
		expect(weeks.index[1]! - weeks.index[0]!).toBe(2);
		expect(timeSlots(['Hot', 'Warm'])).toBeNull();
		const view = chartView(
			{ columns: [{ key: 'tier', label: 'Tier', format: 'text' }, pct('share')], rows: [{ tier: 'Hot', share: 1 }, { tier: 'Warm', share: 2 }], chartSeries: { xKey: 'tier', yKey: 'share' } },
			{ chart: 'line' }
		)!;
		expect(view.time).toBeNull();
		expect(view.slots).toEqual([0, 1]);
	});

	it('nulls break the line and draw no point', () => {
		expect(lineSegments([1, null, 3, 4, null], [0, 1, 2, 3, 4])).toEqual([[0], [2, 3]]);
		expect(lineSegments([null, null], [0, 1])).toEqual([]);
	});

	it('comparison: newest-first rows chart oldest → newest, and a 0-sent campaign is a gap', () => {
		const view = chartView(
			{
				columns: [
					{ key: 'subject', label: 'Subject', format: 'text' },
					pct('open_rate', 'Open rate'),
					pct('click_rate', 'Click rate'),
					{ key: 'recipients', label: 'Sent', format: 'count' },
					{ key: 'sent_at', label: 'Sent at', format: 'date' }
				],
				rows: [
					{ subject: 'Newest', open_rate: 0, click_rate: 0, recipients: 0, sent_at: '2026-10-20' },
					{ subject: 'Middle', open_rate: 40, click_rate: 5, recipients: 10, sent_at: '2026-10-10' },
					{ subject: 'Oldest', open_rate: 0, click_rate: 0, recipients: 8, sent_at: '2026-10-01' }
				],
				chartSeries: { xKey: 'subject', yKey: 'open_rate' }
			},
			{ chart: 'bar', sort: { key: 'sent_at', dir: 'desc' } }
		)!;
		expect(view.labels).toEqual(['Oldest', 'Middle', 'Newest']);
		expect(view.series.map((series) => series.key)).toEqual(['open_rate', 'click_rate']);
		// A real 0 stays 0; nothing sent is null.
		expect(view.series[0]!.values).toEqual([0, 40, null]);
		expect(view.series[1]!.values).toEqual([0, 5, null]);
		expect(view.noSends).toEqual([false, false, true]);
	});

	it('labels are abbreviated, never dropped', () => {
		expect(shortLabel('2026-10-05')).toBe('10/05');
		expect(shortLabel('A very long campaign subject line')).toHaveLength(14);
		expect(shortLabel('')).toBe('—');
	});

	it('heatmap grid from { weekday, hour, count, pct } rows', () => {
		expect(weekdayIndex('Mon')).toBe(1);
		expect(weekdayIndex('Sunday')).toBe(0);
		expect(weekdayIndex(6)).toBe(6);
		expect(weekdayIndex('x')).toBeNull();
		expect(hourIndex('12am')).toBe(0);
		expect(hourIndex('9am')).toBe(9);
		expect(hourIndex('12pm')).toBe(12);
		expect(hourIndex(23)).toBe(23);
		expect(hourIndex('25')).toBeNull();
		const heat = heatmapGrid([
			{ weekday: 'Tue', hour: 9, count: 3, pct: 75 },
			{ weekday: 0, hour: '11pm', count: 1, pct: 25 }
		])!;
		expect(heat.total).toBe(4);
		expect(heat.grid).toHaveLength(7);
		expect(heat.grid[2]![9]).toBe(3);
		expect(heat.grid[0]![23]).toBe(1);
		// The old top-slots shape isn't a grid: the report falls back to bars.
		expect(heatmapGrid([{ slot: 'Tue 9am', engagements: 3, share: 100 }])).toBeNull();
	});
});

describe('#454 built-ins and components', () => {
	it('Best send times is a heatmap chart', () => {
		const def = BUILT_IN_REPORTS.find((report) => report.key === 'best-send-times')!;
		expect(def.chart).toBe('heatmap');
		expect(def.spec(resolveParams(def), { role: 'admin' }).chart).toBe('heatmap');
		expect(parseReportSpec({ entity: 'campaigns', columns: ['subject'], chart: 'heatmap' }).chart).toBe('heatmap');
	});

	it('ReportChart has the legend, null slot and per-point readout; results and pins have the heatmap branch', () => {
		expect(chartSource).toContain('class="legend"');
		expect(chartSource).toContain('gap-slot');
		expect(chartSource).toContain('lineSegments(');
		expect(chartSource).toContain('pointText(');
		expect(resultsSource).toContain('<EngagementHeatmap');
		expect(resultsSource).toContain('heatmapGrid(');
		expect(homeSource).toContain('<EngagementHeatmap');
		expect(homeSource).toContain('chartView(');
	});
});
