// Dashboard "Last campaign" card (#451): the pure math and wording, client- and server-safe.
// The query lives in `lastCampaign` (src/lib/server/dashboard.ts).

/** Percentage with one decimal (12.3), or null when the denominator is 0. Same rule as the
 *  send log's rate columns: unique ÷ accepted. */
export function rate(n: number, d: number): number | null {
	if (!d) return null;
	return Math.round((n / d) * 1000) / 10;
}

/** "12.3%", or "—" when there is no rate. */
export function rateText(r: number | null): string {
	return r === null ? '—' : `${r}%`;
}

/** Change in percentage points, one decimal; null when either side is missing. */
export function delta(cur: number | null, prev: number | null): number | null {
	if (cur === null || prev === null) return null;
	return Math.round((cur - prev) * 10) / 10;
}

/** A drop larger than this (points) is flagged. */
export const DELTA_WARN_PTS = 5;
/** An unsubscribe rate at or above this (%) is flagged. */
export const UNSUB_WARN_PCT = 0.5;

/** "+1.2 pts vs previous" / "−3.0 pts vs previous" / "no change vs previous". */
export function deltaText(d: number | null): string | null {
	if (d === null) return null;
	if (d === 0) return 'no change vs previous';
	const abs = Math.abs(d).toFixed(1);
	return `${d > 0 ? '+' : '−'}${abs} pts vs previous`;
}

export function deltaWarn(d: number | null): boolean {
	return d !== null && d < -DELTA_WARN_PTS;
}

export function unsubWarn(unsubRate: number | null): boolean {
	return unsubRate !== null && unsubRate >= UNSUB_WARN_PCT;
}

/** The header badge: a resend that went out wins over one that's scheduled. */
export function resendBadge(c: { resent_at: string | null; resend_status: string | null }, scheduledText: string | null): string | null {
	if (c.resent_at) return 'Resent to non-openers';
	if (c.resend_status === 'pending') return scheduledText ? `Resend scheduled ${scheduledText}` : 'Resend scheduled';
	return null;
}

export type PassLine = { sent: number; opens: number; clicks: number };

/** "120 sent · 30 opened (25%) · 6 clicked (5%)". */
export function passText(p: PassLine): string {
	return `${p.sent} sent · ${p.opens} opened (${rateText(rate(p.opens, p.sent))}) · ${p.clicks} clicked (${rateText(rate(p.clicks, p.sent))})`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
