// #434: the "Visits the site often" trigger (`site_activity`). Universal (no server imports):
// the config shape stored in `automations.trigger_config`, its validation, session counting and
// the one-line summary. Firing lives in `src/lib/server/site-activity-trigger.ts`.
//
// The config:
//   measure         'pages' (pageviews in the window) | 'visits' (sessions in the window)
//   threshold       1–1000: fires once the count reaches it
//   days            1–180: the rolling window (site_events are pruned after 180 days)
//   site_id         null = any site
//   path_op / path  only pageviews whose path matches count (blank path = every page)
//   cooldown_hours  0–8760: after enrolling a contact, don't fire again for them this long

import { isPathOp, pathMatches, PATTERN_MAX, type PathOp } from '$lib/site-trigger';

export const SITE_ACTIVITY_KIND = 'site_activity';

export function isSiteActivityKind(type: unknown): type is 'site_activity' {
	return type === SITE_ACTIVITY_KIND;
}

/** A visit (session) = a run of pageviews each at most this long after the previous one. */
export const SESSION_GAP_MINUTES = 30;
/** Same as the server's SITE_EVENTS_MAX_AGE_DAYS — older events are pruned, so a longer window can't see more. */
export const SITE_ACTIVITY_MAX_DAYS = 180;
export const SITE_ACTIVITY_MAX_THRESHOLD = 1000;
export const SITE_ACTIVITY_MAX_COOLDOWN = 8760;
export const SITE_ACTIVITY_DEFAULT_COOLDOWN = 168;
/** Pageviews read per contact when counting visits. */
export const SITE_ACTIVITY_ROW_CAP = 2000;

export type SiteActivityMeasure = 'pages' | 'visits';

export type SiteActivityConfig = {
	measure: SiteActivityMeasure;
	threshold: number;
	days: number;
	site_id: number | null;
	path_op: PathOp;
	path: string;
	cooldown_hours: number;
};

export function defaultSiteActivityConfig(): SiteActivityConfig {
	return { measure: 'pages', threshold: 10, days: 30, site_id: null, path_op: 'contains', path: '', cooldown_hours: SITE_ACTIVITY_DEFAULT_COOLDOWN };
}

