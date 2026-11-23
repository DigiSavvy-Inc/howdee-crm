// Business-day scheduling (#119) — deliberately small: a single rule, applied in one
// helper. If a computed due time falls on Saturday or Sunday in the OPERATOR's timezone
// (Settings → Timezone, src/lib/server/settings.ts), move it to Monday at the same local
// wall-clock time. No business-day counting, no holidays. Opt-in via `weekday_only` on
// `automation_steps` / `campaigns` (migration 0043).
//
// There is no tz database library here (Workers-native, no `Intl.DateTimeFormat` tz data
// shipped separately — the runtime's built-in ICU data is used via `Intl` directly), so
// converting a LOCAL wall-clock time back to a UTC instant needs the "two-pass" trick
// below: guess a UTC instant, see what wall-clock time that guess maps to in the target
// zone, and nudge the guess by the difference. One pass is enough for ordinary offsets;
// a second pass defends the (rare) case where the first nudge crosses a DST boundary.

const WEEKDAY_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6
};

export type LocalParts = {
	weekday: number; // 0 = Sunday … 6 = Saturday
	hour: number;
	minute: number;
	second: number;
	y: number;
	m: number; // 1-12
	day: number;
};

/** The wall-clock date/time `d` reads as in IANA zone `tz`, via Intl.DateTimeFormat
 *  (no external tz data needed — the JS runtime ships its own ICU tz database). */
export function localParts(d: Date, tz: string): LocalParts {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		weekday: 'short'
	});
	const parts = fmt.formatToParts(d);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	// Some locales/engines render midnight as "24" with hour12: false — normalize.
	let hour = Number(get('hour'));
	if (hour === 24) hour = 0;
	return {
		weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
		hour,
		minute: Number(get('minute')),
		second: Number(get('second')),
		y: Number(get('year')),
		m: Number(get('month')),
		day: Number(get('day'))
	};
}

/**
 * Convert a LOCAL wall-clock date/time in `tz` to the UTC instant it represents.
 * Two-pass trick (documented above): guess the UTC instant is just the wall-clock
 * numbers read as UTC, see what that guess actually reads as in `tz`, and shift the
 * guess by the difference. Repeated once more to settle a guess that crossed a DST
 * transition on the first nudge.
 */
export function localToUtc(y: number, m: number, day: number, hour: number, minute: number, second: number, tz: string): Date {
	const wantMs = Date.UTC(y, m - 1, day, hour, minute, second);
	let guessMs = wantMs;
	for (let i = 0; i < 2; i++) {
		const got = localParts(new Date(guessMs), tz);
		const gotMs = Date.UTC(got.y, got.m - 1, got.day, got.hour, got.minute, got.second);
		const diff = wantMs - gotMs;
		if (diff === 0) break;
		guessMs += diff;
	}
	return new Date(guessMs);
}

/**
 * The business-day rule (#119): if `dueUtc` falls on Saturday or Sunday in `tz`, push it
 * to the following Monday at the SAME local wall-clock time (hour/minute/second
 * preserved — not the same UTC offset, so DST transitions in between are handled
 * correctly via `localToUtc`). Any other weekday is returned unchanged.
 */
export function applyWeekdayOnly(dueUtc: Date, tz: string): Date {
	const parts = localParts(dueUtc, tz);
	const addDays = parts.weekday === 6 ? 2 : parts.weekday === 0 ? 1 : 0; // Sat -> +2, Sun -> +1
	if (addDays === 0) return dueUtc;

	// Advance the local CALENDAR DATE by addDays. Anchor at local noon (UTC) purely so
	// the plain day-add can't itself skip/repeat a day around a DST boundary; the actual
	// target time-of-day is re-applied via localToUtc below.
	const anchor = new Date(Date.UTC(parts.y, parts.m - 1, parts.day, 12, 0, 0));
	anchor.setUTCDate(anchor.getUTCDate() + addDays);

	return localToUtc(
		anchor.getUTCFullYear(),
		anchor.getUTCMonth() + 1,
		anchor.getUTCDate(),
		parts.hour,
		parts.minute,
		parts.second,
		tz
	);
}

/**
 * SEO Snapshot clock (#190): the `days`-th business day (Mon–Fri) after the LOCAL calendar
 * date of `fromUtc` in `tz`, at `hour`:00 local. The submit day itself never counts, so a
 * Friday-evening or weekend submit with days = 2 lands on Tuesday. No holidays.
 */
export function businessDayAt(fromUtc: Date, days: number, hour: number, tz: string): Date {
	const parts = localParts(fromUtc, tz);
	// Local noon as a UTC anchor so the day steps can't skip a date around DST.
	const anchor = new Date(Date.UTC(parts.y, parts.m - 1, parts.day, 12, 0, 0));
	let left = Math.max(1, Math.floor(days));
	while (left > 0) {
		anchor.setUTCDate(anchor.getUTCDate() + 1);
		const weekday = anchor.getUTCDay();
		if (weekday !== 0 && weekday !== 6) left--;
	}
	return localToUtc(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate(), hour, 0, 0, tz);
}

/** A UTC instant as operator-local text, e.g. "Tue, Oct 6, 9:00 AM PDT". */
export function formatLocal(d: Date, tz: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	}).format(d);
}

/** The reverse of `parseZonedLocal` (#246): a UTC instant as a `datetime-local` value
 *  (`YYYY-MM-DDTHH:mm`) in `tz`, e.g. to prefill a picker with a stored time. */
export function toZonedLocalInput(d: Date, tz: string): string {
	const p = localParts(d, tz);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${p.y}-${pad(p.m)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * A `datetime-local` value (`YYYY-MM-DDTHH:mm` or with seconds) as wall-clock time
 * in `tz`, returned as a UTC instant. `new Date(local)` on a UTC worker reads that
 * string as UTC and shifts the operator by 7–8 hours.
 */
export function parseZonedLocal(input: string, tz: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.trim());
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6] ?? 0);
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
	return localToUtc(year, month, day, hour, minute, second, tz);
}

/** UTC timestamp formatted 'YYYY-MM-DD HH:MM:SS' — directly comparable to SQLite's
 *  datetime('now'). Mirrors the toUtcString() helpers already local to compose/campaign
 *  routes (kept here too so engine code doesn't need to import a route file). */
export function sqliteUtc(d: Date): string {
	return d.toISOString().slice(0, 19).replace('T', ' ');
}
