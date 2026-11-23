// Pure view math for the campaign Engagement bar (#161) — client- and server-safe so
// EngagementBar.svelte stays presentational and this stays unit-testable.
// The breakdown itself comes from $lib/server/campaign-engagement.ts.

export type EngagementCounts = {
	sent: number;
	clicked: number;
	openedOnly: number;
	none: number;
	bounced: number;
	unsubscribed: number;
	proxyOpens: number;
};

export type BarSegment = {
	key: 'clicked' | 'opened' | 'none';
	label: string;
	count: number;
	/** Share of `sent`, 0–100, rounded to a whole number for display. */
	pct: number;
	/** CSS custom property carrying the segment color (one sequential hue, see app.css). */
	color: string;
};

/** Whole-number percent of `d`; 0 when there's nothing to divide by. */
export function pctOf(n: number, d: number): number {
	return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** Fixed left→right order: most engaged → least. Never reordered by size. */
export function barSegments(b: EngagementCounts): BarSegment[] {
	return [
		{ key: 'clicked', label: 'Clicked', count: b.clicked, pct: pctOf(b.clicked, b.sent), color: 'var(--viz-1)' },
		{ key: 'opened', label: 'Opened, no click', count: b.openedOnly, pct: pctOf(b.openedOnly, b.sent), color: 'var(--viz-2)' },
		{ key: 'none', label: 'No interaction', count: b.none, pct: pctOf(b.none, b.sent), color: 'var(--viz-3)' }
	];
}

/** Headline: interacted = clicked + opened (no click); rate is over everyone sent. */
export function engagementHeadline(b: EngagementCounts): { interacted: number; rate: number } {
	const interacted = b.clicked + b.openedOnly;
	return { interacted, rate: pctOf(interacted, b.sent) };
}

/** Muted note under the bar — "3 bounced · 1 unsubscribed"; empty when both are 0. */
export function engagementNote(b: EngagementCounts): string {
	const parts: string[] = [];
	if (b.bounced > 0) parts.push(`${b.bounced} bounced`);
	if (b.unsubscribed > 0) parts.push(`${b.unsubscribed} unsubscribed`);
	return parts.join(' · ');
}
