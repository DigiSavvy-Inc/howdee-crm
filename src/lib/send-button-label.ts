// Compose's submit button label (#338): "Send now · N contacts" for an immediate send,
// "Schedule for Oct 20, 4:00 PM · N contacts" for a scheduled one, "Schedule…" (disabled)
// while no time is picked. Pure so it can be unit-tested; universal (no server imports).

export type SendButtonInput = {
	mode: 'campaign' | 'direct';
	sendWhen: 'now' | 'later';
	/** The picked send time (the compose picker's local time), null/invalid = none yet. */
	scheduledAt: Date | null;
	count: number;
	weekdayOnly?: boolean;
	bestTime?: boolean;
	busy?: boolean;
	/** Test seams. */
	now?: Date;
	locale?: string | string[];
	timeZone?: string;
};

export type SendButtonLabel = { label: string; needsTime: boolean };

export function contactsText(n: number): string {
	return `${n} contact${n === 1 ? '' : 's'}`;
}

/** Weekdays only (#119): a Sat/Sun time moves to Monday, same wall-clock time. The server
 *  applies this in the Settings timezone; here it's the browser's, the same zone the
 *  picker uses — they only disagree when the operator's browser isn't in that zone. */
export function weekdayShift(d: Date, timeZone?: string): Date {
	const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(d);
	const days = wd === 'Sat' ? 2 : wd === 'Sun' ? 1 : 0;
	return days ? new Date(d.getTime() + days * 86_400_000) : d;
}

/** "Oct 20, 4:00 PM" — the year only when it isn't the current one. */
export function formatSendTime(
	d: Date,
	now: Date = new Date(),
	locale?: string | string[],
	timeZone?: string
): string {
	const year = (x: Date) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(x);
	return d.toLocaleString(locale, {
		month: 'short',
		day: 'numeric',
		...(year(d) !== year(now) ? { year: 'numeric' as const } : {}),
		hour: 'numeric',
		minute: '2-digit',
		timeZone
	});
}

export function sendButtonLabel(input: SendButtonInput): SendButtonLabel {
	const { mode, sendWhen, count } = input;
	if (mode === 'direct') return { label: input.busy ? 'Sending…' : 'Send now', needsTime: false };
	if (sendWhen === 'now') {
		return { label: input.busy ? 'Sending…' : `Send now · ${contactsText(count)}`, needsTime: false };
	}
	const at = input.scheduledAt;
	if (!at || Number.isNaN(at.getTime())) return { label: 'Schedule…', needsTime: true };
	if (input.busy) return { label: 'Scheduling…', needsTime: false };
	const when = input.weekdayOnly ? weekdayShift(at, input.timeZone) : at;
	const time = formatSendTime(when, input.now, input.locale, input.timeZone);
	const best = input.bestTime ? ' (best time per contact)' : '';
	return { label: `Schedule for ${time}${best} · ${contactsText(count)}`, needsTime: false };
}
