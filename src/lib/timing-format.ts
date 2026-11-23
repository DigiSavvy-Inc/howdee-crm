// Display helpers for Timing numbers (#168) — client- and server-safe.

/** "12.5h"; null (never synced) → "—". */
export function fmtHours(h: number | null | undefined): string {
	return h === null || h === undefined ? '—' : `${Number(h.toFixed(1))}h`;
}

/** Coarse relative time: "just now", "3h ago", "2d ago", else the date. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return '—';
	// SQLite datetime('now') has no zone — it's UTC.
	const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
	if (!Number.isFinite(t)) return iso;
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
	return new Date(t).toISOString().slice(0, 10);
}
