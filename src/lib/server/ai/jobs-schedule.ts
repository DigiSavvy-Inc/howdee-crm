// When a scheduled assistant job (#303) runs next — pure, no DB. Wall-clock times are in the
// job's own IANA timezone, converted with the same Intl-based helpers as business-day
// scheduling (../businessdays.ts), so DST is handled: "daily at 08:00" in Los Angeles is
// 15:00 UTC in summer and 16:00 UTC in winter. A local time that doesn't exist on a
// spring-forward day lands where `localToUtc` puts it (an hour later); a repeated
// fall-back hour runs once (the first match after `after`).

import type { JobSchedule } from '$lib/ai-jobs';
import { localParts, localToUtc } from '../businessdays';

const MINUTE = 60_000;

export function parseHHMM(s: string): { hour: number; minute: number } | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

function lastDayOfMonth(y: number, m: number): number {
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The first run strictly after `after`, or null for an unusable schedule. */
export function nextRunAt(s: JobSchedule, after: Date): Date | null {
	const hm = parseHHMM(s.time);
	if (!hm) return null;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: s.timezone });
	} catch {
		return null;
	}

	if (s.kind === 'hourly') {
		// Step whole UTC minutes until the local minute matches (≤ 2 h covers any offset).
		let t = Math.floor(after.getTime() / MINUTE) * MINUTE;
		for (let i = 0; i < 180; i++) {
			t += MINUTE;
			if (localParts(new Date(t), s.timezone).minute === hm.minute) return new Date(t);
		}
		return null;
	}

	// Walk local calendar dates from `after`'s local date. Local noon as a UTC anchor keeps
	// the day steps from skipping a date around DST.
	const p = localParts(after, s.timezone);
	const anchor = new Date(Date.UTC(p.y, p.m - 1, p.day, 12, 0, 0));
	for (let i = 0; i < 400; i++, anchor.setUTCDate(anchor.getUTCDate() + 1)) {
		const y = anchor.getUTCFullYear();
		const m = anchor.getUTCMonth() + 1;
		const d = anchor.getUTCDate();
		if (s.kind === 'weekly' && anchor.getUTCDay() !== (s.dow ?? 1)) continue;
		if (s.kind === 'monthly' && d !== Math.min(s.dom ?? 1, lastDayOfMonth(y, m))) continue;
		const at = localToUtc(y, m, d, hm.hour, hm.minute, 0, s.timezone);
		if (at.getTime() > after.getTime()) return at;
	}
	return null;
}
