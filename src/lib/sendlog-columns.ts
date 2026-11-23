/**
 * Send log columns (#336) — the `/campaigns` table's column picker vocabulary and the rate
 * math. Universal (the page renders it, the server sorts by the same keys).
 *
 * Rates use the same rule as the "Open rate (30 days)" tile on that page: unique recipients
 * with the event ÷ accepted recipients ("delivered"), one decimal, `null` (shown "—") when
 * nothing was accepted. Opens count every unique opener — the tile doesn't single out
 * auto-opens (Apple MPP), so neither does the column, and the two agree.
 * Click-to-open = unique clickers ÷ unique openers.
 */

export const SENDLOG_COLUMNS = [
	{ key: 'status', label: 'Status' },
	{ key: 'sent', label: 'Sent' },
	{ key: 'delivered', label: 'Delivered' },
	{ key: 'open_rate', label: 'Open rate' },
	{ key: 'opens', label: 'Opens' },
	{ key: 'click_rate', label: 'Click rate' },
	{ key: 'clicks', label: 'Clicks' },
	{ key: 'ctor', label: 'Click-to-open' },
	{ key: 'unsubs', label: 'Unsubs' },
	{ key: 'unsub_rate', label: 'Unsub rate' },
	{ key: 'bounces', label: 'Bounces' },
	{ key: 'bounce_rate', label: 'Bounce rate' },
	{ key: 'replies', label: 'Replies' },
	{ key: 'audience', label: 'Audience' },
	{ key: 'type', label: 'Type' },
	{ key: 'date', label: 'Date (UTC)' }
] as const;

export type SendLogColumn = (typeof SENDLOG_COLUMNS)[number]['key'];

/** Subject is always shown and isn't in the picker. */
export const DEFAULT_SENDLOG_COLUMNS: SendLogColumn[] = ['status', 'sent', 'open_rate', 'opens', 'clicks', 'unsubs', 'date'];

export const SENDLOG_COLS_LS_KEY = 'campaigns.columns';

/** A saved choice from localStorage → known keys only, in table order; junk → the default. */
export function cleanSendLogColumns(saved: unknown): SendLogColumn[] {
	if (!Array.isArray(saved)) return DEFAULT_SENDLOG_COLUMNS;
	return SENDLOG_COLUMNS.map((c) => c.key).filter((k) => saved.includes(k));
}

/** n ÷ d as a percentage with one decimal; null when d is 0. */
export function ratePct(n: number, d: number): number | null {
	if (!d) return null;
	return Math.round((n / d) * 1000) / 10;
}

export type SendLogCounts = {
	accepted: number;
	opens: number;
	clicks: number;
	unsubs: number;
	bounces: number;
};

export function sendLogRates(r: SendLogCounts) {
	return {
		open_rate: ratePct(r.opens, r.accepted),
		click_rate: ratePct(r.clicks, r.accepted),
		ctor: ratePct(r.clicks, r.opens),
		unsub_rate: ratePct(r.unsubs, r.accepted),
		bounce_rate: ratePct(r.bounces, r.accepted)
	};
}

/** "28.9%" | "—" */
export function rateText(n: number | null): string {
	return n === null ? '—' : `${n.toFixed(1)}%`;
}
