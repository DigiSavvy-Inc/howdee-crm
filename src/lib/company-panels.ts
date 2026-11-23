// Company dashboard 4/4 (#567): pure helpers for the company page's side panels. Universal.

import { utcWeekStart } from './report-spec';

export const HOURS_SPARK_WEEKS = 12;

export type WeekHours = { week: string; hours: number | null };

/**
 * Weekly Timing hours from the daily `company_metrics_daily.hours_7d` snapshots (#358): a week's
 * value is its newest snapshot's 7-day total (the last snapshot in a UTC Monday week covers that
 * week). `weeks` UTC Monday weeks ending with the current one; a week with no snapshot is null
 * (a gap, never 0) — snapshots only exist from the day history started.
 */
export function weeklyHours(points: { day: string; value: number | null }[], now: Date, weeks = HOURS_SPARK_WEEKS): WeekHours[] {
	const latest = new Map<string, { day: string; value: number | null }>();
	for (const p of points) {
		const w = utcWeekStart(p.day);
		if (!w) continue;
		const have = latest.get(w);
		if (!have || p.day > have.day) latest.set(w, { day: p.day, value: p.value });
	}
	const thisWeek = utcWeekStart(now.toISOString().slice(0, 10))!;
	const start = new Date(`${thisWeek}T00:00:00Z`).getTime();
	const out: WeekHours[] = [];
	for (let i = weeks - 1; i >= 0; i--) {
		const week = new Date(start - i * 7 * 86_400_000).toISOString().slice(0, 10);
		out.push({ week, hours: latest.get(week)?.value ?? null });
	}
	return out;
}

/** Bar heights (px) for the sparkline; null stays null, a real 0 gets 1px. */
export function sparkHeights(values: (number | null)[], maxPx: number): (number | null)[] {
	const max = Math.max(0, ...values.map((v) => v ?? 0));
	return values.map((v) => (v == null ? null : max > 0 && v > 0 ? Math.max(2, Math.round((v / max) * maxPx)) : 1));
}
