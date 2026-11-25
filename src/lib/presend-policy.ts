// #479: the pre-send check policy (Settings → General → Pre-send checks). Universal: the
// compose panel, the send gate, the scheduled-send tick, the API and the settings page all
// read the same rules. Stored in app_state (src/lib/server/presend-policy.ts):
// `presend_enforcement`, `presend_levels` (JSON), `presend_override`, `presend_retry_minutes`,
// `presend_notify_email`.
import { softenLiveLinks, summarize, type Check, type CheckCategory, type CheckLevel, type ChecksReport } from './presend-checks';

export type Enforcement = 'warn' | 'block' | 'strict';
export type LevelOverride = 'block' | 'warn' | 'off';
export type OverrideRule = 'admins' | 'none';

export const ENFORCEMENTS: { value: Enforcement; label: string; help: string }[] = [
	{ value: 'warn', label: 'Warn only', help: 'Checks show, nothing is stopped. Not recommended.' },
	{ value: 'block', label: 'Block on blocking checks', help: 'A blocking check stops the send, the schedule and a scheduled send when it fires.' },
	{ value: 'strict', label: 'Strict', help: 'Also blocks on any check you set to Block below, and never sends with links not checked yet.' }
];

/** "Keep trying for N minutes, then hold." 0 = hold at once. */
export const RETRY_CHOICES = [0, 15, 30, 60] as const;

export type PresendPolicy = {
	enforcement: Enforcement;
	/** Per-check overrides by catalogue id. Missing = the check's default level. */
	levels: Record<string, LevelOverride>;
	override: OverrideRule;
	retryMinutes: number;
	/** Also email the admins (their users.email) when a send is held. */
	notifyEmail: boolean;
};

export const DEFAULT_POLICY: PresendPolicy = { enforcement: 'block', levels: {}, override: 'admins', retryMinutes: 15, notifyEmail: false };

export type CatalogEntry = {
	id: string;
	label: string;
	category: CheckCategory;
	/** The level when the check fails, before any override. */
	level: 'block' | 'warn';
	/** Compliance checks that always keep their level (the send path refuses anyway). */
	locked?: boolean;
	/** Matches every id that starts with `id + '.'` (per-tag merge coverage rows). */
	prefix?: boolean;
};

/** Every check id the rules emit, with its default level. */
export const CHECK_CATALOG: CatalogEntry[] = [
	{ id: 'links.placeholder', label: 'Placeholder or fake links', category: 'links', level: 'block' },
	{ id: 'links.utm', label: 'Same page with different UTMs', category: 'links', level: 'warn' },
	{ id: 'links.live_broken', label: 'Link not found (404 / 410)', category: 'links', level: 'block' },
	{ id: 'links.live_server', label: 'Link failing on its server (500–504 or 530, after a retry)', category: 'links', level: 'block' },
	{ id: 'links.live_dns', label: 'Link to a domain that does not exist', category: 'links', level: 'block' },
	{ id: 'links.live_error', label: 'Link timed out or answered oddly (after a retry)', category: 'links', level: 'warn' },
	{ id: 'links.live_refused', label: 'Link refused the check (401 / 403 / 429)', category: 'links', level: 'warn' },
	{ id: 'links.live_login', label: 'Link redirects to a login page', category: 'links', level: 'warn' },
	{ id: 'links.live_redirects', label: 'Redirect loop or more than 3 hops', category: 'links', level: 'warn' },
	{ id: 'links.live_merge', label: 'Merge-tag links failing for sample contacts', category: 'links', level: 'warn' },
	{ id: 'links.live_unfinished', label: 'Links not checked yet (out of time or request budget)', category: 'links', level: 'warn' },
	{ id: 'links.live_skipped', label: 'Links not checked (over the 60-link limit, or merge-tag links with no usable sample)', category: 'links', level: 'warn' },
	{ id: 'images.alt', label: 'Images without alt text', category: 'images', level: 'warn' },
	{ id: 'images.width', label: 'Images without a width', category: 'images', level: 'warn' },
	{ id: 'images.size', label: 'Images over 1 MB', category: 'images', level: 'warn' },
	{ id: 'images.text', label: 'Mostly images, little text', category: 'images', level: 'warn' },
	{ id: 'content.subject', label: 'Subject empty (blocks) or too long (warns)', category: 'content', level: 'block' },
	{ id: 'content.preheader', label: 'No preview text', category: 'content', level: 'warn' },
	{ id: 'content.unsubscribe', label: 'Unsubscribe link missing', category: 'content', level: 'block', locked: true },
	{ id: 'content.merge_unknown', label: 'Merge tags that will not fill in', category: 'content', level: 'block' },
	{ id: 'content.merge', label: 'Merge tags some recipients have no value for', category: 'content', level: 'warn', prefix: true },
	{ id: 'content.address', label: 'Mailing address missing', category: 'content', level: 'warn' },
	{ id: 'content.spammy', label: 'Wording spam filters dislike', category: 'content', level: 'warn' },
	{ id: 'audience.count', label: 'No recipients', category: 'audience', level: 'block', locked: true },
	{ id: 'audience.bounced', label: 'Many recipients bounced before', category: 'audience', level: 'warn' },
	{ id: 'audience.last_bounce', label: 'Last send to this list bounced a lot', category: 'audience', level: 'warn' },
	{ id: 'audience.cold', label: 'Many recipients cold for 12 months', category: 'audience', level: 'warn' }
];

export function catalogEntry(id: string): CatalogEntry | null {
	return CHECK_CATALOG.find((e) => e.id === id) ?? CHECK_CATALOG.find((e) => e.prefix && id.startsWith(`${e.id}.`)) ?? null;
}

