// #154: site activity in automations — the "Visits a page" trigger (`site_visit`) and the
// `visited` Condition kind. Universal (no server imports) so the automation page shows the
// same labels / matching rules the server applies.

export type PathOp = 'contains' | 'equals' | 'wildcard';

export const PATH_OPS: { op: PathOp; label: string }[] = [
	{ op: 'contains', label: 'path contains' },
	{ op: 'equals', label: 'path equals' },
	{ op: 'wildcard', label: 'path matches (* = anything)' }
];

export const DEFAULT_COOLDOWN_HOURS = 24;
export const MAX_COOLDOWN_HOURS = 24 * 365;
export const PATTERN_MAX = 300;

export function isPathOp(op: string): op is PathOp {
	return PATH_OPS.some((o) => o.op === op);
}

/** `/pricing/` and `/pricing` are the same page for `equals`/`wildcard`; root stays `/`. */
function trimSlash(p: string): string {
	return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/**
 * Does a stored pageview path match the trigger pattern? Case-insensitive. `contains` is a
 * substring test; `equals` compares whole paths (trailing slash ignored); `wildcard` is
 * regex-lite — `*` matches any run of characters (including `/`), everything else is literal,
 * anchored at both ends (`/blog/*` matches `/blog/a/b`, not `/blog`).
 */
export function pathMatches(path: string | null, op: string, pattern: string): boolean {
	const p = (path ?? '/').toLowerCase();
	const pat = pattern.trim().toLowerCase();
	if (!pat) return false;
	if (op === 'contains') return p.includes(pat);
	if (op === 'equals') return trimSlash(p) === trimSlash(pat);
	if (op === 'wildcard') {
		const re = trimSlash(pat)
			.split('*')
			.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*');
		return new RegExp(`^${re}$`).test(trimSlash(p));
	}
	return false;
}

/** "Visits a page whose path contains “/pricing” on example.com (cooldown 24 h)". */
export function siteTriggerLabel(
	op: string | null,
	pattern: string | null,
	siteName: string | null,
	cooldownHours: number | null
): string {
	const verb = op === 'equals' ? 'is' : op === 'wildcard' ? 'matches' : 'contains';
	const site = siteName ? ` on ${siteName}` : ' on any site';
	const cd = cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
	return `Visits a page whose path ${verb} “${pattern ?? ''}”${site} (cooldown ${cd} h)`;
}

// ---- Condition kind `visited` -------------------------------------------------------------
// gate_name = the path text (contains) or event name (exact); gate_value = `page:<days>` or
// `event:<days>` (0 = ever).

export type VisitedMode = 'page' | 'event';
export type VisitedCondition = { mode: VisitedMode; match: string; days: number };

export function normalizeVisited(mode: string, match: string, days: unknown): VisitedCondition | null {
	if (mode !== 'page' && mode !== 'event') return null;
	const m = match.trim().slice(0, PATTERN_MAX);
	if (!m) return null;
	const n = Math.floor(Number(typeof days === 'string' ? days.trim() || '0' : (days ?? 0)));
	if (!Number.isFinite(n) || n < 0) return null;
	return { mode, match: m, days: Math.min(n, 3650) };
}

export function decodeVisited(gateName: string | null, gateValue: string | null): VisitedCondition | null {
	const [mode, days] = (gateValue ?? '').split(':');
	return normalizeVisited(mode ?? '', gateName ?? '', days ?? '0');
}

/** "Visited a page containing “/pricing” in the last 7 days" / "Did event «booked_call» ever". */
export function visitedLabel(c: VisitedCondition): string {
	const when = c.days > 0 ? ` in the last ${c.days} day${c.days === 1 ? '' : 's'}` : '';
	return c.mode === 'event' ? `Did event «${c.match}»${when}` : `Visited a page containing “${c.match}”${when}`;
}