function int(v: unknown): number | null {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/**
 * Untrusted input → a clean config, or the first problem. Shape and bounds only — that the
 * site exists is checked by the write layer. Missing keys take the defaults.
 */
export function normalizeSiteActivityConfig(
	raw: Record<string, unknown> | null | undefined
): { ok: true; config: SiteActivityConfig } | { ok: false; error: string } {
	const src = raw && typeof raw === 'object' ? raw : {};
	const cfg = defaultSiteActivityConfig();

	if (src.measure !== undefined && src.measure !== null) {
		if (src.measure !== 'pages' && src.measure !== 'visits') return { ok: false, error: 'Count either pages viewed or separate visits.' };
		cfg.measure = src.measure;
	}
	if (src.threshold !== undefined && src.threshold !== null) {
		const n = int(src.threshold);
		if (n === null || n < 1 || n > SITE_ACTIVITY_MAX_THRESHOLD) return { ok: false, error: `The number must be a whole number from 1 to ${SITE_ACTIVITY_MAX_THRESHOLD}.` };
		cfg.threshold = n;
	}
	if (src.days !== undefined && src.days !== null) {
		const n = int(src.days);
		if (n === null || n < 1 || n > SITE_ACTIVITY_MAX_DAYS) {
			return { ok: false, error: `The window must be 1 to ${SITE_ACTIVITY_MAX_DAYS} days (site events older than ${SITE_ACTIVITY_MAX_DAYS} days are deleted).` };
		}
		cfg.days = n;
	}
	if (src.site_id !== undefined && src.site_id !== null && src.site_id !== '') {
		const n = int(src.site_id);
		if (n === null || n < 1) return { ok: false, error: 'That tracking site is not valid.' };
		cfg.site_id = n;
	}
	if (src.path_op !== undefined && src.path_op !== null) {
		const op = String(src.path_op);
		if (!isPathOp(op)) return { ok: false, error: 'Choose how the page path is matched.' };
		cfg.path_op = op;
	}
	if (src.path !== undefined && src.path !== null) cfg.path = String(src.path).trim().slice(0, PATTERN_MAX);
	if (src.cooldown_hours !== undefined && src.cooldown_hours !== null) {
		const n = int(src.cooldown_hours);
		if (n === null || n < 0 || n > SITE_ACTIVITY_MAX_COOLDOWN) return { ok: false, error: `Cooldown must be 0 to ${SITE_ACTIVITY_MAX_COOLDOWN} whole hours.` };
		cfg.cooldown_hours = n;
	}
	return { ok: true, config: cfg };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** `automations.trigger_config` → config. Lenient: out-of-range numbers are clamped, junk → defaults. */
export function parseSiteActivityConfig(json: string | null | undefined): SiteActivityConfig {
	if (!json) return defaultSiteActivityConfig();
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(json);
	} catch {
		return defaultSiteActivityConfig();
	}
	if (!raw || typeof raw !== 'object') return defaultSiteActivityConfig();
	const fixed = { ...raw };
	const num = (k: string, lo: number, hi: number) => {
		const n = Math.round(Number(fixed[k]));
		if (fixed[k] !== undefined && fixed[k] !== null && Number.isFinite(n)) fixed[k] = clamp(n, lo, hi);
	};
	num('threshold', 1, SITE_ACTIVITY_MAX_THRESHOLD);
	num('days', 1, SITE_ACTIVITY_MAX_DAYS);
	num('cooldown_hours', 0, SITE_ACTIVITY_MAX_COOLDOWN);
	const r = normalizeSiteActivityConfig(fixed);
	return r.ok ? r.config : defaultSiteActivityConfig();
}

/** Does this pageview path count toward the trigger? Blank pattern = every page. */
export function pageCounts(path: string | null, cfg: Pick<SiteActivityConfig, 'path_op' | 'path'>): boolean {
	return !cfg.path.trim() || pathMatches(path, cfg.path_op, cfg.path);
}

/**
 * Number of visits in a list of pageview times (ms, any order). A new visit starts when a
 * pageview comes more than SESSION_GAP_MINUTES after the previous one; exactly 30 minutes
 * apart is still the same visit.
 */
export function countVisits(times: number[]): number {
	const t = times.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	const gap = SESSION_GAP_MINUTES * 60_000;
	let visits = 0;
	for (let i = 0; i < t.length; i++) if (i === 0 || t[i] - t[i - 1] > gap) visits++;
	return visits;
}

function cooldownText(h: number): string {
	if (h === 0) return 'no cooldown';
	return h >= 48 && h % 24 === 0 ? `${h / 24}d cooldown` : `${h}h cooldown`;
}

const PATH_VERB: Record<string, string> = { contains: 'containing', equals: 'exactly', wildcard: 'matching' };

/** "Visits the site 10+ times in 30 days on any site · 7d cooldown",
 *  "Views 10+ pages containing “/blog” in 14 days on Site X · 24h cooldown". */
export function siteActivityTriggerText(cfg: SiteActivityConfig, siteName: (id: number) => string | null): string {
	const site = cfg.site_id === null ? 'any site' : (siteName(cfg.site_id) ?? '(deleted site)');
	const pathText = cfg.path.trim() ? ` ${PATH_VERB[cfg.path_op] ?? 'containing'} “${cfg.path}”` : '';
	const days = `${cfg.days} day${cfg.days === 1 ? '' : 's'}`;
	const what =
		cfg.measure === 'visits'
			? `Visits the site ${cfg.threshold}+ time${cfg.threshold === 1 ? '' : 's'}${pathText ? ` (pages${pathText})` : ''}`
			: `Views ${cfg.threshold}+ page${cfg.threshold === 1 ? '' : 's'}${pathText}`;
	return `${what} in ${days} on ${site} · ${cooldownText(cfg.cooldown_hours)}`;
}
