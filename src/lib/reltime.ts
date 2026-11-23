// Relative time for UTC 'YYYY-MM-DD HH:MM:SS' strings (SQLite datetime('now')) — client-
// and server-safe. "just now", "5m ago", "3h ago", "2d ago", then the date.

export function parseUtc(s: string): Date {
	return new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
}

export function relTime(s: string | null | undefined, now: Date = new Date()): string {
	if (!s) return '';
	const t = parseUtc(s).getTime();
	if (Number.isNaN(t)) return s;
	const sec = Math.round((now.getTime() - t) / 1000);
	if (sec < 0) {
		const ahead = -sec;
		if (ahead < 3600) return `in ${Math.max(1, Math.round(ahead / 60))}m`;
		if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
		return `in ${Math.round(ahead / 86400)}d`;
	}
	if (sec < 60) return 'just now';
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	if (sec < 30 * 86400) return `${Math.floor(sec / 86400)}d ago`;
	return s.slice(0, 10);
}