const isEnforcement = (v: unknown): v is Enforcement => v === 'warn' || v === 'block' || v === 'strict';
const isLevel = (v: unknown): v is LevelOverride => v === 'block' || v === 'warn' || v === 'off';

/** Lenient read of stored / posted values; junk → the defaults. */
export function normalizePolicy(raw: { enforcement?: unknown; levels?: unknown; override?: unknown; retryMinutes?: unknown; notifyEmail?: unknown } = {}): PresendPolicy {
	let levelsIn: unknown = raw.levels;
	if (typeof levelsIn === 'string') {
		try {
			levelsIn = JSON.parse(levelsIn);
		} catch {
			levelsIn = null;
		}
	}
	const levels: Record<string, LevelOverride> = {};
	if (levelsIn && typeof levelsIn === 'object' && !Array.isArray(levelsIn)) {
		for (const [k, v] of Object.entries(levelsIn as Record<string, unknown>)) {
			const e = CHECK_CATALOG.find((x) => x.id === k);
			if (e && !e.locked && isLevel(v) && v !== e.level) levels[k] = v;
		}
	}
	const minutes = Number(raw.retryMinutes);
	return {
		enforcement: isEnforcement(raw.enforcement) ? raw.enforcement : DEFAULT_POLICY.enforcement,
		levels,
		override: raw.override === 'none' ? 'none' : 'admins',
		retryMinutes: (RETRY_CHOICES as readonly number[]).includes(minutes) ? minutes : DEFAULT_POLICY.retryMinutes,
		notifyEmail: raw.notifyEmail === true || raw.notifyEmail === '1' || raw.notifyEmail === 'on'
	};
}

/** #479: the row a scheduled send's report gets when the checker itself failed (Strict only;
 *  under Warn only / Block a checker error fails open and the send goes out). */
export const CHECKER_ERROR_ID = 'links.check_error';

/** Rows that mean "the links were not checked", not "a link is broken". */
export function isUncheckedRow(id: string): boolean {
	return id === 'links.live_unfinished' || id === CHECKER_ERROR_ID;
}

/** The report saved when the scheduled-send check could not run (Strict). */
export function checkerErrorReport(now: Date, linksChecked = false): ChecksReport {
	const checks: Check[] = [
		{
			id: CHECKER_ERROR_ID,
			category: 'links',
			level: 'block',
			title: 'The links could not be checked',
			detail: 'The pre-send check itself failed (not a link). Under Strict the send waits and is tried again every minute, then held.'
		}
	];
	return { ...summarize(checks, linksChecked), checkedAt: now.toISOString() };
}

const WARN_ONLY_NOTE = 'Not enforced: Settings → General → Pre-send checks is set to Warn only.';

/** The levels that will be enforced: per-check overrides, then the enforcement mode. A passing
 *  check stays a pass; "Off" removes the row. `scheduling` (#479, checking at schedule time):
 *  after the overrides, a failing live link is only a warning ("checked again at send time"),
 *  under every policy — so a check raised to Block under Strict still only warns here. */
export function applyPolicy(report: ChecksReport, policy: PresendPolicy, opts: { scheduling?: boolean } = {}): ChecksReport {
	const checks: Check[] = [];
	for (const c of report.checks) {
		if (c.level === 'pass') {
			checks.push(c);
			continue;
		}
		const e = catalogEntry(c.id);
		let level: CheckLevel = c.level;
		if (e && !e.locked) {
			const ov = policy.levels[e.id];
			if (ov === 'off') continue;
			if (ov === 'warn') level = 'warn';
			// Raising a check to Block only counts under Strict.
			if (ov === 'block' && policy.enforcement === 'strict') level = 'block';
		}
		// Strict never sends with links that weren't checked yet.
		if (c.id === 'links.live_unfinished' && policy.enforcement === 'strict' && policy.levels[c.id] !== 'off') level = 'block';
		let detail = c.detail;
		if (policy.enforcement === 'warn' && level === 'block' && !e?.locked) {
			level = 'warn';
			detail = `${detail ? `${detail} ` : ''}${WARN_ONLY_NOTE}`;
		}
		checks.push(level === c.level && detail === c.detail ? c : { ...c, level, ...(detail ? { detail } : {}) });
	}
	const final = opts.scheduling ? softenLiveLinks(checks) : checks;
	return { ...report, ...summarize(final, report.linksChecked) };
}

/** May this user tick "Send anyway"? Members never; admins unless overrides are off. */
export function canSendAnyway(policy: PresendPolicy, role: string | null | undefined): boolean {
	return policy.override === 'admins' && role === 'admin';
}

/** "2 broken links" / "3 blocking problems" — the held badge on the campaigns list and dashboard. */
export function heldSummary(report: ChecksReport | null): string {
	const blocks = report?.checks.filter((c) => c.level === 'block') ?? [];
	if (!blocks.length) return 'failed pre-send checks';
	// The checker itself failed → "links could not be checked"; only links the limits didn't
	// reach (Strict) → "could not check all links".
	if (blocks.every((c) => isUncheckedRow(c.id))) return blocks.some((c) => c.id === CHECKER_ERROR_ID) ? 'links could not be checked' : 'could not check all links';
	if (blocks.every((c) => c.id.startsWith('links.live_'))) {
		const n = blocks.filter((c) => !isUncheckedRow(c.id)).reduce((sum, c) => sum + Math.max(1, c.urls?.length ?? c.items?.length ?? 1), 0);
		return `${n} broken link${n === 1 ? '' : 's'}`;
	}
	return `${blocks.length} blocking problem${blocks.length === 1 ? '' : 's'}`;
}

/** A stored report (campaigns.preflight_report); junk → null. */
export function parseReport(raw: string | null | undefined): ChecksReport | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as ChecksReport;
		return v && Array.isArray(v.checks) ? v : null;
	} catch {
		return null;
	}
}
